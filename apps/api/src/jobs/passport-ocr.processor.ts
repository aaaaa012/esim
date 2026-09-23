import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { DocumentStatus, DocumentType, type Prisma } from "@prisma/client";
import type { Job } from "bullmq";
import { createHash, randomUUID } from "node:crypto";
import { CryptoService } from "../infrastructure/crypto.service.js";
import { S3StorageService } from "../infrastructure/s3-storage.service.js";
import { PrismaService } from "../infrastructure/prisma.service.js";
import {
  PassportVerificationService,
  canonicalIdentity,
  verifyStoredExtraction,
  type PassportExtractedFields,
} from "../modules/orders/passport-verification.service.js";
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
        passportExtraction: true,
        partner: { select: { id: true } },
      },
    });
    if (!order) return { skipped: true };
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
    // Human decisions are authoritative; never auto-restart underneath them.
    if (
      ["MANUAL_REVIEW", "MANUALLY_APPROVED"].includes(
        order.documentReviewStatus,
      )
    )
      return { skipped: true, reviewAlreadyDecided: true };
    // A confirmed travel ticket awaiting approval. Tickets are validated on
    // basic upload evidence (the declared size/format/type and the stored file
    // were confirmed at upload time), not OCR. Re-approving it here restarts
    // validation reliably even when a ticket-only replacement is confirmed
    // after the passport already received a terminal verdict.
    const ticket = order.documents.find(
      (document) =>
        document.type === DocumentType.TICKET &&
        document.uploadVerified &&
        document.status === DocumentStatus.PENDING,
    );
    // A terminal passport verdict exists from a previous run; do not overwrite
    // it. A replacement ticket is the only open item, so approve it and replay
    // the verdict onto the order instead of leaving it stranded.
    const terminalVerdict =
      passport.passportVerificationStatus === "VERIFIED" ||
      passport.passportVerificationStatus === "SKIPPED"
        ? passport.passportVerificationStatus
        : null;
    if (terminalVerdict) {
      if (!ticket) return { skipped: true, alreadyVerified: true };
      const ticketClaim = await this.prisma.travelerDocument.updateMany({
        where: {
          id: ticket.id,
          privateAssetId: ticket.privateAssetId,
          uploadVerified: true,
          status: DocumentStatus.PENDING,
        },
        data: { status: DocumentStatus.APPROVED },
      });
      if (ticketClaim.count === 0)
        return { skipped: true, supersededTicketUpload: true };
      const verdictReplayed = await this.prisma.$transaction(async (tx) => {
        const orderClaim = await tx.order.updateMany({
          where: {
            id: order.id,
            documentReviewStatus: {
              in: ["NOT_STARTED", "OCR_PENDING", "REUPLOAD_REQUIRED"],
            },
          },
          data: {
            documentReviewStatus: terminalVerdict,
            version: { increment: 1 },
          },
        });
        if (orderClaim.count === 0) return false;
        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            fromStatus: order.status,
            toStatus: order.status,
            reason: "Travel ticket re-validated after replacement",
            metadata: {
              documentType: DocumentType.TICKET,
              documentReviewStatus: terminalVerdict,
            },
          },
        });
        return true;
      });
      if (!verdictReplayed)
        return { skipped: true, reviewAlreadyDecided: true };
      return {
        status: terminalVerdict,
        documentType: "TICKET",
        ticketRevalidated: true,
      };
    }
    // A re-uploaded ticket satisfies an earlier resubmission request; resume
    // the review so the current passport is re-verified against it.
    if (order.documentReviewStatus === "REUPLOAD_REQUIRED") {
      if (!ticket) return { skipped: true, reviewAlreadyDecided: true };
      const resumed = await this.prisma.order.updateMany({
        where: { id: order.id, documentReviewStatus: "REUPLOAD_REQUIRED" },
        data: {
          documentReviewStatus: "OCR_PENDING",
          version: { increment: 1 },
        },
      });
      if (resumed.count === 0)
        return { skipped: true, reviewAlreadyDecided: true };
    }

    const traveler = this.decryptTraveler(order.traveler);
    if (!traveler) {
      const extraction = await this.passportVerifier.extract({
        id: order.id,
        purchaseType: "INITIAL_PURCHASE",
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
      const passportInvalid = [
        "MRZ_NOT_READABLE",
        "PASSPORT_BIODATA_NOT_DETECTED",
        "PASSPORT_EXPIRED",
      ].includes(extraction.failureCode ?? "");
      const passportNeedsReview =
        extraction.failureCode === "MRZ_REVIEW_REQUIRED";
      await this.prisma.$transaction(async (tx) => {
        const current = await tx.travelerDocument.findUnique({
          where: { id: passport.id },
          select: { privateAssetId: true, uploadVerified: true },
        });
        if (
          !current?.uploadVerified ||
          current.privateAssetId !== passport.privateAssetId
        )
          return;
        await tx.passportExtraction.upsert({
          where: { orderId: order.id },
          update: {
            passportAssetId: passport.privateAssetId,
            status: extraction.status,
            payloadEncrypted: this.crypto.encrypt(
              JSON.stringify(extraction.fields),
            ),
            fieldsRequiringInput:
              extraction.fieldsRequiringInput as Prisma.InputJsonValue,
            confidence: extraction.confidence ?? null,
            method: extraction.method,
            failureCode: extraction.failureCode ?? null,
          },
          create: {
            orderId: order.id,
            passportAssetId: passport.privateAssetId,
            status: extraction.status,
            payloadEncrypted: this.crypto.encrypt(
              JSON.stringify(extraction.fields),
            ),
            fieldsRequiringInput:
              extraction.fieldsRequiringInput as Prisma.InputJsonValue,
            confidence: extraction.confidence ?? null,
            method: extraction.method,
            failureCode: extraction.failureCode ?? null,
          },
        });
        await tx.order.updateMany({
          where: {
            id: order.id,
            documentReviewStatus: passportInvalid
              ? {
                  in: [
                    "NOT_STARTED",
                    "OCR_PENDING",
                    "OCR_BACKGROUND",
                    "CORRECTION_REQUIRED",
                    "REUPLOAD_REQUIRED",
                  ],
                }
              : "OCR_PENDING",
          },
          data: {
            documentReviewStatus: passportInvalid
              ? "REUPLOAD_REQUIRED"
              : passportNeedsReview
                ? "MANUAL_REVIEW"
                : "NOT_STARTED",
            version: { increment: 1 },
          },
        });
        if (passportInvalid)
          await tx.travelerDocument.update({
            where: { id: passport.id },
            data: {
              status: "REUPLOAD_REQUIRED",
              passportVerificationStatus: "FAILED",
              passportVerificationMethod: extraction.method,
              passportVerifiedAt: new Date(extraction.checkedAt),
            },
          });
      });
      if (passportInvalid)
        await this.resilience.attention({
          dedupeKey: `document-review:${order.id}`,
          category: "DOCUMENT_REUPLOAD",
          entityType: "Order",
          entityId: order.id,
          orderId: order.id,
          summary: "Passport image must be replaced",
          detail:
            extraction.failureCode === "PASSPORT_EXPIRED"
              ? "The uploaded passport has expired and must be replaced with a valid passport"
              : "The uploaded passport does not contain a readable machine-readable zone",
          failureCategory:
            extraction.failureCode === "PASSPORT_EXPIRED"
              ? "PASSPORT_EXPIRED"
              : "PASSPORT_MRZ_NOT_READABLE",
          lastSuccessfulStep: "DOCUMENTS_UPLOADED",
          availableActions: [],
        });
      if (passportNeedsReview)
        await this.resilience.attention({
          dedupeKey: `document-review:${order.id}`,
          category: "DOCUMENT_REVIEW",
          entityType: "Order",
          entityId: order.id,
          orderId: order.id,
          summary: "Passport requires manual verification",
          detail:
            "The upload appears to contain a passport, but automated MRZ recovery could not prove its identity fields.",
          failureCategory: "PASSPORT_MRZ_REVIEW_REQUIRED",
          lastSuccessfulStep: "DOCUMENTS_UPLOADED",
          availableActions: ["REVIEW_DOCUMENTS"],
        });
      return extraction;
    }
    const storedFields = this.readyExtractionFields(
      order.passportExtraction,
      passport.privateAssetId,
    );
    const result = storedFields
      ? verifyStoredExtraction(
          storedFields,
          traveler,
          order.passportExtraction?.confidence,
        )
      : await this.passportVerifier.verify({
          id: order.id,
          purchaseType:
            order.orderType === "TOPUP" ? "TOPUP" : "INITIAL_PURCHASE",
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
    const hasIdentityConflict = Boolean(result.mismatchedFields?.length);
    const extractionHasName = Boolean(
      storedFields?.firstName || storedFields?.surname,
    );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(canonicalIdentity(traveler)))
      .digest("hex");
    const repeatedMismatch =
      order.passportExtraction?.lastMismatchFingerprint === fingerprint;
    const correctionAttempts = hasIdentityConflict
      ? (order.passportExtraction?.correctionAttempts ?? 0) +
        (repeatedMismatch ? 0 : 1)
      : (order.passportExtraction?.correctionAttempts ?? 0);
    // A comparison failure does not prove that the image is unusable. It can
    // equally mean that a traveller corrected (or mistyped) a field. Keep the
    // document available for correction and human review; only an explicit
    // reviewer decision may require a replacement image.
    const reviewStatus = verified
      ? "VERIFIED"
      : storedFields &&
          !technicalFailure &&
          hasIdentityConflict &&
          extractionHasName &&
          correctionAttempts < 3
        ? "CORRECTION_REQUIRED"
        : "MANUAL_REVIEW";
    const correctionRequired = reviewStatus === "CORRECTION_REQUIRED";
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

        if (storedFields && hasIdentityConflict) {
          const extractionClaim = await tx.passportExtraction.updateMany({
            where: {
              orderId: order.id,
              passportAssetId: passport.privateAssetId,
            },
            data: {
              correctionAttempts,
              lastMismatchFingerprint: fingerprint,
              lastMismatchFields:
                result.mismatchedFields as Prisma.InputJsonValue,
              confirmedMismatchFingerprint: null,
            },
          });
          if (extractionClaim.count === 0)
            throw new ManualDocumentDecisionWon();
        }

        const documentClaim = await tx.travelerDocument.updateMany({
          where: {
            id: passport.id,
            privateAssetId: passport.privateAssetId,
            uploadVerified: true,
            status: { not: "APPROVED" },
          },
          data: {
            status: verified ? "APPROVED" : "PENDING",
            passportVerificationStatus: result.status,
            passportVerificationMethod: result.method,
            passportMatchedFields:
              result.matchedFields as Prisma.InputJsonValue,
            passportConfidence: result.confidence ?? null,
            passportVerifiedAt: new Date(result.checkedAt),
          },
        });
        if (documentClaim.count === 0) throw new ManualDocumentDecisionWon();

        if (verified)
          await tx.travelerDocument.updateMany({
            where: {
              orderId: order.id,
              type: DocumentType.TICKET,
              uploadVerified: true,
              status: DocumentStatus.PENDING,
            },
            data: { status: DocumentStatus.APPROVED },
          });

        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            fromStatus: order.status,
            toStatus: order.status,
            reason: verified
              ? "Passport verified automatically"
              : partial
                ? correctionRequired
                  ? "Passport details require customer correction"
                  : "Passport partially matched; routed to manual review"
                : technicalFailure
                  ? "OCR technical failure; routed to non-blocking manual review"
                  : "Traveller details were not confirmed; correction or manual review required",
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
          correctionRequired || partial || technicalFailure
            ? "DOCUMENT_MANUAL_REVIEW"
            : "DOCUMENT_REUPLOAD",
        entityType: "Order",
        entityId: order.id,
        orderId: order.id,
        summary: correctionRequired
          ? "Traveller details need customer confirmation"
          : partial || technicalFailure
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
        include: { documents: true, passportExtraction: true },
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
        if (document.type === DocumentType.TICKET) {
          // Tickets are validated on the basic upload checks above (declared
          // size, content-type and the stored file) plus field existence, not
          // OCR, matching the earlier document validation flow.
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
      if (
        verification.mode === "EXTRACT_FIRST" &&
        !verification.travelerSnapshot
      ) {
        const extraction = await this.passportVerifier.extract({
          id: verification.id,
          purchaseType: "INITIAL_PURCHASE",
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
        const nextStatus = [
          "MRZ_NOT_READABLE",
          "PASSPORT_BIODATA_NOT_DETECTED",
          "PASSPORT_EXPIRED",
        ].includes(extraction.failureCode ?? "")
          ? "REUPLOAD_REQUIRED"
          : extraction.failureCode === "MRZ_REVIEW_REQUIRED"
            ? "MANUAL_REVIEW"
            : extraction.status === "READY" || extraction.status === "PARTIAL"
              ? "AWAITING_TRAVELER_CONFIRMATION"
              : extraction.status;
        await this.prisma.$transaction(async (tx) => {
          const current = await tx.partnerDocumentVerification.findUnique({
            where: { id: verification.id },
            select: { travelerSnapshot: true, status: true },
          });
          if (current?.travelerSnapshot || current?.status !== "PROCESSING")
            return;
          await tx.passportExtraction.upsert({
            where: { partnerVerificationId: verification.id },
            update: {
              passportAssetId: passport.privateAssetId,
              status: extraction.status,
              payloadEncrypted: this.crypto.encrypt(
                JSON.stringify(extraction.fields),
              ),
              fieldsRequiringInput:
                extraction.fieldsRequiringInput as Prisma.InputJsonValue,
              confidence: extraction.confidence ?? null,
              method: extraction.method,
              failureCode: extraction.failureCode ?? null,
              confirmedAt: null,
            },
            create: {
              partnerVerificationId: verification.id,
              passportAssetId: passport.privateAssetId,
              status: extraction.status,
              payloadEncrypted: this.crypto.encrypt(
                JSON.stringify(extraction.fields),
              ),
              fieldsRequiringInput:
                extraction.fieldsRequiringInput as Prisma.InputJsonValue,
              confidence: extraction.confidence ?? null,
              method: extraction.method,
              failureCode: extraction.failureCode ?? null,
            },
          });
          await tx.partnerDocumentVerification.update({
            where: { id: verification.id },
            data: {
              status: nextStatus,
              failureCode: extraction.failureCode ?? null,
            },
          });
          if (
            [
              "MRZ_NOT_READABLE",
              "PASSPORT_BIODATA_NOT_DETECTED",
              "PASSPORT_EXPIRED",
            ].includes(extraction.failureCode ?? "")
          )
            await tx.partnerDocumentUploadIntent.update({
              where: { id: passport.id },
              data: {
                verificationStatus: "REUPLOAD_REQUIRED",
                verificationCode:
                  extraction.failureCode === "PASSPORT_EXPIRED"
                    ? "PASSPORT_EXPIRED"
                    : "PASSPORT_MRZ_NOT_READABLE",
                verifiedAt: new Date(),
              },
            });
        });
        return extraction;
      }
      const traveler = this.decryptSnapshot(verification.travelerSnapshot);
      const storedFields = this.readyExtractionFields(
        verification.passportExtraction,
        passport.privateAssetId,
      );
      const result = storedFields
        ? verifyStoredExtraction(
            storedFields,
            traveler,
            verification.passportExtraction?.confidence,
          )
        : await this.passportVerifier.verify({
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
      const intentStatus = accepted ? "VERIFIED" : "PENDING";
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
              status: accepted ? "VERIFIED" : "MANUAL_REVIEW",
              failureCode: accepted ? null : "TRAVELLER_DETAILS_UNCONFIRMED",
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
            status: "REVIEW_PENDING",
            documentReviewStatus: accepted ? "VERIFIED" : "MANUAL_REVIEW",
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
            status: accepted ? "APPROVED" : "PENDING",
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
      const failedPassport = verification.documents.find(
        (document) => document.type === DocumentType.PASSPORT,
      );
      if (
        exhausted &&
        verification.mode === "EXTRACT_FIRST" &&
        !verification.travelerSnapshot &&
        failedPassport
      )
        await this.prisma.passportExtraction.upsert({
          where: { partnerVerificationId: verification.id },
          update: {
            passportAssetId: failedPassport.privateAssetId,
            status: "MANUAL_ENTRY_REQUIRED",
            payloadEncrypted: this.crypto.encrypt("{}"),
            fieldsRequiringInput: [
              "firstName",
              "surname",
              "dateOfBirth",
              "nationality",
              "passportNumber",
              "passportExpiryDate",
            ],
            failureCode: "DOCUMENT_PROCESSING_FAILED",
          },
          create: {
            partnerVerificationId: verification.id,
            passportAssetId: failedPassport.privateAssetId,
            status: "MANUAL_ENTRY_REQUIRED",
            payloadEncrypted: this.crypto.encrypt("{}"),
            fieldsRequiringInput: [
              "firstName",
              "surname",
              "dateOfBirth",
              "nationality",
              "passportNumber",
              "passportExpiryDate",
            ],
            failureCode: "DOCUMENT_PROCESSING_FAILED",
          },
        });
      await this.prisma.partnerDocumentVerification.update({
        where: { id: verification.id },
        data: exhausted
          ? verification.mode === "EXTRACT_FIRST" &&
            !verification.travelerSnapshot
            ? {
                status: "MANUAL_ENTRY_REQUIRED",
                failureCode: "DOCUMENT_PROCESSING_FAILED",
              }
            : {
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

  private decryptSnapshot(value: Prisma.JsonValue | null) {
    if (!value) throw new Error("Traveler confirmation is required");
    const snapshot = value as Record<string, string | null>;
    return {
      firstName: snapshot.firstName ?? "",
      ...(snapshot.middleName ? { middleName: snapshot.middleName } : {}),
      surname: snapshot.surname ?? "",
      nationality: snapshot.nationality ?? "",
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
    const [verification, invalidDocument] = await Promise.all([
      this.prisma.partnerDocumentVerification.findUnique({
        where: { id: verificationId },
        select: {
          consumedOrderId: true,
          partnerId: true,
          externalOrderId: true,
        },
      }),
      this.prisma.partnerDocumentUploadIntent.findUnique({
        where: { id: documentId },
        select: { type: true },
      }),
    ]);
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
            ...(invalidDocument
              ? [
                  this.prisma.travelerDocument.updateMany({
                    where: {
                      orderId: verification.consumedOrderId,
                      type: invalidDocument.type,
                    },
                    data: { status: "REUPLOAD_REQUIRED" },
                  }),
                ]
              : []),
          ]
        : []),
    ]);
    if (verification)
      await this.emitPreOrderEvent(
        verification.partnerId,
        verificationId,
        verification.externalOrderId,
        "document.verification.reupload_required",
        verification.consumedOrderId,
      );
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
    const dedupeKey = `document-verification:${verificationId}:${type}`;
    await this.prisma.partnerEvent.upsert({
      where: { dedupeKey },
      update: {},
      create: {
        partnerId,
        ...(orderId ? { orderId } : {}),
        dedupeKey,
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
    const dedupeKey = `order-document-verification:${orderId}:${documentId}:${verificationStatus}`;
    await this.prisma.partnerEvent.upsert({
      where: { dedupeKey },
      update: {},
      create: {
        partnerId,
        orderId,
        dedupeKey,
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
      nationality: string;
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
      nationality: traveler.nationality,
      dateOfBirth: this.crypto.decrypt(traveler.dateOfBirthEncrypted ?? ""),
      passportNumber: this.crypto.decrypt(
        traveler.passportNumberEncrypted ?? "",
      ),
      passportExpiryDate: this.crypto.decrypt(
        traveler.passportExpiryEncrypted ?? "",
      ),
    };
  }

  private readyExtractionFields(
    extraction: {
      status: string;
      passportAssetId: string;
      payloadEncrypted: string | null;
    } | null,
    currentAssetId: string,
  ): PassportExtractedFields | null {
    if (
      !extraction ||
      !["READY", "PARTIAL"].includes(extraction.status) ||
      extraction.passportAssetId !== currentAssetId ||
      !extraction.payloadEncrypted
    )
      return null;
    try {
      const value = JSON.parse(
        this.crypto.decrypt(extraction.payloadEncrypted),
      ) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
      return Object.fromEntries(
        Object.entries(value).filter(([, field]) => typeof field === "string"),
      ) as PassportExtractedFields;
    } catch (error) {
      this.logger.warn(
        `Stored passport extraction could not be used: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return null;
    }
  }
}
