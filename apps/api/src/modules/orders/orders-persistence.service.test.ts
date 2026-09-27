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
    paymentEvent: {
      createMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async () => ({})),
    },
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

describe("recharge creation transaction", () => {
  it("stores beneficiary, recovery credential and notification together without creating a guest identity", async () => {
    const tx = {
      customer: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: "beneficiary",
          userId: null,
        })),
      },
      user: { upsert: vi.fn() },
      country: { upsert: vi.fn(async () => ({ id: "country" })) },
      plan: { upsert: vi.fn() },
      order: {
        findMany: vi.fn(async () => [{ customerId: "beneficiary" }]),
        findUnique: vi.fn(async () => null),
        create: vi.fn(),
      },
      guestOrderAccessToken: { create: vi.fn() },
      notification: { create: vi.fn() },
      travelerDocument: { deleteMany: vi.fn() },
      passportExtraction: { deleteMany: vi.fn(), upsert: vi.fn() },
      orderEvent: { createMany: vi.fn(), findMany: vi.fn(async () => []) },
    };
    const prisma = {
      enabled: true,
      $transaction: vi.fn(async (fn: any) => fn(tx)),
    };
    const service = new OrdersPersistenceService(prisma as never, {} as never);
    const order: any = {
      id: "recharge",
      ownerId: null,
      beneficiaryCustomerId: "beneficiary",
      targetInventoryId: "inventory",
      purchasedByUserId: "payer",
      checkoutAttemptKey: "attempt",
      checkoutRequestHash: "hash",
      purchaseType: "TOPUP",
      orderNumber: "VC-TEST",
      status: "DRAFT",
      version: 0,
      plan: {
        id: "plan",
        countryCode: "IN",
        countryName: "India",
        name: "Package",
        dataAllowance: "1GB",
        validityDays: 1,
        sellingPriceNpr: 100,
      },
      totalAmountNpr: 100,
      pricingSnapshot: {},
      documents: [],
      timeline: [],
      compatibilityAcceptedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    await service.save(order, {
      recipient: "owner@example.com",
      recipientHash: "recipient-hash",
      tokenHash: "token-hash",
      expiresAt: "2027-01-01",
      recoveryUrlEncrypted: "encrypted-link",
    });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.user.upsert).not.toHaveBeenCalled();
    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customerId: "beneficiary",
          purchasedByUserId: "payer",
          targetInventoryId: "inventory",
        }),
      }),
    );
    expect(tx.guestOrderAccessToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: "recharge",
        tokenHash: "token-hash",
      }),
    });
    expect(tx.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: "recharge",
        status: "QUEUED",
        recoveryUrlEncrypted: "encrypted-link",
      }),
    });
    expect(tx.passportExtraction.deleteMany).toHaveBeenCalledWith({
      where: { orderId: "recharge" },
    });
  });
});
