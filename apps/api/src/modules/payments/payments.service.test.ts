import { describe, expect, it, vi } from "vitest";
import {
  ApiErrorCode,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
} from "@visa-compass/shared";
import { ApiException } from "../../common/api-error.js";
import { PaymentsService } from "./payments.service.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

function orderFor(overrides: AnyRecord = {}) {
  return {
    id: "order-1",
    ownerId: "user-1",
    orderNumber: "VC-100",
    status: OrderStatus.PAYMENT_PENDING,
    version: 1,
    plan: {
      id: "p1",
      countryCode: "NP",
      dataAllowance: "5GB",
      validityDays: 7,
    },
    totalAmountNpr: 2499,
    pricingSnapshot: {},
    compatibilityAcceptedAt: new Date().toISOString(),
    documents: [],
    timeline: [],
    createdAt: new Date().toISOString(),
    payment: {
      provider: PaymentProvider.KHALTI,
      reference: "pidx-1",
      status: PaymentStatus.PENDING,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      redirectUrl: "https://khalti.example/pay",
    },
    ...overrides,
  };
}

function makeService(opts: {
  status?: PaymentStatus;
  amountNpr?: number;
  orderId?: string;
  transactionId?: string;
  gatewayError?: unknown;
  currency?: string;
  order?: AnyRecord;
}) {
  const order = (opts.order ?? orderFor()) as AnyRecord;
  const confirmedCalls: { id: string; reference: string; txId?: string }[] = [];
  const failedCalls: {
    id: string;
    reason: string;
    paymentStatus?: PaymentStatus;
  }[] = [];

  const confirmed = vi.fn(
    async (id: string, reference?: string, txId?: string) => {
      confirmedCalls.push({
        id,
        reference: reference ?? "",
        ...(txId ? { txId } : {}),
      });
      order.status = OrderStatus.PAYMENT_CONFIRMED;
      order.payment.status = PaymentStatus.COMPLETED;
      return order;
    },
  );
  const failed = vi.fn(
    async (
      id: string,
      _ownerId: string | null,
      reason: string,
      paymentStatus?: PaymentStatus,
    ) => {
      failedCalls.push({
        id,
        reason,
        ...(paymentStatus ? { paymentStatus } : {}),
      });
      order.status = OrderStatus.PAYMENT_FAILED;
      if (paymentStatus) order.payment.status = paymentStatus;
      return order;
    },
  );

  const orders = {
    get: () => order,
    view: () => order,
    list: () => [order],
    confirmPayment: confirmed,
    resolvePaymentFailure: failed,
  };

  const svc = new PaymentsService(orders as never, {} as never, {} as never);
  const gateway = {
    provider: "KHALTI",
    async verify() {
      if (opts.gatewayError !== undefined) throw opts.gatewayError;
      return {
        reference: order.payment.reference,
        orderId: opts.orderId ?? order.id,
        amountNpr: opts.amountNpr ?? order.totalAmountNpr,
        ...(opts.currency ? { currency: opts.currency } : {}),
        status: opts.status ?? PaymentStatus.COMPLETED,
        ...(opts.transactionId
          ? { providerTransactionId: opts.transactionId }
          : {}),
      };
    },
  };
  (svc as unknown as { gateway: () => typeof gateway }).gateway = () => gateway;
  return { svc, order, confirmed, confirmedCalls, failedCalls };
}

describe("PaymentsService inventory admission", () => {
  it("does not open a payment session when a new purchase has no inventory", async () => {
    const order = orderFor({
      status: OrderStatus.DRAFT,
      purchaseType: "INITIAL_PURCHASE",
      payment: undefined,
    });
    const assertInventory = vi
      .fn()
      .mockRejectedValue(new Error("No eSIM inventory is currently available"));
    const initiate = vi.fn();
    const service = new PaymentsService(
      {
        get: vi.fn().mockReturnValue(order),
        assertInventoryAvailableForNewOrder: assertInventory,
      } as never,
      { initiate } as never,
      { initiate } as never,
    );

    await expect(
      service.initiate(order.id, order.ownerId, PaymentProvider.KHALTI),
    ).rejects.toThrow("No eSIM inventory is currently available");
    expect(assertInventory).toHaveBeenCalledOnce();
    expect(initiate).not.toHaveBeenCalled();
  });

  it("allows an existing-eSIM top-up to reach payment without new stock", async () => {
    const order = orderFor({
      status: OrderStatus.DRAFT,
      purchaseType: "TOPUP",
      payment: undefined,
    });
    const assertInventory = vi.fn();
    const initiate = vi.fn().mockResolvedValue({
      reference: "topup-payment",
      redirectUrl: "https://khalti.example/topup",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const beginPayment = vi.fn().mockResolvedValue(undefined);
    const service = new PaymentsService(
      {
        get: vi.fn().mockReturnValue(order),
        beginPayment,
        assertInventoryAvailableForNewOrder: assertInventory,
      } as never,
      { initiate } as never,
      { initiate } as never,
    );

    await expect(
      service.initiate(order.id, order.ownerId, PaymentProvider.KHALTI),
    ).resolves.toMatchObject({ reference: "topup-payment" });
    expect(assertInventory).not.toHaveBeenCalled();
    expect(initiate).toHaveBeenCalledOnce();
    expect(beginPayment).toHaveBeenCalledOnce();
  });

  it("allows only one provider initiation across concurrent API requests", async () => {
    const order = orderFor({
      status: OrderStatus.DRAFT,
      purchaseType: "TOPUP",
      payment: undefined,
    });
    let record: AnyRecord | null = null;
    const initiate = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        reference: "shared-pidx",
        redirectUrl: "https://khalti.example/shared",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    });
    const prisma = {
      enabled: true,
      paymentInitiation: {
        create: vi.fn(async ({ data }: AnyRecord) => {
          if (record) throw { code: "P2002" };
          record = { id: "init-1", status: "PROCESSING", result: null, ...data };
          return record;
        }),
        findUnique: vi.fn(async () => record),
        updateMany: vi.fn(async ({ where, data }: AnyRecord) => {
          if (!record || (where.claimToken && where.claimToken !== record.claimToken))
            return { count: 0 };
          record = { ...record, ...data };
          return { count: 1 };
        }),
      },
    };
    const beginPayment = vi.fn().mockResolvedValue(undefined);
    const orders = {
      refreshOne: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockReturnValue(order),
      beginPayment,
      assertInventoryAvailableForNewOrder: vi.fn(),
    };
    const service = new PaymentsService(
      orders as never,
      { initiate } as never,
      { initiate } as never,
      undefined,
      undefined,
      prisma as never,
    );

    const [first, second] = await Promise.all([
      service.initiate(order.id, order.ownerId, PaymentProvider.KHALTI),
      service.initiate(order.id, order.ownerId, PaymentProvider.KHALTI),
    ]);
    expect(first.reference).toBe("shared-pidx");
    expect(second.reference).toBe("shared-pidx");
    expect(initiate).toHaveBeenCalledOnce();
    expect(beginPayment).toHaveBeenCalledTimes(2);
  });
});

describe("PaymentsService payment verification mapping", () => {
  it("returns the pending order (200) while the gateway reports pending", async () => {
    const { svc, order, confirmedCalls } = makeService({
      status: PaymentStatus.PENDING,
    });
    const result = await svc.verify("order-1", "user-1", "pidx-1");
    expect(result.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(confirmedCalls).toHaveLength(0);
    expect(order.status).toBe(OrderStatus.PAYMENT_PENDING);
  });

  it("confirms a completed lookup with matching order and amount", async () => {
    const { svc, confirmedCalls, order } = makeService({
      status: PaymentStatus.COMPLETED,
      transactionId: "tx-9",
    });
    const result = await svc.verify("order-1", "user-1", "pidx-1");
    expect(confirmedCalls).toEqual([
      { id: "order-1", reference: "pidx-1", txId: "tx-9" },
    ]);
    expect(result.status).toBe(OrderStatus.PAYMENT_CONFIRMED);
    expect(order.payment.status).toBe(PaymentStatus.COMPLETED);
  });

  it("rejects an amount mismatch as a security error and leaves the order pending", async () => {
    const { svc, confirmedCalls, failedCalls } = makeService({
      status: PaymentStatus.COMPLETED,
      amountNpr: 2500,
    });
    await expect(
      svc.verify("order-1", "user-1", "pidx-1"),
    ).rejects.toMatchObject({ code: ApiErrorCode.PAYMENT_REFERENCE_MISMATCH });
    expect(confirmedCalls).toHaveLength(0);
    expect(failedCalls).toHaveLength(0);
  });

  it("rejects a currency mismatch and leaves the order unresolved", async () => {
    const { svc, confirmedCalls, failedCalls } = makeService({
      status: PaymentStatus.COMPLETED,
      currency: "USD",
    });
    await expect(
      svc.verify("order-1", "user-1", "pidx-1"),
    ).rejects.toMatchObject({ code: ApiErrorCode.PAYMENT_REFERENCE_MISMATCH });
    expect(confirmedCalls).toHaveLength(0);
    expect(failedCalls).toHaveLength(0);
  });

  it("maps user canceled to PAYMENT_FAILED (retryable) with payment status CANCELLED", async () => {
    const { svc, failedCalls, order } = makeService({
      status: PaymentStatus.CANCELLED,
    });
    await expect(
      svc.verify("order-1", "user-1", "pidx-1"),
    ).rejects.toMatchObject({ code: ApiErrorCode.PAYMENT_NOT_CONFIRMED });
    expect(failedCalls).toEqual([
      {
        id: "order-1",
        reason: expect.any(String),
        paymentStatus: PaymentStatus.CANCELLED,
      },
    ]);
    expect(order.status).toBe(OrderStatus.PAYMENT_FAILED);
    expect(order.payment.status).toBe(PaymentStatus.CANCELLED);
  });

  it("maps expired to PAYMENT_FAILED (retryable) and surfaces PAYMENT_EXPIRED", async () => {
    const { svc, failedCalls, order } = makeService({
      status: PaymentStatus.FAILED,
    });
    await expect(
      svc.verify("order-1", "user-1", "pidx-1"),
    ).rejects.toMatchObject({ code: ApiErrorCode.PAYMENT_EXPIRED });
    expect(failedCalls).toEqual([
      {
        id: "order-1",
        reason: expect.any(String),
        paymentStatus: PaymentStatus.FAILED,
      },
    ]);
    expect(order.status).toBe(OrderStatus.PAYMENT_FAILED);
  });

  it("propagates provider errors without touching the order", async () => {
    const providerError = new ApiException({
      code: ApiErrorCode.PAYMENT_PROVIDER_ERROR,
      message: "unavailable",
      status: 502,
    });
    const { svc, confirmedCalls, failedCalls, order } = makeService({
      gatewayError: providerError,
    });
    await expect(
      svc.verify("order-1", "user-1", "pidx-1"),
    ).rejects.toMatchObject({ code: ApiErrorCode.PAYMENT_PROVIDER_ERROR });
    expect(confirmedCalls).toHaveLength(0);
    expect(failedCalls).toHaveLength(0);
    expect(order.status).toBe(OrderStatus.PAYMENT_PENDING);
  });

  it("rejects a reference that does not match the stored payment", async () => {
    const { svc, confirmedCalls } = makeService({
      status: PaymentStatus.COMPLETED,
    });
    await expect(svc.verify("order-1", "user-1", "pidx-OTHER")).rejects.toThrow(
      "Payment reference mismatch",
    );
    expect(confirmedCalls).toHaveLength(0);
  });
});

describe("PaymentsService.verifyCallback", () => {
  it("confirms a completed callback lookup", async () => {
    const { svc, confirmedCalls } = makeService({
      status: PaymentStatus.COMPLETED,
    });
    const result = await svc.verifyCallback("order-1", "pidx-1");
    expect(confirmedCalls).toEqual([
      { id: "order-1", reference: "pidx-1", txId: undefined },
    ]);
    expect(result.status).toBe(OrderStatus.PAYMENT_CONFIRMED);
  });

  it("refreshes an already-confirmed order without re-looking-up", async () => {
    const { svc, order, confirmedCalls } = makeService({
      status: PaymentStatus.COMPLETED,
    });
    order.status = OrderStatus.PAYMENT_CONFIRMED;
    order.payment.status = PaymentStatus.COMPLETED;
    const result = await svc.verifyCallback("order-1", "pidx-1");
    expect(result.status).toBe(OrderStatus.PAYMENT_CONFIRMED);
    expect(confirmedCalls).toHaveLength(0);
  });

  it("returns the pending order without throwing while still pending", async () => {
    const { svc } = makeService({ status: PaymentStatus.PENDING });
    const result = await svc.verifyCallback("order-1", "pidx-1");
    expect(result.status).toBe(OrderStatus.PAYMENT_PENDING);
  });
});

describe("PaymentsService.reconcileRecentPendingPayments", () => {
  it("confirms only a completed lookup and defers pending ones", async () => {
    const order = orderFor();
    const pendingOrder = orderFor({
      id: "order-2",
      payment: { ...orderFor().payment, reference: "pidx-2" },
    });

    const list = [order, pendingOrder];
    const confirmed = vi.fn(async (id: string) => {
      order.status = OrderStatus.PAYMENT_CONFIRMED;
      return order;
    });
    const svc = new PaymentsService(
      {
        get: () => order,
        view: () => order,
        list: () => list,
        confirmPayment: confirmed,
        resolvePaymentFailure: vi.fn(async () => order),
      } as never,
      {} as never,
      {} as never,
    );
    const gateway = {
      provider: "KHALTI",
      async verify(reference: string) {
        if (reference === "pidx-2")
          return {
            reference,
            orderId: pendingOrder.id,
            amountNpr: pendingOrder.totalAmountNpr,
            status: PaymentStatus.PENDING,
          };
        return {
          reference,
          orderId: order.id,
          amountNpr: order.totalAmountNpr,
          status: PaymentStatus.COMPLETED,
        };
      },
    };
    (svc as unknown as { gateway: () => typeof gateway }).gateway = () =>
      gateway;

    const result = await svc.reconcileRecentPendingPayments();
    expect(result.confirmed).toEqual(["order-1"]);
    expect(result.stillPending).toEqual(["order-2"]);
    expect(result.errored).toHaveLength(0);
  });

  it("skips orders outside their payment window (hand-off to expiry reconcile)", async () => {
    const order = orderFor({
      payment: {
        ...orderFor().payment,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    });
    const { svc, confirmedCalls } = makeService({ order });
    const result = await svc.reconcileRecentPendingPayments();
    expect(result.confirmed).toHaveLength(0);
    expect(result.stillPending).toHaveLength(0);
    expect(confirmedCalls).toHaveLength(0);
  });

  it("defers provider errors without failing the order", async () => {
    const providerError = new ApiException({
      code: ApiErrorCode.PAYMENT_PROVIDER_ERROR,
      message: "unavailable",
      status: 502,
    });
    const { svc, confirmedCalls, failedCalls } = makeService({
      gatewayError: providerError,
    });
    const result = await svc.reconcileRecentPendingPayments();
    expect(result.errored).toEqual(["order-1"]);
    expect(result.confirmed).toHaveLength(0);
    expect(result.stillPending).toHaveLength(0);
    expect(confirmedCalls).toHaveLength(0);
    expect(failedCalls).toHaveLength(0);
  });
});

describe("PaymentsService durable verification attempts", () => {
  it("uses the persisted attempt count after a process restart and requires review", async () => {
    const order = orderFor({
      payment: {
        ...orderFor().payment,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    const requirePaymentReview = vi.fn(async () => undefined);
    const attention = vi.fn(async () => undefined);
    const resetAttempts = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      enabled: true,
      payment: {
        update: vi.fn(async () => ({ verificationAttempts: 3 })),
        updateMany: resetAttempts,
      },
    };
    const service = new PaymentsService(
      {
        get: () => order,
        view: () => order,
        list: () => [order],
        requirePaymentReview,
      } as never,
      {} as never,
      {} as never,
      undefined,
      { attention } as never,
      prisma as never,
    );
    const gateway = {
      provider: "KHALTI",
      verify: vi.fn(async () => {
        throw new Error("gateway unavailable");
      }),
    };
    (service as unknown as { gateway: () => typeof gateway }).gateway = () =>
      gateway;

    const result = await service.reconcilePendingPayments();

    expect(result.reviewRequired).toEqual(["order-1"]);
    expect(result.failed).toHaveLength(0);
    expect(requirePaymentReview).toHaveBeenCalledWith(
      "order-1",
      expect.stringContaining("3 verification attempts"),
    );
    expect(attention).toHaveBeenCalledWith(
      expect.objectContaining({ category: "PAYMENT_UNCERTAIN" }),
    );
    expect(resetAttempts).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ verificationAttempts: 0 }),
      }),
    );
  });
});
