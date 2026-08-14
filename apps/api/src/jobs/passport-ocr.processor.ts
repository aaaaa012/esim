import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { DocumentType, type Prisma } from "@prisma/client";
import type { Job } from "bullmq";
import { randomUUID } from "node:crypto";
import { CryptoService } from "../infrastructure/crypto.service.js";
import { PrismaService } from "../infrastructure/prisma.service.js";
import { PassportVerificationService } from "../modules/orders/passport-verification.service.js";
import { QueueService } from "./queue.service.js";
import { QUEUES } from "./queues.js";

type PassportOcrJob = { orderId: string; documentId: string };

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
  ) {}

  onModuleInit() {
    this.queues.registerWorker(QUEUES.documents, (job) =>
      this.process(job as Job<PassportOcrJob>),
    );
  }

  async process(job: Job<PassportOcrJob>) {
    const { orderId, documentId } = job.data;
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        traveler: true,
        documents: true,
        partner: { select: { id: true } },
      },
    });
    if (!order || !order.partnerId) return { skipped: true };
    const passport = order.documents.find(
      (document) =>
        document.type === DocumentType.PASSPORT && document.id === documentId,
    );
    if (!passport) return { skipped: true };
    // A terminal verdict already exists from a previous run; do not overwrite.
    if (
      passport.passportVerificationStatus === "VERIFIED" ||
      passport.passportVerificationStatus === "SKIPPED"
    )
      return { skipped: true, alreadyVerified: true };

    const traveler = this.decryptTraveler(order.traveler);
    const result = await this.passportVerifier.verify({
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

    await this.prisma.travelerDocument.update({
      where: { id: passport.id },
      data: {
        passportVerificationStatus: result.status,
        passportVerificationMethod: result.method,
        passportMatchedFields: result.matchedFields as Prisma.InputJsonValue,
        passportConfidence: result.confidence ?? null,
        passportVerifiedAt: new Date(result.checkedAt),
      },
    });

    await this.emitVerifiedEvent(
      order.partnerId,
      order.id,
      order.externalOrderId,
      passport.id,
      result.status,
    );

    return result;
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
        ? endpoint.eventTypes.filter((value): value is string => typeof value === "string")
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