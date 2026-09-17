import { describe, expect, it, vi } from "vitest";
import {
  ManualRefundReason,
  ManualRefundStatus,
  PaymentStatus,
} from "@prisma/client";
import { ManualRefundsService } from "./manual-refunds.service.js";

function setup() {
  const created = {
    id: "refund-1",
    orderId: "order-1",
    paymentId: "payment-1",
    status: ManualRefundStatus.REQUESTED,
    amount: 2499,
  };
  const tx = {
    manualRefund: {
      create: vi.fn().mockResolvedValue(created),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue(created),
    },
    payment: { update: vi.fn().mockResolvedValue({}) },
    order: { update: vi.fn().mockResolvedValue({}) },
    orderEvent: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    enabled: true,
    order: {
      findUnique: vi.fn().mockResolvedValue({
        id: "order-1",
        status: "PROVISIONING_FAILED",
        payments: [
          { id: "payment-1", status: PaymentStatus.COMPLETED, amount: 2499 },
        ],
        manualRefunds: [],
      }),
    },
    manualRefund: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn().mockResolvedValue(created),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    $transaction: vi.fn(async (work: (client: typeof tx) => unknown) =>
      work(tx),
    ),
  };
  const orders = { refreshOne: vi.fn() };
  return {
    service: new ManualRefundsService(prisma as never, orders as never),
    prisma,
    orders,
    tx,
  };
}

describe("ManualRefundsService", () => {
  it("loads the original provider for gateway-neutral Ops instructions", async () => {
    const context = setup();
    await context.service.list({});
    expect(context.prisma.manualRefund.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          payment: { select: { provider: true } },
        }),
      }),
    );
  });

  it("records a company-fault request without changing payment or order state", async () => {
    const context = setup();
    await context.service.request("order-1", "actor-1", {
      reason: ManualRefundReason.PROVISIONING_FAILURE,
      explanation: "Provider activation failed after payment",
    });
    expect(context.tx.manualRefund.create).toHaveBeenCalled();
    expect(context.tx.payment.update).not.toHaveBeenCalled();
    expect(context.tx.order.update).not.toHaveBeenCalled();
  });

  it("accepts a request when the payment attempt was never confirmed locally", async () => {
    const context = setup();
    context.prisma.order.findUnique.mockResolvedValue({
      id: "order-1",
      status: "PAYMENT_PENDING",
      payments: [
        { id: "payment-1", status: PaymentStatus.PENDING, amount: 2499 },
      ],
      manualRefunds: [],
    });

    await context.service.request("order-1", "actor-1", {
      reason: ManualRefundReason.PROVIDER_SERVICE_FAILURE,
      explanation: "Customer supplied evidence of the completed bank debit",
    });

    expect(context.tx.manualRefund.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ paymentId: "payment-1", amount: 2499 }),
    });
    expect(context.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        newValue: expect.objectContaining({
          paymentStatus: PaymentStatus.PENDING,
          paymentConfirmationMissing: true,
        }),
      }),
    });
  });

  it("rejects duplicate active requests", async () => {
    const context = setup();
    context.prisma.order.findUnique.mockResolvedValue({
      id: "order-1",
      payments: [{ id: "payment-1", status: PaymentStatus.COMPLETED }],
      manualRefunds: [{ id: "existing" }],
    });
    await expect(
      context.service.request("order-1", "actor-1", {
        reason: ManualRefundReason.INTERNAL_OPERATIONAL_ERROR,
        explanation: "Internal fulfillment error occurred",
      }),
    ).rejects.toThrow("already awaiting");
  });

  it("completes only an approved full refund and atomically updates payment and order", async () => {
    const context = setup();
    context.prisma.manualRefund.findUnique.mockResolvedValue({
      id: "refund-1",
      orderId: "order-1",
      paymentId: "payment-1",
      status: ManualRefundStatus.APPROVED,
      reason: ManualRefundReason.PROVIDER_SERVICE_FAILURE,
      amount: 2499,
      order: { status: "PROVISIONING_FAILED" },
      payment: { status: PaymentStatus.COMPLETED, amount: 2499 },
    });
    context.prisma.manualRefund.findUniqueOrThrow = vi.fn().mockResolvedValue({
      id: "refund-1",
      status: ManualRefundStatus.COMPLETED,
    });
    await context.service.complete("refund-1", "admin-1", {
      providerReference: "khalti-ref-123",
      amount: 2499,
      completedAt: new Date().toISOString(),
    });
    expect(context.tx.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: PaymentStatus.REFUNDED } }),
    );
    expect(context.tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "REFUNDED" }),
      }),
    );
    expect(context.orders.refreshOne).toHaveBeenCalledWith("order-1", true);
  });

  it("rejects partial completion amounts", async () => {
    const context = setup();
    context.prisma.manualRefund.findUnique.mockResolvedValue({
      id: "refund-1",
      status: ManualRefundStatus.APPROVED,
      amount: 2499,
      payment: { amount: 2499 },
      order: {},
    });
    await expect(
      context.service.complete("refund-1", "admin-1", {
        providerReference: "khalti-ref-123",
        amount: 1000,
        completedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow("Partial refunds are not supported");
  });

  it("walks a non-pending order through REFUND_PENDING before marking it refunded", async () => {
    const context = setup();
    const orderUpdates = context.tx.order.update;
    const events = context.tx.orderEvent.create;
    context.prisma.manualRefund.findUnique.mockResolvedValue({
      id: "refund-1",
      orderId: "order-1",
      paymentId: "payment-1",
      status: ManualRefundStatus.APPROVED,
      reason: ManualRefundReason.PROVISIONING_FAILURE,
      amount: 2499,
      order: { status: "QR_READY" },
      payment: { status: PaymentStatus.COMPLETED, amount: 2499 },
    });
    await context.service.complete("refund-1", "admin-1", {
      providerReference: "khalti-ref-456",
      amount: 2499,
      completedAt: new Date().toISOString(),
    });
    expect(orderUpdates).toHaveBeenNthCalledWith(1, {
      where: { id: "order-1" },
      data: { status: "REFUND_PENDING", version: { increment: 1 } },
    });
    expect(events).toHaveBeenNthCalledWith(1, {
      data: {
        orderId: "order-1",
        fromStatus: "QR_READY",
        toStatus: "REFUND_PENDING",
        actorId: "admin-1",
        reason: "Manual refund entered pending refund state",
        metadata: {
          manualRefundId: "refund-1",
          reason: "PROVISIONING_FAILURE",
        },
      },
    });
    expect(orderUpdates).toHaveBeenNthCalledWith(2, {
      where: { id: "order-1" },
      data: { status: "REFUNDED", version: { increment: 1 } },
    });
  });

  it("keeps an order already in REFUND_PENDING on the single refunded leg", async () => {
    const context = setup();
    context.prisma.manualRefund.findUnique.mockResolvedValue({
      id: "refund-1",
      orderId: "order-1",
      paymentId: "payment-1",
      status: ManualRefundStatus.APPROVED,
      reason: ManualRefundReason.PROVIDER_SERVICE_FAILURE,
      amount: 2499,
      order: { status: "REFUND_PENDING" },
      payment: { status: PaymentStatus.COMPLETED, amount: 2499 },
    });
    await context.service.complete("refund-1", "admin-1", {
      providerReference: "khalti-ref-789",
      amount: 2499,
      completedAt: new Date().toISOString(),
    });
    expect(context.tx.order.update).toHaveBeenCalledTimes(1);
    expect(context.tx.order.update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { status: "REFUNDED", version: { increment: 1 } },
    });
  });

  it("completes an approved evidence-based refund from payment pending", async () => {
    const context = setup();
    context.prisma.manualRefund.findUnique.mockResolvedValue({
      id: "refund-1",
      orderId: "order-1",
      paymentId: "payment-1",
      status: ManualRefundStatus.APPROVED,
      reason: ManualRefundReason.PROVIDER_SERVICE_FAILURE,
      amount: 2499,
      payment: { status: PaymentStatus.PENDING, amount: 2499 },
      order: { status: "PAYMENT_PENDING" },
    });
    await context.service.complete("refund-1", "admin-1", {
      providerReference: "khalti-ref-321",
      amount: 2499,
      completedAt: new Date().toISOString(),
    });
    expect(context.tx.order.update).toHaveBeenNthCalledWith(1, {
      where: { id: "order-1" },
      data: { status: "REFUND_PENDING", version: { increment: 1 } },
    });
    expect(context.tx.order.update).toHaveBeenNthCalledWith(2, {
      where: { id: "order-1" },
      data: { status: "REFUNDED", version: { increment: 1 } },
    });
  });
});
