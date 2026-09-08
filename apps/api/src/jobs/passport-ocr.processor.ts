import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { DocumentType, type Prisma } from "@prisma/client";
import type { Job } from "bullmq";
import { randomUUID } from "node:crypto";
import { CryptoService } from "../infrastructure/crypto.service.js";
import { S3StorageService } from "../infrastructure/s3-storage.service.js";
import { PrismaService } from "../infrastructure/prisma.service.js";
import { PassportVerificationService } from "../modules/orders/passport-verification.service.js";
import { QueueService } from "./queue.service.js";
import { QUEUES } from "./queues.js";
import { ProductionResilienceService } from "./production-resilience.service.js";

type PassportOcrJob =
  | { orderId: string; documentId: string; privateAssetId?: string }
  | { verificationId: string };

class ManualDocumentDecisionWon extends Error {}

/**
 * Processes passport OCR for partner orders in the background. Triggered after
 * a partner confirms a PASSPORT document upload (or after a complete order is
 * placed) so the request never blocks on Tesseract, mirroring the synchronous
 * verify the hosted checkout performs. Persists the verdict onto the document
 * and emits a `document.verified` partner webhook so REST partners can observe
 * the result without polling.
 */
@Injectable()
export class PassportOcrProcessor implements OnModuleInit {
  private readonly logger = new Logger(PassportOcrProcessor.name);

  constructor(
    private readonly queues: QueueService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly passportVerifier: PassportVerificationService,
    private readonly storage: S3StorageService,
    private readonly resilience: ProductionResilienceService,
  ) {}

  onModuleInit() {
    this.queues.registerWorker(
      QUEUES.documents,
      (job) => this.process(job as Job<PassportOcrJob>),
      { concurrency: 1 },
    );
  }

  async process(job: Job<PassportOcrJob>) {
    if ("verificationId" in job.data)
      return this.processPreOrderVerification(job);
    const { orderId, documentId } = job.data;
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        traveler: true,
        documents: true,
        partner: { select: { id: true } },
      },
    });
    if (!order) return { skipped: true };
    if (
      ["MANUAL_REVIEW", "MANUALLY_APPROVED", "REUPLOAD_REQUIRED"].includes(
        order.documentReviewStatus,
      )
    )
      return { skipped: true, reviewAlreadyDecided: true };
    const passport = order.documents.find(
      (document) =>
        document.type === DocumentType.PASSPORT && document.id === documentId,
    );
    if (!passport) return { skipped: true };
    if (
      !passport.uploadVerified ||
      (job.data.privateAssetId &&
        job.data.privateAssetId !== passport.privateAssetId)
    )
      return { skipped: true, supersededUpload: true };
    // A terminal verdict already exists from a previous run; do not overwrite.
    if (
      passport.passportVerificationStatus === "VERIFIED" ||
      passport.passportVerificationStatus === "SKIPPED"
    )
      return { skipped: true, alreadyVerified: true };

    const traveler = this.decryptTraveler(order.traveler);
    const result = await this.passportVerifier.verify({
      id: order.id,
      purchaseType: order.orderType === "TOPUP" ? "TOPUP" : "INITIAL_PURCHASE",
      traveler,
      documents: [
        {
          id: passport.id,
          type: DocumentType.PASSPORT,
          fileName: passport.fileName,
          privateAssetId: passport.privateAssetId,
          status: passport.status,
          uploadVerified: true,
        },
      ],
    } as never);

    const technicalFailure =
      result.method === "ocr-error" || result.status === "NOT_READY";
    if (
      technicalFailure &&
      job.attemptsMade + 1 < Number(job.opts.attempts ?? 1)
    )
      throw new Error(
        result.detail ?? "Passport OCR is temporarily unavailable",
      );
    const verified =
      result.status === "VERIFIED" || result.status === "SKIPPED";
    const partial = result.status === "PARTIAL";
    const reviewStatus = verified
      ? "VERIFIED"
      : partial || technicalFailure
        ? "MANUAL_REVIEW"
        : "REUPLOAD_REQUIRED";
    try {
      await this.prisma.$transaction(async (tx) => {
        const orderClaim = await tx.order.updateMany({
          where: {
            id: order.id,
            documentReviewStatus: { in: ["OCR_PENDING", "OCR_BACKGROUND"] },
          },
          data: {
            documentReviewStatus: reviewStatus,
            version: { increment: 1 },
          },
        });
        if (orderClaim.count === 0) throw new ManualDocumentDecisionWon();

        const documentClaim = await tx.travelerDocument.updateMany({
          where: {
            id: passport.id,
            privateAssetId: passport.privateAssetId,
            uploadVerified: true,
            status: { not: "APPROVED" },
          },
          data: {
            status: verified
              ? "APPROVED"
              : partial || technicalFailure
                ? "PENDING"
                : "REUPLOAD_REQUIRED",
            passportVerificationStatus: result.status,
            passportVerificationMethod: result.method,
            passportMatchedFields:
              result.matchedFields as Prisma.InputJsonValue,
            passportConfidence: result.confidence ?? null,
            passportVerifiedAt: new Date(result.checkedAt),
          },
        });
        if (documentClaim.count === 0) throw new ManualDocumentDecisionWon();

        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            fromStatus: order.status,
            toStatus: order.status,
            reason: verified
              ? "Passport verified automatically"
              : partial
                ? "Passport partially matched; routed to manual review"
                : technicalFailure
                  ? "OCR technical failure; routed to non-blocking manual review"
                  : "Passport verification failed; replacement requested",
            metadata: { documentReviewStatus: reviewStatus },
          },
        });
      });
    } catch (error) {
      if (error instanceof ManualDocumentDecisionWon)
        return { skipped: true, manualDecisionWon: true };
      throw error;
    }

    if (verified) {
      await this.resilience.resolve(
        `document-review:${order.id}`,
        null,
        "Document verification completed",
      );
    } else {
      await this.resilience.attention({
        dedupeKey: `document-review:${order.id}`,
        category:
          partial || technicalFailure
            ? "DOCUMENT_MANUAL_REVIEW"
            : "DOCUMENT_REUPLOAD",
        entityType: "Order",
        entityId: order.id,
        orderId: order.id,
        summary:
          partial || technicalFailure
            ? "Document processing needs manual review"
            : "Document verification requires a clearer upload",
        ...(result.detail ? { detail: result.detail } : {}),
        failureCategory: technicalFailure
          ? "OCR_TECHNICAL_FAILURE"
          : partial
            ? "OCR_PARTIAL_MATCH"
            : "OCR_MISMATCH",
        lastSuccessfulStep: "DOCUMENTS_UPLOADED",
        availableActions: [],
      });
    }

    if (order.partnerId)
      await this.emitVerifiedEvent(
        order.partnerId,
        order.id,
        order.externalOrderId,
        passport.id,
        reviewStatus,
      );

    return result;
  }

  private async processPreOrderVerification(job: Job<PassportOcrJob>) {
    if (!("verificationId" in job.data)) return;
    const verification =
      await this.prisma.partnerDocumentVerification.findUnique({
        where: { id: job.data.verificationId },
        include: { documents: true },
      });
    if (
      !verification ||
      [
        "VERIFIED",
        "INVALID",
        "REUPLOAD_REQUIRED",
        "CONSUMED",
        "MANUAL_REVIEW",
        "EXPIRED",
      ].includes(verification.status)
    )
      return { skipped: true };
    if (verification.expiresAt <= new Date()) {
      await this.prisma.partnerDocumentVerification.update({
        where: { id: verification.id },
        data: { status: "EXPIRED", failureCode: "VERIFICATION_EXPIRED" },
      });
      return { status: "EXPIRED" };
    }
    try {
      await this.prisma.partnerDocumentVerification.update({
        where: { id: verification.id },
        data: { status: "PROCESSING" },
      });
      for (const document of verification.documents) {
        const asset = await this.prismaSafeVerify(document.privateAssetId);
        if (
          !asset.simulated &&
          (asset.bytes !== document.declaredSizeBytes ||
            !this.formatMatches(asset.format, document.contentType))
        ) {
          await this.markInvalid(
            verification.id,
            document.id,
            "UPLOAD_DECLARATION_MISMATCH",
          );
          return { status: "INVALID" };
        }
        if (document.type !== DocumentType.PASSPORT) {
          await this.prisma.partnerDocumentUploadIntent.update({
            where: { id: document.id },
            data: { verificationStatus: "VERIFIED", verifiedAt: new Date() },
          });
        }
      }
      const passport = verification.documents.find(
        (document) => document.type === DocumentType.PASSPORT,
      );
      if (!passport) {
        await this.prisma.partnerDocumentVerification.update({
          where: { id: verification.id },
          data: { status: "INVALID", failureCode: "PASSPORT_REQUIRED" },
        });
        return { status: "INVALID" };
      }
      const traveler = this.decryptSnapshot(verification.travelerSnapshot);
      const result = await this.passportVerifier.verify({
        id: verification.id,
        purchaseType: "INITIAL_PURCHASE",
        traveler,
        documents: [
          {
            id: passport.id,
            type: DocumentType.PASSPORT,
            fileName: passport.fileName,
            privateAssetId: passport.privateAssetId,
            status: "PENDING",
            uploadVerified: true,
          },
        ],
      } as never);
      if (
        result.status === "NOT_READY" ||
        (result.status === "FAILED" && result.method === "ocr-error")
      )
        throw new Error(
          result.detail ?? "Passport OCR is temporarily unavailable",
        );
      const accepted =
        result.status === "VERIFIED" || result.status === "SKIPPED";
      // A partial read (identity matched, number unreadable) is not the
      // traveller's fault; route it to manual review instead of rejecting it.
      const partial = result.status === "PARTIAL";
      const intentStatus = accepted
        ? "VERIFIED"
        : partial
          ? "PENDING"
          : "REUPLOAD_REQUIRED";
      let linkedOrderId: string | null = null;
      let verdictPersisted = false;
      let linkedOrderUpdated = false;
      await this.prisma.$transaction(async (tx) => {
        const verificationClaim =
          await tx.partnerDocumentVerification.updateMany({
            where: {
              id: verification.id,
              status: {
                in: ["AWAITING_UPLOAD", "PROCESSING", "PROCESSING_BACKGROUND"],
              },
            },
            data: {
              status: accepted
                ? "VERIFIED"
                : partial
                  ? "MANUAL_REVIEW"
                  : "REUPLOAD_REQUIRED",
              failureCode:
                accepted || partial ? null : "PASSPORT_REUPLOAD_REQUIRED",
            },
          });
        if (verificationClaim.count === 0) return;
        verdictPersisted = true;
        await tx.partnerDocumentUploadIntent.update({
          where: { id: passport.id },
          data: {
            verificationStatus: intentStatus,
            verificationCode: accepted ? null : (result.status ?? null),
            verificationResult: {
              method: result.method,
              matchedFields: result.matchedFields,
              confidence: result.confidence ?? null,
            } as Prisma.InputJsonValue,
            verifiedAt: new Date(result.checkedAt),
          },
        });
        const persistedVerification =
          await tx.partnerDocumentVerification.findUnique({
            where: { id: verification.id },
            select: { consumedOrderId: true },
          });
        linkedOrderId = persistedVerification?.consumedOrderId ?? null;
        if (!linkedOrderId) return;
        const orderClaim = await tx.order.updateMany({
          where: {
            id: linkedOrderId,
            status: { in: ["REVIEW_PENDING", "AWAITING_CUSTOMER"] },
            documentReviewStatus: {
              in: ["OCR_PENDING", "OCR_BACKGROUND", "REUPLOAD_REQUIRED"],
            },
          },
          data: {
            status: accepted
              ? "REVIEW_PENDING"
              : partial
                ? "REVIEW_PENDING"
                : "AWAITING_CUSTOMER",
            documentReviewStatus: accepted
              ? "VERIFIED"
              : partial
                ? "MANUAL_REVIEW"
                : "REUPLOAD_REQUIRED",
            version: { increment: 1 },
          },
        });
        if (orderClaim.count === 0) return;
        linkedOrderUpdated = true;
        await tx.travelerDocument.updateMany({
          where: {
            orderId: linkedOrderId,
            type: DocumentType.PASSPORT,
          },
          data: {
            status: accepted
              ? "APPROVED"
              : partial
                ? "PENDING"
                : "REUPLOAD_REQUIRED",
            passportVerificationStatus: result.status,
            passportVerificationMethod: result.method,
            passportMatchedFields:
              result.matchedFields as Prisma.InputJsonValue,
            passportConfidence: result.confidence ?? null,
            passportVerifiedAt: new Date(result.checkedAt),
          },
        });
        if (accepted)
          await tx.travelerDocument.updateMany({
            where: {
              orderId: linkedOrderId,
              type: { in: [DocumentType.TICKET, DocumentType.VISA] },
            },
            data: { status: "APPROVED", uploadVerified: true },
          });
      });
      if (!verdictPersisted)
        return { skipped: true, reviewAlreadyDecided: true };
      if (linkedOrderId && linkedOrderUpdated) {
        if (!accepted)
          await this.resilience.attention({
            dedupeKey: `document-review:${linkedOrderId}`,
            category: partial ? "DOCUMENT_MANUAL_REVIEW" : "DOCUMENT_REUPLOAD",
            entityType: "Order",
            entityId: linkedOrderId,
            orderId: linkedOrderId,
            summary: partial
              ? "Document processing needs manual review"
              : "Document verification requires a clearer upload",
            failureCategory: partial ? "OCR_PARTIAL_MATCH" : "OCR_MISMATCH",
            lastSuccessfulStep: "ORDER_ACCEPTED",
            availableActions: [],
          });
      }
      await this.emitPreOrderEvent(
        verification.partnerId,
        verification.id,
        verification.externalOrderId,
        accepted
          ? "document.verification.verified"
          : partial
            ? "document.verification.manual_review"
            : "document.verification.reupload_required",
        linkedOrderUpdated ? linkedOrderId : null,
      );
      return result;
    } catch (error) {
      this.logger.error(
        `Partner document verification ${verification.id} failed: ${error instanceof Error ? error.message : "unknown"}`,
      );
      const exhausted = job.attemptsMade + 1 >= Number(job.opts.attempts ?? 1);
      await this.prisma.partnerDocumentVerification.update({
        where: { id: verification.id },
        data: exhausted
          ? {
              status: "MANUAL_REVIEW",
              failureCode: "DOCUMENT_PROCESSING_FAILED",
            }
          : { status: "AWAITING_UPLOAD", failureCode: null },
      });
      if (exhausted)
        await this.emitPreOrderEvent(
          verification.partnerId,
          verification.id,
          verification.externalOrderId,
          "document.verification.manual_review",
          verification.consumedOrderId,
        );
      if (exhausted && verification.consumedOrderId)
        await this.prisma.order.update({
          where: { id: verification.consumedOrderId },
          data: {
            documentReviewStatus: "MANUAL_REVIEW",
            version: { increment: 1 },
          },
        });
      if (exhausted && verification.consumedOrderId)
        await this.resilience.attention({
          dedupeKey: `document-review:${verification.consumedOrderId}`,
          category: "DOCUMENT_MANUAL_REVIEW",
          entityType: "Order",
          entityId: verification.consumedOrderId,
          orderId: verification.consumedOrderId,
          summary: "Document processing needs manual review",
          detail: error instanceof Error ? error.message : "unknown",
          failureCategory: "OCR_TECHNICAL_FAILURE",
          lastSuccessfulStep: "ORDER_ACCEPTED",
          availableActions: [],
        });
      if (!exhausted) throw error;
      return { status: "MANUAL_REVIEW" };
    }
  }

  private async prismaSafeVerify(assetId: string) {
    return this.storage.verifyDocument(assetId);
  }

  private formatMatches(format: string | undefined, contentType: string) {
    if (!format) return false;
    return (
      (
        {
          "application/pdf": "pdf",
          "image/jpeg": "jpg",
          "image/png": "png",
        } as Record<string, string>
      )[contentType] === format.toLowerCase() ||
      (contentType === "image/jpeg" && format.toLowerCase() === "jpeg")
    );
  }

  private decryptSnapshot(value: Prisma.JsonValue) {
    const snapshot = value as Record<string, string | null>;
    return {
      firstName: snapshot.firstName ?? "",
      ...(snapshot.middleName ? { middleName: snapshot.middleName } : {}),
      surname: snapshot.surname ?? "",
      dateOfBirth: this.crypto.decrypt(snapshot.dateOfBirthEncrypted ?? ""),
      passportNumber: this.crypto.decrypt(
        snapshot.passportNumberEncrypted ?? "",
      ),
      passportExpiryDate: this.crypto.decrypt(
        snapshot.passportExpiryEncrypted ?? "",
      ),
    };
  }

  private async markInvalid(
    verificationId: string,
    documentId: string,
    code: string,
  ) {
    const verification =
      await this.prisma.partnerDocumentVerification.findUnique({
        where: { id: verificationId },
        select: { consumedOrderId: true },
      });
    await this.prisma.$transaction([
      this.prisma.partnerDocumentUploadIntent.update({
        where: { id: documentId },
        data: {
          verificationStatus: "INVALID",
          verificationCode: code,
          verifiedAt: new Date(),
        },
      }),
      this.prisma.partnerDocumentVerification.update({
        where: { id: verificationId },
        data: { status: "REUPLOAD_REQUIRED", failureCode: code },
      }),
      ...(verification?.consumedOrderId
        ? [
            this.prisma.order.update({
              where: { id: verification.consumedOrderId },
              data: {
                status: "AWAITING_CUSTOMER",
                documentReviewStatus: "REUPLOAD_REQUIRED",
                version: { increment: 1 },
              },
            }),
            this.prisma.travelerDocument.updateMany({
              where: {
                orderId: verification.consumedOrderId,
                type: DocumentType.PASSPORT,
              },
              data: { status: "REUPLOAD_REQUIRED" },
            }),
          ]
        : []),
    ]);
  }

  private async emitPreOrderEvent(
    partnerId: string,
    verificationId: string,
    externalOrderId: string,
    type: string,
    orderId?: string | null,
  ) {
    const endpoints = await this.prisma.partnerWebhookEndpoint.findMany({
      where: { partnerId, active: true },
    });
    const eligible = endpoints.filter((endpoint) => {
      const types = Array.isArray(endpoint.eventTypes)
        ? endpoint.eventTypes
        : [];
      return types.includes("*") || types.includes(type);
    });
    await this.prisma.partnerEvent.create({
      data: {
        partnerId,
        ...(orderId ? { orderId } : {}),
        type,
        resourceId: verificationId,
        correlationId: randomUUID(),
        payload: { verificationId, externalOrderId },
        deliveries: {
          create: eligible.map((endpoint) => ({ endpointId: endpoint.id })),
        },
      },
    });
  }

  private async emitVerifiedEvent(
    partnerId: string,
    orderId: string,
    externalOrderId: string | null,
    documentId: string,
    verificationStatus: string,
  ) {
    if (!this.prisma.enabled) return;
    const endpoints = await this.prisma.partnerWebhookEndpoint.findMany({
      where: { partnerId, active: true },
    });
    const eligible = endpoints.filter((endpoint) => {
      const types = Array.isArray(endpoint.eventTypes)
        ? endpoint.eventTypes.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      return types.includes("*") || types.includes("document.verified");
    });
    await this.prisma.partnerEvent.create({
      data: {
        partnerId,
        orderId,
        type: "document.verified",
        resourceId: orderId,
        correlationId: randomUUID(),
        payload: {
          orderId,
          externalOrderId,
          documentId,
          verificationStatus,
        },
        deliveries: {
          create: eligible.map((endpoint) => ({ endpointId: endpoint.id })),
        },
      },
    });
  }

  private decryptTraveler(
    traveler: {
      firstName: string;
      middleName: string | null;
      surname: string;
      dateOfBirthEncrypted: string | null;
      passportNumberEncrypted: string | null;
      passportExpiryEncrypted: string | null;
    } | null,
  ) {
    if (!traveler) return undefined;
    return {
      firstName: traveler.firstName,
      ...(traveler.middleName ? { middleName: traveler.middleName } : {}),
      surname: traveler.surname,
      dateOfBirth: this.crypto.decrypt(traveler.dateOfBirthEncrypted ?? ""),
      passportNumber: this.crypto.decrypt(
        traveler.passportNumberEncrypted ?? "",
      ),
      passportExpiryDate: this.crypto.decrypt(
        traveler.passportExpiryEncrypted ?? "",
      ),
    };
  }
}
