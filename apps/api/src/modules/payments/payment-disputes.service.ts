import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  PaymentDisputeStatus,
  PaymentDisputeType,
  PaymentProvider,
  PaymentStatus,
  Prisma,
} from "@prisma/client";
import { createHash } from "node:crypto";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { ProductionResilienceService } from "../../jobs/production-resilience.service.js";

export type PaymentDisputeEventType =
  | "CHARGEBACK_OPENED"
  | "DISPUTE_OPENED"
  | "CHARGEBACK_WON"
  | "CHARGEBACK_LOST"
  | "DISPUTE_WON"
  | "DISPUTE_LOST"
  | "DISPUTE_RESOLVED";

@Injectable()
export class PaymentDisputesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resilience: ProductionResilienceService,
  ) {}

  async list(status?: PaymentDisputeStatus) {
    if (!this.prisma.enabled) return [];
    return this.prisma.paymentDispute.findMany({
      where: status ? { status } : {},
      include: {
        order: { select: { orderNumber: true, status: true } },
        payment: {
          select: { paymentReference: true, status: true, amount: true },
        },
      },
      orderBy: { openedAt: "desc" },
      take: 200,
    });
  }

  async item(id: string) {
    const dispute = await this.prisma.paymentDispute.findUnique({
      where: { id },
      include: {
        order: { select: { orderNumber: true, status: true } },
        payment: true,
      },
    });
    if (!dispute) throw new NotFoundException("Payment dispute not found");
    return dispute;
  }

  async recordProviderEvent(input: {
    provider: string;
    eventId: string;
    eventType: PaymentDisputeEventType;
    reference: string;
    caseId: string;
    amount?: number;
    currency?: string;
    reason?: string;
    evidence?: Record<string, unknown>;
  }) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    const provider = input.provider.toUpperCase();
    if (provider !== PaymentProvider.KHALTI)
      throw new BadRequestException(
        `Unsupported payment provider: ${provider}`,
      );
    const payment = await this.prisma.payment.findUnique({
      where: { paymentReference: input.reference },
      include: { order: { select: { id: true, orderNumber: true } } },
    });
    if (!payment) {
      const referenceHash = createHash("sha256")
        .update(input.reference)
        .digest("hex");
      const webhook = await this.prisma.webhookEvent.findUnique({
        where: {
          source_eventId: {
            source: input.provider.toLowerCase(),
            eventId: input.eventId,
          },
        },
        select: { id: true },
      });
      await this.resilience.attention({
        dedupeKey: `unknown-payment-dispute:${provider}:${input.eventId}`,
        category: "PAYMENT_SECURITY",
        entityType: webhook ? "WebhookEvent" : "PaymentReference",
        entityId: webhook?.id ?? referenceHash,
        severity: "CRITICAL",
        summary: "Payment dispute references an unknown payment",
        detail: `Provider case ${input.caseId} cannot be linked to a local payment`,
        externalState: input.eventType,
        failureCategory: "UNKNOWN_PAYMENT_REFERENCE",
        availableActions: webhook ? ["REPLAY_WEBHOOK"] : [],
      });
      throw new NotFoundException("Payment dispute reference is unknown");
    }
    if (
      input.currency &&
      input.currency.toUpperCase() !== payment.currency.toUpperCase()
    )
      throw new BadRequestException("Payment dispute currency does not match");
    if (input.amount !== undefined && input.amount > Number(payment.amount))
      throw new BadRequestException("Payment dispute amount exceeds payment");

    const status = this.status(input.eventType);
    const type = input.eventType.startsWith("CHARGEBACK")
      ? PaymentDisputeType.CHARGEBACK
      : PaymentDisputeType.DISPUTE;
    const terminal = this.isTerminal(status);
    const dispute = await this.prisma.$transaction(async (tx) => {
      const row = await tx.paymentDispute.upsert({
        where: {
          provider_providerCaseId: {
            provider: PaymentProvider.KHALTI,
            providerCaseId: input.caseId,
          },
        },
        create: {
          orderId: payment.orderId,
          paymentId: payment.id,
          provider: PaymentProvider.KHALTI,
          providerCaseId: input.caseId,
          openedEventId: input.eventId,
          type,
          status,
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          currency: input.currency?.toUpperCase() ?? payment.currency,
          ...(input.reason ? { reason: input.reason.slice(0, 1000) } : {}),
          providerEvidence: (input.evidence ?? {}) as Prisma.InputJsonValue,
          ...(terminal ? { resolvedAt: new Date() } : {}),
        },
        update: {
          status,
          ...(input.reason ? { reason: input.reason.slice(0, 1000) } : {}),
          providerEvidence: (input.evidence ?? {}) as Prisma.InputJsonValue,
          ...(terminal ? { resolvedAt: new Date() } : { resolvedAt: null }),
        },
      });
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status:
            status === PaymentDisputeStatus.LOST
              ? PaymentStatus.CHARGED_BACK
              : status === PaymentDisputeStatus.WON ||
                  status === PaymentDisputeStatus.RESOLVED
                ? PaymentStatus.COMPLETED
                : PaymentStatus.DISPUTED,
        },
      });
      await tx.auditLog.create({
        data: {
          module: "PAYMENTS",
          entity: "PaymentDispute",
          entityId: row.id,
          action: input.eventType,
          newValue: {
            providerCaseId: input.caseId,
            orderId: payment.orderId,
            status,
          },
        },
      });
      return row;
    });

    const dedupeKey = `payment-dispute:${dispute.id}`;
    if (
      status === PaymentDisputeStatus.WON ||
      status === PaymentDisputeStatus.RESOLVED
    ) {
      await this.resilience.resolve(
        dedupeKey,
        null,
        `Provider resolved dispute as ${status}`,
      );
    } else {
      await this.resilience.attention({
        dedupeKey,
        category: "PAYMENT_DISPUTE",
        entityType: "PaymentDispute",
        entityId: dispute.id,
        orderId: payment.orderId,
        severity: status === PaymentDisputeStatus.LOST ? "CRITICAL" : "WARNING",
        summary: `${type.toLowerCase()} ${input.caseId} affects ${payment.order.orderNumber}`,
        ...(input.reason ? { detail: input.reason.slice(0, 1000) } : {}),
        localState: payment.status,
        externalState: status,
        lastSuccessfulStep: "PAYMENT_CONFIRMED",
        failureCategory:
          status === PaymentDisputeStatus.LOST
            ? "FUNDS_REVERSED"
            : "PAYMENT_DISPUTED",
        availableActions: ["REVIEW_FINANCIAL_DISPUTE"],
      });
    }
    return dispute;
  }

  async updateStatus(
    id: string,
    actorId: string,
    status: PaymentDisputeStatus,
    note: string,
  ) {
    if (!Object.values(PaymentDisputeStatus).includes(status))
      throw new BadRequestException("Invalid dispute status");
    if (note.trim().length < 5)
      throw new BadRequestException("A resolution note is required");
    const current = await this.prisma.paymentDispute.findUnique({
      where: { id },
    });
    if (!current) throw new NotFoundException("Payment dispute not found");
    const terminal = this.isTerminal(status);
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.paymentDispute.update({
        where: { id },
        data: {
          status,
          resolutionNote: note.trim(),
          ...(terminal ? { resolvedAt: new Date() } : { resolvedAt: null }),
        },
      });
      await tx.payment.update({
        where: { id: current.paymentId },
        data: {
          status:
            status === PaymentDisputeStatus.LOST
              ? PaymentStatus.CHARGED_BACK
              : terminal
                ? PaymentStatus.COMPLETED
                : PaymentStatus.DISPUTED,
        },
      });
      await tx.auditLog.create({
        data: {
          module: "PAYMENTS",
          entity: "PaymentDispute",
          entityId: id,
          action: "PAYMENT_DISPUTE_STATUS_CHANGED",
          performedById: actorId,
          previousValue: { status: current.status },
          newValue: { status, note: note.trim() },
        },
      });
      return row;
    });
    if (terminal && status !== PaymentDisputeStatus.LOST)
      await this.resilience.resolve(
        `payment-dispute:${id}`,
        actorId,
        note.trim(),
      );
    return updated;
  }

  private status(eventType: PaymentDisputeEventType): PaymentDisputeStatus {
    if (eventType.endsWith("_WON")) return PaymentDisputeStatus.WON;
    if (eventType.endsWith("_LOST")) return PaymentDisputeStatus.LOST;
    if (eventType.endsWith("_RESOLVED")) return PaymentDisputeStatus.RESOLVED;
    return PaymentDisputeStatus.OPEN;
  }

  private isTerminal(status: PaymentDisputeStatus): boolean {
    return (
      status === PaymentDisputeStatus.WON ||
      status === PaymentDisputeStatus.LOST ||
      status === PaymentDisputeStatus.RESOLVED
    );
  }
}
