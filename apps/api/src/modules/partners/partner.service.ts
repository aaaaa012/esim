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
  DocumentReviewPolicy,
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
  declarePaymentRetry,
  documentTypeLabel,
  DocumentType as SharedDocumentType,
  passportRequiresManualReview,
  RESTRICTED_PLAN_COUNTRY_CODES,
  type TravelerInput,
} from "@visa-compass/shared";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { CryptoService } from "../../infrastructure/crypto.service.js";
import { S3StorageService } from "../../infrastructure/s3-storage.service.js";
import { ApiException } from "../../common/api-error.js";
import { ConnectivityService } from "../integration/connectivity.service.js";
import { EsimUsageView, UsageService } from "../esims/usage.service.js";
import { NotificationService } from "../notification/notification.service.js";
import { PartnerWebhookProcessor } from "../../jobs/partner-webhook.processor.js";
import { QueueService } from "../../jobs/queue.service.js";
import { QUEUES } from "../../jobs/queues.js";
import {
  ocrJobOptions,
  orderPassportOcrJobId,
} from "../../jobs/ocr-recovery.config.js";
import { OrdersService } from "../orders/orders.service.js";
import { sanitizePassportExtractedFields } from "../orders/passport-verification.service.js";
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
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
  mode: "EXTRACT_FIRST";
  externalOrderId: string;
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
  customerEsim: { select: { inventoryId: true } },
} satisfies Prisma.OrderInclude;

type PartnerOrderRow = Prisma.OrderGetPayload<{
  include: typeof PARTNER_ORDER_INCLUDE;
}>;

@Injectable()
export class PartnerService {
  private readonly logger = new Logger(PartnerService.name);
  private readonly usageRefreshAt = new Map<string, number>();

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
    private readonly usageService?: UsageService,
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

  private async finalizeTravelerDocument(document: {
    id: string;
    privateAssetId: string;
  }) {
    const finalized = await this.storage.finalizeDocument(
      document.privateAssetId,
    );
    const version = await this.prisma.$transaction(async (tx) => {
      const created = await tx.documentAssetVersion.upsert({
        where: {
          documentId_sha256: {
            documentId: document.id,
            sha256: finalized.sha256,
          },
        },
        update: { supersededAt: null },
        create: {
          documentId: document.id,
          temporaryAssetId: finalized.temporaryAssetId,
          finalizedAssetId: finalized.finalizedAssetId,
          sha256: finalized.sha256,
          byteSize: finalized.byteSize,
          contentType: finalized.contentType,
          storageVersionId: finalized.storageVersionId,
        },
      });
      const activated = await tx.travelerDocument.updateMany({
        where: {
          id: document.id,
          privateAssetId: finalized.temporaryAssetId,
        },
        data: {
          privateAssetId: finalized.finalizedAssetId,
          activeAssetVersionId: created.id,
        },
      });
      if (activated.count !== 1)
        throw new ConflictException(
          "This document was replaced while its upload was being confirmed",
        );
      await tx.documentAssetVersion.updateMany({
        where: {
          documentId: document.id,
          id: { not: created.id },
          supersededAt: null,
        },
        data: { supersededAt: new Date() },
      });
      return created;
    });
    await this.storage
      .deleteDocument(finalized.temporaryAssetId)
      .catch(() => undefined);
    return { finalized, version };
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
      documentVerification: {
        recommendedMode: "EXTRACT_FIRST",
        travelerConfirmationRequired: true,
        compatibilityModes: [],
      },
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
    const storedConfig = await this.prisma.platformConfiguration.findUnique({
      where: { id: "platform" },
      select: {
        documentReviewPolicy: true,
        ocrCheckoutWaitMs: true,
      },
    });
    const config = storedConfig ?? {
      documentReviewPolicy: DocumentReviewPolicy.AUTO_OCR,
      ocrCheckoutWaitMs: 8000,
    };
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
          if (resumable && existing.mode !== "EXTRACT_FIRST")
            throw new ConflictException({
              code: "DOCUMENT_SESSION_MODE_MISMATCH",
              message:
                "The active document session uses a different verification mode",
            });
          if (resumable) {
            this.assertUploadDeclarationsMatch(existing.documents, input);
            return await this.uploadSessionResponse(existing, true);
          }
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
            mode: "EXTRACT_FIRST",
            expiresAt,
            reviewPolicy: config.documentReviewPolicy,
            checkoutReleaseAt,
            status: "AWAITING_UPLOAD",
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
          mode: "EXTRACT_FIRST",
          externalOrderId: input.externalOrderId,
          status: "AWAITING_UPLOAD",
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
      this.assertUploadDeclarationsMatch(existing.documents, input);
      return this.uploadSessionResponse(existing, true);
    }
  }

  private assertUploadDeclarationsMatch(
    existing: Array<{
      type: DocumentType;
      fileName: string;
      contentType: string;
      declaredSizeBytes: number;
    }>,
    input: UploadSessionInput,
  ) {
    const declarations = (items: typeof existing) =>
      items
        .map((item) => ({
          type: item.type,
          fileName: item.fileName,
          contentType: item.contentType,
          sizeBytes: item.declaredSizeBytes,
        }))
        .sort((left, right) => left.type.localeCompare(right.type));
    const requested = input.documents
      .map((item) => ({ ...item }))
      .sort((left, right) => left.type.localeCompare(right.type));
    if (canonicalJson(declarations(existing)) !== canonicalJson(requested))
      throw new ConflictException({
        code: "DOCUMENT_SESSION_DECLARATION_MISMATCH",
        message:
          "The active document session was created with different file declarations",
      });
  }

  private async uploadSessionResponse(
    verification: {
      id: string;
      externalOrderId: string;
      status: string;
      expiresAt: Date;
      checkoutReleaseAt: Date | null;
      mode: string;
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
      mode: verification.mode,
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
        include: { documents: true, passportExtraction: true },
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
    const travelerConfirmed = Boolean(verification.travelerSnapshot);
    const draftCreationAllowed =
      allRequiredUploadsConfirmed &&
      travelerConfirmed &&
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
      mode: verification.mode,
      reviewPolicy: verification.reviewPolicy,
      failureCode: verification.failureCode,
      expiresAt: verification.expiresAt,
      consumedAt: verification.consumedAt,
      linkedOrderId: verification.consumedOrderId,
      requiredDocuments: [DocumentType.PASSPORT, DocumentType.TICKET],
      travelerConfirmationRequired:
        verification.mode === "EXTRACT_FIRST" && !travelerConfirmed,
      suggestedTraveler: this.extractionPayload(
        verification.passportExtraction,
      ),
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
          document.verificationStatus === "REUPLOAD_REQUIRED" &&
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
    const verificationResult = document.verificationResult;
    const isReplacement =
      verificationResult !== null &&
      typeof verificationResult === "object" &&
      !Array.isArray(verificationResult) &&
      verificationResult.replacement === true;
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
      const finalized = await this.storage.finalizeDocument(
        document.privateAssetId,
      );
      const activated =
        await this.prisma.partnerDocumentUploadIntent.updateMany({
          where: {
            id: document.id,
            privateAssetId: finalized.temporaryAssetId,
            uploadVerified: false,
          },
          data: {
            uploadVerified: true,
            verificationStatus: "UPLOADED",
            temporaryAssetId: finalized.temporaryAssetId,
            privateAssetId: finalized.finalizedAssetId,
            contentSha256: finalized.sha256,
            storageVersionId: finalized.storageVersionId,
          },
        });
      if (activated.count !== 1)
        throw new ConflictException(
          "This document was replaced while its upload was being confirmed",
        );
      if (verification.consumedOrderId)
        await this.prisma.$transaction([
          this.prisma.travelerDocument.updateMany({
            where: {
              orderId: verification.consumedOrderId,
              type: document.type,
            },
            data: {
              fileName: document.fileName,
              privateAssetId: finalized.finalizedAssetId,
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
          ...(isReplacement
            ? [
                this.prisma.orderEvent.create({
                  data: {
                    orderId: verification.consumedOrderId,
                    fromStatus: OrderStatus.AWAITING_CUSTOMER,
                    toStatus: OrderStatus.REVIEW_PENDING,
                    reason: `${documentTypeLabel(document.type)} replacement uploaded and confirmed`,
                    metadata: {
                      documentType: document.type,
                      documentReviewStatus:
                        verification.reviewPolicy === "AUTO_OCR"
                          ? "OCR_PENDING"
                          : verification.reviewPolicy === "MANUAL_REVIEW"
                            ? "MANUAL_REVIEW"
                            : "SKIPPED",
                    },
                  },
                }),
              ]
            : []),
        ]);
      if (verification.consumedOrderId && isReplacement)
        await this.prisma.$transaction((tx) =>
          this.createEvent(
            tx,
            partnerId,
            verification.consumedOrderId!,
            "document.replacement_confirmed",
            document.id,
            {
              orderId: verification.consumedOrderId,
              verificationId,
              documentId: document.id,
              documentType: document.type,
            },
          ),
        );
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
    if (
      verification.reviewPolicy !== "AUTO_OCR" &&
      verification.mode !== "EXTRACT_FIRST"
    ) {
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
      const passportAttempt = verification.documents.find(
        (item) => item.type === DocumentType.PASSPORT,
      );
      const attemptKey = createHash("sha256")
        .update(passportAttempt?.privateAssetId ?? document.privateAssetId)
        .digest("hex")
        .slice(0, 16);
      await this.queues.add(
        QUEUES.documents,
        "verify-partner-documents",
        { verificationId },
        `document-verification-${verificationId}-${attemptKey}`,
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

  async confirmExtractedTraveler(
    partnerId: string,
    verificationId: string,
    traveler: TravelerInput,
  ) {
    const verification =
      await this.prisma.partnerDocumentVerification.findFirst({
        where: { id: verificationId, partnerId },
        include: { documents: true, passportExtraction: true },
      });
    if (!verification)
      throw new NotFoundException({
        code: "DOCUMENT_VERIFICATION_NOT_FOUND",
        message: "Document verification not found",
      });
    if (verification.mode !== "EXTRACT_FIRST")
      throw new ApiException({
        code: "TRAVELER_CONFIRMATION_NOT_APPLICABLE",
        message: "This verification uses the traveler-first compatibility flow",
        status: 409,
      });
    if (verification.expiresAt <= new Date() || verification.consumedAt)
      throw new GoneException({
        code: "DOCUMENT_VERIFICATION_EXPIRED",
        message: "This document verification can no longer be updated",
      });
    if (
      !verification.passportExtraction ||
      !["READY", "PARTIAL", "MANUAL_ENTRY_REQUIRED", "SKIPPED"].includes(
        verification.passportExtraction.status,
      )
    )
      throw new ApiException({
        code: "PASSPORT_EXTRACTION_NOT_READY",
        message:
          "Wait for passport extraction before confirming traveler details",
        status: 409,
      });
    const requiredUploadsPresent = [
      DocumentType.PASSPORT,
      DocumentType.TICKET,
    ].every((type) =>
      verification.documents.some(
        (document) => document.type === type && document.uploadVerified,
      ),
    );
    if (!requiredUploadsPresent)
      throw new ApiException({
        code: "DOCUMENT_UPLOADS_INCOMPLETE",
        message: "Passport and ticket uploads must be confirmed first",
        status: 409,
      });

    const confirmedAt = new Date();
    const automationUnavailable = passportRequiresManualReview(
      verification.passportExtraction.failureCode,
    );
    const claimed = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.partnerDocumentVerification.updateMany({
        where: {
          id: verification.id,
          partnerId,
          mode: "EXTRACT_FIRST",
          travelerSnapshot: { equals: Prisma.DbNull },
          status: {
            in: [
              "AWAITING_TRAVELER_CONFIRMATION",
              "MANUAL_ENTRY_REQUIRED",
              "SKIPPED",
            ],
          },
        },
        data: {
          travelerSnapshot: this.travelerData(
            traveler,
          ) as unknown as Prisma.InputJsonValue,
          status:
            verification.reviewPolicy === "AUTO_OCR"
              ? automationUnavailable
                ? "MANUAL_REVIEW"
                : "PROCESSING"
              : verification.reviewPolicy === "NO_REVIEW"
                ? "SKIPPED"
                : "MANUAL_REVIEW",
          failureCode: automationUnavailable
            ? "OCR_EVIDENCE_UNAVAILABLE_MANUAL_REVIEW"
            : null,
        },
      });
      if (claim.count)
        await Promise.all([
          tx.passportExtraction.update({
            where: { partnerVerificationId: verification.id },
            data: { confirmedAt },
          }),
          tx.partnerTravelerRevision.create({
            data: {
              verificationId: verification.id,
              version: 1,
              idempotencyKeyHash: createHash("sha256")
                .update(`initial:${verification.id}`)
                .digest("hex"),
              reason: "Initial traveller confirmation",
              travelerSnapshot: this.travelerData(
                traveler,
              ) as unknown as Prisma.InputJsonValue,
            },
          }),
        ]);
      return claim.count === 1;
    });
    if (!claimed) {
      const current = await this.prisma.partnerDocumentVerification.findUnique({
        where: { id: verification.id },
        select: { travelerSnapshot: true, status: true },
      });
      if (current?.travelerSnapshot) {
        const requested = this.travelerData(traveler);
        if (
          canonicalJson(current.travelerSnapshot) !== canonicalJson(requested)
        )
          throw new ConflictException({
            code: "TRAVELER_ALREADY_CONFIRMED",
            message:
              "Traveller details were already confirmed with different values; retrieve the verification before correcting them",
          });
        return {
          id: verification.id,
          status: current.status,
          confirmed: true,
          replayed: true,
        };
      }
      throw new ConflictException({
        code: "TRAVELER_CONFIRMATION_CONFLICT",
        message: "The verification changed; retrieve it before trying again",
      });
    }
    if (verification.reviewPolicy === "AUTO_OCR" && !automationUnavailable) {
      try {
        const attemptKey = createHash("sha256")
          .update(
            `${verification.passportExtraction.passportAssetId}:${confirmedAt.toISOString()}`,
          )
          .digest("hex")
          .slice(0, 16);
        await this.queues.add(
          QUEUES.documents,
          "verify-partner-documents",
          { verificationId },
          `document-verification-${verificationId}-${attemptKey}`,
          ocrJobOptions(),
        );
      } catch (error) {
        await this.prisma.partnerDocumentVerification.updateMany({
          where: { id: verification.id, status: "PROCESSING" },
          data: { failureCode: "QUEUE_UNAVAILABLE" },
        });
        this.logger.error(
          `Could not queue confirmed traveler verification ${verificationId}: ${error instanceof Error ? error.message : "unknown"}`,
        );
        return {
          id: verification.id,
          status: "PROCESSING",
          confirmed: true,
          verificationQueued: false,
        };
      }
    }
    return {
      id: verification.id,
      status:
        verification.reviewPolicy === "AUTO_OCR"
          ? automationUnavailable
            ? "MANUAL_REVIEW"
            : "PROCESSING"
          : verification.reviewPolicy === "NO_REVIEW"
            ? "SKIPPED"
            : "MANUAL_REVIEW",
      confirmed: true,
      verificationQueued:
        verification.reviewPolicy === "AUTO_OCR" && !automationUnavailable,
    };
  }

  async correctExtractedTraveler(
    partnerId: string,
    verificationId: string,
    input: { traveler: TravelerInput; reason: string },
    idempotencyKey: string,
  ) {
    if (
      !idempotencyKey ||
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 200
    )
      throw new BadRequestException({
        code: "INVALID_IDEMPOTENCY_KEY",
        message: "Idempotency-Key is required for a traveler correction",
      });
    const keyHash = createHash("sha256").update(idempotencyKey).digest("hex");
    const snapshot = this.travelerData(
      input.traveler,
    ) as unknown as Prisma.InputJsonValue;
    const revision = await this.prisma.$transaction(async (tx) => {
      const verification = await tx.partnerDocumentVerification.findFirst({
        where: { id: verificationId, partnerId },
        include: {
          passportExtraction: true,
          travelerRevisions: { orderBy: { version: "desc" }, take: 1 },
        },
      });
      if (!verification)
        throw new NotFoundException({
          code: "DOCUMENT_VERIFICATION_NOT_FOUND",
          message: "Document verification not found",
        });
      const replay = await tx.partnerTravelerRevision.findUnique({
        where: {
          verificationId_idempotencyKeyHash: {
            verificationId,
            idempotencyKeyHash: keyHash,
          },
        },
      });
      if (replay) return { ...replay, replayed: true };
      if (verification.expiresAt <= new Date() || verification.consumedAt)
        throw new GoneException({
          code: "DOCUMENT_VERIFICATION_EXPIRED",
          message: "This document verification can no longer be corrected",
        });
      if (
        verification.mode !== "EXTRACT_FIRST" ||
        verification.status !== "MANUAL_REVIEW" ||
        verification.failureCode !== "TRAVELLER_DETAILS_UNCONFIRMED"
      )
        throw new ConflictException({
          code: "TRAVELER_CORRECTION_NOT_ALLOWED",
          message: "Corrections are accepted only after a details mismatch",
        });
      const latestVersion = verification.travelerRevisions[0]?.version ?? 0;
      if (latestVersion >= 4)
        throw new ApiException({
          code: "TRAVELER_CORRECTION_LIMIT_REACHED",
          message:
            "The correction limit has been reached; manual review is required",
          status: 409,
        });
      const claim = await tx.partnerDocumentVerification.updateMany({
        where: {
          id: verificationId,
          partnerId,
          status: "MANUAL_REVIEW",
          failureCode: "TRAVELLER_DETAILS_UNCONFIRMED",
        },
        data: {
          travelerSnapshot: snapshot,
          status: "PROCESSING",
          failureCode: null,
        },
      });
      if (claim.count !== 1)
        throw new ConflictException({
          code: "TRAVELER_CORRECTION_CONFLICT",
          message: "Another correction or review decision was accepted first",
        });
      return {
        ...(await tx.partnerTravelerRevision.create({
          data: {
            verificationId,
            version: latestVersion + 1,
            idempotencyKeyHash: keyHash,
            reason: input.reason,
            travelerSnapshot: snapshot,
          },
        })),
        replayed: false,
      };
    });
    if (!revision.replayed) {
      const extraction = await this.prisma.passportExtraction.findUnique({
        where: { partnerVerificationId: verificationId },
      });
      await this.queues.add(
        QUEUES.documents,
        "verify-partner-documents",
        { verificationId },
        `document-verification-${verificationId}-revision-${revision.version}-${createHash(
          "sha256",
        )
          .update(extraction?.passportAssetId ?? verificationId)
          .digest("hex")
          .slice(0, 16)}`,
        ocrJobOptions(),
      );
    }
    return {
      verificationId,
      revision: revision.version,
      status: "PROCESSING",
      replayed: revision.replayed,
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
    await this.prisma.$transaction(async (tx) => {
      await tx.partnerDocumentUploadIntent.update({
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
      });
      await tx.partnerDocumentVerification.update({
        where: { id: verification.id },
        data: { status: "AWAITING_UPLOAD", failureCode: null },
      });
      await tx.orderEvent.create({
        data: {
          orderId,
          fromStatus: order.status,
          toStatus: order.status,
          reason: `${documentTypeLabel(input.type)} replacement requested`,
          metadata: {
            documentType: input.type,
            documentReviewStatus: "REUPLOAD_REQUIRED",
          },
        },
      });
      await this.createEvent(
        tx,
        partnerId,
        orderId,
        "document.replacement_declared",
        intent.id,
        {
          orderId,
          verificationId: verification.id,
          documentId: intent.id,
          documentType: input.type,
        },
      );
    });
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
    if (!verification.travelerSnapshot)
      throw new ApiException({
        code: "TRAVELER_CONFIRMATION_REQUIRED",
        message:
          "Confirm the complete traveler record before placing the order",
        status: 409,
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
      const persistedDocuments = await tx.travelerDocument.findMany({
        where: { orderId },
        select: { id: true, type: true, privateAssetId: true },
      });
      for (const persisted of persistedDocuments) {
        const intent = currentIntents.find(
          (candidate) => candidate.type === persisted.type,
        );
        if (!intent?.contentSha256)
          throw new ApiException({
            code: "DOCUMENT_FINALIZATION_REQUIRED",
            message:
              "A confirmed document is missing its immutable integrity record; confirm the upload again",
            status: 409,
          });
        const version = await tx.documentAssetVersion.create({
          data: {
            documentId: persisted.id,
            temporaryAssetId: intent.temporaryAssetId ?? intent.privateAssetId,
            finalizedAssetId: persisted.privateAssetId,
            sha256: intent.contentSha256,
            byteSize: intent.declaredSizeBytes,
            contentType: intent.contentType,
            storageVersionId: intent.storageVersionId,
          },
        });
        await tx.travelerDocument.update({
          where: { id: persisted.id },
          data: { activeAssetVersionId: version.id },
        });
      }
      await this.reserveAccount(
        tx,
        partnerId,
        orderId,
        amountPaisa,
        input.externalOrderId,
      );
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
      await this.captureOrDebitAccount(
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
          "This eSIM MSISDN cannot be used for a top-up with the selected plan. Create a documented initial purchase only after customer consent.",
        status: 422,
      });
    if (!target.customerId)
      throw new ApiException({
        code: "TOPUP_NOT_ELIGIBLE",
        message: "This eSIM cannot receive the selected package.",
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
          // A top-up may be purchased through any channel. Keep the order and
          // resulting CustomerEsim attached to the established eSIM owner;
          // partnerCustomerId separately records who initiated the purchase.
          customerId: target.customerId,
          targetInventoryId: inventory.id,
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
    const [debits, credits, refunds, adjustments, orderGroups] =
      await Promise.all([
        this.prisma.partnerLedgerEntry.aggregate({
          where: {
            partnerId,
            type: {
              in: [
                PartnerLedgerEntryType.DEBIT,
                PartnerLedgerEntryType.CAPTURE,
              ],
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
        this.prisma.order.groupBy({
          by: ["status"],
          where: { partnerId },
          _count: { _all: true },
          _sum: { totalAmount: true },
        }),
      ]);
    const ordersByStatus = orderGroups.reduce<Record<string, number>>(
      (result, group) => ({
        ...result,
        [group.status]: group._count._all,
      }),
      {},
    );
    const ordersCreated = orderGroups.reduce(
      (total, group) => total + group._count._all,
      0,
    );
    const totalOrderValuePaisa = orderGroups.reduce(
      (total, group) =>
        total + Math.round(Number(group._sum.totalAmount ?? 0) * 100),
      0,
    );
    return {
      currency: "NPR",
      balancePaisa: account.balancePaisa,
      reservedPaisa: account.reservedPaisa,
      creditLimitPaisa: 0,
      availableBalancePaisa: Math.max(
        0,
        account.balancePaisa - account.reservedPaisa,
      ),
      totalDebitsPaisa: debits._sum.amountPaisa ?? 0,
      totalCreditsPaisa: credits._sum.amountPaisa ?? 0,
      totalRefundedPaisa: refunds._sum.amountPaisa ?? 0,
      totalAdjustedPaisa: adjustments._sum.amountPaisa ?? 0,
      ordersCreated,
      ordersByStatus,
      fulfilledOrders:
        (ordersByStatus.QR_READY ?? 0) + (ordersByStatus.COMPLETED ?? 0),
      failedOrders: ordersByStatus.PROVISIONING_FAILED ?? 0,
      totalOrderValuePaisa,
      averageOrderValuePaisa: ordersCreated
        ? Math.round(totalOrderValuePaisa / ordersCreated)
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
      type?:
        | "CREDIT"
        | "DEBIT"
        | "RESERVATION"
        | "CAPTURE"
        | "RELEASE"
        | "REFUND"
        | "ADJUSTMENT"
        | undefined;
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
    if (order.orderType === "TOPUP")
      throw new ApiException({
        code: "PARTNER_ESIM_MANAGEMENT_NOT_GRANTED",
        message:
          "A top-up purchase does not grant access to eSIM activation details.",
        status: 403,
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
      esimId: order.customerEsim.inventory.id,
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
      const saved = await tx.travelerDocument.upsert({
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
      if (input.type === DocumentType.PASSPORT)
        await tx.order.update({
          where: { id: order.id },
          data: {
            documentReviewStatus: "NOT_STARTED",
            documentReviewStartedAt: null,
            documentCheckoutReleaseAt: null,
          },
        });
      if (input.type === DocumentType.PASSPORT)
        await tx.passportExtraction.deleteMany({
          where: { orderId: order.id },
        });
      return saved;
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
    const { finalized } = await this.finalizeTravelerDocument(document);
    await this.prisma.travelerDocument.update({
      where: { id: document.id },
      data: { uploadVerified: true },
    });
    // Any required evidence replacement invalidates the order verdict. When a
    // ticket is the replaced file, rerun verification against the current
    // passport as well; otherwise the order can remain at NOT_STARTED forever.
    // Use a distinct OCR job key for the ticket so the run is never deduplicated
    // against the earlier passport job and the replacement ticket is
    // re-validated.
    await this.enqueuePassportOcr(
      orderId,
      document.type === DocumentType.PASSPORT ? documentId : undefined,
      document.type === DocumentType.TICKET
        ? `replacement:${document.id}:${finalized.finalizedAssetId}`
        : undefined,
    );
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
    const isTopUp = Boolean(
      topUp?.customerId && topUp.inventory && eligibility?.allowed,
    );
    if (input.topUpMobile && !isTopUp && !input.allowInitialPurchaseFallback)
      throw new ApiException({
        code: "TOPUP_NOT_ELIGIBLE",
        message:
          eligibility?.errorMessage ??
          "This eSIM MSISDN cannot be used for a top-up with the selected plan. Ask the customer whether they want a new eSIM purchase instead.",
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
          // Hosted checkout is a sales channel, not an ownership transfer.
          // The beneficiary remains the established owner of the target eSIM,
          // while partnerCustomerId records the partner-side purchaser.
          customerId:
            isTopUp && topUp?.customerId
              ? topUp.customerId
              : partnerCustomer.customerId,
          ...(isTopUp && topUp?.inventory
            ? { targetInventoryId: topUp.inventory.id }
            : {}),
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
            msisdn: input.topUpMobile,
            // Retained for Partner API v1 response compatibility.
            mobile: input.topUpMobile,
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
        traveler: true,
        passportExtraction: true,
        documents: {
          select: {
            id: true,
            type: true,
            status: true,
            fileName: true,
            uploadVerified: true,
            passportVerificationStatus: true,
          },
        },
        partner: { select: { name: true, slug: true, brand: true } },
        payments: { orderBy: { createdAt: "desc" }, take: 1 },
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
              traveler: true,
              passportExtraction: true,
              documents: {
                select: {
                  id: true,
                  type: true,
                  status: true,
                  fileName: true,
                  uploadVerified: true,
                  passportVerificationStatus: true,
                },
              },
              partner: { select: { name: true, slug: true, brand: true } },
              payments: { orderBy: { createdAt: "desc" }, take: 1 },
            },
          })) ?? order;
    }
    const topUpSnapshot = order.pricingSnapshot as {
      topUpMobile?: string;
    } | null;
    const topUpMsisdn = topUpSnapshot?.topUpMobile;
    const topUpMsisdnMasked = topUpMsisdn
      ? `••••${topUpMsisdn.replace(/\D/g, "").slice(-4)}`
      : undefined;
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
        ...(order.orderType === "TOPUP" && topUpMsisdnMasked
          ? { topUpMsisdnMasked }
          : {}),
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
        traveler: order.traveler ? this.decryptTraveler(order.traveler) : null,
        passportExtraction: this.extractionPayload(
          "passportExtraction" in order ? order.passportExtraction : null,
        ),
        documents: order.documents,
        documentReviewStatus: order.documentReviewStatus,
        requiredDocuments,
        paymentRetry: declarePaymentRetry({
          status: order.status,
          payment: order.payments?.[0]
            ? {
                status: order.payments[0]!.status,
                ...(order.payments[0]!.expiresAt
                  ? { expiresAt: order.payments[0]!.expiresAt.toISOString() }
                  : {}),
              }
            : null,
        }),
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
        uploadVerified: true,
        passportVerificationStatus: true,
      },
    });
    return { documents };
  }

  async setHostedTraveler(token: string, traveler: TravelerInput) {
    const order = await this.sessionOrder(token, [OrderStatus.DRAFT]);
    const retryExistingPassport =
      order.documentReviewStatus === "REUPLOAD_REQUIRED" ||
      (order.documentReviewStatus === "MANUAL_REVIEW" &&
        ["PARTIAL", "FAILED"].includes(
          order.documents.find((document) => document.type === "PASSPORT")
            ?.passportVerificationStatus ?? "",
        ));
    await this.prisma.$transaction(async (tx) => {
      await this.bumpInTransaction(tx, order.id, order.version);
      if (retryExistingPassport) {
        await tx.order.update({
          where: { id: order.id },
          data: {
            documentReviewStatus: "NOT_STARTED",
            documentReviewStartedAt: null,
            documentCheckoutReleaseAt: null,
          },
        });
        await tx.travelerDocument.updateMany({
          where: { orderId: order.id, type: DocumentType.PASSPORT },
          data: {
            status: DocumentStatus.PENDING,
            passportVerificationStatus: null,
            passportVerificationMethod: null,
            passportMatchedFields: Prisma.DbNull,
            passportConfidence: null,
            passportVerifiedAt: null,
          },
        });
      }
      await tx.traveler.upsert({
        where: { orderId: order.id },
        update: this.travelerData(traveler),
        create: { orderId: order.id, ...this.travelerData(traveler) },
      });
      if (!retryExistingPassport)
        await tx.passportExtraction.updateMany({
          where: { orderId: order.id, confirmedAt: null },
          data: { confirmedAt: new Date() },
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
      const saved = await tx.travelerDocument.upsert({
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
      // Passport OCR owns the aggregate review status. An optional visa must
      // never reset a verified passport or requeue an already-consumed OCR job.
      if (input.type === DocumentType.PASSPORT)
        await tx.order.update({
          where: { id: order.id },
          data: {
            documentReviewStatus: "NOT_STARTED",
            documentReviewStartedAt: null,
            documentCheckoutReleaseAt: null,
          },
        });
      if (input.type === DocumentType.PASSPORT)
        await tx.passportExtraction.deleteMany({
          where: { orderId: order.id },
        });
      return saved;
    });
    return {
      id: document.id,
      type: document.type,
      status: document.status,
      upload: signed.upload,
    };
  }

  async confirmHostedDocument(token: string, documentId: string) {
    const order = await this.sessionOrder(token, [
      OrderStatus.DRAFT,
      OrderStatus.AWAITING_CUSTOMER,
    ]);
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
    await this.finalizeTravelerDocument(document);
    await this.prisma.travelerDocument.update({
      where: { id: document.id },
      data: { uploadVerified: true },
    });
    const remainingRequired = this.requiredDocuments(
      order.plan.country.isoCode,
    ).filter(
      (type) =>
        !order.documents.some(
          (item) =>
            item.type === type &&
            (item.id === document.id || item.uploadVerified),
        ),
    );
    if (remainingRequired.length === 0) await this.verifyHostedPassport(token);
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
    const order = await this.sessionOrder(token, [
      OrderStatus.DRAFT,
      OrderStatus.AWAITING_CUSTOMER,
    ]);
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
    const updated = await this.applicationOrders.verifyPassport(order.id, null);
    return {
      status: updated.documentReviewStatus ?? "NOT_STARTED",
      passportExtraction: updated.passportExtraction ?? null,
      ...(updated.passportVerification ?? {}),
    };
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

  async hostedCheckoutTelemetry(token: string, body: unknown) {
    const session = await this.hostedCheckoutSession(token);
    if (!this.payments) return this.hostedPaymentDeprecated();
    return this.payments.recordFonepayClientTelemetry(
      session.orderId,
      null,
      body,
    );
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

  /** Releases prepaid funds left behind when an API order becomes terminal. */
  async reconcileApiReservations(): Promise<{
    released: number;
    skipped: number;
  }> {
    const reservations = await this.prisma.partnerLedgerEntry.findMany({
      where: {
        type: PartnerLedgerEntryType.RESERVATION,
        order: {
          channel: OrderChannel.PARTNER_API,
          status: OrderStatus.CANCELLED,
          partnerLedgerEntries: {
            none: {
              type: {
                in: [
                  PartnerLedgerEntryType.CAPTURE,
                  PartnerLedgerEntryType.RELEASE,
                ],
              },
            },
          },
        },
      },
      select: {
        partnerId: true,
        orderId: true,
        amountPaisa: true,
      },
      take: 100,
    });
    let released = 0;
    let skipped = 0;
    for (const reservation of reservations) {
      if (!reservation.orderId) {
        skipped += 1;
        continue;
      }
      try {
        const result = await this.prisma.$transaction((tx) =>
          this.releaseReservation(
            tx,
            reservation.partnerId,
            reservation.orderId!,
            reservation.amountPaisa,
          ),
        );
        if (result.applied) released += 1;
        else skipped += 1;
      } catch (error) {
        this.logger.warn(
          `API partner reservation release failed for ${reservation.orderId}: ${error instanceof Error ? error.message : "unknown"}`,
        );
        skipped += 1;
      }
    }
    return { released, skipped };
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
          await this.releaseOrRefundAccount(
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

  async events(
    partnerId: string,
    orderId: string,
    input: { cursor?: string | undefined; limit?: number | undefined },
  ) {
    const ownedOrder = await this.prisma.order.findFirst({
      where: { id: orderId, partnerId },
      select: { id: true },
    });
    if (!ownedOrder)
      throw new ApiException({
        code: "PARTNER_ORDER_NOT_FOUND",
        message: "Order not found",
        status: 404,
      });
    const bound = decodeCursor(input.cursor);
    const limit = input.limit ?? 50;
    const rows = await this.prisma.partnerEvent.findMany({
      where: {
        partnerId,
        orderId,
        ...(bound
          ? {
              OR: [
                { occurredAt: { gt: bound.createdAt } },
                { occurredAt: bound.createdAt, id: { gt: bound.id } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        type: true,
        version: true,
        resourceId: true,
        correlationId: true,
        payload: true,
        occurredAt: true,
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: limit + 1,
    });
    const more = rows.length > limit;
    const items = rows.slice(0, limit);
    return {
      items,
      nextCursor: more
        ? (encodeCursor(items.at(-1)?.occurredAt, items.at(-1)?.id) ?? null)
        : null,
    };
  }

  async usage(partnerId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, partnerId },
      include: { customerEsim: true },
    });
    if (!order)
      throw new ApiException({
        code: "PARTNER_ORDER_NOT_FOUND",
        message: "Order not found",
        status: 404,
      });
    if (!order.customerEsim)
      throw new ApiException({
        code: "PARTNER_USAGE_UNAVAILABLE",
        message: "Usage details are available once the eSIM is provisioned",
        status: 409,
      });
    await this.authorizePartnerEsim(partnerId, order.customerEsim.inventoryId);
    if (!this.usageService) return this.connectivity.getUsage(orderId);
    return this.partnerUsageView(
      partnerId,
      await this.usageService.cached(order.customerEsim.inventoryId),
      orderId,
    );
  }

  async usageByEsim(partnerId: string, esimId: string) {
    await this.authorizePartnerEsim(partnerId, esimId);
    if (!this.usageService)
      throw new ApiException({
        code: "PARTNER_USAGE_UNAVAILABLE",
        message: "Usage service is unavailable",
        status: 503,
      });
    return this.partnerUsageView(
      partnerId,
      await this.usageService.cached(esimId),
    );
  }

  async customerUsage(partnerId: string, externalCustomerId: string) {
    const usageService = this.usageService;
    if (!usageService)
      throw new ApiException({
        code: "PARTNER_USAGE_UNAVAILABLE",
        message: "Usage service is unavailable",
        status: 503,
      });
    const partnerCustomer = await this.prisma.partnerCustomer.findUnique({
      where: {
        partnerId_externalCustomerId: { partnerId, externalCustomerId },
      },
      select: { id: true, customerId: true },
    });
    if (!partnerCustomer)
      throw new ApiException({
        code: "PARTNER_CUSTOMER_NOT_FOUND",
        message: "Customer not found",
        status: 404,
      });
    const links = await this.prisma.customerEsim.findMany({
      where: { customerId: partnerCustomer.customerId },
      select: { inventoryId: true },
      distinct: ["inventoryId"],
    });
    const esims = await Promise.all(
      links.map(async (link) =>
        this.partnerUsageView(
          partnerId,
          await usageService.cached(link.inventoryId),
        ),
      ),
    );
    return { externalCustomerId, esims };
  }

  async refreshOrderUsage(partnerId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, partnerId },
      include: { customerEsim: true },
    });
    if (!order?.customerEsim)
      throw new ApiException({
        code: "PARTNER_ORDER_NOT_FOUND",
        message: "Order or provisioned eSIM was not found",
        status: 404,
      });
    await this.authorizePartnerEsim(partnerId, order.customerEsim.inventoryId);
    return this.refreshPartnerEsim(
      partnerId,
      order.customerEsim.inventoryId,
      orderId,
    );
  }

  async refreshEsimUsage(partnerId: string, esimId: string) {
    await this.authorizePartnerEsim(partnerId, esimId);
    return this.refreshPartnerEsim(partnerId, esimId);
  }

  private async refreshPartnerEsim(
    partnerId: string,
    esimId: string,
    anchorOrderId?: string,
  ) {
    if (!this.usageService)
      throw new ApiException({
        code: "PARTNER_USAGE_UNAVAILABLE",
        message: "Usage service is unavailable",
        status: 503,
      });
    const cooldownKey = `${partnerId}:${esimId}`;
    const previous = this.usageRefreshAt.get(cooldownKey) ?? 0;
    const remainingMs = 30_000 - (Date.now() - previous);
    if (!this.queues.enabled && remainingMs > 0)
      throw new ApiException({
        code: "PARTNER_USAGE_REFRESHED_RECENTLY",
        message: `Usage was refreshed recently. Retry in ${Math.ceil(remainingMs / 1000)} seconds.`,
        status: 429,
      });
    const rate = await this.queues.consumeRateLimit(
      `partner-usage-refresh:${cooldownKey}`,
      30_000,
    );
    if (rate.count > 1)
      throw new ApiException({
        code: "PARTNER_USAGE_REFRESHED_RECENTLY",
        message: `Usage was refreshed recently. Retry in ${rate.retryAfterSeconds} seconds.`,
        status: 429,
      });
    this.usageRefreshAt.set(cooldownKey, Date.now());
    try {
      const result = await this.usageService.refresh(esimId);
      return {
        ...this.partnerUsageView(partnerId, result, anchorOrderId),
        refreshResult: "SUCCESS",
      };
    } catch {
      const cached = await this.usageService.cached(esimId);
      if (!cached.summary.confirmedPackageCount)
        throw new ApiException({
          code: "PARTNER_USAGE_UNAVAILABLE",
          message: "Live usage and a confirmed cached balance are unavailable",
          status: 503,
        });
      return {
        ...this.partnerUsageView(
          partnerId,
          { ...cached, freshness: "STALE" },
          anchorOrderId,
        ),
        refreshResult: "PROVIDER_UNAVAILABLE",
        message:
          "Transatel could not confirm the latest balance. Last-known usage is shown.",
      };
    }
  }

  private async authorizePartnerEsim(partnerId: string, esimId: string) {
    const link = await this.prisma.customerEsim.findFirst({
      // Buying a top-up for an eSIM is intentionally allowed across channels,
      // but it does not grant the purchasing partner management or usage
      // access. That access exists only when this partner supplied the
      // physical eSIM through an initial-purchase order.
      where: {
        inventoryId: esimId,
        order: { partnerId, orderType: "INITIAL_PURCHASE" },
      },
      select: { id: true },
    });
    if (!link)
      throw new ApiException({
        code: "PARTNER_ESIM_NOT_FOUND",
        message: "eSIM not found",
        status: 404,
      });
  }

  private partnerUsageView(
    partnerId: string,
    view: EsimUsageView,
    anchorOrderId?: string,
  ) {
    const packages = view.packages.map((item) => {
      const owned = item.partnerId === partnerId;
      const common = {
        packageReference: item.packageReference,
        ownedByRequester: owned,
        plan: item.plan,
        status: item.status,
        balanceStatus: item.balanceStatus,
        usedMb: item.usedMb,
        totalMb: item.totalMb,
        remainingMb: item.remainingMb,
        activatedAt: item.activatedAt,
        expiresAt: item.expiresAt,
        lastConfirmedAt: item.lastConfirmedAt,
      };
      return owned
        ? {
            ...common,
            orderId: item.orderId,
            orderNumber: item.orderNumber,
            externalOrderId: item.externalOrderId,
            purchaseType: item.purchaseType,
            providerSubscriptionId: item.providerSubscriptionId,
          }
        : common;
    });
    const anchor = anchorOrderId
      ? packages.find(
          (item) => "orderId" in item && item.orderId === anchorOrderId,
        )
      : undefined;
    return {
      scope: "PHYSICAL_ESIM",
      anchorOrderId: anchorOrderId ?? null,
      esim: {
        id: view.esim.id,
        iccid: view.esim.iccid,
        msisdn: view.esim.msisdn,
        status: view.esim.status,
      },
      usageStatus: view.usageStatus,
      completeness: view.completeness,
      freshness: view.freshness,
      lastConfirmedAt: view.lastConfirmedAt,
      oldestConfirmedAt: view.oldestConfirmedAt,
      summary: view.summary,
      packages,
      // Additive V1 compatibility aliases.
      usedMb: view.summary.usedMb,
      totalMb: view.summary.totalMb,
      usageAvailable: view.usageStatus === "AVAILABLE",
      subscriptions: packages,
      ...(anchor ? { anchorPackage: anchor } : {}),
    };
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
    const isTopUp = order.orderType === "TOPUP";
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      externalOrderId: order.externalOrderId,
      // A blind top-up exposes the purchased order, not the beneficiary's
      // internal eSIM identifier or management surfaces.
      esimId: isTopUp ? null : (order.customerEsim?.inventoryId ?? null),
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
      requiredDocuments: isTopUp
        ? []
        : [DocumentType.PASSPORT, DocumentType.TICKET],
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
        ...(!isTopUp
          ? {
              esim: `/api/v1/partners/orders/${order.id}/esim`,
              usage: `/api/v1/partners/orders/${order.id}/usage`,
            }
          : {}),
      },
      esimDetailsAvailable:
        !isTopUp &&
        (order.status === OrderStatus.QR_READY ||
          order.status === OrderStatus.ACTIVATION_ATTENTION ||
          order.status === OrderStatus.COMPLETED),
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
        passportExtraction: true,
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
    orderId: string,
    amountPaisa: number,
    externalOrderId: string,
  ) {
    const account = await tx.partnerAccount.upsert({
      where: { partnerId },
      update: {},
      create: { partnerId },
    });
    const reservedPaisa = account.reservedPaisa ?? 0;
    const available = account.balancePaisa - reservedPaisa;
    if (available < amountPaisa)
      throw new ApiException({
        code: "INSUFFICIENT_PARTNER_BALANCE",
        message: `Partner balance is insufficient. Required NPR ${(amountPaisa / 100).toFixed(2)}; available NPR ${(Math.max(0, available) / 100).toFixed(2)}.`,
        status: 402,
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
        orderId,
        type: PartnerLedgerEntryType.RESERVATION,
        amountPaisa,
        balanceAfterPaisa: account.balancePaisa,
        reference: `reserve:${partnerId}:${externalOrderId}`,
        metadata: { settlement: "PARTNER_ACCOUNT", channel: "PARTNER_API" },
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
    const reservedPaisa = account.reservedPaisa ?? 0;
    const available = account.balancePaisa - reservedPaisa;
    if (available < amountPaisa)
      throw new ApiException({
        code: "INSUFFICIENT_PARTNER_BALANCE",
        message: `Partner balance is insufficient. Required NPR ${(amountPaisa / 100).toFixed(2)}; available NPR ${(Math.max(0, available) / 100).toFixed(2)}.`,
        status: 402,
      });
    const balanceAfterPaisa = account.balancePaisa - amountPaisa;
    const updated = await tx.partnerAccount.updateMany({
      where: {
        id: account.id,
        version: account.version,
        balancePaisa: { gte: amountPaisa + reservedPaisa },
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
        metadata: { settlement: "PARTNER_ACCOUNT" },
      },
    });
    return { applied: true };
  }

  private async captureOrDebitAccount(
    tx: Prisma.TransactionClient,
    partnerId: string,
    orderId: string,
    amountPaisa: number,
    externalOrderId: string,
  ) {
    const reservation = await tx.partnerLedgerEntry.findFirst({
      where: {
        partnerId,
        orderId,
        type: PartnerLedgerEntryType.RESERVATION,
      },
      select: { id: true },
    });
    if (reservation)
      return this.captureAccount(tx, partnerId, orderId, amountPaisa);
    await this.debitAccount(
      tx,
      partnerId,
      orderId,
      amountPaisa,
      externalOrderId,
    );
    return { applied: true, legacyDirectDebit: true };
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

  private extractionPayload(
    extraction: {
      status: string;
      payloadEncrypted: string | null;
      fieldsRequiringInput: Prisma.JsonValue;
      failureCode: string | null;
    } | null,
  ) {
    if (!extraction) return null;
    let fields: Partial<Record<string, string>> = {};
    if (extraction.payloadEncrypted) {
      try {
        const parsed = JSON.parse(
          this.crypto.decrypt(extraction.payloadEncrypted),
        ) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          fields = sanitizePassportExtractedFields(
            Object.fromEntries(
              Object.entries(parsed).filter(
                ([, value]) => typeof value === "string",
              ),
            ),
          );
      } catch (error) {
        this.logger.error(
          `Could not decrypt passport extraction: ${error instanceof Error ? error.message : "unknown"}`,
        );
        return {
          status: "MANUAL_ENTRY_REQUIRED",
          fields: {},
          fieldsRequiringInput: [
            "firstName",
            "surname",
            "dateOfBirth",
            "nationality",
            "passportNumber",
            "passportExpiryDate",
          ],
          failureCode: "EXTRACTION_PAYLOAD_UNAVAILABLE",
        };
      }
    }
    return {
      status: extraction.status,
      fields,
      fieldsRequiringInput: Array.isArray(extraction.fieldsRequiringInput)
        ? extraction.fieldsRequiringInput.filter(
            (field): field is string => typeof field === "string",
          )
        : [],
      failureCode: extraction.failureCode,
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
    if (account.reservedPaisa < amountPaisa)
      throw new ApiException({
        code: "PARTNER_BALANCE_CONFLICT",
        message: "The reserved balance no longer covers this order",
        status: 409,
      });
    const updated = await tx.partnerAccount.updateMany({
      where: {
        id: account.id,
        version: account.version,
        reservedPaisa: { gte: amountPaisa },
      },
      data: {
        reservedPaisa: { decrement: amountPaisa },
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
        metadata: { settlement: "PARTNER_ACCOUNT" },
      },
    });
    return { applied: true };
  }

  private async releaseOrRefundAccount(
    tx: Prisma.TransactionClient,
    partnerId: string,
    orderId: string,
    amountPaisa: number,
    reason: string,
  ) {
    const reservation = await tx.partnerLedgerEntry.findFirst({
      where: {
        partnerId,
        orderId,
        type: PartnerLedgerEntryType.RESERVATION,
      },
      select: { id: true },
    });
    if (reservation)
      return this.releaseReservation(tx, partnerId, orderId, amountPaisa);
    await this.refundDirectDebit(tx, partnerId, orderId, amountPaisa, reason);
    return { applied: true, legacyDirectDebit: true };
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

  private async enqueuePassportOcr(
    orderId: string,
    documentId?: string,
    attemptKey = "initial",
  ) {
    const document = await this.prisma.travelerDocument.findFirst({
      where: {
        orderId,
        type: DocumentType.PASSPORT,
        ...(documentId ? { id: documentId } : {}),
      },
      select: { id: true, privateAssetId: true },
    });
    if (!document) return;
    const id = document.id;
    try {
      await this.queues.add(
        QUEUES.documents,
        "verify-passport",
        { orderId, documentId: id, privateAssetId: document.privateAssetId },
        orderPassportOcrJobId(orderId, id, document.privateAssetId, attemptKey),
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
