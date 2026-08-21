import { describe, expect, it, vi } from "vitest";
import { ConflictException } from "@nestjs/common";
import { OrdersPersistenceService } from "./orders-persistence.service.js";

function serviceFor(payment: {
  orderId: string;
  status: string;
  order: { status: string };
}) {
  const paymentUpdateMany = vi.fn(async () => ({ count: 1 }));
  const orderUpdateMany = vi.fn(async () => ({ count: 1 }));
  const eventCreate = vi.fn(async () => ({}));
  const tx = {
    payment: {
      findUnique: vi.fn(async () => payment),
      updateMany: paymentUpdateMany,
    },
    order: { updateMany: orderUpdateMany },
    orderEvent: { create: eventCreate },
  };
  const prisma = {
    enabled: true,
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) =>
      work(tx),
    ),
  };
  return {
    service: new OrdersPersistenceService(prisma as never, {} as never),
    tx,
    paymentUpdateMany,
    orderUpdateMany,
    eventCreate,
  };
}

describe("OrdersPersistenceService.confirmPaymentAtomically", () => {
  it("claims pending payment and order state in one serializable command", async () => {
    const { service, paymentUpdateMany, orderUpdateMany, eventCreate } =
      serviceFor({
        orderId: "order-1",
        status: "PENDING",
        order: { status: "PAYMENT_PENDING" },
      });

    await expect(
      service.confirmPaymentAtomically("order-1", "pidx-1", "tx-1"),
    ).resolves.toEqual({
      claimed: true,
      alreadyCompleted: false,
      requiresReview: false,
    });
    expect(paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orderId: "order-1",
          status: { in: ["PENDING", "REVIEW_REQUIRED"] },
        }),
        data: expect.objectContaining({
          status: "COMPLETED",
          providerTransactionId: "tx-1",
        }),
      }),
    );
    expect(orderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "order-1" }),
        data: expect.objectContaining({ status: "PAYMENT_CONFIRMED" }),
      }),
    );
    expect(eventCreate).toHaveBeenCalledOnce();
  });

  it("returns the existing result when another replica already confirmed it", async () => {
    const { service, paymentUpdateMany, orderUpdateMany } = serviceFor({
      orderId: "order-1",
      status: "COMPLETED",
      order: { status: "PROVISIONING" },
    });

    await expect(
      service.confirmPaymentAtomically("order-1", "pidx-1"),
    ).resolves.toEqual({
      claimed: false,
      alreadyCompleted: true,
      requiresReview: false,
    });
    expect(paymentUpdateMany).not.toHaveBeenCalled();
    expect(orderUpdateMany).not.toHaveBeenCalled();
  });

  it("fails closed when a payment reference belongs to another order", async () => {
    const { service, paymentUpdateMany } = serviceFor({
      orderId: "order-other",
      status: "PENDING",
      order: { status: "PAYMENT_PENDING" },
    });

    await expect(
      service.confirmPaymentAtomically("order-1", "pidx-reused"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(paymentUpdateMany).not.toHaveBeenCalled();
  });

  it("records late paid evidence but does not advance a cancelled order", async () => {
    const { service, paymentUpdateMany, orderUpdateMany } = serviceFor({
      orderId: "order-1",
      status: "PENDING",
      order: { status: "CANCELLED" },
    });

    await expect(
      service.confirmPaymentAtomically("order-1", "pidx-late", "tx-late"),
    ).resolves.toEqual({
      claimed: true,
      alreadyCompleted: false,
      requiresReview: true,
    });
    expect(paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "COMPLETED" }),
      }),
    );
    expect(orderUpdateMany).not.toHaveBeenCalled();
  });
});
