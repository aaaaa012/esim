import { describe, it, expect, vi } from "vitest";
import {
  OrderStatus,
  PaymentStatus,
  PaymentProvider,
} from "@visa-compass/shared";
import { RechargesService, rechargeView } from "./recharges.service.js";
import { GuestOrderAccessService } from "./guest-order-access.service.js";
import { resolveRechargeOwner } from "./recharge-ownership.js";
import { decideRepair } from "../../../prisma/reconcile-recharge-customers.js";
import { OrdersService } from "./orders.service.js";
import { ConflictException } from "@nestjs/common";

type Any = any;
const makeOrder = (extra: Any = {}) => ({
  id: "order",
  ownerId: "owner",
  beneficiaryCustomerId: "beneficiary",
  purchasedByUserId: "payer",
  purchaseType: "TOPUP",
  status: OrderStatus.DRAFT,
  plan: { name: "Package" },
  documents: [],
  timeline: [],
  ...extra,
});
const user = (id = "other", localUserId = "payer") =>
  ({
    id,
    localUserId,
    accountType: "CUSTOMER",
    mustChangePassword: false,
  }) as Any;
function setup(order = makeOrder()) {
  const prisma: Any = {
    enabled: true,
    order: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
    },
  };
  const orders: Any = {
    refreshOne: vi.fn(),
    get: vi.fn(() => order),
    create: vi.fn(),
  };
  const access: Any = new GuestOrderAccessService({ enabled: false } as Any);
  const notifications: Any = { retry: vi.fn(), markFailure: vi.fn() };
  const payments: Any = { verify: vi.fn(), initiate: vi.fn() };
  const service = new RechargesService(
    prisma,
    orders,
    access,
    notifications,
    payments,
    { encrypt: (v: string) => `encrypted:${v}` } as Any,
  );
  return { service, prisma, orders, access, payments, order, notifications };
}
describe("automatic recharge target discovery", () => {
  it.each(["QR_READY", "COMPLETED"])(
    "accepts a provisioned initial purchase as a recharge target (%s)",
    async (status) => {
      const { service, prisma } = setup();
      prisma.order.findMany.mockResolvedValue([
        {
          id: "original",
          customerId: "customer",
          status,
          customer: { status: "ACTIVE", user: { clerkId: "owner" } },
          traveler: { email: "owner@example.com" },
          customerEsim: { inventory: { msisdn: "882470001234" } },
        },
      ]);
      await expect(service.target("inventory")).resolves.toMatchObject({
        inventoryId: "inventory",
        ownerId: "owner",
      });
    },
  );

  it.each([
    "DRAFT",
    "PAYMENT_PENDING",
    "PAYMENT_CONFIRMED",
    "PROVISIONING",
    "CANCELLED",
    "REFUNDED",
  ])(
    "never recharges an unprovisioned or cancelled original (%s)",
    async (status) => {
      const { service, prisma } = setup();
      prisma.order.findMany.mockResolvedValue([
        {
          id: "original",
          customerId: "customer",
          status,
          customer: { status: "ACTIVE", user: { clerkId: "owner" } },
          traveler: { email: "owner@example.com" },
          customerEsim: { inventory: { msisdn: "882470001234" } },
        },
      ]);
      await expect(service.target("inventory")).rejects.toThrow(/not eligible/);
    },
  );

  it("checks provider eligibility for ready-to-install eSIMs before creating a recharge", async () => {
    const instance: Any = Object.create(OrdersService.prototype);
    const findFirst = vi.fn().mockResolvedValue({
      id: "original",
      customerId: "customer",
      status: "QR_READY",
      plan: { country: { isoCode: "NP" } },
      traveler: {
        firstName: "Test",
        surname: "Traveler",
        email: "owner@example.com",
        mobile: "123456789",
        city: "City",
        countryOfResidence: "NP",
      },
      customerEsim: {
        inventory: {
          id: "inventory",
          msisdn: "882470001234",
          iccid: "test-iccid",
        },
      },
    });
    instance.prisma = { enabled: true, order: { findFirst } };
    instance.catalog = {
      findActive: vi.fn().mockResolvedValue({ id: "plan", countryCode: "IN" }),
    };
    instance.targetForMobile = vi.fn().mockResolvedValue(null);
    instance.connectivity = {
      checkEligibility: vi
        .fn()
        .mockResolvedValue({
          allowed: false,
          errorMessage: "Selected plan is not eligible",
        }),
    };
    instance.persistence = { save: vi.fn() };
    await expect(
      instance.create("owner", "plan", true, {
        mobile: "882470001234",
        termsAccepted: true,
        privacyAccepted: true,
        recharge: {
          orderId: "recharge",
          inventoryId: "inventory",
          customerId: "customer",
        },
      }),
    ).rejects.toThrow("Selected plan is not eligible");
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["QR_READY", "COMPLETED"] },
        }),
      }),
    );
    expect(instance.connectivity.checkEligibility).toHaveBeenCalledWith(
      "plan",
      "882470001234",
    );
    expect(instance.persistence.save).not.toHaveBeenCalled();
  });

  const candidate = (id: string) => ({
    customerEsim: {
      inventoryId: id,
      inventory: { iccid: `898824700000${id}` },
    },
  });
  it("discovers verified initial purchases owned by the signed-in customer across all purchase channels", async () => {
    const { service, prisma } = setup();
    prisma.order.findMany.mockResolvedValue([
      candidate("1234"),
      candidate("1234"),
    ]);
    const resolve = vi.spyOn(service, "target").mockResolvedValue({
      inventoryId: "1234",
      originalOrderId: "original",
      customerId: "beneficiary",
      ownerId: "owner",
      mobile: "private-mobile",
      email: "private@example.com",
    });
    await expect(service.eligibleTargets(user("owner"))).resolves.toEqual({
      targets: [{ id: "1234", label: "Travel eSIM · 1234" }],
    });
    expect(resolve).toHaveBeenCalledOnce();
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          orderType: "INITIAL_PURCHASE",
          status: { in: ["QR_READY", "COMPLETED"] },
          documentReviewStatus: { in: ["VERIFIED", "MANUALLY_APPROVED"] },
          customer: { user: { clerkId: "owner" }, status: { not: "BLOCKED" } },
          customerEsim: { isNot: null },
        },
      }),
    );
  });

  it("omits targets whose owner changed or whose ownership is ambiguous", async () => {
    const { service, prisma } = setup();
    prisma.order.findMany.mockResolvedValue([
      candidate("1234"),
      candidate("5678"),
    ]);
    vi.spyOn(service, "target")
      .mockResolvedValueOnce({
        inventoryId: "1234",
        originalOrderId: "original",
        customerId: "other",
        ownerId: "someone-else",
        mobile: "private",
        email: "private@example.com",
      })
      .mockRejectedValueOnce(new ConflictException("Ownership needs review"));
    await expect(service.eligibleTargets(user("owner"))).resolves.toEqual({
      targets: [],
    });
  });

  it("does not treat a database failure as proof the customer needs a new eSIM", async () => {
    const { service, prisma } = setup();
    prisma.order.findMany.mockResolvedValue([candidate("1234")]);
    vi.spyOn(service, "target").mockRejectedValue(
      new Error("Database unavailable"),
    );
    await expect(service.eligibleTargets(user("owner"))).rejects.toThrow(
      "Database unavailable",
    );
  });

  it("returns no targets for a customer with no verified completed initial purchases", async () => {
    const { service, prisma } = setup();
    prisma.order.findMany.mockResolvedValue([]);
    await expect(
      service.eligibleTargets(user("new-customer")),
    ).resolves.toEqual({ targets: [] });
  });

  it("rejects non-customer and password-reset accounts before reading targets", async () => {
    const { service, prisma } = setup();
    await expect(
      service.eligibleTargets({ ...user(), accountType: "OPERATIONS" }),
    ).rejects.toThrow();
    await expect(
      service.eligibleTargets({ ...user(), mustChangePassword: true }),
    ).rejects.toThrow();
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });
});

describe("recharge ownership and privacy", () => {
  it("uses only an unambiguous initial purchase; missing or multiple origins require review", () => {
    expect(
      resolveRechargeOwner([{ id: "original", customerId: "owner" }])
        .customerId,
    ).toBe("owner");
    expect(() => resolveRechargeOwner([])).toThrow(/review/);
    expect(() =>
      resolveRechargeOwner([
        { id: "a", customerId: "x" },
        { id: "b", customerId: "x" },
      ]),
    ).toThrow(/review/);
  });
  it("allows owner, distinct recorded purchaser and scoped guest, denies an unrelated account", async () => {
    const { service, access } = setup();
    await expect(
      service.authorize("order", user("owner", "owner-local")),
    ).resolves.toBeDefined();
    await expect(service.authorize("order", user())).resolves.toBeDefined();
    await expect(
      service.authorize("order", undefined, access.createSessionToken("order")),
    ).resolves.toBeDefined();
    await expect(
      service.authorize("order", user("stranger", "stranger")),
    ).rejects.toThrow();
    await expect(
      service.authorize(
        "order",
        undefined,
        access.createSessionToken("another"),
      ),
    ).rejects.toThrow();
  });
  it("omits owner contact, installation data, documents and provider diagnostics", () => {
    const view = rechargeView(
      makeOrder({
        qrPayload: "QR-secret",
        traveler: { email: "private@example.com" },
        documents: [{ privateAssetId: "passport-secret" }],
        pricingSnapshot: { topUpEmail: "private@example.com" },
        assignment: { iccid: "private-iccid" },
        provisioningFailure: { message: "provider-private" },
        timeline: [{ from: null, to: "DRAFT", at: "now", reason: "secret" }],
      }),
    );
    const encoded = JSON.stringify(view);
    for (const secret of [
      "QR-secret",
      "private@example.com",
      "passport-secret",
      "private-iccid",
      "provider-private",
      "beneficiary",
      "payer",
      "secret",
    ])
      expect(encoded).not.toContain(secret);
    expect(view.documents).toEqual([]);
  });
  it("never claims a recharge as a new eSIM owner", async () => {
    const service: Any = Object.create(OrdersService.prototype);
    service.refreshOne = vi.fn();
    service.prisma = { enabled: false };
    service.orders = new Map([["order", makeOrder()]]);
    await expect(service.claimGuestOrder("order", "someone")).rejects.toThrow(
      /cannot be claimed/,
    );
  });
  it("rejects a changed beneficiary or recovery email behind a lookup token", async () => {
    const { service, access } = setup();
    const target = {
      inventoryId: "inventory",
      originalOrderId: "original",
      customerId: "customer",
      mobile: "123",
      email: "owner@example.com",
      ownerId: "owner",
    };
    const token = access.createLookupToken("123", target);
    vi.spyOn(service, "target").mockResolvedValue({
      ...target,
      customerId: "changed",
    });
    await expect(service.targetFromLookup(token)).rejects.toThrow(
      /no longer valid/,
    );
  });
  it("lookup tokens expire and bind purpose, inventory, original order, customer and recipient", () => {
    const access = new GuestOrderAccessService({ enabled: false } as Any);
    const token = access.createLookupToken("123", {
      inventoryId: "inventory",
      originalOrderId: "original",
      customerId: "customer",
      email: "a@example.com",
    });
    expect(access.rechargeLookupClaims(token)).toMatchObject({
      inventoryId: "inventory",
      originalOrderId: "original",
      customerId: "customer",
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
    expect(() => access.rechargeLookupClaims(token)).toThrow();
    now.mockRestore();
    expect(() => access.createLookupToken("123")).toThrow();
  });
});
describe("recharge creation and retries", () => {
  const target = {
    inventoryId: "inventory",
    originalOrderId: "original",
    customerId: "beneficiary",
    ownerId: "owner",
    email: "owner@example.com",
    mobile: "123",
  };
  const input = {
    planId: "plan",
    lookupToken: "valid",
    checkoutAttemptKey: "a".repeat(32),
    termsAccepted: true,
    privacyAccepted: true,
  };
  it.each([undefined, user()])(
    "persists the beneficiary separately from the purchaser and replays one order",
    async (purchaser) => {
      const { service, prisma, orders, access } = setup();
      vi.spyOn(service, "targetFromLookup").mockResolvedValue(target);
      vi.spyOn(service, "ensureRecovery").mockResolvedValue();
      let row: Any = null;
      prisma.order.findUnique.mockImplementation(async () => row);
      prisma.order.findUniqueOrThrow.mockImplementation(async () => row);
      orders.create.mockImplementation(
        async (
          owner: string,
          _plan: string,
          _compatible: boolean,
          meta: Any,
        ) => {
          expect(owner).toBe("owner");
          expect(meta.recharge.customerId).toBe("beneficiary");
          expect(meta.recharge.purchasedByUserId).toBe(purchaser?.localUserId);
          row = {
            id: "order",
            checkoutRequestHash: meta.recharge.checkoutRequestHash,
          };
          return row;
        },
      );
      const first = await service.create(input, purchaser);
      const repeated = await service.create(input, purchaser);
      expect(first.order.id).toBe(repeated.order.id);
      expect(orders.create).toHaveBeenCalledTimes(1);
      expect(() =>
        access.assertSessionToken("order", first.token),
      ).not.toThrow();
      await expect(
        service.create({ ...input, planId: "different" }, purchaser),
      ).rejects.toThrow(/different purchase/);
    },
  );
  it("does not create an order for someone else's owned-eSIM selection", async () => {
    const { service, orders } = setup();
    vi.spyOn(service, "target").mockResolvedValue(target);
    await expect(
      service.create(
        { ...input, lookupToken: undefined, targetEsimId: "inventory" },
        user(),
      ),
    ).rejects.toThrow();
    expect(orders.create).not.toHaveBeenCalled();
  });
  it("reconciles expired pending payment without initiating another payment", async () => {
    const { service, payments } = setup(
      makeOrder({
        status: OrderStatus.PAYMENT_PENDING,
        payment: {
          status: PaymentStatus.PENDING,
          reference: "payment",
          expiresAt: "2000-01-01",
        },
      }),
    );
    vi.spyOn(service, "ensureRecovery").mockResolvedValue();
    await expect(
      service.pay("order", PaymentProvider.KHALTI, user()),
    ).rejects.toThrow(/pending/);
    expect(payments.verify).toHaveBeenCalled();
    expect(payments.initiate).not.toHaveBeenCalled();
  });
  it("reuses a pending Fonepay QR without requiring a redirect URL", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const { service, payments, prisma } = setup(
      makeOrder({
        status: OrderStatus.PAYMENT_PENDING,
        payment: {
          status: PaymentStatus.PENDING,
          provider: PaymentProvider.FONEPAY,
          reference: "payment",
          redirectUrl: "",
          expiresAt,
        },
      }),
    );
    vi.spyOn(service, "ensureRecovery").mockResolvedValue();
    prisma.paymentInitiation = {
      findUnique: vi.fn(async () => ({
        status: "COMPLETED",
        result: {
          reference: "payment",
          redirectUrl: "",
          expiresAt,
          qrPayload: "existing-payment-qr",
          correlationId: "private",
        },
      })),
    };
    const result = await service.pay("order", PaymentProvider.FONEPAY, user());
    expect(result).toMatchObject({
      reference: "payment",
      qrPayload: "existing-payment-qr",
    });
    expect(result).not.toHaveProperty("correlationId");
    expect(payments.verify).toHaveBeenCalled();
    expect(payments.initiate).not.toHaveBeenCalled();
  });
  it("does not collect payment again after a late successful confirmation", async () => {
    const { service, payments, order } = setup(
      makeOrder({
        status: OrderStatus.PAYMENT_PENDING,
        payment: { status: PaymentStatus.PENDING, reference: "payment" },
      }),
    );
    vi.spyOn(service, "ensureRecovery").mockResolvedValue();
    payments.verify.mockImplementation(async () => {
      order.status = OrderStatus.PROVISIONING;
      order.payment.status = PaymentStatus.COMPLETED;
    });
    await expect(
      service.pay("order", PaymentProvider.KHALTI, user()),
    ).rejects.toThrow(/another payment/);
    expect(payments.initiate).not.toHaveBeenCalled();
  });
});
describe("historical recharge repair", () => {
  const row = {
    id: "order",
    customerId: "guest",
    targetInventoryId: null,
    purchasedByUserId: null,
    pricingSnapshot: { targetEsimId: "inventory" },
    customer: { user: { id: "guest-user", clerkId: "guest-old" } },
    customerEsim: { inventoryId: "inventory", customerId: "guest" },
  };
  it("repairs using inventory evidence without inventing a purchaser and is repeatable", () => {
    const decision = decideRepair(row, [{ customerId: "owner" }]);
    expect(decision).toMatchObject({
      action: "REPAIR",
      customerId: "owner",
      purchasedByUserId: null,
    });
    expect(
      decideRepair(
        {
          ...row,
          customerId: "owner",
          targetInventoryId: "inventory",
          customerEsim: { inventoryId: "inventory", customerId: "owner" },
        },
        [{ customerId: "owner" }],
      ).action,
    ).toBe("UNCHANGED");
  });
  it("flags conflicting targets and missing original purchases", () => {
    expect(
      decideRepair({ ...row, targetInventoryId: "different" }, [
        { customerId: "owner" },
      ]).action,
    ).toBe("REVIEW");
    expect(decideRepair(row, []).action).toBe("REVIEW");
  });
  it("retains a different authenticated purchaser", () => {
    expect(
      decideRepair(
        { ...row, customer: { user: { id: "payer", clerkId: "user_payer" } } },
        [{ customerId: "claimed-owner" }],
      ),
    ).toMatchObject({
      purchasedByUserId: "payer",
      customerId: "claimed-owner",
    });
  });
});

describe("initial purchase after paying for another eSIM", () => {
  it("creates a fresh initial purchase for the purchaser without adopting the recharged eSIM", async () => {
    const instance: Any = Object.create(OrdersService.prototype);
    instance.orders = new Map([
      [
        "topup",
        makeOrder({
          status: OrderStatus.COMPLETED,
          purchasedByUserId: "payer",
          ownerId: "owner",
        }),
      ],
    ]);
    instance.catalog = {
      findActive: vi.fn(async () => ({
        id: "plan",
        countryCode: "IN",
        name: "New eSIM",
        sellingPriceNpr: 100,
      })),
    };
    instance.inventory = { assertAvailableForNewOrder: vi.fn() };
    instance.persistence = { save: vi.fn(), recordConsent: vi.fn() };
    const result = await instance.create("payer-clerk", "plan", true, {
      termsAccepted: true,
      privacyAccepted: true,
    });
    expect(result.purchaseType).toBe("INITIAL_PURCHASE");
    expect(instance.orders.get(result.id).ownerId).toBe("payer-clerk");
    expect(instance.orders.get("topup").ownerId).toBe("owner");
  });
});
