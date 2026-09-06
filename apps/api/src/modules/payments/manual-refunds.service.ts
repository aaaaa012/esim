import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  ManualRefundReason,
  ManualRefundStatus,
  OrderStatus,
  PaymentStatus,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { withPostgresTransactionRetry } from "../../infrastructure/postgres-transaction-retry.js";
import { OrdersService } from "../orders/orders.service.js";
import { ProductionResilienceService } from "../../jobs/production-resilience.service.js";

const ACTIVE = [ManualRefundStatus.REQUESTED, ManualRefundStatus.APPROVED];

@Injectable()
export class ManualRefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly resilience?: ProductionResilienceService,
  ) {}

  async list(input: {
    status?: ManualRefundStatus;
    orderId?: string;
    limit?: number;
    offset?: number;
  }) {
    if (!this.prisma.enabled)
      return { items: [], total: 0, limit: 50, offset: 0 };
    const limit = Math.min(200, Math.max(1, input.limit ?? 50));
    const offset = Math.max(0, input.offset ?? 0);
    const where = {
      ...(input.status ? { status: input.status } : {}),
      ...(input.orderId ? { orderId: input.orderId } : {}),
    };
    const include = {
      order: { select: { orderNumber: true, status: true, totalAmount: true } },
      payment: { select: { provider: true } },
      requestedBy: { select: { email: true } },
      reviewedBy: { select: { email: true } },
    } as const;
    const [items, total] = await Promise.all([
      this.prisma.manualRefund.findMany({
        where,
        include,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      this.prisma.manualRefund.count({ where }),
    ]);
    return { items, total, limit, offset };
  }

  async item(id: string) {
    const refund = await this.prisma.manualRefund.findUnique({
      where: { id },
      include: {
        order: { select: { orderNumber: true, status: true } },
        payment: true,
      },
    });
    if (!refund) throw new NotFoundException("Manual refund request not found");
    return refund;
  }

  async reconcilePending() {
    if (!this.prisma.enabled || !this.resilience)
      return { attention: [] as string[] };
    const hours = Math.max(1, Number(process.env.REFUND_ATTENTION_HOURS ?? 24));
    const staleBefore = new Date(Date.now() - hours * 60 * 60_000);
    const refunds = await this.prisma.manualRefund.findMany({
      where: {
        status: { in: ACTIVE },
        updatedAt: { lte: staleBefore },
      },
      include: { order: { select: { orderNumber: true } } },
      take: 100,
      orderBy: { updatedAt: "asc" },
    });
    for (const refund of refunds)
      await this.resilience.attention({
        dedupeKey: `manual-refund-stale:${refund.id}`,
        category: "REFUND_ACTION_REQUIRED",
        entityType: "ManualRefund",
        entityId: refund.id,
        orderId: refund.orderId,
        summary: `Refund for ${refund.order.orderNumber} needs action`,
        detail: `${refund.status} refund has not changed for ${hours} hour(s)`,
        localState: refund.status,
        lastSuccessfulStep:
          refund.status === ManualRefundStatus.APPROVED
            ? "REFUND_APPROVED"
            : "REFUND_REQUESTED",
        failureCategory: "REFUND_STALE",
        availableActions: ["REVIEW_MANUAL_REFUND"],
      });
    return { attention: refunds.map((refund) => refund.id) };
  }

  async request(
    orderId: string,
    actorId: string,
    input: { reason: ManualRefundReason; explanation: string },
  ) {
    if (!this.prisma.enabled)
      throw new BadRequestException(
        "Database persistence is required for manual refunds",
      );
    if (!Object.values(ManualRefundReason).includes(input.reason))
      throw new BadRequestException(
        "A valid company-fault category is required",
      );
    const explanation = input.explanation.trim();
    if (explanation.length < 10 || explanation.length > 1000)
      throw new BadRequestException(
        "Explanation must be between 10 and 1000 characters",
      );
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        payments: { orderBy: { createdAt: "desc" } },
        manualRefunds: { where: { status: { in: ACTIVE } } },
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (order.manualRefunds.length)
      throw new ConflictException(
        "A manual refund is already awaiting a decision",
      );
    const payment = order.payments.find(
      (item) => item.status === PaymentStatus.COMPLETED,
    );
    if (!payment)
      throw new BadRequestException(
        "Only a confirmed, not-yet-refunded payment can be refunded",
      );
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.manualRefund
        .create({
          data: {
            orderId,
            paymentId: payment.id,
            activeKey: orderId,
            reason: input.reason,
            explanation,
            amount: payment.amount,
            requestedById: actorId,
          },
        })
        .catch((error) => {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
          )
            throw new ConflictException(
              "A manual refund is already awaiting a decision",
            );
          throw error;
        });
      await tx.auditLog.create({
        data: {
          module: "PAYMENTS",
          entity: "ManualRefund",
          entityId: created.id,
          action: "MANUAL_REFUND_REQUESTED",
          performedById: actorId,
          newValue: {
            orderId,
            reason: input.reason,
            amount: payment.amount.toString(),
          } as Prisma.InputJsonValue,
        },
      });
      return created;
    });
  }

  async approve(id: string, actorId: string, note?: string) {
    return this.decide(id, actorId, ManualRefundStatus.APPROVED, note);
  }

  async reject(id: string, actorId: string, note?: string) {
    if (!note?.trim())
      throw new BadRequestException("A rejection note is required");
    return this.decide(id, actorId, ManualRefundStatus.REJECTED, note);
  }

  private async decide(
    id: string,
    actorId: string,
    status: "APPROVED" | "REJECTED",
    note?: string,
  ) {
    const current = await this.prisma.manualRefund.findUnique({
      where: { id },
    });
    if (!current)
      throw new NotFoundException("Manual refund request not found");
    if (current.status !== ManualRefundStatus.REQUESTED)
      throw new ConflictException(
        "This manual refund has already been reviewed",
      );
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.manualRefund.updateMany({
        where: { id, status: ManualRefundStatus.REQUESTED },
        data: {
          status,
          reviewedById: actorId,
          reviewNote: note?.trim() || null,
          ...(status === ManualRefundStatus.APPROVED
            ? { approvedAt: now }
            : { rejectedAt: now, activeKey: null }),
        },
      });
      if (changed.count !== 1)
        throw new ConflictException(
          "This manual refund was changed by another administrator",
        );
      await tx.auditLog.create({
        data: {
          module: "PAYMENTS",
          entity: "ManualRefund",
          entityId: id,
          action: `MANUAL_REFUND_${status}`,
          performedById: actorId,
          newValue: { note: note?.trim() || null } as Prisma.InputJsonValue,
        },
      });
      return tx.manualRefund.findUniqueOrThrow({ where: { id } });
    });
  }

  async complete(
    id: string,
    actorId: string,
    input: {
      providerReference: string;
      amount: number;
      completedAt: string;
      note?: string;
    },
  ) {
    const reference = input.providerReference.trim();
    if (reference.length < 3 || reference.length > 200)
      throw new BadRequestException(
        "A valid payment-provider refund reference is required",
      );
    const completedAt = new Date(input.completedAt);
    if (
      !Number.isFinite(completedAt.getTime()) ||
      completedAt.getTime() > Date.now() + 60_000
    )
      throw new BadRequestException("A valid completion date is required");
    const current = await this.prisma.manualRefund.findUnique({
      where: { id },
      include: { order: true, payment: true },
    });
    if (!current)
      throw new NotFoundException("Manual refund request not found");
    if (current.status !== ManualRefundStatus.APPROVED)
      throw new ConflictException(
        "The manual refund must be approved before completion",
      );
    if (
      Number(current.amount) !== Number(input.amount) ||
      Number(current.payment.amount) !== Number(input.amount)
    )
      throw new BadRequestException(
        "Partial refunds are not supported; the amount must equal the confirmed payment",
      );
    try {
      await withPostgresTransactionRetry(() =>
        this.prisma.$transaction(
          async (tx) => {
            const claimed = await tx.manualRefund.updateMany({
              where: { id, status: ManualRefundStatus.APPROVED },
              data: {
                status: ManualRefundStatus.COMPLETED,
                activeKey: null,
                reviewedById: actorId,
                providerReference: reference,
                completionNote: input.note?.trim() || null,
                completedAt,
              },
            });
            if (claimed.count !== 1)
              throw new ConflictException(
                "This manual refund was changed by another administrator",
              );
            await tx.payment.update({
              where: { id: current.paymentId },
              data: { status: PaymentStatus.REFUNDED },
            });
            await tx.order.update({
              where: { id: current.orderId },
              data: { status: OrderStatus.REFUNDED, version: { increment: 1 } },
            });
            await tx.orderEvent.create({
              data: {
                orderId: current.orderId,
                fromStatus: current.order.status,
                toStatus: OrderStatus.REFUNDED,
                actorId,
                reason: `Manual refund completed (${reference})`,
                metadata: { manualRefundId: id, reason: current.reason },
              },
            });
            await tx.auditLog.create({
              data: {
                module: "PAYMENTS",
                entity: "ManualRefund",
                entityId: id,
                action: "MANUAL_REFUND_COMPLETED",
                performedById: actorId,
                previousValue: {
                  orderStatus: current.order.status,
                  paymentStatus: current.payment.status,
                } as Prisma.InputJsonValue,
                newValue: {
                  orderStatus: OrderStatus.REFUNDED,
                  paymentStatus: PaymentStatus.REFUNDED,
                  providerReference: reference,
                  amount: input.amount,
                } as Prisma.InputJsonValue,
              },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new ConflictException(
          "This payment-provider refund reference has already been recorded",
        );
      throw error;
    }
    await this.orders.refreshOne(current.orderId, true);
    return this.prisma.manualRefund.findUniqueOrThrow({ where: { id } });
  }
}
