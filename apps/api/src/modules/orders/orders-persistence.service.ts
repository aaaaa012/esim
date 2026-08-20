import { ConflictException, Injectable } from "@nestjs/common";
import {
  Prisma,
  type OrderStatus as DbOrderStatus,
  type OrderType as DbOrderType,
  type PaymentStatus as DbPaymentStatus,
} from "@prisma/client";
import {
  DocumentStatus,
  DocumentType,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  type TravelerInput,
} from "@visa-compass/shared";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { CryptoService } from "../../infrastructure/crypto.service.js";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import type { DemoOrder } from "./orders.service.js";
import type { PassportVerificationResult } from "./passport-verification.service.js";

@Injectable()
export class OrdersPersistenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async load(orderId?: string): Promise<DemoOrder[]> {
    if (!this.prisma.enabled) return [];
    const rows = await this.prisma.order.findMany({
      where: orderId ? { id: orderId } : {},
      include: {
        customer: { include: { user: true } },
        partner: { select: { id: true, code: true, name: true } },
        plan: { include: { country: true } },
        traveler: true,
        customerEsim: { include: { inventory: true, subscriptions: true } },
        documents: true,
        payments: { orderBy: { createdAt: "desc" }, take: 1 },
        events: { orderBy: { createdAt: "asc" } },
      },
    });
    return rows.map((row) => {
      const traveler: TravelerInput | undefined = row.traveler
        ? {
            title: row.traveler.title as TravelerInput["title"],
            firstName: row.traveler.firstName,
            surname: row.traveler.surname,
            ...(row.traveler.middleName
              ? { middleName: row.traveler.middleName }
              : {}),
            dateOfBirth: this.crypto.decrypt(row.traveler.dateOfBirthEncrypted),
            nationality: row.traveler.nationality,
            city: row.traveler.city,
            countryOfResidence: row.traveler.countryOfResidence,
            ...(row.traveler.employerOrBusinessName
              ? { employerOrBusinessName: row.traveler.employerOrBusinessName }
              : {}),
            email: row.traveler.email,
            mobile: row.traveler.mobile,
            passportNumber: this.crypto.decrypt(
              row.traveler.passportNumberEncrypted,
            ),
            passportExpiryDate: this.crypto.decrypt(
              row.traveler.passportExpiryEncrypted,
            ),
            ...(row.traveler.pointOfSaleCode
              ? { pointOfSaleCode: row.traveler.pointOfSaleCode }
              : {}),
          }
        : undefined;
      const payment = row.payments[0];
      return {
        id: row.id,
        ownerId: row.customer.user?.clerkId ?? row.customerId,
        orderNumber: row.orderNumber,
        status: row.status as OrderStatus,
        version: row.version,
        plan: {
          id: row.plan.id,
          countryCode: row.plan.country.isoCode,
          countryName: row.plan.country.name,
          name: row.plan.name,
          dataAllowance: row.plan.dataAllowance,
          validityDays: row.plan.validityDays,
          sellingPriceNpr: Number(row.plan.sellingPrice),
          coverage: row.plan.coverage as string[],
          popular: row.plan.popular,
        },
        totalAmountNpr: Number(row.totalAmount),
        pricingSnapshot: row.pricingSnapshot as object,
        compatibilityAcceptedAt: row.compatibilityAcceptedAt.toISOString(),
        ...(traveler ? { traveler } : {}),
        documents: row.documents.map((doc) => ({
          id: doc.id,
          type: doc.type as DocumentType,
          fileName: doc.fileName,
          privateAssetId: doc.privateAssetId,
          status: doc.status as DocumentStatus,
          uploadVerified: doc.uploadVerified,
        })),
        ...(() => {
          const passport = row.documents.find((doc) => doc.type === "PASSPORT");
          if (!passport?.passportVerificationStatus) return {};
          const verification: PassportVerificationResult = {
            status:
              passport.passportVerificationStatus as PassportVerificationResult["status"],
            matchedFields:
              (passport.passportMatchedFields as
                PassportVerificationResult["matchedFields"] | null) ?? [],
            ...(passport.passportConfidence != null
              ? { confidence: passport.passportConfidence }
              : {}),
            checkedAt:
              passport.passportVerifiedAt?.toISOString() ??
              new Date().toISOString(),
            method:
              (passport.passportVerificationMethod as
                PassportVerificationResult["method"] | null) ?? "tesseract-ocr",
          };
          return { passportVerification: verification };
        })(),
        ...(payment
          ? {
              payment: {
                provider: payment.provider as PaymentProvider,
                reference: payment.paymentReference,
                status: payment.status as PaymentStatus,
                verificationAttempts: payment.verificationAttempts,
                ...(payment.providerCorrelationId
                  ? { correlationId: payment.providerCorrelationId }
                  : {}),
                ...(payment.expiresAt
                  ? { expiresAt: payment.expiresAt.toISOString() }
                  : {}),
                ...(payment.returnUrl ? { returnUrl: payment.returnUrl } : {}),
                ...(payment.redirectUrl
                  ? { redirectUrl: payment.redirectUrl }
                  : {}),
                ...(payment.providerTransactionId
                  ? { providerTransactionId: payment.providerTransactionId }
                  : {}),
              },
            }
          : {}),
        timeline: row.events.map((event) => ({
          from: event.fromStatus as OrderStatus | null,
          to: event.toStatus as OrderStatus,
          at: event.createdAt.toISOString(),
          ...(event.reason ? { reason: event.reason } : {}),
        })),
        ...(row.customerEsim
          ? {
              qrPayload: this.crypto.decrypt(
                row.customerEsim.qrPayloadEncrypted,
              ),
            }
          : {}),
        ...(row.providerSubscriptionId
          ? { providerSubscriptionId: row.providerSubscriptionId }
          : {}),
        ...(row.providerStatus ? { providerStatus: row.providerStatus } : {}),
        ...(row.qrDeliveredAt
          ? { qrDeliveredAt: row.qrDeliveredAt.toISOString() }
          : {}),
        ...(row.activatedAt
          ? { activatedAt: row.activatedAt.toISOString() }
          : {}),
        documentReviewPolicy: row.documentReviewPolicy,
        documentReviewStatus: row.documentReviewStatus,
        ...(row.documentReviewStartedAt
          ? {
              documentReviewStartedAt:
                row.documentReviewStartedAt.toISOString(),
            }
          : {}),
        ...(row.documentCheckoutReleaseAt
          ? {
              documentCheckoutReleaseAt:
                row.documentCheckoutReleaseAt.toISOString(),
            }
          : {}),
        activationRefetchAttempts: row.activationRefetchAttempts,
        ...(row.lastProvisioningRecoveryAt
          ? {
              lastProvisioningRecoveryAt:
                row.lastProvisioningRecoveryAt.toISOString(),
            }
          : {}),
        ...(row.operationalDisposition
          ? { operationalDisposition: row.operationalDisposition }
          : {}),
        purchaseType: row.orderType as "INITIAL_PURCHASE" | "TOPUP",
        ...(row.partner ? { partner: row.partner } : {}),
        ...(row.externalOrderId
          ? { externalOrderId: row.externalOrderId }
          : {}),
        ...(() => {
          const snapshot = row.pricingSnapshot as { topUpMobile?: string };
          return snapshot?.topUpMobile
            ? { topUpMobile: snapshot.topUpMobile }
            : {};
        })(),
        ...(() => {
          if (!row.customerEsim?.subscriptions?.length) return {};
          const latest = [...row.customerEsim.subscriptions].sort(
            (a, b) =>
              (b.usageLastCheckedAt?.getTime() ?? 0) -
              (a.usageLastCheckedAt?.getTime() ?? 0),
          )[0];
          if (!latest?.usageLastCheckedAt) return {};
          return {
            usage: {
              usedMb: latest.usedMb,
              totalMb: latest.totalMb,
              lastCheckedAt: latest.usageLastCheckedAt.toISOString(),
            },
          };
        })(),
        ...(() => {
          const subscription = row.customerEsim?.subscriptions[0];
          const inventory = row.customerEsim?.inventory;
          if (!inventory) return {};
          return {
            assignment: {
              inventoryId: inventory.id,
              iccid: inventory.iccid,
              ...(inventory.msisdn ? { msisdn: inventory.msisdn } : {}),
              ...(subscription?.providerSubscriptionId
                ? {
                    providerSubscriptionId: subscription.providerSubscriptionId,
                  }
                : {}),
              ...(subscription
                ? {
                    verificationStatus:
                      subscription.assignmentVerificationStatus,
                  }
                : {}),
              ...(subscription?.assignmentVerifiedAt
                ? {
                    verifiedAt: subscription.assignmentVerifiedAt.toISOString(),
                  }
                : {}),
              ...(subscription?.providerLastSeenAt
                ? {
                    providerLastSeenAt:
                      subscription.providerLastSeenAt.toISOString(),
                  }
                : {}),
            },
          };
        })(),
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  async save(order: DemoOrder) {
    if (!this.prisma.enabled) return;
    // Interactive transactions default to a 5000 ms timeout, which cloud DB
    // latency routinely exceeds during payment flows; raise it so payment
    // initiation does not die with "Transaction already closed".
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const identity = await this.ensureIdentity(tx, order);
          const country = await tx.country.upsert({
            where: { isoCode: order.plan.countryCode },
            update: { name: order.plan.countryName, active: true },
            create: {
              isoCode: order.plan.countryCode,
              name: order.plan.countryName,
            },
          });
          await tx.plan.upsert({
            where: { id: order.plan.id },
            update: {
              name: order.plan.name,
              dataAllowance: order.plan.dataAllowance,
              validityDays: order.plan.validityDays,
              sellingPrice: order.plan.sellingPriceNpr,
              coverage: order.plan.coverage,
              popular: order.plan.popular,
              status: "ACTIVE",
            },
            create: {
              id: order.plan.id,
              countryId: country.id,
              providerPlanId: `TRANSATEL-${order.plan.countryCode}`,
              name: order.plan.name,
              dataAllowance: order.plan.dataAllowance,
              validityDays: order.plan.validityDays,
              costPrice: Math.round(order.plan.sellingPriceNpr * 0.65),
              sellingPrice: order.plan.sellingPriceNpr,
              coverage: order.plan.coverage,
              popular: order.plan.popular,
              status: "ACTIVE",
            },
          });
          const existing = await tx.order.findUnique({
            where: { id: order.id },
            select: {
              id: true,
              status: true,
              partnerId: true,
              externalOrderId: true,
            },
          });
          if (existing) {
            const updated = await tx.order.updateMany({
              where: { id: order.id, version: order.version },
              data: {
                status: order.status as DbOrderStatus,
                totalAmount: order.totalAmountNpr,
                pricingSnapshot: order.pricingSnapshot as Prisma.InputJsonValue,
                orderType: (order.purchaseType ??
                  "INITIAL_PURCHASE") as DbOrderType,
                providerSubscriptionId: order.providerSubscriptionId ?? null,
                providerStatus: order.providerStatus ?? null,
                operationalDisposition: order.operationalDisposition ?? null,
                qrDeliveredAt: order.qrDeliveredAt
                  ? new Date(order.qrDeliveredAt)
                  : null,
                activatedAt: order.activatedAt
                  ? new Date(order.activatedAt)
                  : null,
                ...(order.documentReviewPolicy
                  ? { documentReviewPolicy: order.documentReviewPolicy }
                  : {}),
                ...(order.documentReviewStatus
                  ? { documentReviewStatus: order.documentReviewStatus }
                  : {}),
                documentReviewStartedAt: order.documentReviewStartedAt
                  ? new Date(order.documentReviewStartedAt)
                  : null,
                documentCheckoutReleaseAt: order.documentCheckoutReleaseAt
                  ? new Date(order.documentCheckoutReleaseAt)
                  : null,
                version: { increment: 1 },
              },
            });
            if (updated.count !== 1)
              throw new ConflictException(
                "Order was changed by another request; reload and retry",
              );
            if (existing.partnerId && existing.status !== order.status) {
              const eventType = this.partnerEventType(order.status);
              if (eventType) {
                const endpoints = await tx.partnerWebhookEndpoint.findMany({
                  where: { partnerId: existing.partnerId, active: true },
                });
                const eligible = endpoints.filter((endpoint) => {
                  const types = Array.isArray(endpoint.eventTypes)
                    ? endpoint.eventTypes.filter(
                        (value): value is string => typeof value === "string",
                      )
                    : [];
                  return types.includes("*") || types.includes(eventType);
                });
                await tx.partnerEvent.create({
                  data: {
                    partnerId: existing.partnerId,
                    orderId: order.id,
                    type: eventType,
                    resourceId: order.id,
                    correlationId: randomUUID(),
                    payload: {
                      orderId: order.id,
                      externalOrderId: existing.externalOrderId,
                      status: order.status,
                      fulfillmentStatus: this.fulfillmentStatus(order.status),
                      version: order.version + 1,
                    },
                    deliveries: {
                      create: eligible.map((endpoint) => ({
                        endpointId: endpoint.id,
                      })),
                    },
                  },
                });
              }
            }
          } else {
            await tx.order.create({
              data: {
                id: order.id,
                orderNumber: order.orderNumber,
                customerId: identity.customerId,
                planId: order.plan.id,
                orderType: (order.purchaseType ??
                  "INITIAL_PURCHASE") as DbOrderType,
                status: order.status as DbOrderStatus,
                version: 1,
                subtotal: order.totalAmountNpr,
                totalAmount: order.totalAmountNpr,
                pricingSnapshot: order.pricingSnapshot as Prisma.InputJsonValue,
                compatibilityAcceptedAt: new Date(
                  order.compatibilityAcceptedAt,
                ),
                providerSubscriptionId: order.providerSubscriptionId ?? null,
                providerStatus: order.providerStatus ?? null,
                qrDeliveredAt: order.qrDeliveredAt
                  ? new Date(order.qrDeliveredAt)
                  : null,
                activatedAt: order.activatedAt
                  ? new Date(order.activatedAt)
                  : null,
                createdAt: new Date(order.createdAt),
              },
            });
          }
          if (order.traveler)
            await tx.traveler.upsert({
              where: { orderId: order.id },
              update: this.travelerData(order.traveler),
              create: {
                orderId: order.id,
                ...this.travelerData(order.traveler),
              },
            });
          await tx.travelerDocument.deleteMany({
            where: {
              orderId: order.id,
              id: { notIn: order.documents.map((document) => document.id) },
            },
          });
          for (const doc of order.documents) {
            const isPassport = doc.type === DocumentType.PASSPORT;
            const verification = order.passportVerification;
            const passportFields = isPassport
              ? {
                  passportVerificationStatus: verification?.status ?? null,
                  passportVerificationMethod: verification?.method ?? null,
                  passportMatchedFields: (verification?.matchedFields ??
                    []) as Prisma.InputJsonValue,
                  passportConfidence: verification?.confidence ?? null,
                  passportVerifiedAt: verification?.checkedAt
                    ? new Date(verification.checkedAt)
                    : null,
                }
              : {};
            await tx.travelerDocument.upsert({
              where: { id: doc.id },
              update: {
                ...passportFields,
                fileName: doc.fileName,
                privateAssetId: doc.privateAssetId,
                status: doc.status as never,
                uploadVerified: doc.uploadVerified ?? false,
              },
              create: {
                id: doc.id,
                orderId: order.id,
                type: doc.type as never,
                ...passportFields,
                fileName: doc.fileName,
                privateAssetId: doc.privateAssetId,
                status: doc.status as never,
                uploadVerified: doc.uploadVerified ?? false,
              },
            });
          }
          if (order.payment)
            await tx.payment.upsert({
              where: { paymentReference: order.payment.reference },
              update: {
                status: order.payment.status as DbPaymentStatus,
                providerCorrelationId: order.payment.correlationId ?? null,
                providerTransactionId:
                  order.payment.providerTransactionId ?? null,
                expiresAt: order.payment.expiresAt
                  ? new Date(order.payment.expiresAt)
                  : null,
                returnUrl: order.payment.returnUrl ?? null,
                redirectUrl: order.payment.redirectUrl ?? null,
                paidAt:
                  order.payment.status === PaymentStatus.COMPLETED
                    ? new Date()
                    : null,
              },
              create: {
                orderId: order.id,
                provider: order.payment.provider as never,
                paymentReference: order.payment.reference,
                providerCorrelationId: order.payment.correlationId ?? null,
                providerTransactionId:
                  order.payment.providerTransactionId ?? null,
                expiresAt: order.payment.expiresAt
                  ? new Date(order.payment.expiresAt)
                  : null,
                returnUrl: order.payment.returnUrl ?? null,
                redirectUrl: order.payment.redirectUrl ?? null,
                amount: order.totalAmountNpr,
                status: order.payment.status as DbPaymentStatus,
              },
            });
          await tx.orderEvent.deleteMany({ where: { orderId: order.id } });
          if (order.timeline.length)
            await tx.orderEvent.createMany({
              data: order.timeline.map((event) => ({
                orderId: order.id,
                fromStatus: event.from as DbOrderStatus | null,
                toStatus: event.to as DbOrderStatus,
                createdAt: new Date(event.at),
                reason: event.reason ?? null,
              })),
            });
        },
        { maxWait: 15000, timeout: 45000 },
      );
    } catch (error) {
      // Callers mutate the cached object before saving. On a CAS conflict (or
      // a failed transaction), restore that same object from the database so
      // future requests do not keep retrying with a stale version forever.
      const persisted = await this.load(order.id).catch(() => []);
      if (persisted[0]) {
        for (const key of Object.keys(order))
          delete (order as Record<string, unknown>)[key];
        Object.assign(order, persisted[0]);
      }
      throw error;
    }
    order.version += 1;
  }

  /**
   * Atomically claims a gateway-confirmed payment.  This is deliberately a
   * narrow database command rather than a mutation of the process cache: a
   * callback, browser return, and reconciliation job may execute on separate
   * API replicas.  Exactly one of them can move PENDING to COMPLETED.
   */
  async confirmPaymentAtomically(
    orderId: string,
    reference: string,
    transactionId?: string,
  ): Promise<{
    claimed: boolean;
    alreadyCompleted: boolean;
    requiresReview: boolean;
  }> {
    if (!this.prisma.enabled)
      return { claimed: true, alreadyCompleted: false, requiresReview: false };
    return this.prisma.$transaction(
      async (tx) => {
        const payment = await tx.payment.findUnique({
          where: { paymentReference: reference },
          select: {
            orderId: true,
            status: true,
            order: { select: { status: true } },
          },
        });
        if (!payment || payment.orderId !== orderId)
          throw new ConflictException(
            "Payment reference does not belong to this order",
          );
        if (payment.status === PaymentStatus.COMPLETED)
          return {
            claimed: false,
            alreadyCompleted: true,
            requiresReview: false,
          };
        const orderCanAdvance = [
          OrderStatus.PAYMENT_PENDING,
          OrderStatus.PAYMENT_REVIEW_REQUIRED,
        ].includes(payment.order.status as OrderStatus);
        const paid = await tx.payment.updateMany({
          where: {
            paymentReference: reference,
            orderId,
            status: {
              in: [
                PaymentStatus.PENDING,
                PaymentStatus.REVIEW_REQUIRED,
              ] as DbPaymentStatus[],
            },
          },
          data: {
            status: PaymentStatus.COMPLETED as DbPaymentStatus,
            ...(transactionId ? { providerTransactionId: transactionId } : {}),
            paidAt: new Date(),
          },
        });
        if (paid.count !== 1) {
          const latest = await tx.payment.findUnique({
            where: { paymentReference: reference },
            select: { status: true },
          });
          return {
            claimed: false,
            alreadyCompleted: latest?.status === PaymentStatus.COMPLETED,
            requiresReview: false,
          };
        }
        if (!orderCanAdvance)
          return {
            claimed: true,
            alreadyCompleted: false,
            requiresReview: true,
          };
        const transitioned = await tx.order.updateMany({
          where: {
            id: orderId,
            status: {
              in: [
                OrderStatus.PAYMENT_PENDING,
                OrderStatus.PAYMENT_REVIEW_REQUIRED,
              ] as DbOrderStatus[],
            },
          },
          data: {
            status: OrderStatus.PAYMENT_CONFIRMED as DbOrderStatus,
            version: { increment: 1 },
          },
        });
        if (transitioned.count === 1) {
          await tx.orderEvent.create({
            data: {
              orderId,
              fromStatus: payment.order.status as DbOrderStatus,
              toStatus: OrderStatus.PAYMENT_CONFIRMED as DbOrderStatus,
              reason: "Gateway payment confirmed",
            },
          });
        }
        return {
          claimed: true,
          alreadyCompleted: false,
          requiresReview: false,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 15_000,
        timeout: 45_000,
      },
    );
  }

  async recordConsent(
    orderId: string,
    ownerId: string,
    type: string,
    version: string,
    ipAddress: string,
    userAgent: string,
  ) {
    if (!this.prisma.enabled) return;
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { customerId: true },
    });
    if (!order) return;
    await this.prisma.customerConsent.create({
      data: {
        customerId: order.customerId,
        type,
        version,
        ipAddress: ipAddress.slice(0, 64),
        userAgent: userAgent.slice(0, 255),
      },
    });
  }

  async provisioningAttempt(
    orderId: string,
    attempt: number,
    request: object,
    result?: { response?: object; errorCode?: string },
  ) {
    if (!this.prisma.enabled) return;
    const provider = "TRANSATEL";
    await this.prisma.provisioningAttempt.create({
      data: {
        orderId,
        provider,
        status: result?.errorCode
          ? attempt >= 3
            ? "FAILED"
            : "RETRYING"
          : "SUCCEEDED",
        correlationId: randomUUID(),
        attempt,
        requestSnapshot: request as Prisma.InputJsonValue,
        ...(result?.response
          ? { responseSnapshot: result.response as Prisma.InputJsonValue }
          : {}),
        ...(result?.errorCode ? { errorCode: result.errorCode } : {}),
        completedAt: new Date(),
      },
    });
  }

  async audit() {
    if (!this.prisma.enabled) return [];
    const rows = await this.prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { performedBy: { select: { email: true } } },
    });
    return rows.map((row) => ({
      id: row.id,
      module: row.module,
      entity: row.entity,
      entityId: row.entityId,
      action: row.action,
      performedByEmail: row.performedBy?.email ?? null,
      previousValue: row.previousValue,
      newValue: row.newValue,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async recordReview(
    orderId: string,
    documentId: string,
    actorClerkId: string,
    decision: "APPROVE" | "REUPLOAD",
    reason?: string,
  ) {
    if (!this.prisma.enabled) return;
    const actor = await this.prisma.user.upsert({
      where: { clerkId: actorClerkId },
      update: {},
      create: {
        clerkId: actorClerkId,
        email: `${createHash("sha256").update(actorClerkId).digest("hex").slice(0, 12)}@local.visacompass.invalid`,
      },
    });
    await this.prisma.$transaction([
      this.prisma.orderReview.create({
        data: {
          orderId,
          reviewerId: actor.id,
          decision: decision === "APPROVE" ? "APPROVED" : "REUPLOAD_REQUIRED",
          reasons: reason ? [reason] : [],
          comments: reason ?? null,
        },
      }),
      this.prisma.travelerDocument.update({
        where: { id: documentId },
        data: { reviewedById: actor.id, reviewedAt: new Date() },
      }),
      this.prisma.auditLog.create({
        data: {
          module: "VERIFICATION",
          entity: "TravelerDocument",
          entityId: documentId,
          action: decision,
          performedById: actor.id,
          newValue: { orderId, reason: reason ?? null },
        },
      }),
    ]);
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

  private partnerEventType(status: OrderStatus) {
    const types: Partial<Record<OrderStatus, string>> = {
      [OrderStatus.PROVISIONING]: "order.provisioning",
      [OrderStatus.QR_READY]: "order.qr_ready",
      [OrderStatus.COMPLETED]: "order.activated",
      [OrderStatus.PROVISIONING_FAILED]: "order.provisioning_failed",
      [OrderStatus.CANCELLED]: "order.cancelled",
      [OrderStatus.REFUNDED]: "order.refunded",
    };
    return types[status];
  }

  private fulfillmentStatus(status: OrderStatus) {
    if (status === OrderStatus.QR_READY) return "READY";
    if (status === OrderStatus.COMPLETED) return "ACTIVATED";
    if (status === OrderStatus.PROVISIONING_FAILED) return "FAILED";
    if ([OrderStatus.APPROVED, OrderStatus.PROVISIONING].includes(status))
      return "PENDING";
    return "NOT_READY";
  }

  private async ensureIdentity(tx: Prisma.TransactionClient, order: DemoOrder) {
    if (!order.ownerId) {
      const suffix = createHash("sha256")
        .update(order.id)
        .digest("hex")
        .slice(0, 12);
      const clerkId = `guest-${suffix}`;
      const email = `${suffix}@guest.visacompass.invalid`;
      const user = await tx.user.upsert({
        where: { clerkId },
        update: {},
        create: { clerkId, email },
      });
      const customerCode = `G-${suffix.toUpperCase()}`;
      const customer = await tx.customer.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id, email, customerCode },
      });
      return { userId: user.id, customerId: customer.id };
    }
    const suffix = createHash("sha256")
      .update(order.ownerId)
      .digest("hex")
      .slice(0, 12);
    const email = `${suffix}@local.visacompass.invalid`;
    const user = await tx.user.upsert({
      where: { clerkId: order.ownerId },
      update: {},
      create: { clerkId: order.ownerId, email },
    });
    const customer = await tx.customer.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        email,
        customerCode: `VC-${suffix.toUpperCase()}`,
      },
    });
    return { userId: user.id, customerId: customer.id };
  }
}
