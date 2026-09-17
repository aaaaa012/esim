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

  const reviewRequired = vi.fn(
    async (id: string, _reason: string) => {
      order.status = OrderStatus.PAYMENT_REVIEW_REQUIRED;
      order.payment.status = PaymentStatus.REVIEW_REQUIRED;
      return order;
    },
  );

  const orders = {
    get: () => order,
    view: () => order,
    list: () => [order],
    confirmPayment: confirmed,
    resolvePaymentFailure: failed,
    requirePaymentReview: reviewRequired,
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
  return {
    svc,
    order,
    confirmed,
    confirmedCalls,
    failedCalls,
    reviewRequired,
  };
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

  it("blocks provider switching while a persisted session is active", async () => {
    const order = orderFor({ purchaseType: "TOPUP", payment: undefined });
    const record = {
      id: "init-1",
      orderId: order.id,
      provider: PaymentProvider.FONEPAY,
      amountNpr: order.totalAmountNpr,
      claimToken: "claim-1",
      leaseExpiresAt: new Date(),
      status: "COMPLETED",
      result: {
        reference: "VCREF",
        redirectUrl: "",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        qrPayload: "payload",
      },
    };
    const service = new PaymentsService(
      {
        refreshOne: vi.fn(),
        get: vi.fn().mockReturnValue(order),
        assertInventoryAvailableForNewOrder: vi.fn(),
      } as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      {
        enabled: true,
        paymentInitiation: {
          create: vi.fn().mockRejectedValue({ code: "P2002" }),
          findUnique: vi.fn().mockResolvedValue(record),
        },
      } as never,
    );

    await expect(
      service.initiate(order.id, order.ownerId, PaymentProvider.KHALTI),
    ).rejects.toMatchObject({ code: "PAYMENT_SESSION_ACTIVE" });
  });

  it("does not open a payment session when the order is already paid", async () => {
    const order = orderFor({
      status: OrderStatus.PAYMENT_CONFIRMED,
      payment: {
        ...orderFor().payment,
        status: PaymentStatus.COMPLETED,
      },
    });
    const initiate = vi.fn();
    const beginPayment = vi.fn().mockResolvedValue(undefined);
    const service = new PaymentsService(
      {
        refreshOne: vi.fn(),
        get: vi.fn().mockReturnValue(order),
        beginPayment,
        assertInventoryAvailableForNewOrder: vi.fn(),
      } as never,
      { initiate } as never,
      { initiate } as never,
    );

    await expect(
      service.initiate(order.id, order.ownerId, PaymentProvider.KHALTI),
    ).rejects.toThrow("already been paid");
    expect(initiate).not.toHaveBeenCalled();
    expect(beginPayment).not.toHaveBeenCalled();
  });

  it("blocks a new payment session while the previous one is under review", async () => {
    const order = orderFor({
      status: OrderStatus.PAYMENT_REVIEW_REQUIRED,
      payment: {
        ...orderFor().payment,
        status: PaymentStatus.REVIEW_REQUIRED,
      },
    });
    const initiate = vi.fn();
    const service = new PaymentsService(
      {
        refreshOne: vi.fn(),
        get: vi.fn().mockReturnValue(order),
        assertInventoryAvailableForNewOrder: vi.fn(),
      } as never,
      { initiate } as never,
      { initiate } as never,
    );

    await expect(
      service.initiate(order.id, order.ownerId, PaymentProvider.KHALTI),
    ).rejects.toMatchObject({ code: ApiErrorCode.PAYMENT_RETRY_NOT_SAFE });
    expect(initiate).not.toHaveBeenCalled();
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

  it("escalates a cancelled wallet session with a provider transaction to review, never retry", async () => {
    // A provider transaction id means a record was created at the wallet even
    // though the status is cancelled — automatically closing it as retryable
    // could double charge the customer.
    const { svc, order, failedCalls, reviewRequired } = makeService({
      status: PaymentStatus.CANCELLED,
      transactionId: "tx-ambiguous",
    });
    await expect(
      svc.verify("order-1", "user-1", "pidx-1"),
    ).rejects.toMatchObject({ code: ApiErrorCode.PAYMENT_RETRY_NOT_SAFE });
    expect(failedCalls).toHaveLength(0);
    expect(reviewRequired).toHaveBeenCalledWith("order-1", expect.any(String));
    expect(order.status).toBe(OrderStatus.PAYMENT_REVIEW_REQUIRED);
    expect(order.payment.status).toBe(PaymentStatus.REVIEW_REQUIRED);
  });

  it("escalates a refunded session to review instead of retrying", async () => {
    // Money moved for this session and was returned; a retry is never a replay
    // of a refunded charge.
    const { svc, order, failedCalls, reviewRequired } = makeService({
      status: PaymentStatus.REFUNDED,
      transactionId: "tx-refunded",
    });
    await expect(
      svc.verify("order-1", "user-1", "pidx-1"),
    ).rejects.toMatchObject({ code: ApiErrorCode.PAYMENT_RETRY_NOT_SAFE });
    expect(failedCalls).toHaveLength(0);
    expect(reviewRequired).toHaveBeenCalledWith("order-1", expect.any(String));
    expect(order.status).toBe(OrderStatus.PAYMENT_REVIEW_REQUIRED);
  });

  it("escalates a failed status that still has a provider transaction to review", async () => {
    const { svc, order, failedCalls, reviewRequired } = makeService({
      status: PaymentStatus.FAILED,
      transactionId: "tx-recorded",
    });
    await expect(
      svc.verify("order-1", "user-1", "pidx-1"),
    ).rejects.toMatchObject({ code: ApiErrorCode.PAYMENT_RETRY_NOT_SAFE });
    expect(failedCalls).toHaveLength(0);
    expect(reviewRequired).toHaveBeenCalledWith("order-1", expect.any(String));
    expect(order.status).toBe(OrderStatus.PAYMENT_REVIEW_REQUIRED);
  });

  it("keeps a plain cancelled session (no provider transaction) retryable", async () => {
    const { svc, failedCalls, reviewRequired } = makeService({
      status: PaymentStatus.CANCELLED,
    });
    await expect(
      svc.verify("order-1", "user-1", "pidx-1"),
    ).rejects.toMatchObject({ code: ApiErrorCode.PAYMENT_NOT_CONFIRMED });
    expect(failedCalls).toHaveLength(1);
    expect(reviewRequired).not.toHaveBeenCalled();
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

  it("keeps a still-initiating wallet pending instead of failing it", async () => {
    // Khalti can still be authenticating when the wallet returns; INITIATED is
    // not a failure and must stay pending exactly like PENDING.
    const { svc, order, confirmedCalls, failedCalls } = makeService({
      status: PaymentStatus.INITIATED,
    });
    const result = await svc.verify("order-1", "user-1", "pidx-1");
    expect(result.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(confirmedCalls).toHaveLength(0);
    expect(failedCalls).toHaveLength(0);
    expect(order.payment.status).toBe(PaymentStatus.PENDING);
  });

  it("returns the paid order without a gateway round-trip when already COMPLETED", async () => {
    const order = orderFor({
      status: OrderStatus.PAYMENT_CONFIRMED,
      payment: {
        ...orderFor().payment,
        status: PaymentStatus.COMPLETED,
      },
    });
    const { svc, gateway } = serviceWithGateway(order);
    const result = await svc.verify("order-1", "user-1", "pidx-1");
    expect(result.status).toBe(OrderStatus.PAYMENT_CONFIRMED);
    expect(gateway.verify).not.toHaveBeenCalled();
  });

  it("rethrows the stored verdict for a cancelled session without re-querying", async () => {
    const order = orderFor({
      status: OrderStatus.PAYMENT_FAILED,
      payment: {
        ...orderFor().payment,
        status: PaymentStatus.CANCELLED,
      },
    });
    const { svc, gateway, confirmedCalls, failedCalls } = serviceWithGateway(order);
    await expect(
      svc.verify("order-1", "user-1", "pidx-1"),
    ).rejects.toMatchObject({ code: ApiErrorCode.PAYMENT_NOT_CONFIRMED });
    expect(gateway.verify).not.toHaveBeenCalled();
    // The stored verdict is returned as an error, never re-applied.
    expect(failedCalls).toHaveLength(0);
    expect(confirmedCalls).toHaveLength(0);
  });

  it("rethrows the stored verdict for a failed/expired session without re-querying", async () => {
    const order = orderFor({
      status: OrderStatus.PAYMENT_FAILED,
      payment: {
        ...orderFor().payment,
        status: PaymentStatus.FAILED,
      },
    });
    const { svc, gateway } = serviceWithGateway(order);
    await expect(
      svc.verify("order-1", "user-1", "pidx-1"),
    ).rejects.toMatchObject({ code: ApiErrorCode.PAYMENT_EXPIRED });
    expect(gateway.verify).not.toHaveBeenCalled();
  });

  it("rethrows PAYMENT_RETRY_NOT_SAFE for a payment under operational review", async () => {
    const order = orderFor({
      status: OrderStatus.PAYMENT_REVIEW_REQUIRED,
      payment: {
        ...orderFor().payment,
        status: PaymentStatus.REVIEW_REQUIRED,
      },
    });
    const { svc, gateway } = serviceWithGateway(order);
    await expect(
      svc.verify("order-1", "user-1", "pidx-1"),
    ).rejects.toMatchObject({ code: ApiErrorCode.PAYMENT_RETRY_NOT_SAFE });
    expect(gateway.verify).not.toHaveBeenCalled();
  });
});

/** Builds a service whose gateway never gets called unless the session is live. */
function serviceWithGateway(order: AnyRecord) {
  const confirmedCalls: { id: string }[] = [];
  const failedCalls: { id: string; reason: string }[] = [];
  const svc = new PaymentsService(
    {
      refreshOne: vi.fn(),
      get: () => order,
      view: () => order,
      confirmPayment: vi.fn(async (id: string) => {
        confirmedCalls.push({ id });
        return order;
      }),
      resolvePaymentFailure: vi.fn(async (id: string, _o: string | null, reason: string) => {
        failedCalls.push({ id, reason });
        return order;
      }),
    } as never,
    {} as never,
    {} as never,
  );
  const gateway = {
    provider: "KHALTI",
    verify: vi.fn(async () => ({
      reference: order.payment.reference,
      orderId: order.id,
      amountNpr: order.totalAmountNpr,
      status: PaymentStatus.COMPLETED,
    })),
  };
  (svc as unknown as { gateway: () => typeof gateway }).gateway = () => gateway;
  return { svc, gateway, confirmedCalls, failedCalls };
}

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

  it("returns the stored view for a cancelled session without a gateway round-trip", async () => {
    const order = orderFor({
      status: OrderStatus.PAYMENT_FAILED,
      payment: {
        ...orderFor().payment,
        status: PaymentStatus.CANCELLED,
      },
    });
    const { svc, gateway } = serviceWithGateway(order);
    const result = await svc.verifyCallback("order-1", "pidx-1");
    expect(result.status).toBe(OrderStatus.PAYMENT_FAILED);
    expect(gateway.verify).not.toHaveBeenCalled();
  });

  it("returns the stored view for a failed session without a gateway round-trip", async () => {
    const order = orderFor({
      status: OrderStatus.PAYMENT_FAILED,
      payment: {
        ...orderFor().payment,
        status: PaymentStatus.FAILED,
      },
    });
    const { svc, gateway } = serviceWithGateway(order);
    const result = await svc.verifyCallback("order-1", "pidx-1");
    expect(result.status).toBe(OrderStatus.PAYMENT_FAILED);
    expect(gateway.verify).not.toHaveBeenCalled();
  });

  it("rejects a callback whose reference does not match a settled session", async () => {
    const order = orderFor({
      status: OrderStatus.PAYMENT_FAILED,
      payment: {
        ...orderFor().payment,
        status: PaymentStatus.FAILED,
      },
    });
    const { svc, gateway } = serviceWithGateway(order);
    await expect(svc.verifyCallback("order-1", "pidx-OTHER")).rejects.toThrow(
      "Payment reference mismatch",
    );
    expect(gateway.verify).not.toHaveBeenCalled();
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

  it("settles an expired session with exactly one terminal lookup, confirming a paid result", async () => {
    const order = orderFor({
      payment: {
        ...orderFor().payment,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    });
    const { svc, confirmedCalls } = makeService({ order });
    const result = await svc.reconcileRecentPendingPayments();
    expect(result.confirmed).toEqual(["order-1"]);
    expect(result.stillPending).toHaveLength(0);
    expect(result.errored).toHaveLength(0);
    // A single lookup settles the expired session; a dead QR is not re-polled.
    const again = await svc.reconcileRecentPendingPayments();
    expect(again.confirmed).toHaveLength(0);
    expect(confirmedCalls).toHaveLength(1);
  });

  it("fails an expired session once when the gateway reports payment cancelled", async () => {
    const order = orderFor({
      payment: {
        ...orderFor().payment,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    });
    const { svc, failedCalls, confirmedCalls } = makeService({
      order,
      status: PaymentStatus.CANCELLED,
    });
    const result = await svc.reconcileRecentPendingPayments();
    expect(result.confirmed).toHaveLength(0);
    expect(result.stillPending).toHaveLength(0);
    expect(result.terminal).toEqual(["order-1"]);
    expect(failedCalls).toEqual([
      {
        id: "order-1",
        reason: "Customer cancelled the payment at the wallet",
        paymentStatus: PaymentStatus.CANCELLED,
      },
    ]);
    expect(confirmedCalls).toHaveLength(0);
    // Settled once: a second sweep must not re-query or re-fail.
    const again = await svc.reconcileRecentPendingPayments();
    expect(again.terminal).toHaveLength(0);
    expect(failedCalls).toHaveLength(1);
  });

  it("hands a still-pending expired session to the expiry reconcile and never re-queries it", async () => {
    const order = orderFor({
      payment: {
        ...orderFor().payment,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    });
    const calls: string[] = [];
    const svc = new PaymentsService(
      {
        get: () => order,
        view: () => order,
        list: () => [order],
        confirmPayment: vi.fn(async () => order),
        resolvePaymentFailure: vi.fn(async () => order),
      } as never,
      {} as never,
      {} as never,
    );
    const gateway = {
      provider: "KHALTI",
      verify: vi.fn(async (reference: string) => {
        calls.push(reference);
        return {
          reference,
          orderId: order.id,
          amountNpr: order.totalAmountNpr,
          status: PaymentStatus.PENDING,
        };
      }),
    };
    (svc as unknown as { gateway: () => typeof gateway }).gateway = () =>
      gateway;
    const state = (
      svc as unknown as {
        recentReconcileState: Map<string, { expiryEvaluated?: boolean }>;
      }
    ).recentReconcileState;

    const first = await svc.reconcileRecentPendingPayments();
    expect(calls).toEqual(["pidx-1"]);
    expect(first.confirmed).toHaveLength(0);
    expect(first.stillPending).toHaveLength(0);
    expect(first.errored).toHaveLength(0);
    expect(state.get("order-1")?.expiryEvaluated).toBe(true);

    // Even if the gateway starts reporting paid later, the expired session was
    // already handed to the expiry-phase reconcile — the fast sweep is done.
    const second = await svc.reconcileRecentPendingPayments();
    expect(calls).toEqual(["pidx-1"]);
    expect(second.confirmed).toHaveLength(0);
  });

  it("does not re-query the gateway once an expired session already errored", async () => {
    const order = orderFor({
      payment: {
        ...orderFor().payment,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    });
    const calls: string[] = [];
    const svc = new PaymentsService(
      {
        get: () => order,
        view: () => order,
        list: () => [order],
        confirmPayment: vi.fn(async () => order),
        resolvePaymentFailure: vi.fn(async () => order),
      } as never,
      {} as never,
      {} as never,
    );
    const gateway = {
      provider: "KHALTI",
      verify: vi.fn(async (reference: string) => {
        calls.push(reference);
        throw new ApiException({
          code: ApiErrorCode.PAYMENT_PROVIDER_ERROR,
          message: "unavailable",
          status: 502,
        });
      }),
    };
    (svc as unknown as { gateway: () => typeof gateway }).gateway = () =>
      gateway;

    const first = await svc.reconcileRecentPendingPayments();
    expect(first.errored).toEqual(["order-1"]);
    expect(calls).toEqual(["pidx-1"]);

    // The expired session is not hung on: one failure evaluation and then no
    // more provider chatter from the fast sweep.
    const second = await svc.reconcileRecentPendingPayments();
    expect(calls).toEqual(["pidx-1"]);
    expect(second.errored).toHaveLength(0);
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

  it("backs off an order that keeps returning pending (no transaction yet)", async () => {
    const order = orderFor();
    const calls: string[] = [];
    const svc = new PaymentsService(
      {
        get: () => order,
        view: () => order,
        list: () => [order],
        confirmPayment: vi.fn(async () => order),
        resolvePaymentFailure: vi.fn(async () => order),
      } as never,
      {} as never,
      {} as never,
    );
    const gateway = {
      provider: "KHALTI",
      async verify(reference: string) {
        calls.push(reference);
        return {
          reference,
          orderId: order.id,
          amountNpr: order.totalAmountNpr,
          status: PaymentStatus.PENDING,
        };
      },
    };
    (svc as unknown as { gateway: () => typeof gateway }).gateway = () =>
      gateway;

    const first = await svc.reconcileRecentPendingPayments();
    expect(calls).toEqual(["pidx-1"]);
    expect(first.stillPending).toEqual(["order-1"]);

    // A second sweep in the same window must not re-query an order that was
    // just checked and is still pending.
    const second = await svc.reconcileRecentPendingPayments();
    expect(calls).toEqual(["pidx-1"]);
    expect(second.stillPending).toEqual([]);
    expect(second.confirmed).toHaveLength(0);
    expect(second.errored).toHaveLength(0);
  });

  it("escalates a completed-but-mismatched lookup to operational review", async () => {
    const order = orderFor();
    const requirePaymentReview = vi.fn(async (id: string) => {
      order.status = OrderStatus.PAYMENT_REVIEW_REQUIRED;
      return order;
    });
    const attention = vi.fn(async () => undefined);
    const svc = new PaymentsService(
      {
        get: () => order,
        view: () => order,
        list: () => [order],
        confirmPayment: vi.fn(async () => order),
        resolvePaymentFailure: vi.fn(async () => order),
        requirePaymentReview,
      } as never,
      {} as never,
      {} as never,
      undefined,
      { attention } as never,
    );
    const gateway = {
      provider: "KHALTI",
      verify: vi.fn(async (reference: string) => ({
        reference,
        orderId: order.id,
        amountNpr: order.totalAmountNpr + 1, // provider reports a different amount
        status: PaymentStatus.COMPLETED,
      })),
    };
    (svc as unknown as { gateway: () => typeof gateway }).gateway = () =>
      gateway;

    const result = await svc.reconcileRecentPendingPayments();
    expect(result.terminal).toEqual(["order-1"]);
    expect(result.confirmed).toHaveLength(0);
    expect(requirePaymentReview).toHaveBeenCalledWith(
      "order-1",
      expect.stringContaining("mismatch"),
    );
    expect(attention).toHaveBeenCalledWith(
      expect.objectContaining({ category: "PAYMENT_SECURITY" }),
    );

    // The order is now in review, so a second sweep must not re-query it.
    const second = await svc.reconcileRecentPendingPayments();
    expect(gateway.verify).toHaveBeenCalledTimes(1);
    expect(second.terminal).toHaveLength(0);
  });

  it("does not reset the poll backoff when the provider errors", async () => {
    const order = orderFor();
    const calls: string[] = [];
    const svc = new PaymentsService(
      {
        get: () => order,
        view: () => order,
        list: () => [order],
        confirmPayment: vi.fn(async () => order),
        resolvePaymentFailure: vi.fn(async () => order),
      } as never,
      {} as never,
      {} as never,
    );
    const gateway = {
      provider: "KHALTI",
      verify: vi.fn(async (reference: string) => {
        calls.push(reference);
        throw new ApiException({
          code: ApiErrorCode.PAYMENT_PROVIDER_ERROR,
          message: "unavailable",
          status: 502,
        });
      }),
    };
    (svc as unknown as { gateway: () => typeof gateway }).gateway = () =>
      gateway;

    const first = await svc.reconcileRecentPendingPayments();
    expect(first.errored).toEqual(["order-1"]);
    expect(calls).toEqual(["pidx-1"]);

    // The error counts toward the backoff: a second sweep in the same window
    // must not hammer the provider again.
    const second = await svc.reconcileRecentPendingPayments();
    expect(calls).toEqual(["pidx-1"]);
    expect(second.errored).toEqual([]);
  });

  it("prunes backoff state once an order is no longer a sweep candidate", async () => {
    const order = orderFor();
    const svc = new PaymentsService(
      {
        get: () => order,
        view: () => order,
        list: () => [order],
        confirmPayment: vi.fn(async () => order),
        resolvePaymentFailure: vi.fn(async () => order),
      } as never,
      {} as never,
      {} as never,
    );
    const gateway = {
      provider: "KHALTI",
      verify: vi.fn(async (reference: string) => ({
        reference,
        orderId: order.id,
        amountNpr: order.totalAmountNpr,
        status: PaymentStatus.PENDING,
      })),
    };
    (svc as unknown as { gateway: () => typeof gateway }).gateway = () =>
      gateway;
    const state = (
      svc as unknown as {
        recentReconcileState: Map<string, { consecutivePending: number }>;
      }
    ).recentReconcileState;

    const first = await svc.reconcileRecentPendingPayments();
    expect(first.stillPending).toEqual(["order-1"]);
    expect(state.size).toBe(1);

    // The order leaves the candidate set (cancelled externally); the stale
    // backoff entry must be dropped, not retained forever.
    order.status = OrderStatus.CANCELLED;
    order.payment.status = PaymentStatus.CANCELLED;
    await svc.reconcileRecentPendingPayments();
    expect(state.size).toBe(0);
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

describe("PaymentsService Fonepay client telemetry", () => {
  function telemetrySetup(prismaEnabled = true) {
    const order = orderFor({
      payment: {
        provider: PaymentProvider.FONEPAY,
        reference: "VC-2026-ABCD",
        status: PaymentStatus.PENDING,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      },
    });
    const create = vi.fn(async () => ({}));
    const orders = { get: () => order };
    const service = new PaymentsService(
      orders as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      {
        enabled: prismaEnabled,
        integrationLog: { create },
      } as never,
    );
    return { service, order, create };
  }

  it("records a matching event with the order correlation and no payload", async () => {
    const { service, create } = telemetrySetup();

    const result = await service.recordFonepayClientTelemetry(
      "order-1",
      "user-1",
      {
        reference: "VC-2026-ABCD",
        event: "SOCKET_CONNECTED",
        platform: "ANDROID",
      },
    );

    expect(result).toEqual({ recorded: true });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "fonepay-client-socket-connected",
        method: "CLIENT",
        correlationId: "order-1",
        requestBody: expect.objectContaining({
          reference: "VC-2026-ABCD",
          event: "SOCKET_CONNECTED",
          platform: "ANDROID",
        }),
      }),
    });
  });

  it("persists the resolved issuer scheme and redacted deep link on a bank launch", async () => {
    const { service, create } = telemetrySetup();

    await service.recordFonepayClientTelemetry("order-1", "user-1", {
      reference: "VC-2026-ABCD",
      event: "BANK_LAUNCH_ATTEMPTED",
      platform: "IOS",
      bankCode: "SNMANPKA",
      bankName: "Sanima Bank Ltd.",
      launchMethod: "CUSTOM_SCHEME",
      scheme: "SNMANPKA",
      launchUrl: "SNMANPKA://payment/?qrPayload=<redacted>",
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "fonepay-client-bank-launch-attempted",
        requestBody: expect.objectContaining({
          bankCode: "SNMANPKA",
          scheme: "SNMANPKA",
          launchUrl: "SNMANPKA://payment/?qrPayload=<redacted>",
        }),
      }),
    });
  });

  it("rejects telemetry that does not match the active Fonepay reference", async () => {
    const { service, create } = telemetrySetup();

    await expect(
      service.recordFonepayClientTelemetry("order-1", "user-1", {
        reference: "VC-2026-OTHER",
        event: "SOCKET_CONNECTED",
        platform: "ANDROID",
      }),
    ).rejects.toThrow("does not match the active Fonepay payment");
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects unknown events before any lookup", async () => {
    const { service } = telemetrySetup();

    await expect(
      service.recordFonepayClientTelemetry("order-1", "user-1", {
        reference: "VC-2026-ABCD",
        event: "MADE_UP_EVENT",
        platform: "ANDROID",
      }),
    ).rejects.toThrow();
  });

  it("skips persistence when Prisma is disabled", async () => {
    const { service, create } = telemetrySetup(false);

    const result = await service.recordFonepayClientTelemetry(
      "order-1",
      "user-1",
      {
        reference: "VC-2026-ABCD",
        event: "QR_RENDERED",
        platform: "DESKTOP",
      },
    );

    expect(result).toEqual({ recorded: false });
    expect(create).not.toHaveBeenCalled();
  });
});
