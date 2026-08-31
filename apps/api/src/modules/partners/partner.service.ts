import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  CustomerSource,
  DocumentStatus,
  DocumentType,
  OrderChannel,
  OrderStatus,
  PaymentProvider,
  PartnerLedgerEntryType,
  PartnerQuoteStatus,
  PartnerSettlementMethod,
  PartnerStatus,
  PartnerIntegrationType,
  Prisma,
} from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  documentTypeLabel,
  DocumentType as SharedDocumentType,
  RESTRICTED_PLAN_COUNTRY_CODES,
  type TravelerInput,
} from "@visa-compass/shared";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { CryptoService } from "../../infrastructure/crypto.service.js";
import { S3StorageService } from "../../infrastructure/s3-storage.service.js";
import { ApiException } from "../../common/api-error.js";
import { ConnectivityService } from "../integration/connectivity.service.js";
import { NotificationService } from "../notification/notification.service.js";
import { PartnerWebhookProcessor } from "../../jobs/partner-webhook.processor.js";
import { QueueService } from "../../jobs/queue.service.js";
import { QUEUES } from "../../jobs/queues.js";
import { ocrJobOptions } from "../../jobs/ocr-recovery.config.js";
import { OrdersService } from "../orders/orders.service.js";
import { PaymentsService } from "../payments/payments.service.js";

/** Opaque, deterministic composite cursor for (createdAt, id) keyset pagination. */
function encodeCursor(
  createdAt: Date | undefined,
  id: string | undefined,
): string | null {
  if (!createdAt || !id) return null;
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString(
    "base64url",
  );
}
function decodeCursor(
  cursor?: string | undefined,
): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const invalid = () =>
    new ApiException({
      code: "INVALID_CURSOR",
      message: "Cursor is malformed or expired",
      status: 400,
    });
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = raw.lastIndexOf("|");
  if (separator <= 0 || separator !== raw.indexOf("|")) throw invalid();
  const iso = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))
    throw invalid();
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== iso)
    throw invalid();
  return { createdAt, id };
}

type CreateOrderInput = {
  quoteId: string;
  externalOrderId: string;
  externalCustomerId: string;
  compatibilityAccepted: true;
  metadata?: Record<string, string> | undefined;
};

type CompleteOrderInput = {
  externalOrderId: string;
  externalCustomerId: string;
  planId: string;
  settlement?:
    | (
        | { method: "PARTNER_ACCOUNT" }
        | {
            method: "HOSTED_PAYMENT";
            provider: PaymentProvider;
            redirectUrl: string;
          }
      )
    | undefined;
  documentVerificationId?: string | undefined;
  topUpMobile?: string | undefined;
  consent: {
    compatibilityAccepted: true;
    termsAccepted: true;
    privacyAccepted: true;
    acceptedAt: string;
  };
  metadata?: Record<string, string> | undefined;
};

type UploadSessionInput = {
  externalOrderId: string;
  traveler: TravelerInput;
  documents: Array<{
    type: DocumentType;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }>;
};

const PARTNER_ORDER_INCLUDE = {
  plan: { include: { country: true } },
  traveler: true,
  documents: true,
  payments: { orderBy: { createdAt: "desc" as const }, take: 1 },
  events: { orderBy: { createdAt: "asc" as const } },
  partnerQuote: true,
  partnerRefundRequests: { orderBy: { createdAt: "desc" as const }, take: 1 },
} satisfies Prisma.OrderInclude;

type PartnerOrderRow = Prisma.OrderGetPayload<{
  include: typeof PARTNER_ORDER_INCLUDE;
}>;

@Injectable()
export class PartnerService {
  private readonly logger = new Logger(PartnerService.name);

  // Legacy reservation reconciliation remains readable for historical
  // PARTNER_ACCOUNT orders. New partner-hosted sessions use HOSTED_PAYMENT and
  // never enter this settlement path.
  private readonly hostedDepositSuccess = new Set<OrderStatus>([
    OrderStatus.QR_READY,
    OrderStatus.COMPLETED,
    OrderStatus.ACTIVATION_ATTENTION,
  ]);
  private readonly hostedDepositRelease = new Set<OrderStatus>([
    OrderStatus.PROVISIONING_FAILED,
    OrderStatus.CANCELLED,
  ]);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly storage: S3StorageService,
    private readonly connectivity: ConnectivityService,
    private readonly notifications: NotificationService,
    private readonly partnerWebhooks: PartnerWebhookProcessor,
    private readonly queues: QueueService,
    private readonly applicationOrders: OrdersService,
    private readonly payments?: PaymentsService,
  ) {}

  private async verifyUploadedDocument(assetId: string) {
    try {
      return await this.storage.verifyDocument(assetId);
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw new ApiException({
          code: "PARTNER_DOCUMENT_INVALID",
          message: error.message,
          status: 400,
        });
      }
      throw error;
    }
  }

  async capabilities(partnerId: string) {
    await this.partner(partnerId);
    return {
      apiVersion: "v1",
      currency: "NPR",
      settlementMethods: ["PARTNER_ACCOUNT"],
      payments: [],
      notifications: ["EMAIL", "WHATSAPP"],
      connectivity: {
        available: (await this.connectivity.health()).ok,
      },
      idempotencyRequiredForMutations: true,
      outboundWebhooks: true,
    };
  }

  async plans(partnerId: string, country?: string) {
    await this.partner(partnerId);
    const rows = await this.prisma.plan.findMany({
      where: {
        status: "ACTIVE",
        country: {
          active: true,
          isoCode: {
            ...(RESTRICTED_PLAN_COUNTRY_CODES.length
              ? { notIn: [...RESTRICTED_PLAN_COUNTRY_CODES] }
              : {}),
            ...(country ? { equals: country.toUpperCase() } : {}),
          },
        },
      },
      include: { country: true },
      orderBy: [{ country: { name: "asc" } }, { sellingPrice: "asc" }],
    });
    return rows.map((plan) => {
      const publicAmountPaisa = Math.round(Number(plan.sellingPrice) * 100);
      return {
        id: plan.id,
        countryCode: plan.country.isoCode,
        countryName: plan.country.name,
        name: plan.name,
        dataAllowance: plan.dataAllowance,
        validityDays: plan.validityDays,
        coverage: plan.coverage,
        destination: {
          countryCode: plan.country.isoCode,
          countryName: plan.country.name,
        },
        price: { amountPaisa: publicAmountPaisa, currency: "NPR" },
        requiredDocuments: this.requiredDocuments(plan.country.isoCode),
        availability: "AVAILABLE",
        compatibilityDisclaimer:
          "The traveler must confirm that the destination device supports eSIM before purchase.",
        refundSummary:
          "Refund eligibility depends on payment, review, provisioning, and activation status.",
        updatedAt: plan.updatedAt,
        currency: "NPR",
      };
    });
  }

  async createUploadSessions(partnerId: string, input: UploadSessionInput) {
    await this.partner(partnerId);
    const activeExternalOrderKey = `${partnerId}:${input.externalOrderId}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000);
    const config = await this.prisma.platformConfiguration.upsert({
      where: { id: "platform" },
      update: {},
      create: { id: "platform" },
    });
    const checkoutReleaseAt = new Date(
      now.getTime() + config.ocrCheckoutWaitMs,
    );
    const verificationId = randomUUID();
    const create = async () =>
      this.prisma.$transaction(async (tx) => {
        const existing = await tx.partnerDocumentVerification.findUnique({
          where: { activeExternalOrderKey },
          include: { documents: true },
        });
        if (existing) {
          const resumable =
            !existing.consumedAt &&
            existing.expiresAt > now &&
            !["EXPIRED", "INVALID", "CONSUMED"].includes(existing.status);
          if (resumable)
            return await this.uploadSessionResponse(existing, true);
          await tx.partnerDocumentVerification.update({
            where: { id: existing.id },
            data: {
              activeExternalOrderKey: null,
              ...(existing.expiresAt <= now ? { status: "EXPIRED" } : {}),
            },
          });
        }
        await tx.partnerDocumentVerification.create({
          data: {
            id: verificationId,
            partnerId,
            externalOrderId: input.externalOrderId,
            activeExternalOrderKey,
            travelerSnapshot: this.travelerData(
              input.traveler,
            ) as unknown as Prisma.InputJsonValue,
            expiresAt,
            reviewPolicy: config.documentReviewPolicy,
            checkoutReleaseAt,
            ...(config.documentReviewPolicy === "MANUAL_REVIEW"
              ? { status: "MANUAL_REVIEW" }
              : config.documentReviewPolicy === "NO_REVIEW"
                ? { status: "SKIPPED" }
                : {}),
          },
        });
        const items = [];
        for (const document of input.documents) {
          const id = randomUUID();
          const signed = await this.storage.createPartnerDocumentUpload(
            id,
            document.type as unknown as SharedDocumentType,
            document.contentType,
          );
          const intent = await tx.partnerDocumentUploadIntent.create({
            data: {
              id,
              partnerId,
              verificationId,
              externalOrderId: input.externalOrderId,
              type: document.type,
              fileName: document.fileName,
              contentType: document.contentType,
              declaredSizeBytes: document.sizeBytes,
              privateAssetId: signed.assetId,
              expiresAt,
            },
          });
          items.push({
            id: intent.id,
            type: intent.type,
            fileName: intent.fileName,
            expiresAt: intent.expiresAt,
            upload: signed.upload,
          });
        }
        return {
          verificationId,
          externalOrderId: input.externalOrderId,
          status:
            config.documentReviewPolicy === "MANUAL_REVIEW"
              ? "MANUAL_REVIEW"
              : config.documentReviewPolicy === "NO_REVIEW"
                ? "SKIPPED"
                : "AWAITING_UPLOAD",
          expiresAt,
          checkoutReleaseAt,
          documents: items,
          resumed: false,
        };
      });
    try {
      return await create();
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      )
        throw error;
      const existing = await this.prisma.partnerDocumentVerification.findUnique(
        {
          where: { activeExternalOrderKey },
          include: { documents: true },
        },
      );
      if (!existing) throw error;
      return this.uploadSessionResponse(existing, true);
    }
  }

  private async uploadSessionResponse(
    verification: {
      id: string;
      externalOrderId: string;
      status: string;
      expiresAt: Date;
      checkoutReleaseAt: Date | null;
      documents: Array<{
        id: string;
        type: DocumentType;
        fileName: string;
        contentType: string;
        expiresAt: Date;
      }>;
    },
    resumed: boolean,
  ) {
    return {
      verificationId: verification.id,
      externalOrderId: verification.externalOrderId,
      status: verification.status,
      expiresAt: verification.expiresAt,
      checkoutReleaseAt: verification.checkoutReleaseAt,
      resumed,
      documents: await Promise.all(
        verification.documents.map(async (document) => ({
          id: document.id,
          type: document.type,
          fileName: document.fileName,
          expiresAt: document.expiresAt,
          upload: (
            await this.storage.createPartnerDocumentUpload(
              document.id,
              document.type as unknown as SharedDocumentType,
              document.contentType,
            )
          ).upload,
        })),
      ),
    };
  }

  async documentVerification(partnerId: string, verificationId: string) {
    const verification =
      await this.prisma.partnerDocumentVerification.findFirst({
        where: { id: verificationId, partnerId },
        include: { documents: true },
      });
    if (!verification)
      throw new NotFoundException({
        code: "DOCUMENT_VERIFICATION_NOT_FOUND",
        message: "Document verification not found",
      });
    const allRequiredUploadsConfirmed = [
      DocumentType.PASSPORT,
      DocumentType.TICKET,
    ].every((type) =>
      verification.documents.some(
        (document) => document.type === type && document.uploadVerified,
      ),
    );
    const draftCreationAllowed =
      allRequiredUploadsConfirmed &&
      verification.status !== "EXPIRED" &&
      verification.failureCode !== "DOCUMENTS_REJECTED";
    const linkedOrder = verification.consumedOrderId
      ? await this.prisma.order.findUnique({
          where: { id: verification.consumedOrderId },
          select: {
            status: true,
            documentReviewPolicy: true,
            documentReviewStatus: true,
          },
        })
      : null;
    const fulfillmentAllowed = linkedOrder
      ? linkedOrder.status === OrderStatus.REVIEW_PENDING &&
        ((linkedOrder.documentReviewPolicy === "AUTO_OCR" &&
          ["VERIFIED", "MANUALLY_APPROVED"].includes(
            linkedOrder.documentReviewStatus,
          )) ||
          (linkedOrder.documentReviewPolicy === "MANUAL_REVIEW" &&
            linkedOrder.documentReviewStatus === "MANUALLY_APPROVED") ||
          (linkedOrder.documentReviewPolicy === "NO_REVIEW" &&
            linkedOrder.documentReviewStatus === "SKIPPED"))
      : (verification.reviewPolicy === "AUTO_OCR" &&
          verification.status === "VERIFIED") ||
        (verification.reviewPolicy === "NO_REVIEW" &&
          verification.status === "SKIPPED");
    return {
      id: verification.id,
      externalOrderId: verification.externalOrderId,
      status: verification.status,
      reviewPolicy: verification.reviewPolicy,
      failureCode: verification.failureCode,
      expiresAt: verification.expiresAt,
      consumedAt: verification.consumedAt,
      linkedOrderId: verification.consumedOrderId,
      requiredDocuments: [DocumentType.PASSPORT, DocumentType.TICKET],
      draftCreationAllowed,
      orderCreationAllowed: draftCreationAllowed,
      fulfillmentAllowed,
      documents: verification.documents.map((document) => ({
        id: document.id,
        type: document.type,
        uploadVerified: document.uploadVerified,
        status: document.verificationStatus,
        code: document.verificationCode,
        verifiedAt: document.verifiedAt,
        replacementEligible:
          Boolean(verification.consumedOrderId) &&
          verification.failureCode !== "DOCUMENTS_REJECTED" &&
          ["INVALID", "MANUAL_REVIEW", "REUPLOAD_REQUIRED"].includes(
            verification.status,
          ) &&
          (
            [DocumentType.PASSPORT, DocumentType.TICKET] as DocumentType[]
          ).includes(document.type),
      })),
    };
  }

  async confirmVerificationDocument(
    partnerId: string,
    verificationId: string,
    documentId: string,
  ) {
    const verification =
      await this.prisma.partnerDocumentVerification.findFirst({
        where: { id: verificationId, partnerId },
        include: { documents: true },
      });
    if (!verification)
      throw new NotFoundException({
        code: "DOCUMENT_VERIFICATION_NOT_FOUND",
        message: "Document verification not found",
      });
    const document = verification.documents.find(
      (item) => item.id === documentId,
    );
    if (!document)
      throw new NotFoundException({
        code: "PARTNER_DOCUMENT_NOT_FOUND",
        message: "Document not found",
      });
    if (!document.uploadVerified) {
      const asset = await this.verifyUploadedDocument(document.privateAssetId);
      if (
        asset.bytes !== document.declaredSizeBytes ||
        !this.formatMatchesContentType(asset.format ?? "", document.contentType)
      )
        throw new ApiException({
          code: "UPLOAD_DECLARATION_MISMATCH",
          message:
            "Uploaded bytes do not match the declared size or content type",
          status: 422,
        });
      await this.prisma.partnerDocumentUploadIntent.update({
        where: { id: document.id },
        data: { uploadVerified: true, verificationStatus: "UPLOADED" },
      });
      if (verification.consumedOrderId)
        await this.prisma.$transaction([
          this.prisma.travelerDocument.updateMany({
            where: {
              orderId: verification.consumedOrderId,
              type: document.type,
            },
            data: {
              fileName: document.fileName,
              privateAssetId: document.privateAssetId,
              uploadVerified: true,
              status: DocumentStatus.PENDING,
              ...(document.type === DocumentType.PASSPORT
                ? {
                    passportVerificationStatus: null,
                    passportVerificationMethod: null,
                    passportMatchedFields: Prisma.DbNull,
                    passportConfidence: null,
                    passportVerifiedAt: null,
                  }
                : {}),
            },
          }),
          this.prisma.order.update({
            where: { id: verification.consumedOrderId },
            data: {
              status: OrderStatus.REVIEW_PENDING,
              documentReviewStatus:
                verification.reviewPolicy === "AUTO_OCR"
                  ? "OCR_PENDING"
                  : verification.reviewPolicy === "MANUAL_REVIEW"
                    ? "MANUAL_REVIEW"
                    : "SKIPPED",
              version: { increment: 1 },
            },
          }),
        ]);
    }
    const remaining = await this.prisma.partnerDocumentUploadIntent.count({
      where: { verificationId, uploadVerified: false },
    });
    if (remaining > 0)
      return {
        id: document.id,
        uploadVerified: true,
        verificationQueued: false,
        remaining,
      };
    if (verification.reviewPolicy !== "AUTO_OCR") {
      const status =
        verification.reviewPolicy === "NO_REVIEW" ? "SKIPPED" : "MANUAL_REVIEW";
      await this.prisma.partnerDocumentVerification.update({
        where: { id: verificationId },
        data: { status, failureCode: null },
      });
      if (verification.consumedOrderId) {
        await this.prisma.order.update({
          where: { id: verification.consumedOrderId },
          data: {
            status: OrderStatus.REVIEW_PENDING,
            documentReviewStatus: status,
            version: { increment: 1 },
          },
        });
        if (status === "SKIPPED")
          await this.prisma.travelerDocument.updateMany({
            where: {
              orderId: verification.consumedOrderId,
              type: { in: [DocumentType.PASSPORT, DocumentType.TICKET] },
            },
            data: { status: DocumentStatus.APPROVED },
          });
      }
      return {
        id: document.id,
        uploadVerified: true,
        verificationQueued: false,
        remaining: 0,
        status,
      };
    }
    if (verification.consumedOrderId && document.type === DocumentType.TICKET) {
      const verifiedPassport = await this.prisma.travelerDocument.findFirst({
        where: {
          orderId: verification.consumedOrderId,
          type: DocumentType.PASSPORT,
          status: DocumentStatus.APPROVED,
          passportVerificationStatus: "VERIFIED",
        },
      });
      if (verifiedPassport) {
        await this.prisma.$transaction([
          this.prisma.partnerDocumentUploadIntent.update({
            where: { id: document.id },
            data: { verificationStatus: "VERIFIED", verifiedAt: new Date() },
          }),
          this.prisma.partnerDocumentVerification.update({
            where: { id: verificationId },
            data: { status: "VERIFIED", failureCode: null },
          }),
          this.prisma.travelerDocument.updateMany({
            where: {
              orderId: verification.consumedOrderId,
              type: DocumentType.TICKET,
            },
            data: { status: DocumentStatus.APPROVED },
          }),
          this.prisma.order.update({
            where: { id: verification.consumedOrderId },
            data: {
              status: OrderStatus.REVIEW_PENDING,
              documentReviewStatus: "VERIFIED",
              version: { increment: 1 },
            },
          }),
        ]);
        return {
          id: document.id,
          uploadVerified: true,
          verificationQueued: false,
          remaining: 0,
          status: "VERIFIED",
        };
      }
    }
    await this.prisma.partnerDocumentVerification.updateMany({
      where: { id: verificationId, status: "AWAITING_UPLOAD" },
      data: { status: "PROCESSING" },
    });
    try {
      await this.queues.add(
        QUEUES.documents,
        "verify-partner-documents",
        { verificationId },
        `document-verification-${verificationId}`,
        ocrJobOptions(),
      );
    } catch (error) {
      await this.prisma.partnerDocumentVerification.update({
        where: { id: verificationId },
        data: { status: "PROCESSING", failureCode: "QUEUE_UNAVAILABLE" },
      });
      this.logger.error(
        `Could not queue document verification ${verificationId}: ${error instanceof Error ? error.message : "unknown"}`,
      );
      return {
        id: document.id,
        uploadVerified: true,
        verificationQueued: false,
        manualReview: false,
        retrying: true,
        remaining: 0,
      };
    }
    return {
      id: document.id,
      uploadVerified: true,
      verificationQueued: true,
      remaining: 0,
    };
  }

  async declareDocumentReplacement(
    partnerId: string,
    orderId: string,
    input: {
      type: DocumentType;
      fileName: string;
      contentType: string;
      sizeBytes: number;
    },
  ) {
    if (
      !(
        [DocumentType.PASSPORT, DocumentType.TICKET] as DocumentType[]
      ).includes(input.type)
    )
      throw new ApiException({
        code: "DOCUMENT_REPLACEMENT_NOT_ALLOWED",
        message: "Only a required passport or ticket can be replaced",
        status: 400,
      });
    const order = await this.prisma.order.findFirst({
      where: {
        id: orderId,
        partnerId,
        status: {
          in: [OrderStatus.REVIEW_PENDING, OrderStatus.AWAITING_CUSTOMER],
        },
      },
      include: { documents: true },
    });
    if (!order)
      throw new ApiException({
        code: "PARTNER_ORDER_INVALID_STATE",
        message: "Only an uncharged pending order can accept replacements",
        status: 409,
      });
    const orderDocument = order.documents.find(
      (document) => document.type === input.type,
    );
    if (
      !orderDocument ||
      orderDocument.status !== DocumentStatus.REUPLOAD_REQUIRED
    )
      throw new ApiException({
        code: "DOCUMENT_REPLACEMENT_NOT_REQUESTED",
        message: "This document was not requested for replacement",
        status: 409,
      });
    const verification =
      await this.prisma.partnerDocumentVerification.findFirst({
        where: { partnerId, consumedOrderId: orderId },
        include: { documents: true },
      });
    if (!verification || verification.expiresAt <= new Date())
      throw new GoneException({
        code: "VERIFICATION_EXPIRED",
        message: "Document verification has expired",
      });
    const intent = verification.documents.find(
      (document) => document.type === input.type,
    );
    if (!intent)
      throw new NotFoundException({
        code: "PARTNER_DOCUMENT_NOT_FOUND",
        message: "Document not found",
      });
    const signed = await this.storage.createPartnerDocumentUpload(
      intent.id,
      input.type as unknown as SharedDocumentType,
      input.contentType,
    );
    await this.prisma.$transaction([
      this.prisma.partnerDocumentUploadIntent.update({
        where: { id: intent.id },
        data: {
          fileName: input.fileName,
          contentType: input.contentType,
          declaredSizeBytes: input.sizeBytes,
          privateAssetId: signed.assetId,
          uploadVerified: false,
          verificationStatus: "AWAITING_UPLOAD",
          verificationCode: null,
          verificationResult: {
            replacement: true,
            previousFileName: intent.fileName,
            previousStatus: intent.verificationStatus,
            previousCode: intent.verificationCode,
            previousVerifiedAt: intent.verifiedAt?.toISOString() ?? null,
            declaredAt: new Date().toISOString(),
          },
          verifiedAt: null,
        },
      }),
      this.prisma.partnerDocumentVerification.update({
        where: { id: verification.id },
        data: { status: "AWAITING_UPLOAD", failureCode: null },
      }),
    ]);
    return {
      verificationId: verification.id,
      orderId,
      documentId: intent.id,
      type: input.type,
      expiresAt: verification.expiresAt,
      upload: signed.upload,
    };
  }

  async confirmDocumentReplacement(
    partnerId: string,
    orderId: string,
    documentId: string,
  ) {
    const verification =
      await this.prisma.partnerDocumentVerification.findFirst({
        where: { partnerId, consumedOrderId: orderId },
        select: { id: true },
      });
    if (!verification)
      throw new NotFoundException({
        code: "DOCUMENT_VERIFICATION_NOT_FOUND",
        message: "Document verification not found",
      });
    return this.confirmVerificationDocument(
      partnerId,
      verification.id,
      documentId,
    );
  }

  async createCompleteOrder(
    partnerId: string,
    input: CompleteOrderInput,
    requestContext: { ipAddress: string; userAgent: string },
  ) {
    const partner = await this.partner(partnerId);
    const settlement = input.settlement ?? {
      method: "PARTNER_ACCOUNT" as const,
    };
    if (settlement.method === "HOSTED_PAYMENT")
      throw this.hostedPaymentDeprecated();
    const settlementMethod = PartnerSettlementMethod.PARTNER_ACCOUNT;
    const plan = await this.prisma.plan.findFirst({
      where: {
        id: input.planId,
        status: "ACTIVE",
        country: {
          active: true,
          ...(RESTRICTED_PLAN_COUNTRY_CODES.length
            ? { isoCode: { notIn: [...RESTRICTED_PLAN_COUNTRY_CODES] } }
            : {}),
        },
      },
      include: { country: true },
    });
    if (!plan)
      throw new BadRequestException({
        code: "PLAN_UNAVAILABLE",
        message: "Plan is unavailable",
      });
    if (input.topUpMobile)
      return this.createCompleteTopUpOrder(
        partner,
        { ...input, topUpMobile: input.topUpMobile },
        plan,
        requestContext,
      );
    if (!input.documentVerificationId)
      throw new BadRequestException({
        code: "DOCUMENT_VERIFICATION_REQUIRED",
        message: "Document verification is required for an initial purchase",
      });
    const verification =
      await this.prisma.partnerDocumentVerification.findFirst({
        where: { id: input.documentVerificationId, partnerId },
        include: { documents: true },
      });
    if (!verification || verification.externalOrderId !== input.externalOrderId)
      throw new BadRequestException({
        code: "VERIFICATION_ORDER_MISMATCH",
        message: "Document verification does not match this order",
      });
    if (verification.expiresAt <= new Date())
      throw new GoneException({
        code: "VERIFICATION_EXPIRED",
        message: "Document verification has expired",
      });
    if (verification.consumedAt)
      throw new ConflictException({
        code: "VERIFICATION_ALREADY_CONSUMED",
        message: "Document verification was already consumed",
      });
    if (
      verification.status === "EXPIRED" ||
      (verification.status === "INVALID" &&
        verification.failureCode === "DOCUMENTS_REJECTED")
    )
      throw new ApiException({
        code: "DOCUMENT_REUPLOAD_REQUIRED",
        message: "Documents are invalid or expired; upload replacements",
        status: 422,
      });
    const required = this.requiredDocuments(plan.country.isoCode);
    const suppliedTypes = new Set(
      verification.documents.map((item) => item.type),
    );
    const missing = required.filter((type) => !suppliedTypes.has(type));
    if (missing.length)
      throw new BadRequestException({
        code: "DOCUMENT_REQUIRED",
        message: `Missing required documents: ${missing.map(documentTypeLabel).join(", ")}`,
      });
    const intents = verification.documents;
    if (intents.some((intent) => !intent.uploadVerified))
      throw new ApiException({
        code: "DOCUMENT_UPLOAD_NOT_CONFIRMED",
        message:
          "Confirm every required document upload before placing the order",
        status: 409,
      });
    const uploadIds = intents.map((item) => item.id);
    const amountPaisa = Math.round(Number(plan.sellingPrice) * 100);
    const orderId = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      const duplicate = await tx.order.findFirst({
        where: { partnerId, externalOrderId: input.externalOrderId },
      });
      if (duplicate)
        throw new ApiException({
          code: "EXTERNAL_ORDER_ID_EXISTS",
          message: "External order ID already exists",
          status: 409,
        });
      const consumable = await tx.partnerDocumentUploadIntent.updateMany({
        where: {
          id: { in: uploadIds },
          partnerId,
          externalOrderId: input.externalOrderId,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date(), consumedOrderId: orderId },
      });
      if (consumable.count !== uploadIds.length)
        throw new ApiException({
          code: "UPLOAD_ALREADY_CONSUMED",
          message: "Document upload was already consumed",
          status: 409,
        });
      const consumedVerification =
        await tx.partnerDocumentVerification.updateMany({
          where: {
            id: verification.id,
            partnerId,
            status: { not: "EXPIRED" },
            consumedAt: null,
            expiresAt: { gt: new Date() },
          },
          data: {
            consumedAt: new Date(),
            consumedOrderId: orderId,
            activeExternalOrderKey: null,
          },
        });
      if (consumedVerification.count !== 1)
        throw new ApiException({
          code: "VERIFICATION_ALREADY_CONSUMED",
          message: "Document verification was already consumed",
          status: 409,
        });
      const currentVerification =
        await tx.partnerDocumentVerification.findUnique({
          where: { id: verification.id },
          include: { documents: true },
        });
      if (!currentVerification)
        throw new ApiException({
          code: "DOCUMENT_VERIFICATION_NOT_FOUND",
          message: "Document verification not found",
          status: 404,
        });
      if (
        currentVerification.status === "EXPIRED" ||
        (currentVerification.status === "INVALID" &&
          currentVerification.failureCode === "DOCUMENTS_REJECTED")
      )
        throw new ApiException({
          code: "DOCUMENTS_REJECTED",
          message: "The documented purchase was rejected",
          status: 422,
        });
      const currentIntents = currentVerification.documents;
      const partnerCustomer = await this.ensurePartnerCustomer(
        tx,
        partner.code,
        partnerId,
        input.externalCustomerId,
      );
      const status = ["INVALID", "REUPLOAD_REQUIRED"].includes(
        currentVerification.status,
      )
        ? OrderStatus.AWAITING_CUSTOMER
        : OrderStatus.REVIEW_PENDING;
      const pricingSnapshot = {
        pricingSource: "PUBLIC_CATALOGUE",
        planId: plan.id,
        name: plan.name,
        countryCode: plan.country.isoCode,
        dataAllowance: plan.dataAllowance,
        validityDays: plan.validityDays,
        amountPaisa,
        currency: "NPR",
        capturedAt: new Date().toISOString(),
      };
      await tx.order.create({
        data: {
          id: orderId,
          orderNumber: `VC-${new Date().getUTCFullYear()}-${orderId.slice(0, 8).toUpperCase()}`,
          channel: OrderChannel.PARTNER_API,
          customerId: partnerCustomer.customerId,
          partnerId,
          partnerCustomerId: partnerCustomer.id,
          externalOrderId: input.externalOrderId,
          partnerSettlementMethod: settlementMethod,
          partnerPaymentProvider: null,
          partnerMetadata: input.metadata ?? Prisma.JsonNull,
          planId: plan.id,
          status,
          documentReviewPolicy: currentVerification.reviewPolicy,
          documentReviewStatus:
            currentVerification.status === "VERIFIED"
              ? "VERIFIED"
              : currentVerification.status === "MANUAL_REVIEW"
                ? "MANUAL_REVIEW"
                : currentVerification.status === "SKIPPED"
                  ? "SKIPPED"
                  : ["INVALID", "REUPLOAD_REQUIRED"].includes(
                        currentVerification.status,
                      )
                    ? "REUPLOAD_REQUIRED"
                    : "OCR_BACKGROUND",
          subtotal: amountPaisa / 100,
          totalAmount: amountPaisa / 100,
          pricingSnapshot,
          compatibilityAcceptedAt: new Date(input.consent.acceptedAt),
          traveler: {
            create:
              currentVerification.travelerSnapshot as Prisma.TravelerUncheckedCreateWithoutOrderInput,
          },
          documents: {
            create: currentIntents.map((intent) => {
              const result = intent.verificationResult as {
                method?: string;
                matchedFields?: unknown;
                confidence?: number | null;
              } | null;
              return {
                type: intent.type,
                fileName: intent.fileName,
                privateAssetId: intent.privateAssetId,
                uploadVerified: true,
                status:
                  currentVerification.status === "VERIFIED"
                    ? DocumentStatus.APPROVED
                    : ["INVALID", "REUPLOAD_REQUIRED"].includes(
                          intent.verificationStatus,
                        )
                      ? DocumentStatus.REUPLOAD_REQUIRED
                      : DocumentStatus.PENDING,
                ...(intent.type === DocumentType.PASSPORT &&
                currentVerification.status === "VERIFIED"
                  ? {
                      passportVerificationStatus: "VERIFIED",
                      passportVerificationMethod: result?.method ?? null,
                      passportMatchedFields:
                        result?.matchedFields as Prisma.InputJsonValue,
                      passportConfidence: result?.confidence ?? null,
                      passportVerifiedAt: intent.verifiedAt,
                    }
                  : {}),
              };
            }),
          },
          events: { create: { fromStatus: null, toStatus: status } },
        },
      });
      await tx.customerConsent.createMany({
        data: ["COMPATIBILITY", "TERMS", "PRIVACY"].map((type) => ({
          customerId: partnerCustomer.customerId,
          type,
          version: "1.0",
          ipAddress: requestContext.ipAddress,
          userAgent: requestContext.userAgent.slice(0, 500),
          acceptedAt: new Date(input.consent.acceptedAt),
        })),
      });
      await this.createEvent(
        tx,
        partnerId,
        orderId,
        status === OrderStatus.AWAITING_CUSTOMER
          ? "order.awaiting_customer"
          : "order.review_pending",
        orderId,
        {
          orderId,
          externalOrderId: input.externalOrderId,
          status,
          fulfillmentStatus:
            status === OrderStatus.AWAITING_CUSTOMER
              ? "REUPLOAD_REQUIRED"
              : "BLOCKED_ON_DOCUMENTS",
          version: 0,
          amountPaisa,
          currency: "NPR",
        },
      );
    });
    const handoff = await Promise.allSettled([
      this.applicationOrders.refreshFromPersistence(orderId),
      this.partnerWebhooks.enqueuePending(),
    ]);
    for (const result of handoff)
      if (result.status === "rejected")
        this.logger.error(
          result.reason instanceof Error
            ? result.reason.message
            : "Partner order post-commit handoff failed",
        );
    return this.order(partnerId, orderId);
  }

  async finalizeOrder(partnerId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, partnerId },
      include: {
        plan: { include: { country: true } },
        documents: true,
      },
    });
    if (!order)
      throw new ApiException({
        code: "PARTNER_ORDER_NOT_FOUND",
        message: "Order not found",
        status: 404,
      });
    if (
      (
        [
          OrderStatus.APPROVED,
          OrderStatus.PROVISIONING,
          OrderStatus.QR_READY,
          OrderStatus.ACTIVATION_ATTENTION,
          OrderStatus.COMPLETED,
        ] as OrderStatus[]
      ).includes(order.status)
    )
      return this.order(partnerId, orderId);
    if (order.status === OrderStatus.CANCELLED)
      throw new ApiException({
        code: "DOCUMENTS_REJECTED",
        message: "The documented purchase was rejected and cannot be finalized",
        status: 422,
      });
    if (order.status !== OrderStatus.REVIEW_PENDING)
      throw new ApiException({
        code: "VERIFICATION_NOT_READY",
        message: "Document verification is not complete",
        status: 409,
      });

    const fulfillmentAllowed =
      (order.documentReviewPolicy === "AUTO_OCR" &&
        ["VERIFIED", "MANUALLY_APPROVED"].includes(
          order.documentReviewStatus,
        )) ||
      (order.documentReviewPolicy === "MANUAL_REVIEW" &&
        order.documentReviewStatus === "MANUALLY_APPROVED") ||
      (order.documentReviewPolicy === "NO_REVIEW" &&
        order.documentReviewStatus === "SKIPPED");
    if (!fulfillmentAllowed)
      throw new ApiException({
        code:
          order.documentReviewStatus === "REUPLOAD_REQUIRED"
            ? "DOCUMENT_REUPLOAD_REQUIRED"
            : "VERIFICATION_NOT_READY",
        message:
          order.documentReviewStatus === "REUPLOAD_REQUIRED"
            ? "A required document must be replaced before finalization"
            : "Document verification is not complete",
        status: order.documentReviewStatus === "REUPLOAD_REQUIRED" ? 422 : 409,
      });
    const requiredDocumentsApproved = [
      DocumentType.PASSPORT,
      DocumentType.TICKET,
    ].every((type) =>
      order.documents.some(
        (document) =>
          document.type === type &&
          document.uploadVerified &&
          document.status === DocumentStatus.APPROVED,
      ),
    );
    if (!requiredDocumentsApproved)
      throw new ApiException({
        code: "VERIFICATION_NOT_READY",
        message: "Passport and ticket are not both approved",
        status: 409,
      });

    const activePlan = await this.prisma.plan.findFirst({
      where: {
        id: order.planId,
        status: "ACTIVE",
        country: {
          active: true,
          ...(RESTRICTED_PLAN_COUNTRY_CODES.length
            ? { isoCode: { notIn: [...RESTRICTED_PLAN_COUNTRY_CODES] } }
            : {}),
        },
      },
    });
    if (!activePlan)
      throw new ApiException({
        code: "PLAN_UNAVAILABLE",
        message: "Plan is unavailable",
        status: 409,
      });
    await this.applicationOrders.assertInventoryAvailableForNewOrder();

    const amountPaisa = Math.round(Number(order.totalAmount) * 100);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.updateMany({
        where: {
          id: order.id,
          partnerId,
          version: order.version,
          status: OrderStatus.REVIEW_PENDING,
          documentReviewStatus: order.documentReviewStatus,
        },
        data: { status: OrderStatus.APPROVED, version: { increment: 1 } },
      });
      if (updated.count !== 1)
        throw new ApiException({
          code: "ORDER_CONFLICT",
          message: "Order changed while finalizing; reload and retry",
          status: 409,
        });
      await this.debitAccount(
        tx,
        partnerId,
        order.id,
        amountPaisa,
        order.externalOrderId ?? order.id,
      );
      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          fromStatus: OrderStatus.REVIEW_PENDING,
          toStatus: OrderStatus.APPROVED,
          reason: "Partner explicitly finalized verified documents",
        },
      });
      await this.createEvent(
        tx,
        partnerId,
        order.id,
        "order.accepted",
        order.id,
        {
          orderId: order.id,
          externalOrderId: order.externalOrderId,
          status: OrderStatus.APPROVED,
          fulfillmentStatus: "PENDING",
          amountPaisa,
          currency: "NPR",
        },
      );
      await tx.outboxMessage.create({
        data: {
          dedupeKey: `partner-fulfillment-${order.id}`,
          topic: "provisioning",
          jobName: "advance-approved-order",
          payload: { orderId: order.id },
          orderId: order.id,
        },
      });
    });

    await this.applicationOrders.refreshFromPersistence(order.id);
    await Promise.allSettled([
      this.partnerWebhooks.enqueuePending(),
      this.applicationOrders.approveToProvisioning(
        order.id,
        "Partner finalized verified order",
      ),
    ]);
    return this.order(partnerId, order.id);
  }

  private async createCompleteTopUpOrder(
    partner: { id: string; code: string },
    input: CompleteOrderInput & { topUpMobile: string },
    plan: Prisma.PlanGetPayload<{ include: { country: true } }>,
    requestContext: { ipAddress: string; userAgent: string },
  ) {
    const target = await this.applicationOrders.resolveSubscriber(
      input.topUpMobile,
    );
    const inventory = target?.inventory;
    if (!inventory || !target)
      throw new ApiException({
        code: "TOPUP_NOT_ELIGIBLE",
        message:
          "This number cannot be used for a top-up with the selected plan. Create a documented initial purchase only after customer consent.",
        status: 422,
      });
    const existingPartnerCustomer =
      await this.prisma.partnerCustomer.findUnique({
        where: {
          partnerId_externalCustomerId: {
            partnerId: partner.id,
            externalCustomerId: input.externalCustomerId,
          },
        },
        select: { customerId: true },
      });
    if (
      !existingPartnerCustomer ||
      !target.customerId ||
      existingPartnerCustomer.customerId !== target.customerId
    )
      throw new ApiException({
        code: "TOPUP_CUSTOMER_MISMATCH",
        message:
          "This eSIM is not attached to the supplied partner customer. Use the same externalCustomerId as the original purchase.",
        status: 422,
      });
    const eligibility = await this.applicationOrders.checkTopUpEligibility(
      input.topUpMobile,
      plan.id,
    );
    if (!eligibility.allowed)
      throw new ApiException({
        code: "TOPUP_NOT_ELIGIBLE",
        message:
          eligibility.errorMessage ??
          "This eSIM cannot subscribe to the selected plan.",
        status: 422,
      });

    const amountPaisa = Math.round(Number(plan.sellingPrice) * 100);
    const orderId = randomUUID();
    const acceptedAt = new Date(input.consent.acceptedAt);
    await this.prisma.$transaction(async (tx) => {
      const duplicate = await tx.order.findFirst({
        where: {
          partnerId: partner.id,
          externalOrderId: input.externalOrderId,
        },
      });
      if (duplicate)
        throw new ApiException({
          code: "EXTERNAL_ORDER_ID_EXISTS",
          message: "External order ID already exists",
          status: 409,
        });
      const partnerCustomer = await this.ensurePartnerCustomer(
        tx,
        partner.code,
        partner.id,
        input.externalCustomerId,
      );
      await tx.order.create({
        data: {
          id: orderId,
          orderNumber: `VC-${new Date().getUTCFullYear()}-${orderId.slice(0, 8).toUpperCase()}`,
          channel: OrderChannel.PARTNER_API,
          customerId: partnerCustomer.customerId,
          partnerId: partner.id,
          partnerCustomerId: partnerCustomer.id,
          externalOrderId: input.externalOrderId,
          partnerSettlementMethod: PartnerSettlementMethod.PARTNER_ACCOUNT,
          partnerPaymentProvider: null,
          partnerMetadata: input.metadata ?? Prisma.JsonNull,
          planId: plan.id,
          orderType: "TOPUP",
          status: OrderStatus.APPROVED,
          subtotal: amountPaisa / 100,
          totalAmount: amountPaisa / 100,
          pricingSnapshot: {
            pricingSource: "PUBLIC_CATALOGUE",
            planId: plan.id,
            name: plan.name,
            countryCode: plan.country.isoCode,
            dataAllowance: plan.dataAllowance,
            validityDays: plan.validityDays,
            amountPaisa,
            currency: "NPR",
            capturedAt: new Date().toISOString(),
            topUpMobile: input.topUpMobile,
            targetEsimId: inventory.id,
            ...(target.traveler?.email
              ? { topUpEmail: target.traveler.email }
              : {}),
          },
          compatibilityAcceptedAt: acceptedAt,
          events: {
            create: { fromStatus: null, toStatus: OrderStatus.APPROVED },
          },
        },
      });
      await tx.customerConsent.createMany({
        data: ["COMPATIBILITY", "TERMS", "PRIVACY"].map((type) => ({
          customerId: partnerCustomer.customerId,
          type,
          version: "1.0",
          ipAddress: requestContext.ipAddress,
          userAgent: requestContext.userAgent.slice(0, 500),
          acceptedAt,
        })),
      });
      await this.debitAccount(
        tx,
        partner.id,
        orderId,
        amountPaisa,
        input.externalOrderId,
      );
      await this.createEvent(
        tx,
        partner.id,
        orderId,
        "order.accepted",
        orderId,
        {
          orderId,
          externalOrderId: input.externalOrderId,
          status: OrderStatus.APPROVED,
          fulfillmentStatus: "PENDING",
          amountPaisa,
          currency: "NPR",
        },
      );
      await tx.outboxMessage.create({
        data: {
          dedupeKey: `partner-fulfillment-${orderId}`,
          topic: "provisioning",
          jobName: "advance-approved-order",
          payload: { orderId },
          orderId,
        },
      });
    });
    const handoff = await Promise.allSettled([
      this.applicationOrders.refreshFromPersistence(orderId),
      this.partnerWebhooks.enqueuePending(),
    ]);
    for (const result of handoff)
      if (result.status === "rejected")
        this.logger.error(
          result.reason instanceof Error
            ? result.reason.message
            : "Partner top-up post-commit handoff failed",
        );
    try {
      await this.applicationOrders.approveToProvisioning(
        orderId,
        "Partner top-up auto-approved",
      );
    } catch (error) {
      this.logger.error(
        `Partner top-up provision handoff failed for ${orderId}: ${
          error instanceof Error ? error.message : "unknown"
        }`,
      );
    }
    return this.order(partner.id, orderId);
  }

  async createQuote(
    partnerId: string,
    planId: string,
    settlementMethod: PartnerSettlementMethod,
  ) {
    void partnerId;
    void planId;
    void settlementMethod;
    throw new GoneException({
      code: "PARTNER_QUOTES_DEPRECATED",
      message:
        "Quotes are no longer available. Place a complete order instead (POST /partners/orders).",
    });
    /* Retained below for historical schema compatibility; no new quotes are created.
    const partner = await this.partner(partnerId);
    const allowed = this.stringArray(partner.allowedSettlementMethods);
    if (!allowed.includes(settlementMethod))
      throw new BadRequestException(
        "Settlement method is not enabled for partner",
      );
    const plan = (await this.plans(partnerId)).find(
      (item) => item.id === planId,
    );
    if (!plan) throw new BadRequestException("Invalid or inactive plan");
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    return this.prisma.partnerQuote.create({
      data: {
        partnerId,
        planId,
        settlementMethod,
        wholesaleAmountPaisa: plan.price.amountPaisa,
        retailAmountPaisa: plan.price.amountPaisa,
        currency: "NPR",
        expiresAt,
        pricingSnapshot: {
          planId,
          name: plan.name,
          countryCode: plan.countryCode,
          dataAllowance: plan.dataAllowance,
          validityDays: plan.validityDays,
          wholesaleAmountPaisa: plan.price.amountPaisa,
          retailAmountPaisa: plan.price.amountPaisa,
          priceListVersion: null,
          pricingSource: "PUBLIC_CATALOGUE",
          currency: "NPR",
        },
      },
      select: {
        id: true,
        planId: true,
        settlementMethod: true,
        wholesaleAmountPaisa: true,
        retailAmountPaisa: true,
        currency: true,
        expiresAt: true,
      },
    }); */
  }

  async createOrder(partnerId: string, input: CreateOrderInput) {
    void partnerId;
    void input;
    throw new GoneException({
      code: "LEGACY_PARTNER_ORDER_DEPRECATED",
      message:
        "Quote-based orders are no longer available. Place a complete order instead (POST /partners/orders).",
    });
    /* Retained below for historical schema compatibility; no new quote orders are created.
    const result = await this.prisma.$transaction(async (tx) => {
      const quote = await tx.partnerQuote.findFirst({
        where: { id: input.quoteId, partnerId },
        include: { plan: true, partner: true },
      });
      if (!quote) throw new NotFoundException("Quote not found");
      if (
        quote.status !== PartnerQuoteStatus.ACTIVE ||
        quote.expiresAt <= new Date()
      )
        throw new BadRequestException("Quote is expired or unavailable");
      if (quote.plan.status !== "ACTIVE")
        throw new BadRequestException("Quoted plan is no longer active");
      const duplicate = await tx.order.findFirst({
        where: { partnerId, externalOrderId: input.externalOrderId },
      });
      if (duplicate)
        throw new ApiException({ code: "EXTERNAL_ORDER_ID_EXISTS", message: "External order ID already exists", status: 409 });
      const partnerCustomer = await this.ensurePartnerCustomer(
        tx,
        quote.partner.code,
        partnerId,
        input.externalCustomerId,
      );
      const amountPaisa =
        quote.settlementMethod === PartnerSettlementMethod.PARTNER_ACCOUNT
          ? quote.wholesaleAmountPaisa
          : quote.retailAmountPaisa;
      if (quote.settlementMethod === PartnerSettlementMethod.PARTNER_ACCOUNT)
        await this.reserveAccount(
          tx,
          partnerId,
          quote.wholesaleAmountPaisa,
          input.externalOrderId,
        );
      const id = randomUUID();
      const order = await tx.order.create({
        data: {
          id,
          orderNumber: `VC-${new Date().getUTCFullYear()}-${id.slice(0, 8).toUpperCase()}`,
          channel: OrderChannel.PARTNER_API,
          customerId: partnerCustomer.customerId,
          partnerId,
          partnerCustomerId: partnerCustomer.id,
          externalOrderId: input.externalOrderId,
          partnerQuoteId: quote.id,
          partnerSettlementMethod: quote.settlementMethod,
          partnerMetadata: input.metadata ?? Prisma.JsonNull,
          planId: quote.planId,
          status: OrderStatus.DRAFT,
          subtotal: amountPaisa / 100,
          totalAmount: amountPaisa / 100,
          pricingSnapshot: quote.pricingSnapshot as Prisma.InputJsonValue,
          compatibilityAcceptedAt: new Date(),
          events: { create: { fromStatus: null, toStatus: OrderStatus.DRAFT } },
        },
      });
      await tx.partnerQuote.update({
        where: { id: quote.id },
        data: { status: PartnerQuoteStatus.CONSUMED, consumedAt: new Date() },
      });
      await this.createEvent(
        tx,
        partnerId,
        order.id,
        "order.created",
        order.id,
        {
          orderId: order.id,
          externalOrderId: input.externalOrderId,
          status: order.status,
        },
      );
      return order;
    });
    await this.partnerWebhooks.enqueuePending();
    return this.order(partnerId, result.id); */
  }

  async listOrders(
    partnerId: string,
    input: {
      cursor?: string | undefined;
      status?: OrderStatus | undefined;
      externalOrderId?: string | undefined;
      limit?: number | undefined;
    },
  ) {
    const limit = Math.min(100, Math.max(1, input.limit ?? 25));
    const bound = decodeCursor(input.cursor);
    const rows = await this.prisma.order.findMany({
      where: {
        partnerId,
        ...(input.status ? { status: input.status } : {}),
        ...(input.externalOrderId
          ? { externalOrderId: input.externalOrderId }
          : {}),
        ...(bound
          ? {
              OR: [
                { createdAt: { lt: bound.createdAt } },
                { createdAt: bound.createdAt, id: { lt: bound.id } },
              ],
            }
          : {}),
      },
      include: PARTNER_ORDER_INCLUDE,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const more = rows.length > limit;
    const items = rows.slice(0, limit);
    return {
      items: items.map((order) => this.normalizeOrder(order)),
      nextCursor: more
        ? (encodeCursor(items.at(-1)?.createdAt, items.at(-1)?.id) ?? null)
        : null,
    };
  }

  async account(partnerId: string) {
    await this.partner(partnerId);
    const account = await this.prisma.partnerAccount.upsert({
      where: { partnerId },
      update: {},
      create: { partnerId },
    });
    const [debits, credits, refunds, adjustments, orders] = await Promise.all([
      this.prisma.partnerLedgerEntry.aggregate({
        where: {
          partnerId,
          type: {
            in: [PartnerLedgerEntryType.DEBIT, PartnerLedgerEntryType.CAPTURE],
          },
        },
        _sum: { amountPaisa: true },
      }),
      this.prisma.partnerLedgerEntry.aggregate({
        where: {
          partnerId,
          type: PartnerLedgerEntryType.CREDIT,
        },
        _sum: { amountPaisa: true },
      }),
      this.prisma.partnerLedgerEntry.aggregate({
        where: { partnerId, type: PartnerLedgerEntryType.REFUND },
        _sum: { amountPaisa: true },
      }),
      this.prisma.partnerLedgerEntry.aggregate({
        where: { partnerId, type: PartnerLedgerEntryType.ADJUSTMENT },
        _sum: { amountPaisa: true },
      }),
      this.prisma.order.findMany({
        where: { partnerId },
        select: { status: true, totalAmount: true },
      }),
    ]);
    const ordersByStatus = orders.reduce<Record<string, number>>(
      (result, order) => ({
        ...result,
        [order.status]: (result[order.status] ?? 0) + 1,
      }),
      {},
    );
    const totalOrderValuePaisa = orders.reduce(
      (total, order) => total + Math.round(Number(order.totalAmount) * 100),
      0,
    );
    return {
      currency: "NPR",
      balancePaisa: account.balancePaisa,
      availableBalancePaisa: account.balancePaisa,
      totalDebitsPaisa: debits._sum.amountPaisa ?? 0,
      totalCreditsPaisa: credits._sum.amountPaisa ?? 0,
      totalRefundedPaisa: refunds._sum.amountPaisa ?? 0,
      totalAdjustedPaisa: adjustments._sum.amountPaisa ?? 0,
      ordersCreated: orders.length,
      ordersByStatus,
      fulfilledOrders:
        (ordersByStatus.QR_READY ?? 0) + (ordersByStatus.COMPLETED ?? 0),
      failedOrders: ordersByStatus.PROVISIONING_FAILED ?? 0,
      totalOrderValuePaisa,
      averageOrderValuePaisa: orders.length
        ? Math.round(totalOrderValuePaisa / orders.length)
        : 0,
      updatedAt: account.updatedAt,
    };
  }

  async ledger(
    partnerId: string,
    input: {
      cursor?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      externalOrderId?: string | undefined;
      orderNumber?: string | undefined;
      reference?: string | undefined;
      type?: "CREDIT" | "DEBIT" | "REFUND" | "ADJUSTMENT" | undefined;
      limit?: number | undefined;
    },
  ) {
    await this.partner(partnerId);
    const limit = Math.min(100, Math.max(1, input.limit ?? 25));
    const bound = decodeCursor(input.cursor);
    const rows = await this.prisma.partnerLedgerEntry.findMany({
      where: {
        partnerId,
        ...(input.from || input.to
          ? {
              createdAt: {
                ...(input.from ? { gte: new Date(input.from) } : {}),
                ...(input.to ? { lte: new Date(input.to) } : {}),
              },
            }
          : {}),
        ...(input.externalOrderId || input.orderNumber
          ? {
              order: {
                ...(input.externalOrderId
                  ? { externalOrderId: input.externalOrderId }
                  : {}),
                ...(input.orderNumber
                  ? { orderNumber: input.orderNumber }
                  : {}),
              },
            }
          : {}),
        ...(input.reference
          ? { reference: { contains: input.reference, mode: "insensitive" } }
          : {}),
        ...(input.type ? { type: input.type as PartnerLedgerEntryType } : {}),
        ...(bound
          ? {
              OR: [
                { createdAt: { lt: bound.createdAt } },
                { createdAt: bound.createdAt, id: { lt: bound.id } },
              ],
            }
          : {}),
      },
      include: {
        order: {
          select: { id: true, externalOrderId: true, orderNumber: true },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const more = rows.length > limit;
    const items = rows.slice(0, limit);
    return {
      items: items.map((entry) => ({
        id: entry.id,
        type: entry.type,
        amountPaisa: entry.amountPaisa,
        balanceAfterPaisa: entry.balanceAfterPaisa,
        currency: "NPR",
        reference: entry.reference,
        order: entry.order,
        createdAt: entry.createdAt,
      })),
      nextCursor: more
        ? (encodeCursor(items.at(-1)?.createdAt, items.at(-1)?.id) ?? null)
        : null,
    };
  }

  async order(partnerId: string, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, partnerId },
      include: PARTNER_ORDER_INCLUDE,
    });
    if (!order)
      throw new ApiException({
        code: "PARTNER_ORDER_NOT_FOUND",
        message: "Order not found",
        status: 404,
      });
    return this.normalizeOrder(order);
  }

  async orderByExternalId(partnerId: string, externalOrderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { partnerId, externalOrderId },
      select: { id: true },
    });
    if (!order)
      throw new ApiException({
        code: "PARTNER_ORDER_NOT_FOUND",
        message: "Order not found",
        status: 404,
      });
    return this.order(partnerId, order.id);
  }

  async activationDetails(partnerId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, partnerId },
      include: {
        customerEsim: {
          include: { inventory: true, subscriptions: { take: 1 } },
        },
      },
    });
    if (!order)
      throw new ApiException({
        code: "PARTNER_ORDER_NOT_FOUND",
        message: "Order not found",
        status: 404,
      });
    if (
      order.status !== OrderStatus.QR_READY &&
      order.status !== OrderStatus.ACTIVATION_ATTENTION &&
      order.status !== OrderStatus.COMPLETED
    )
      throw new ApiException({
        code: "PARTNER_ORDER_NOT_READY",
        message:
          "Activation details are available once the eSIM is ready to use",
        status: 409,
      });
    if (!order.customerEsim)
      throw new ApiException({
        code: "PARTNER_ACTIVATION_UNAVAILABLE",
        message: "Activation details are not available yet",
        status: 404,
      });
    const subscription = order.customerEsim.subscriptions[0];
    return {
      orderId: order.id,
      externalOrderId: order.externalOrderId,
      status: order.status,
      fulfillmentStatus: this.fulfillmentStatus(order.status),
      documentStatus: order.documentReviewStatus,
      recoverability: order.operationalDisposition ?? null,
      iccid: order.customerEsim.inventory.iccid,
      msisdn: order.customerEsim.inventory.msisdn,
      smDpAddress: order.customerEsim.inventory.smDpAddress,
      activationCode: this.crypto.decrypt(
        order.customerEsim.qrPayloadEncrypted,
      ),
      activatedAt: order.activatedAt,
      expiresAt:
        subscription?.expiresAt ?? order.customerEsim.inventory.expiresAt,
    };
  }

  async setTraveler(
    partnerId: string,
    orderId: string,
    traveler: TravelerInput,
  ) {
    const order = await this.mutableOrder(partnerId, orderId, [
      OrderStatus.DRAFT,
    ]);
    const data = {
      title: traveler.title,
      firstName: traveler.firstName,
      middleName: traveler.middleName ?? null,
      surname: traveler.surname,
      dateOfBirthEncrypted: this.crypto.encrypt(traveler.dateOfBirth),
      nationality: traveler.nationality,
      city: traveler.city,
      countryOfResidence: traveler.countryOfResidence,
      employerOrBusinessName: traveler.employerOrBusinessName ?? null,
      email: traveler.email,
      mobile: traveler.mobile,
      passportNumberEncrypted: this.crypto.encrypt(traveler.passportNumber),
      passportNumberHash: this.crypto.blindIndex(traveler.passportNumber),
      passportExpiryEncrypted: this.crypto.encrypt(traveler.passportExpiryDate),
      pointOfSaleCode: traveler.pointOfSaleCode ?? null,
    };
    await this.prisma.$transaction(async (tx) => {
      await this.bumpInTransaction(tx, order.id, order.version);
      await tx.traveler.upsert({
        where: { orderId },
        update: data,
        create: { orderId, ...data },
      });
    });
    return this.order(partnerId, orderId);
  }

  async addDocument(
    partnerId: string,
    orderId: string,
    input: { type: DocumentType; fileName: string; contentType: string },
  ) {
    const order = await this.mutableOrder(partnerId, orderId, [
      OrderStatus.DRAFT,
      OrderStatus.AWAITING_CUSTOMER,
    ]);
    const signed = await this.storage.createDocumentUpload(
      orderId,
      input.type as unknown as SharedDocumentType,
      input.contentType,
    );
    const document = await this.prisma.$transaction(async (tx) => {
      await this.bumpInTransaction(tx, order.id, order.version);
      return tx.travelerDocument.upsert({
        where: { orderId_type: { orderId, type: input.type } },
        update: {
          fileName: input.fileName,
          privateAssetId: signed.assetId,
          status: DocumentStatus.PENDING,
          uploadVerified: false,
          reviewedAt: null,
          reviewedById: null,
          ...(input.type === DocumentType.PASSPORT
            ? {
                passportVerificationStatus: null,
                passportVerificationMethod: null,
                passportMatchedFields: Prisma.DbNull,
                passportConfidence: null,
                passportVerifiedAt: null,
              }
            : {}),
        },
        create: {
          orderId,
          type: input.type,
          fileName: input.fileName,
          privateAssetId: signed.assetId,
        },
      });
    });
    return {
      id: document.id,
      type: document.type,
      status: document.status,
      upload: signed.upload,
    };
  }

  async confirmDocument(
    partnerId: string,
    orderId: string,
    documentId: string,
  ) {
    const document = await this.prisma.travelerDocument.findFirst({
      where: { id: documentId, orderId, order: { partnerId } },
    });
    if (!document)
      throw new ApiException({
        code: "PARTNER_DOCUMENT_NOT_FOUND",
        message: "Document not found",
        status: 404,
      });
    await this.verifyUploadedDocument(document.privateAssetId);
    await this.prisma.travelerDocument.update({
      where: { id: document.id },
      data: { uploadVerified: true },
    });
    if (document.type === DocumentType.PASSPORT)
      await this.enqueuePassportOcr(orderId, documentId);
    return {
      id: document.id,
      type: document.type,
      status: document.status,
      uploadVerified: true,
    };
  }

  async hostedSession(partnerId: string, orderId: string, redirectUrl: string) {
    void partnerId;
    void orderId;
    void redirectUrl;
    throw this.hostedPaymentDeprecated();
  }

  /**
   * Portal / no-code path: creates a customer-funded DRAFT order plus a
   * single-use, expiring hosted checkout session for a
   * low-capacity partner that cannot integrate the REST API. The partner
   * shares `checkoutUrl`; the traveller completes traveller details,
   * documents and passport verification on the Visa Compass-hosted,
   * partner-branded page.
   */
  async createHostedCheckoutSession(
    partnerId: string,
    input: {
      planId: string;
      externalOrderId: string;
      externalCustomerId: string;
      topUpMobile?: string | undefined;
      allowInitialPurchaseFallback?: true | undefined;
    },
  ) {
    const partner = await this.partner(partnerId);
    if (partner.integrationType !== PartnerIntegrationType.CHECKOUT_LINK)
      throw new BadRequestException({
        code: "INTEGRATION_TYPE_FORBIDDEN",
        message: "This partner is not approved for hosted checkout links",
      });
    const plan = await this.prisma.plan.findFirst({
      where: {
        id: input.planId,
        status: "ACTIVE",
        country: {
          active: true,
          ...(RESTRICTED_PLAN_COUNTRY_CODES.length
            ? { isoCode: { notIn: [...RESTRICTED_PLAN_COUNTRY_CODES] } }
            : {}),
        },
      },
      include: { country: true },
    });
    if (!plan)
      throw new BadRequestException({
        code: "PLAN_UNAVAILABLE",
        message: "Plan is unavailable",
      });
    const amountPaisa = Math.round(Number(plan.sellingPrice) * 100);
    const topUp = input.topUpMobile
      ? await this.applicationOrders.resolveSubscriber(input.topUpMobile)
      : null;
    // A top-up is only valid when we can bind to a real eSIM. A fallback to a
    // new purchase is deliberately opt-in: callers must obtain consent before
    // changing the requested product from a top-up to a new eSIM.
    const eligibility =
      input.topUpMobile && topUp?.inventory
        ? await this.applicationOrders.checkTopUpEligibility(
            input.topUpMobile,
            plan.id,
          )
        : null;
    const isTopUp = Boolean(topUp?.inventory && eligibility?.allowed);
    if (input.topUpMobile && !isTopUp && !input.allowInitialPurchaseFallback)
      throw new ApiException({
        code: "TOPUP_NOT_ELIGIBLE",
        message:
          eligibility?.errorMessage ??
          "This number cannot be used for a top-up with the selected plan. Ask the customer whether they want a new eSIM purchase instead.",
        status: 422,
      });
    if (!isTopUp)
      await this.applicationOrders.assertInventoryAvailableForNewOrder();
    const token = randomBytes(24).toString("base64url");
    const sessionId = randomUUID();
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await this.prisma.$transaction(async (tx) => {
      const duplicate = await tx.order.findFirst({
        where: {
          partnerId,
          externalOrderId: input.externalOrderId,
        },
      });
      if (duplicate)
        throw new ApiException({
          code: "EXTERNAL_ORDER_ID_EXISTS",
          message: "External order ID already exists",
          status: 409,
        });
      const partnerCustomer = await this.ensurePartnerCustomer(
        tx,
        partner.code,
        partnerId,
        input.externalCustomerId,
      );
      await tx.order.create({
        data: {
          id,
          orderNumber: `VC-${new Date().getUTCFullYear()}-${id.slice(0, 8).toUpperCase()}`,
          channel: OrderChannel.PARTNER_HOSTED,
          customerId: partnerCustomer.customerId,
          partnerId,
          partnerCustomerId: partnerCustomer.id,
          externalOrderId: input.externalOrderId,
          partnerSettlementMethod: PartnerSettlementMethod.HOSTED_PAYMENT,
          partnerMetadata: Prisma.JsonNull,
          planId: plan.id,
          status: OrderStatus.DRAFT,
          orderType: isTopUp ? "TOPUP" : "INITIAL_PURCHASE",
          subtotal: amountPaisa / 100,
          totalAmount: amountPaisa / 100,
          pricingSnapshot: {
            pricingSource: "PUBLIC_CATALOGUE",
            planId: plan.id,
            name: plan.name,
            countryCode: plan.country.isoCode,
            dataAllowance: plan.dataAllowance,
            validityDays: plan.validityDays,
            amountPaisa,
            currency: "NPR",
            capturedAt: new Date().toISOString(),
            ...(isTopUp && input.topUpMobile
              ? { topUpMobile: input.topUpMobile }
              : {}),
            ...(isTopUp && topUp?.inventory
              ? { targetEsimId: topUp.inventory.id }
              : {}),
            ...(isTopUp && topUp?.traveler?.email
              ? { topUpEmail: topUp.traveler.email }
              : {}),
          },
          compatibilityAcceptedAt: new Date(),
          events: { create: { fromStatus: null, toStatus: OrderStatus.DRAFT } },
        },
      });
      await tx.partnerHostedCheckoutSession.create({
        data: {
          id: sessionId,
          partnerId,
          orderId: id,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          redirectUrl: "",
          expiresAt,
        },
      });
    });
    const checkoutUrl = `${process.env.CUSTOMER_WEB_URL ?? "http://localhost:3000"}/partner-checkout/${token}`;
    return {
      sessionId,
      token,
      checkoutUrl,
      orderId: id,
      externalOrderId: input.externalOrderId,
      expiresAt,
      orderType: isTopUp ? "TOPUP" : "INITIAL_PURCHASE",
      topUp: isTopUp
        ? {
            mobile: input.topUpMobile,
            ...(topUp?.traveler
              ? {
                  subscriberName: `${topUp.traveler.firstName} ${topUp.traveler.surname}`,
                }
              : {}),
            status: "BOUND",
          }
        : undefined,
    };
  }

  async hostedCheckout(token: string) {
    const session = await this.hostedCheckoutSession(token, true);
    let order = await this.prisma.order.findUnique({
      where: { id: session.orderId },
      include: {
        plan: { include: { country: true } },
        traveler: { select: { id: true } },
        documents: {
          select: {
            id: true,
            type: true,
            status: true,
            fileName: true,
            passportVerificationStatus: true,
          },
        },
        partner: { select: { name: true, slug: true, brand: true } },
      },
    });
    if (!order)
      throw new ApiException({
        code: "HOSTED_CHECKOUT_NOT_FOUND",
        message: "Hosted checkout not found",
        status: 404,
      });
    const requiredDocuments =
      order.orderType === "TOPUP"
        ? []
        : this.requiredDocuments(order.plan.country.isoCode);
    const currentDocuments = order.documents;
    const allRequiredManuallyApproved =
      requiredDocuments.length > 0 &&
      requiredDocuments.every((type) =>
        currentDocuments.some(
          (document) =>
            document.type === type &&
            document.status === DocumentStatus.APPROVED,
        ),
      );
    if (
      allRequiredManuallyApproved &&
      !["VERIFIED", "MANUALLY_APPROVED", "SKIPPED"].includes(
        order.documentReviewStatus,
      )
    ) {
      const repaired = await this.prisma.order.updateMany({
        where: {
          id: order.id,
          version: order.version,
          documentReviewStatus: {
            notIn: ["VERIFIED", "MANUALLY_APPROVED", "SKIPPED"],
          },
        },
        data: {
          documentReviewStatus: "MANUALLY_APPROVED",
          version: { increment: 1 },
        },
      });
      if (repaired.count === 1)
        order = {
          ...order,
          documentReviewStatus: "MANUALLY_APPROVED",
          version: order.version + 1,
        };
      else
        order =
          (await this.prisma.order.findUnique({
            where: { id: session.orderId },
            include: {
              plan: { include: { country: true } },
              traveler: { select: { id: true } },
              documents: {
                select: {
                  id: true,
                  type: true,
                  status: true,
                  fileName: true,
                  passportVerificationStatus: true,
                },
              },
              partner: { select: { name: true, slug: true, brand: true } },
            },
          })) ?? order;
    }
    return {
      sessionId: session.id,
      expiresAt: session.expiresAt,
      partner: {
        name: order.partner?.name,
        slug: order.partner?.slug,
        brand: order.partner?.brand,
      },
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        orderType: order.orderType,
        status: order.status,
        amountPaisa: Math.round(Number(order.totalAmount) * 100),
        amountNpr: Math.round(Number(order.totalAmount) * 100) / 100,
        currency: order.currency,
        plan: {
          id: order.plan.id,
          name: order.plan.name,
          country: order.plan.country.name,
          countryCode: order.plan.country.isoCode,
          dataAllowance: order.plan.dataAllowance,
          validityDays: order.plan.validityDays,
        },
        travelerComplete: Boolean(order.traveler),
        documents: order.documents,
        documentReviewStatus: order.documentReviewStatus,
        requiredDocuments,
      },
    };
  }

  async claimHostedCheckout(
    token: string,
    clerkId: string,
    performedById?: string,
  ) {
    const session = await this.hostedCheckoutSession(token);
    const [target, order] = await Promise.all([
      this.prisma.customer.findFirst({
        where: { user: { clerkId } },
        select: { id: true },
      }),
      this.prisma.order.findUnique({
        where: { id: session.orderId },
        select: {
          id: true,
          status: true,
          channel: true,
          customerId: true,
          customer: { select: { userId: true } },
        },
      }),
    ]);
    if (!target)
      throw new ApiException({
        code: "CUSTOMER_ACCOUNT_NOT_FOUND",
        message: "Customer account not found",
        status: 404,
      });
    if (!order || order.channel !== OrderChannel.PARTNER_HOSTED)
      throw new ApiException({
        code: "HOSTED_CHECKOUT_NOT_FOUND",
        message: "Hosted checkout not found",
        status: 404,
      });
    if (order.customerId === target.id) return this.hostedCheckout(token);
    if (order.status !== OrderStatus.DRAFT || order.customer.userId)
      throw new ApiException({
        code: "HOSTED_CHECKOUT_ALREADY_CLAIMED",
        message: "This hosted checkout belongs to another account",
        status: 409,
      });
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: {
          id: order.id,
          customerId: order.customerId,
          status: OrderStatus.DRAFT,
        },
        data: { customerId: target.id },
      });
      if (claimed.count !== 1)
        throw new ApiException({
          code: "HOSTED_CHECKOUT_ALREADY_CLAIMED",
          message: "This hosted checkout was claimed by another account",
          status: 409,
        });
      await tx.auditLog.create({
        data: {
          module: "PARTNERS",
          entity: "Order",
          entityId: order.id,
          action: "HOSTED_ORDER_CLAIMED",
          ...(performedById ? { performedById } : {}),
          previousValue: { ownership: "PARTNER_GUEST" },
          newValue: { ownership: "CUSTOMER_ACCOUNT" },
        },
      });
    });
    return this.hostedCheckout(token);
  }

  async hostedCheckoutDocuments(token: string) {
    const order = await this.sessionOrder(token, [OrderStatus.DRAFT]);
    const documents = await this.prisma.travelerDocument.findMany({
      where: { orderId: order.id },
      select: {
        id: true,
        type: true,
        status: true,
        fileName: true,
        passportVerificationStatus: true,
      },
    });
    return { documents };
  }

  async setHostedTraveler(token: string, traveler: TravelerInput) {
    const order = await this.sessionOrder(token, [OrderStatus.DRAFT]);
    await this.prisma.$transaction(async (tx) => {
      await this.bumpInTransaction(tx, order.id, order.version);
      await tx.traveler.upsert({
        where: { orderId: order.id },
        update: this.travelerData(traveler),
        create: { orderId: order.id, ...this.travelerData(traveler) },
      });
      const normalizedEmail = traveler.email.trim().toLowerCase();
      const emailOwner = await tx.customer.findUnique({
        where: { email: normalizedEmail },
        select: { id: true },
      });
      // The Order already owns customerId from ensurePartnerCustomer. Enrich
      // that same Customer from the hosted form, but never steal an email that
      // belongs to another customer account.
      await tx.customer.update({
        where: { id: order.customerId },
        data: {
          phone: traveler.mobile.trim(),
          ...(!emailOwner || emailOwner.id === order.customerId
            ? { email: normalizedEmail }
            : {}),
        },
      });
      if (order.partnerCustomerId) {
        const attached = await tx.partnerCustomer.findFirst({
          where: {
            id: order.partnerCustomerId,
            ...(order.partnerId ? { partnerId: order.partnerId } : {}),
          },
          select: { id: true },
        });
        if (!attached)
          throw new ApiException({
            code: "PARTNER_CUSTOMER_MISMATCH",
            message: "Hosted order is not attached to its partner customer",
            status: 409,
          });
      }
    });
    return this.hostedCheckout(token);
  }

  async addHostedDocument(
    token: string,
    input: { type: DocumentType; fileName: string; contentType: string },
  ) {
    const order = await this.sessionOrder(token, [
      OrderStatus.DRAFT,
      OrderStatus.AWAITING_CUSTOMER,
    ]);
    const signed = await this.storage.createDocumentUpload(
      order.id,
      input.type as unknown as SharedDocumentType,
      input.contentType,
    );
    const document = await this.prisma.$transaction(async (tx) => {
      await this.bumpInTransaction(tx, order.id, order.version);
      return tx.travelerDocument.upsert({
        where: { orderId_type: { orderId: order.id, type: input.type } },
        update: {
          fileName: input.fileName,
          privateAssetId: signed.assetId,
          status: DocumentStatus.PENDING,
          uploadVerified: false,
          reviewedAt: null,
          reviewedById: null,
          ...(input.type === DocumentType.PASSPORT
            ? {
                passportVerificationStatus: null,
                passportVerificationMethod: null,
                passportMatchedFields: Prisma.DbNull,
                passportConfidence: null,
                passportVerifiedAt: null,
              }
            : {}),
        },
        create: {
          orderId: order.id,
          type: input.type,
          fileName: input.fileName,
          privateAssetId: signed.assetId,
        },
      });
    });
    return {
      id: document.id,
      type: document.type,
      status: document.status,
      upload: signed.upload,
    };
  }

  async confirmHostedDocument(token: string, documentId: string) {
    const order = await this.sessionOrder(token, [OrderStatus.DRAFT]);
    const document = await this.prisma.travelerDocument.findFirst({
      where: { id: documentId, orderId: order.id },
    });
    if (!document)
      throw new ApiException({
        code: "PARTNER_DOCUMENT_NOT_FOUND",
        message: "Document not found",
        status: 404,
      });
    await this.verifyUploadedDocument(document.privateAssetId);
    await this.prisma.travelerDocument.update({
      where: { id: document.id },
      data: { uploadVerified: true },
    });
    return {
      id: document.id,
      type: document.type,
      status: document.status,
      uploadVerified: true,
    };
  }

  /**
   * Runs the server-side passport OCR check for a hosted checkout order and
   * persists the verdict onto the passport document (same gate the customer
   * checkout uses). Operates only on this order and writes only the passport
   * verification columns, so it never loads/decrypts unrelated orders or
   * triggers a full order re-save.
   */
  async verifyHostedPassport(token: string) {
    const order = await this.sessionOrder(token, [OrderStatus.DRAFT]);
    if (
      ["VERIFIED", "MANUALLY_APPROVED", "SKIPPED"].includes(
        order.documentReviewStatus,
      )
    )
      return {
        status: order.documentReviewStatus,
        checkedAt: new Date().toISOString(),
        method:
          order.documentReviewStatus === "MANUALLY_APPROVED"
            ? "manual"
            : "asynchronous",
      };
    const missingRequiredDocuments = this.requiredDocuments(
      order.plan.country.isoCode,
    ).filter(
      (type) =>
        !order.documents.some(
          (document) => document.type === type && document.uploadVerified,
        ),
    );
    if (missingRequiredDocuments.length)
      throw new ApiException({
        code: "DOCUMENT_UPLOADS_INCOMPLETE",
        message: `Confirm all required documents before verification: ${missingRequiredDocuments.map(documentTypeLabel).join(", ")}`,
        status: 409,
      });
    const passport = order.documents.find(
      (document) => document.type === DocumentType.PASSPORT,
    );
    if (!passport)
      throw new BadRequestException({
        code: "PASSPORT_REQUIRED",
        message: "Upload a passport before verification",
      });
    if (!this.decryptTraveler(order.traveler))
      throw new BadRequestException({
        code: "TRAVELER_REQUIRED",
        message: "Traveller details are required before verification",
      });
    if (
      ["MANUAL_REVIEW", "OCR_BACKGROUND", "REUPLOAD_REQUIRED"].includes(
        order.documentReviewStatus,
      )
    )
      return {
        status: order.documentReviewStatus,
        checkedAt: new Date().toISOString(),
        method: "asynchronous",
      };
    const config = await this.prisma.platformConfiguration.upsert({
      where: { id: "platform" },
      update: {},
      create: { id: "platform" },
    });
    const now = new Date();
    if (config.documentReviewPolicy === "MANUAL_REVIEW") {
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          documentReviewPolicy: config.documentReviewPolicy,
          documentReviewStatus: "MANUAL_REVIEW",
          documentReviewStartedAt: order.documentReviewStartedAt ?? now,
          documentCheckoutReleaseAt: null,
          version: { increment: 1 },
        },
      });
      return {
        status: "MANUAL_REVIEW",
        checkedAt: now.toISOString(),
        method: "manual",
      };
    }
    if (config.documentReviewPolicy === "NO_REVIEW") {
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          documentReviewPolicy: config.documentReviewPolicy,
          documentReviewStatus: "SKIPPED",
          documentReviewStartedAt: order.documentReviewStartedAt ?? now,
          documentCheckoutReleaseAt: null,
          version: { increment: 1 },
        },
      });
      return {
        status: "SKIPPED",
        checkedAt: now.toISOString(),
        method: "policy",
      };
    }
    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        documentReviewPolicy: config.documentReviewPolicy,
        documentReviewStatus: "OCR_PENDING",
        documentReviewStartedAt: order.documentReviewStartedAt ?? now,
        documentCheckoutReleaseAt: null,
        version: { increment: 1 },
      },
    });
    try {
      await this.queues.add(
        QUEUES.documents,
        "verify-order-passport",
        { orderId: order.id, documentId: passport.id },
        `order-passport-${order.id}-${passport.id}`,
        ocrJobOptions(),
      );
      return {
        status: "OCR_PENDING",
        checkedAt: now.toISOString(),
        method: "asynchronous",
      };
    } catch {
      // Preserve OCR_PENDING during the recovery window. The workflow
      // reconciler retries the handoff and performs the eventual strict manual
      // fallback even if the dedicated OCR process is completely offline.
      return {
        status: "OCR_PENDING",
        checkedAt: now.toISOString(),
        method: "recovery-pending",
      };
    }
  }

  async completeHostedCheckout(
    token: string,
    context: { ipAddress: string; userAgent: string },
  ) {
    const session = await this.hostedCheckoutSession(token);
    const order = await this.prisma.order.findUnique({
      where: { id: session.orderId },
      include: {
        plan: { include: { country: true } },
        traveler: true,
        documents: true,
      },
    });
    if (!order)
      throw new ApiException({
        code: "HOSTED_CHECKOUT_NOT_FOUND",
        message: "Hosted checkout not found",
        status: 404,
      });
    if (order.status !== OrderStatus.DRAFT)
      throw new ApiException({
        code: "HOSTED_CHECKOUT_COMPLETED",
        message: "Hosted checkout is already completed",
        status: 400,
      });
    const required = this.requiredDocuments(order.plan.country.isoCode);
    if (!order.traveler && order.orderType !== "TOPUP")
      throw new ApiException({
        code: "PARTNER_TRAVELER_REQUIRED",
        message: "Traveller details are required",
        status: 400,
      });
    if (order.orderType !== "TOPUP") {
      for (const type of required) {
        const document = order.documents.find((item) => item.type === type);
        if (!document)
          throw new BadRequestException({
            code: "DOCUMENT_REQUIRED",
            message: `Missing required document: ${documentTypeLabel(type)}`,
          });
        await this.verifyUploadedDocument(document.privateAssetId);
      }
      if (
        !["VERIFIED", "MANUALLY_APPROVED", "SKIPPED"].includes(
          order.documentReviewStatus,
        )
      )
        throw new BadRequestException({
          code: "PASSPORT_VERIFICATION_REQUIRED",
          message: "Passport verification must complete before payment",
        });
      await this.applicationOrders.assertInventoryAvailableForNewOrder();
    }
    const amountPaisa = Math.round(Number(order.totalAmount) * 100);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.updateMany({
        where: { id: order.id, version: order.version },
        data: {
          status: OrderStatus.PAYMENT_PENDING,
          compatibilityAcceptedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1)
        throw new ApiException({
          code: "ORDER_CONFLICT",
          message: "Order was changed; reload and retry",
          status: 409,
        });
      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          fromStatus: OrderStatus.DRAFT,
          toStatus: OrderStatus.PAYMENT_PENDING,
          reason: "Hosted checkout review completed; awaiting customer payment",
        },
      });
      await tx.customerConsent.createMany({
        data: ["COMPATIBILITY", "TERMS", "PRIVACY"].map((type) => ({
          customerId: order.customerId,
          type,
          version: "1.0",
          ipAddress: context.ipAddress,
          userAgent: context.userAgent.slice(0, 500),
          acceptedAt: new Date(),
        })),
      });
    });
    const handoff = await Promise.allSettled([
      this.applicationOrders.refreshFromPersistence(order.id),
    ]);
    for (const result of handoff)
      if (result.status === "rejected")
        this.logger.error(
          result.reason instanceof Error
            ? result.reason.message
            : "Hosted checkout post-commit handoff failed",
        );
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: OrderStatus.PAYMENT_PENDING,
      amountPaisa,
      currency: order.currency,
    };
  }

  async hostedCheckoutInitiate(token: string, provider: PaymentProvider) {
    const session = await this.hostedCheckoutSession(token);
    const order = await this.prisma.order.findUnique({
      where: { id: session.orderId },
      select: { status: true, channel: true, partnerSettlementMethod: true },
    });
    if (
      !order ||
      order.channel !== OrderChannel.PARTNER_HOSTED ||
      order.partnerSettlementMethod !== PartnerSettlementMethod.HOSTED_PAYMENT
    )
      throw new ApiException({
        code: "HOSTED_PAYMENT_NOT_ALLOWED",
        message: "This checkout is not customer-funded",
        status: 403,
      });
    if (
      order.status !== OrderStatus.PAYMENT_PENDING &&
      order.status !== OrderStatus.PAYMENT_FAILED
    )
      throw new ApiException({
        code: "HOSTED_CHECKOUT_NOT_COMPLETED",
        message: "Complete the checkout review and consent before payment",
        status: 409,
      });
    if (!this.payments) return this.hostedPaymentDeprecated();
    return this.payments.initiate(
      session.orderId,
      null,
      provider as unknown as Parameters<PaymentsService["initiate"]>[2],
      `${process.env.CUSTOMER_WEB_URL ?? "http://localhost:3000"}/partner-checkout/${token}`,
    );
  }

  async hostedCheckoutVerify(token: string, reference?: string) {
    const session = await this.hostedCheckoutSession(token);
    if (!this.payments) return this.hostedPaymentDeprecated();
    const resolved =
      reference ?? (await this.activePaymentReference(session.orderId));
    if (!resolved)
      throw new ApiException({
        code: "PAYMENT_NOT_INITIATED",
        message: "Start a payment before checking its status",
        status: 400,
      });
    const result = await this.payments.verify(session.orderId, null, resolved);
    await this.finalizeHostedPayment(session, result as { status?: string });
    return result;
  }

  async hostedCheckoutSimulate(
    token: string,
    reference?: string,
    scenario:
      | "SUCCESS"
      | "CANCELLED"
      | "PENDING"
      | "WRONG_AMOUNT"
      | "REFUNDED"
      | "TIMEOUT" = "SUCCESS",
  ) {
    const session = await this.hostedCheckoutSession(token);
    if (!this.payments) return this.hostedPaymentDeprecated();
    const resolved =
      reference ?? (await this.activePaymentReference(session.orderId));
    if (!resolved)
      throw new ApiException({
        code: "PAYMENT_NOT_INITIATED",
        message: "Start a payment before simulating its completion",
        status: 400,
      });
    const result = await this.payments.simulate(
      session.orderId,
      null,
      resolved,
      scenario,
    );
    await this.finalizeHostedPayment(session, result as { status?: string });
    return result;
  }

  private async finalizeHostedPayment(
    session: { id: string; orderId: string; partnerId: string },
    result: { status?: string },
  ) {
    const paidStatuses = new Set<string>([
      OrderStatus.PAYMENT_CONFIRMED,
      OrderStatus.REVIEW_PENDING,
      OrderStatus.APPROVED,
      OrderStatus.PROVISIONING,
      OrderStatus.QR_READY,
      OrderStatus.ACTIVATION_ATTENTION,
      OrderStatus.COMPLETED,
    ]);
    if (!result.status || !paidStatuses.has(result.status)) return;
    const consumed = await this.prisma.partnerHostedCheckoutSession.updateMany({
      where: { id: session.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count === 1) await this.partnerWebhooks.enqueuePending();
  }

  private async activePaymentReference(orderId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { orderId },
      orderBy: { createdAt: "desc" },
      select: { paymentReference: true },
    });
    return payment?.paymentReference ?? null;
  }

  /**
   * Settles the deposit reserved when the hosted checkout session was created:
   * delivery success (QR_READY/COMPLETED/ACTIVATION_ATTENTION) converts the
   * reservation into a CAPTURE debit; delivery failure (PROVISIONING_FAILED) or
   * cancellation releases the reservation. Idempotent — ledger references
   * (`capture:<orderId>` / `release:<orderId>`) make repeated runs no-ops.
   * Outcome is re-derived from the current DB status so races with the
   * order machine resolve to the safer action.
   */
  async settleHostedReservation(
    orderId: string,
    outcome?: "CAPTURE" | "RELEASE",
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        channel: true,
        partnerId: true,
        externalOrderId: true,
        partnerSettlementMethod: true,
        totalAmount: true,
        status: true,
      },
    });
    if (!order)
      return { orderId, action: "SKIPPED" as const, reason: "NOT_FOUND" };
    if (order.channel !== OrderChannel.PARTNER_HOSTED)
      return {
        orderId,
        action: "SKIPPED" as const,
        reason: "NOT_HOSTED_CHECKOUT",
      };
    if (
      order.partnerSettlementMethod !== PartnerSettlementMethod.PARTNER_ACCOUNT
    )
      return {
        orderId,
        action: "SKIPPED" as const,
        reason: "NOT_PARTNER_ACCOUNT",
      };
    const partnerId = order.partnerId;
    if (!partnerId)
      return { orderId, action: "SKIPPED" as const, reason: "NO_PARTNER" };
    const amountPaisa = Math.round(Number(order.totalAmount) * 100);
    if (this.hostedDepositSuccess.has(order.status)) {
      const applied = await this.prisma.$transaction(async (tx) =>
        this.captureAccount(tx, partnerId, orderId, amountPaisa),
      );
      return {
        orderId,
        action: "CAPTURED" as const,
        amountPaisa,
        ...applied,
      };
    }
    if (this.hostedDepositRelease.has(order.status)) {
      const applied = await this.prisma.$transaction(async (tx) =>
        this.releaseReservation(tx, partnerId, orderId, amountPaisa),
      );
      return {
        orderId,
        action: "RELEASED" as const,
        amountPaisa,
        ...applied,
      };
    }
    this.logger.debug(
      `Hosted settlement skipped for ${orderId} in status ${order.status} (hint ${outcome ?? "none"})`,
    );
    return {
      orderId,
      action: "SKIPPED" as const,
      reason: `STATUS_${order.status}`,
    };
  }

  /** Safety net for capturing/releasing deposits that missed the fast path. */
  async reconcileHostedDeposits(): Promise<{
    captured: number;
    released: number;
    skipped: number;
  }> {
    const orders = await this.prisma.order.findMany({
      where: {
        channel: OrderChannel.PARTNER_HOSTED,
        partnerSettlementMethod: PartnerSettlementMethod.PARTNER_ACCOUNT,
        status: {
          in: [
            OrderStatus.QR_READY,
            OrderStatus.COMPLETED,
            OrderStatus.ACTIVATION_ATTENTION,
            OrderStatus.PROVISIONING_FAILED,
            OrderStatus.CANCELLED,
          ],
        },
      },
      select: { id: true },
    });
    let captured = 0;
    let released = 0;
    let skipped = 0;
    for (const { id } of orders) {
      try {
        const result = await this.settleHostedReservation(id);
        if (result.action === "CAPTURED") captured += 1;
        else if (result.action === "RELEASED") released += 1;
        else skipped += 1;
      } catch (error) {
        this.logger.warn(
          `Hosted deposit reconciliation failed for order ${id}: ${
            error instanceof Error ? error.message : "unknown"
          }`,
        );
        skipped += 1;
      }
    }
    return { captured, released, skipped };
  }

  /**
   * Releases deposits for hosted checkout sessions that expired before the
   * customer paid, cancelling their still-unpaid orders. Safe by construction:
   * only sessions with orders in DRAFT/PAYMENT_PENDING are touched — once a
   * payment is confirmed the order leaves those statuses.
   */
  async releaseExpiredHostedReservations(now = new Date()): Promise<{
    released: number;
    cancelled: number;
  }> {
    const sessions = await this.prisma.partnerHostedCheckoutSession.findMany({
      where: { expiresAt: { lt: now }, consumedAt: null },
      select: {
        id: true,
        partnerId: true,
        order: {
          select: {
            id: true,
            channel: true,
            externalOrderId: true,
            partnerSettlementMethod: true,
            totalAmount: true,
            status: true,
            version: true,
          },
        },
      },
    });
    let released = 0;
    let cancelled = 0;
    for (const session of sessions) {
      const order = session.order;
      if (
        !order ||
        order.channel !== OrderChannel.PARTNER_HOSTED ||
        (order.status !== OrderStatus.DRAFT &&
          order.status !== OrderStatus.PAYMENT_PENDING)
      )
        continue;
      try {
        const amountPaisa = Math.round(Number(order.totalAmount) * 100);
        await this.prisma.$transaction(async (tx) => {
          await tx.partnerHostedCheckoutSession.updateMany({
            where: { id: session.id, consumedAt: null },
            data: { consumedAt: now },
          });
          const updated = await tx.order.updateMany({
            where: {
              id: order.id,
              version: order.version,
              status: {
                in: [OrderStatus.DRAFT, OrderStatus.PAYMENT_PENDING],
              },
            },
            data: { status: OrderStatus.CANCELLED, version: { increment: 1 } },
          });
          if (updated.count !== 1)
            throw new ApiException({
              code: "ORDER_CONFLICT",
              message: "Order was changed by another request; retry",
              status: 409,
            });
          await tx.orderEvent.create({
            data: {
              orderId: order.id,
              fromStatus: order.status,
              toStatus: OrderStatus.CANCELLED,
              reason: "Hosted checkout link expired before payment",
            },
          });
          await this.releaseReservation(
            tx,
            session.partnerId,
            order.id,
            amountPaisa,
          );
        });
        cancelled += 1;
        released += 1;
      } catch (error) {
        this.logger.warn(
          `Expired hosted reservation release failed for ${order.id}: ${
            error instanceof Error ? error.message : "unknown"
          }`,
        );
      }
    }
    return { released, cancelled };
  }

  async cancel(partnerId: string, orderId: string, reason: string) {
    const order = await this.mutableOrder(partnerId, orderId, [
      OrderStatus.DRAFT,
      OrderStatus.PAYMENT_PENDING,
      OrderStatus.AWAITING_CUSTOMER,
      OrderStatus.REVIEW_PENDING,
    ]);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.updateMany({
        where: { id: order.id, version: order.version },
        data: { status: OrderStatus.CANCELLED, version: { increment: 1 } },
      });
      if (updated.count !== 1)
        throw new ApiException({
          code: "ORDER_CONFLICT",
          message: "Order was changed by another request; reload and retry",
          status: 409,
        });
      await tx.orderEvent.create({
        data: {
          orderId,
          fromStatus: order.status,
          toStatus: OrderStatus.CANCELLED,
          reason,
        },
      });
      if (
        order.partnerSettlementMethod ===
        PartnerSettlementMethod.PARTNER_ACCOUNT
      ) {
        if (order.partnerQuote)
          await this.releaseReservation(
            tx,
            partnerId,
            orderId,
            order.partnerQuote.wholesaleAmountPaisa,
          );
        else
          await this.refundDirectDebit(
            tx,
            partnerId,
            orderId,
            Math.round(Number(order.totalAmount) * 100),
            "cancellation",
          );
      }
      await this.createEvent(
        tx,
        partnerId,
        orderId,
        "order.cancelled",
        orderId,
        {
          orderId,
          externalOrderId: order.externalOrderId,
          status: OrderStatus.CANCELLED,
          reason,
        },
      );
    });
    await this.partnerWebhooks.enqueuePending();
    return this.order(partnerId, orderId);
  }

  async requestRefund(partnerId: string, orderId: string, reason: string) {
    const order = await this.mutableOrder(partnerId, orderId, [
      OrderStatus.PAYMENT_CONFIRMED,
      OrderStatus.REVIEW_PENDING,
      OrderStatus.PROVISIONING_FAILED,
      OrderStatus.COMPLETED,
    ]);
    const amountPaisa = Math.round(Number(order.totalAmount) * 100);
    const request = await this.prisma.$transaction(async (tx) => {
      const refund = await tx.partnerRefundRequest.create({
        data: { partnerId, orderId, amountPaisa, reason },
      });
      const updated = await tx.order.updateMany({
        where: { id: orderId, version: order.version },
        data: { status: OrderStatus.REFUND_PENDING, version: { increment: 1 } },
      });
      if (updated.count !== 1)
        throw new ApiException({
          code: "ORDER_CONFLICT",
          message: "Order was changed by another request; reload and retry",
          status: 409,
        });
      await tx.orderEvent.create({
        data: {
          orderId,
          fromStatus: order.status,
          toStatus: OrderStatus.REFUND_PENDING,
          reason,
        },
      });
      await this.createEvent(
        tx,
        partnerId,
        orderId,
        "refund.requested",
        refund.id,
        {
          refundRequestId: refund.id,
          orderId,
          amountPaisa,
          currency: "NPR",
          status: refund.status,
        },
      );
      return refund;
    });
    await this.partnerWebhooks.enqueuePending();
    return request;
  }

  async events(partnerId: string, orderId: string) {
    await this.order(partnerId, orderId);
    return this.prisma.partnerEvent.findMany({
      where: { partnerId, orderId },
      select: {
        id: true,
        type: true,
        version: true,
        resourceId: true,
        correlationId: true,
        payload: true,
        occurredAt: true,
      },
      orderBy: { occurredAt: "asc" },
    });
  }

  async usage(partnerId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, partnerId },
    });
    if (!order)
      throw new ApiException({
        code: "PARTNER_ORDER_NOT_FOUND",
        message: "Order not found",
        status: 404,
      });
    if (order.status !== OrderStatus.COMPLETED)
      throw new ApiException({
        code: "PARTNER_USAGE_UNAVAILABLE",
        message: "Usage details are available once the eSIM is active",
        status: 400,
      });
    return this.connectivity.getUsage(orderId);
  }

  async notify(
    partnerId: string,
    orderId: string,
    input: {
      channel: "EMAIL" | "WHATSAPP";
      template: "ORDER_STATUS" | "QR_READY" | "DOCUMENT_REUPLOAD";
    },
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, partnerId },
      include: { traveler: true },
    });
    if (!order)
      throw new ApiException({
        code: "PARTNER_ORDER_NOT_FOUND",
        message: "Order not found",
        status: 404,
      });
    if (!order.traveler)
      throw new ApiException({
        code: "PARTNER_TRAVELER_REQUIRED",
        message: "Traveller contact details are required",
        status: 400,
      });
    return this.notifications.enqueue({
      orderId,
      channel: input.channel,
      template: input.template,
      recipient:
        input.channel === "EMAIL"
          ? order.traveler.email
          : order.traveler.mobile,
      orderNumber: order.orderNumber,
      ...(order.traveler.firstName
        ? { customerName: order.traveler.firstName }
        : {}),
    });
  }

  private normalizeOrder(order: PartnerOrderRow) {
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      externalOrderId: order.externalOrderId,
      status: order.status,
      settlementMethod: order.partnerSettlementMethod,
      metadata: order.partnerMetadata,
      currency: order.currency,
      totalAmountPaisa: Math.round(Number(order.totalAmount) * 100),
      plan: {
        id: order.plan.id,
        countryCode: order.plan.country.isoCode,
        name: order.plan.name,
        dataAllowance: order.plan.dataAllowance,
        validityDays: order.plan.validityDays,
      },
      travelerComplete: Boolean(order.traveler),
      documents: order.documents.map((document) => ({
        id: document.id,
        type: document.type,
        status: document.status,
        passportVerificationStatus: document.passportVerificationStatus,
      })),
      refund: order.partnerRefundRequests[0] ?? null,
      timeline: order.events.map((event) => ({
        from: event.fromStatus,
        to: event.toStatus,
        reason: event.reason,
        at: event.createdAt,
      })),
      fulfillmentStatus: this.fulfillmentStatus(order.status),
      documentReviewPolicy: order.documentReviewPolicy,
      documentReviewStatus: order.documentReviewStatus,
      requiredDocuments: [DocumentType.PASSPORT, DocumentType.TICKET],
      fulfillmentAllowed:
        order.status === OrderStatus.REVIEW_PENDING &&
        ((order.documentReviewPolicy === "AUTO_OCR" &&
          ["VERIFIED", "MANUALLY_APPROVED"].includes(
            order.documentReviewStatus,
          )) ||
          (order.documentReviewPolicy === "MANUAL_REVIEW" &&
            order.documentReviewStatus === "MANUALLY_APPROVED") ||
          (order.documentReviewPolicy === "NO_REVIEW" &&
            order.documentReviewStatus === "SKIPPED")),
      links: {
        order: `/api/v1/partners/orders/${order.id}`,
        events: `/api/v1/partners/orders/${order.id}/events`,
        esim: `/api/v1/partners/orders/${order.id}/esim`,
      },
      esimDetailsAvailable:
        order.status === OrderStatus.QR_READY ||
        order.status === OrderStatus.ACTIVATION_ATTENTION ||
        order.status === OrderStatus.COMPLETED,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }

  private async partner(id: string) {
    const partner = await this.prisma.partner.findUnique({ where: { id } });
    if (
      !partner ||
      (partner.status !== PartnerStatus.ACTIVE &&
        partner.status !== PartnerStatus.SUSPENDED)
    )
      throw new ApiException({
        code: "PARTNER_NOT_FOUND",
        message: "Partner not found",
        status: 404,
      });
    return partner;
  }

  private async hostedCheckoutSession(token: string, allowConsumed = false) {
    if (!/^[A-Za-z0-9_-]{32,100}$/.test(token))
      throw new ApiException({
        code: "HOSTED_CHECKOUT_NOT_FOUND",
        message: "Hosted checkout not found",
        status: 404,
      });
    const session = await this.prisma.partnerHostedCheckoutSession.findUnique({
      where: { tokenHash: createHash("sha256").update(token).digest("hex") },
    });
    if (
      !session ||
      (!allowConsumed && session.consumedAt) ||
      (!session.consumedAt && session.expiresAt <= new Date())
    )
      throw new ApiException({
        code: "HOSTED_CHECKOUT_NOT_FOUND",
        message: "Hosted checkout not found",
        status: 404,
      });
    return session;
  }

  private async sessionOrder(token: string, statuses?: OrderStatus[]) {
    const session = await this.hostedCheckoutSession(token);
    const order = await this.prisma.order.findUnique({
      where: { id: session.orderId },
      include: {
        plan: { include: { country: true } },
        traveler: true,
        documents: true,
        partner: { select: { name: true, slug: true, brand: true } },
      },
    });
    if (!order)
      throw new ApiException({
        code: "HOSTED_CHECKOUT_NOT_FOUND",
        message: "Hosted checkout not found",
        status: 404,
      });
    if (statuses && !statuses.includes(order.status))
      throw new ApiException({
        code: "PARTNER_ORDER_INVALID_STATE",
        message: "Order cannot be changed in its current state",
        status: 400,
      });
    return order;
  }

  private async mutableOrder(
    partnerId: string,
    id: string,
    statuses: OrderStatus[],
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id, partnerId },
      include: { partnerQuote: true },
    });
    if (!order)
      throw new ApiException({
        code: "PARTNER_ORDER_NOT_FOUND",
        message: "Order not found",
        status: 404,
      });
    if (!statuses.includes(order.status))
      throw new ApiException({
        code: "PARTNER_ORDER_INVALID_STATE",
        message: "Order cannot be changed in its current state",
        status: 400,
      });
    return order;
  }

  private async bump(id: string, version: number) {
    const result = await this.prisma.order.updateMany({
      where: { id, version },
      data: { version: { increment: 1 } },
    });
    if (result.count !== 1)
      throw new ApiException({
        code: "ORDER_CONFLICT",
        message: "Order was changed by another request; reload and retry",
        status: 409,
      });
  }

  private async bumpInTransaction(
    tx: Prisma.TransactionClient,
    id: string,
    version: number,
  ) {
    const result = await tx.order.updateMany({
      where: { id, version },
      data: { version: { increment: 1 } },
    });
    if (result.count !== 1)
      throw new ApiException({
        code: "ORDER_CONFLICT",
        message: "Order was changed by another request; reload and retry",
        status: 409,
      });
  }

  private async ensurePartnerCustomer(
    tx: Prisma.TransactionClient,
    partnerCode: string,
    partnerId: string,
    externalCustomerId: string,
  ) {
    const existing = await tx.partnerCustomer.findUnique({
      where: {
        partnerId_externalCustomerId: { partnerId, externalCustomerId },
      },
    });
    if (existing) return existing;
    const suffix = createHash("sha256")
      .update(`${partnerId}:${externalCustomerId}`)
      .digest("hex")
      .slice(0, 18);
    const customer = await tx.customer.create({
      data: {
        customerCode: `VP-${partnerCode.toUpperCase().slice(0, 8)}-${suffix.toUpperCase()}`,
        source: CustomerSource.PARTNER,
        email: `${suffix}@partner.visacompass.invalid`,
      },
    });
    return tx.partnerCustomer.create({
      data: { partnerId, externalCustomerId, customerId: customer.id },
    });
  }

  private async reserveAccount(
    tx: Prisma.TransactionClient,
    partnerId: string,
    amountPaisa: number,
    externalOrderId: string,
  ) {
    const account = await tx.partnerAccount.upsert({
      where: { partnerId },
      update: {},
      create: { partnerId },
    });
    const available =
      account.balancePaisa + account.creditLimitPaisa - account.reservedPaisa;
    if (available < amountPaisa)
      throw new ApiException({
        code: "INSUFFICIENT_PARTNER_BALANCE",
        message: "Partner prepaid balance is insufficient",
        status: 400,
      });
    const updated = await tx.partnerAccount.updateMany({
      where: { id: account.id, version: account.version },
      data: {
        reservedPaisa: { increment: amountPaisa },
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1)
      throw new ApiException({
        code: "PARTNER_BALANCE_CONFLICT",
        message: "Partner balance changed; retry",
        status: 409,
      });
    await tx.partnerLedgerEntry.create({
      data: {
        partnerId,
        type: PartnerLedgerEntryType.RESERVATION,
        amountPaisa,
        balanceAfterPaisa: account.balancePaisa,
        reference: `reserve:${partnerId}:${externalOrderId}`,
      },
    });
  }

  private async debitAccount(
    tx: Prisma.TransactionClient,
    partnerId: string,
    orderId: string,
    amountPaisa: number,
    externalOrderId: string,
  ) {
    const account = await tx.partnerAccount.upsert({
      where: { partnerId },
      update: {},
      create: { partnerId },
    });
    if (account.balancePaisa < amountPaisa)
      throw new BadRequestException({
        code: "INSUFFICIENT_PARTNER_BALANCE",
        message: "Partner prepaid balance is insufficient",
      });
    const balanceAfterPaisa = account.balancePaisa - amountPaisa;
    const updated = await tx.partnerAccount.updateMany({
      where: {
        id: account.id,
        version: account.version,
        balancePaisa: { gte: amountPaisa },
      },
      data: {
        balancePaisa: balanceAfterPaisa,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1)
      throw new ApiException({
        code: "PARTNER_BALANCE_CONFLICT",
        message: "Partner balance changed; retry",
        status: 409,
      });
    await tx.partnerLedgerEntry.create({
      data: {
        partnerId,
        orderId,
        type: PartnerLedgerEntryType.DEBIT,
        amountPaisa,
        balanceAfterPaisa,
        reference: `debit:${partnerId}:${externalOrderId}`,
        metadata: { settlement: "PARTNER_ACCOUNT" },
      },
    });
  }

  private async captureAccount(
    tx: Prisma.TransactionClient,
    partnerId: string,
    orderId: string,
    amountPaisa: number,
  ) {
    const reference = `capture:${orderId}`;
    const existing = await tx.partnerLedgerEntry.findUnique({
      where: { reference },
    });
    if (existing) return { applied: false, reason: "ALREADY_CAPTURED" };
    const account = await tx.partnerAccount.findUnique({
      where: { partnerId },
    });
    if (!account)
      return { applied: false, reason: "NO_ACCOUNT", account: false };
    if (account.reservedPaisa < amountPaisa)
      throw new ApiException({
        code: "PARTNER_BALANCE_CONFLICT",
        message:
          "The deposit reserved for this order does not cover the captured amount",
        status: 409,
      });
    const balanceAfterPaisa = account.balancePaisa - amountPaisa;
    const updated = await tx.partnerAccount.updateMany({
      where: {
        id: account.id,
        version: account.version,
        reservedPaisa: { gte: amountPaisa },
      },
      data: {
        reservedPaisa: { decrement: amountPaisa },
        balancePaisa: balanceAfterPaisa,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1)
      throw new ApiException({
        code: "PARTNER_BALANCE_CONFLICT",
        message: "Partner balance changed; retry",
        status: 409,
      });
    await tx.partnerLedgerEntry.create({
      data: {
        partnerId,
        orderId,
        type: PartnerLedgerEntryType.CAPTURE,
        amountPaisa,
        balanceAfterPaisa,
        reference,
        metadata: { settlement: "PARTNER_ACCOUNT", channel: "PARTNER_HOSTED" },
      },
    });
    return { applied: true };
  }

  private travelerData(traveler: TravelerInput) {
    return {
      title: traveler.title,
      firstName: traveler.firstName,
      middleName: traveler.middleName ?? null,
      surname: traveler.surname,
      dateOfBirthEncrypted: this.crypto.encrypt(traveler.dateOfBirth),
      nationality: traveler.nationality,
      city: traveler.city,
      countryOfResidence: traveler.countryOfResidence,
      employerOrBusinessName: traveler.employerOrBusinessName ?? null,
      email: traveler.email,
      mobile: traveler.mobile,
      passportNumberEncrypted: this.crypto.encrypt(traveler.passportNumber),
      passportNumberHash: this.crypto.blindIndex(traveler.passportNumber),
      passportExpiryEncrypted: this.crypto.encrypt(traveler.passportExpiryDate),
      pointOfSaleCode: traveler.pointOfSaleCode ?? null,
    };
  }

  private decryptTraveler(
    traveler: {
      title: string;
      firstName: string;
      middleName: string | null;
      surname: string;
      dateOfBirthEncrypted: string;
      nationality: string;
      city: string;
      countryOfResidence: string;
      employerOrBusinessName: string | null;
      email: string;
      mobile: string;
      passportNumberEncrypted: string;
      passportExpiryEncrypted: string;
      pointOfSaleCode: string | null;
    } | null,
  ): TravelerInput | undefined {
    if (!traveler) return undefined;
    return {
      title: traveler.title as TravelerInput["title"],
      firstName: traveler.firstName,
      ...(traveler.middleName ? { middleName: traveler.middleName } : {}),
      surname: traveler.surname,
      dateOfBirth: this.crypto.decrypt(traveler.dateOfBirthEncrypted),
      nationality: traveler.nationality,
      city: traveler.city,
      countryOfResidence: traveler.countryOfResidence,
      ...(traveler.employerOrBusinessName
        ? { employerOrBusinessName: traveler.employerOrBusinessName }
        : {}),
      email: traveler.email,
      mobile: traveler.mobile,
      passportNumber: this.crypto.decrypt(traveler.passportNumberEncrypted),
      passportExpiryDate: this.crypto.decrypt(traveler.passportExpiryEncrypted),
      ...(traveler.pointOfSaleCode
        ? { pointOfSaleCode: traveler.pointOfSaleCode }
        : {}),
    };
  }

  private requiredDocuments(_countryCode: string): DocumentType[] {
    return [DocumentType.PASSPORT, DocumentType.TICKET];
  }

  private formatMatchesContentType(format: string, contentType: string) {
    const normalized = format.toLowerCase();
    return (
      (contentType === "application/pdf" && normalized === "pdf") ||
      (contentType === "image/png" && normalized === "png") ||
      (contentType === "image/jpeg" && ["jpg", "jpeg"].includes(normalized))
    );
  }

  private assertRedirectAllowed(
    allowlist: Prisma.JsonValue,
    redirectUrl: string,
  ) {
    const target = new URL(redirectUrl);
    const allowed = this.stringArray(allowlist);
    if (
      !allowed.some((entry) => {
        const permitted = new URL(entry);
        return (
          target.origin === permitted.origin &&
          target.pathname.startsWith(permitted.pathname)
        );
      })
    )
      throw new BadRequestException("Redirect URL is not allowlisted");
  }

  private async releaseReservation(
    tx: Prisma.TransactionClient,
    partnerId: string,
    orderId: string,
    amountPaisa: number,
  ) {
    const reference = `release:${orderId}`;
    const existing = await tx.partnerLedgerEntry.findUnique({
      where: { reference },
    });
    if (existing) return { applied: false, reason: "ALREADY_RELEASED" };
    const account = await tx.partnerAccount.findUnique({
      where: { partnerId },
    });
    if (!account) return { applied: false, reason: "NO_ACCOUNT" };
    if (account.reservedPaisa <= 0)
      return { applied: false, reason: "NO_RESERVATION" };
    const updated = await tx.partnerAccount.updateMany({
      where: { id: account.id, version: account.version },
      data: {
        reservedPaisa: {
          decrement: Math.min(account.reservedPaisa, amountPaisa),
        },
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1)
      throw new ApiException({
        code: "PARTNER_BALANCE_CONFLICT",
        message: "Partner balance changed; retry",
        status: 409,
      });
    await tx.partnerLedgerEntry.create({
      data: {
        partnerId,
        orderId,
        type: PartnerLedgerEntryType.RELEASE,
        amountPaisa,
        balanceAfterPaisa: account.balancePaisa,
        reference,
        metadata: { settlement: "PARTNER_ACCOUNT", channel: "PARTNER_HOSTED" },
      },
    });
    return { applied: true };
  }

  private async refundDirectDebit(
    tx: Prisma.TransactionClient,
    partnerId: string,
    orderId: string,
    amountPaisa: number,
    reason: string,
  ) {
    const reference = `refund:${orderId}:${reason}`;
    const existing = await tx.partnerLedgerEntry.findUnique({
      where: { reference },
    });
    if (existing) return;
    const debit = await tx.partnerLedgerEntry.findFirst({
      where: { partnerId, orderId, type: PartnerLedgerEntryType.DEBIT },
    });
    if (!debit) return;
    const account = await tx.partnerAccount.findUnique({
      where: { partnerId },
    });
    if (!account) return;
    const balanceAfterPaisa = account.balancePaisa + amountPaisa;
    const updated = await tx.partnerAccount.updateMany({
      where: { id: account.id, version: account.version },
      data: { balancePaisa: balanceAfterPaisa, version: { increment: 1 } },
    });
    if (updated.count !== 1)
      throw new ApiException({
        code: "PARTNER_BALANCE_CONFLICT",
        message: "Partner balance changed; retry",
        status: 409,
      });
    await tx.partnerLedgerEntry.create({
      data: {
        partnerId,
        orderId,
        type: PartnerLedgerEntryType.REFUND,
        amountPaisa,
        balanceAfterPaisa,
        reference,
        metadata: { reason },
      },
    });
  }

  private async enqueuePassportOcr(orderId: string, documentId?: string) {
    const id =
      documentId ??
      (
        await this.prisma.travelerDocument.findFirst({
          where: { orderId, type: DocumentType.PASSPORT },
          select: { id: true },
        })
      )?.id;
    if (!id) return;
    try {
      await this.queues.add(
        QUEUES.documents,
        "verify-passport",
        { orderId, documentId: id },
        `order-passport-${orderId}-${id}`,
        ocrJobOptions(),
      );
    } catch (error) {
      this.logger.warn(
        `Could not enqueue passport OCR for ${id}: ${
          error instanceof Error ? error.message : "unknown"
        }`,
      );
    }
  }

  private async createEvent(
    tx: Prisma.TransactionClient,
    partnerId: string,
    orderId: string,
    type: string,
    resourceId: string,
    payload: Prisma.InputJsonValue,
  ) {
    const endpoints = await tx.partnerWebhookEndpoint.findMany({
      where: { partnerId, active: true },
    });
    const eligible = endpoints.filter((endpoint) => {
      const types = this.stringArray(endpoint.eventTypes);
      return types.includes("*") || types.includes(type);
    });
    return tx.partnerEvent.create({
      data: {
        partnerId,
        orderId,
        type,
        resourceId,
        correlationId: randomUUID(),
        payload,
        deliveries: {
          create: eligible.map((endpoint) => ({ endpointId: endpoint.id })),
        },
      },
    });
  }

  private stringArray(value: Prisma.JsonValue) {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  }

  private fulfillmentStatus(status: OrderStatus) {
    if (
      status === OrderStatus.QR_READY ||
      status === OrderStatus.ACTIVATION_ATTENTION
    )
      return "READY";
    if (status === OrderStatus.COMPLETED) return "ACTIVATED";
    if (status === OrderStatus.PROVISIONING_FAILED) return "FAILED";
    if (
      status === OrderStatus.APPROVED ||
      status === OrderStatus.PROVISIONING ||
      status === OrderStatus.PAYMENT_REVIEW_REQUIRED
    )
      return "PENDING";
    return "NOT_READY";
  }

  private hostedPaymentDeprecated() {
    return new GoneException({
      code: "HOSTED_PAYMENT_DEPRECATED",
      message:
        'Hosted payments are no longer available. Include settlement.method = "PARTNER_ACCOUNT" when creating an order.',
    });
  }
}
