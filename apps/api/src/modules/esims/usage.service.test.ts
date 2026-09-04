import { describe, expect, it, vi } from "vitest";
import { UsageService } from "./usage.service.js";

const inventory = () => ({
  id: "inventory-1",
  iccid: "8988247076000000319",
  msisdn: "33612345678",
  status: "ACTIVATED",
  customerEsims: [
    {
      orderId: "order-initial",
      order: {
        id: "order-initial",
        orderNumber: "VC-INITIAL",
        externalOrderId: "partner-initial",
        partnerId: "partner-1",
        orderType: "INITIAL_PURCHASE",
        channel: "PARTNER_API",
        plan: {
          id: "plan-1",
          name: "Asia 5 GB",
          dataAllowance: "5 GB",
          validityDays: 15,
          country: { isoCode: "SG", name: "Singapore" },
        },
      },
      subscriptions: [
        {
          id: "subscription-1",
          providerSubscriptionId: "provider-1",
          status: "ACTIVE",
          usedMb: 100,
          totalMb: 1000,
          usageLastCheckedAt: new Date("2026-09-01T00:00:00Z"),
          providerLastSeenAt: new Date("2026-09-01T00:00:00Z"),
          assignmentVerificationStatus: "VERIFIED",
          assignmentVerifiedAt: new Date("2026-09-01T00:00:00Z"),
          activatedAt: new Date("2026-09-01T00:00:00Z"),
          expiresAt: null,
        },
      ],
    },
    {
      orderId: "order-topup",
      order: {
        id: "order-topup",
        orderNumber: "VC-TOPUP",
        externalOrderId: null,
        partnerId: null,
        orderType: "TOPUP",
        channel: "CUSTOMER_WEB",
        plan: {
          id: "plan-2",
          name: "Thailand 2 GB",
          dataAllowance: "2 GB",
          validityDays: 7,
          country: { isoCode: "TH", name: "Thailand" },
        },
      },
      subscriptions: [
        {
          id: "subscription-2",
          providerSubscriptionId: "provider-2",
          status: "PENDING",
          usedMb: 0,
          totalMb: 0,
          usageLastCheckedAt: null,
          providerLastSeenAt: null,
          assignmentVerificationStatus: "PENDING",
          assignmentVerifiedAt: null,
          activatedAt: null,
          expiresAt: null,
        },
      ],
    },
  ],
});

function context(providerSubscriptions: Array<Record<string, unknown>>) {
  const row = inventory();
  const subscriptionById = new Map<string, any>();
  for (const link of row.customerEsims)
    for (const item of link.subscriptions) subscriptionById.set(item.id, item);
  const prisma = {
    enabled: true,
    esimInventory: { findUnique: vi.fn().mockImplementation(() => row) },
    subscription: {
      update: vi.fn().mockImplementation(({ where, data }) => {
        Object.assign(subscriptionById.get(where.id)!, data);
        return subscriptionById.get(where.id);
      }),
    },
    $transaction: vi.fn((operations: Promise<unknown>[]) =>
      Promise.all(operations),
    ),
  };
  const connectivity = {
    getUsage: vi.fn().mockResolvedValue({
      usedMb: 0,
      totalMb: 0,
      usageAvailable: true,
      subscriptions: providerSubscriptions,
    }),
  };
  const resilience = {
    attention: vi.fn().mockResolvedValue(undefined),
    resolve: vi.fn().mockResolvedValue(undefined),
  };
  return {
    service: new UsageService(
      prisma as never,
      connectivity as never,
      resilience as never,
    ),
    prisma,
    connectivity,
    resilience,
  };
}

describe("UsageService", () => {
  it("synchronizes initial and top-up balances and returns their confirmed aggregate", async () => {
    const { service, connectivity } = context([
      {
        providerSubscriptionId: "provider-1",
        status: "active",
        usedMb: 250,
        totalMb: 1000,
        priority: 1,
      },
      {
        providerSubscriptionId: "provider-2",
        status: "pending",
        usedMb: 100,
        totalMb: 2000,
        priority: 2,
      },
    ]);

    const result = await service.refresh("inventory-1");

    expect(connectivity.getUsage).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      usageStatus: "AVAILABLE",
      completeness: "FULL",
      summary: {
        usedMb: 350,
        totalMb: 3000,
        remainingMb: 2650,
        confirmedPackageCount: 2,
        unconfirmedPackageCount: 0,
      },
    });
    expect(service.packageForOrder(result, "order-topup")).toMatchObject({
      balanceStatus: "CONFIRMED",
      remainingMb: 1900,
    });
  });

  it("confirms a ready subscription without inventing a balance or marking mismatch", async () => {
    const { service, resilience } = context([
      {
        providerSubscriptionId: "provider-1",
        status: "active",
        usedMb: 0,
        totalMb: 1024,
      },
      {
        providerSubscriptionId: "provider-2",
        status: "readyForUse",
        usedMb: 0,
        totalMb: 0,
        usageAvailable: false,
      },
    ]);
    const result = await service.refresh("inventory-1");
    expect(result.summary.totalMb).toBe(1024);
    expect(result.packages[1]).toMatchObject({
      verificationStatus: "VERIFIED",
      balanceStatus: "WAITING_FOR_FIRST_USE",
      expiresAt: null,
      lastCheckedAt: null,
    });
    expect(resilience.attention).not.toHaveBeenCalled();
  });

  it("processes inventory evidence even when no package has a balance", async () => {
    const { service, connectivity, resilience } = context([]);
    connectivity.getUsage.mockResolvedValue({
      usedMb: 0,
      totalMb: 0,
      usageAvailable: false,
      subscriptions: [
        {
          providerSubscriptionId: "provider-1",
          status: "readyForUse",
          usageAvailable: false,
        },
        {
          providerSubscriptionId: "provider-2",
          status: "readyForUse",
          usageAvailable: false,
        },
      ],
    });
    const result = await service.refresh("inventory-1");
    expect(result.usageStatus).toBe("WAITING_FOR_FIRST_USE");
    expect(result.summary.confirmedPackageCount).toBe(0);
    expect(
      result.packages.every((p) => p.verificationStatus === "VERIFIED"),
    ).toBe(true);
    expect(resilience.attention).not.toHaveBeenCalled();
  });

  it("preserves and excludes a missing package while reporting partial usage", async () => {
    const { service, resilience } = context([
      {
        providerSubscriptionId: "provider-1",
        status: "active",
        usedMb: 250,
        totalMb: 1000,
        priority: 1,
      },
    ]);

    const result = await service.refresh("inventory-1");

    expect(result).toMatchObject({
      completeness: "PARTIAL",
      summary: {
        usedMb: 250,
        totalMb: 1000,
        remainingMb: 750,
        confirmedPackageCount: 1,
        unconfirmedPackageCount: 1,
      },
    });
    expect(service.packageForOrder(result, "order-topup")).toMatchObject({
      balanceStatus: "UNAVAILABLE",
      verificationStatus: "MISMATCH",
    });
    expect(resilience.attention).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: "subscription-assignment:subscription-2",
      }),
    );
  });

  it("keeps a newly assigned top-up waiting while Transatel publishes its balance", async () => {
    const { service, prisma, resilience } = context([
      {
        providerSubscriptionId: "provider-1",
        status: "active",
        usedMb: 250,
        totalMb: 1000,
        priority: 1,
      },
    ]);
    const row = await prisma.esimInventory.findUnique();
    row.customerEsims[1].assignedAt = new Date();

    const result = await service.refresh("inventory-1");

    expect(service.packageForOrder(result, "order-topup")).toMatchObject({
      balanceStatus: "WAITING_FOR_FIRST_USE",
      verificationStatus: "PENDING",
    });
    expect(resilience.attention).not.toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: "subscription-assignment:subscription-2",
      }),
    );
  });

  it("does not verify a newly assigned top-up from a provider 0/0 placeholder", async () => {
    const { service, prisma } = context([
      {
        providerSubscriptionId: "provider-1",
        status: "active",
        usedMb: 250,
        totalMb: 1000,
        priority: 1,
      },
      {
        providerSubscriptionId: "provider-2",
        status: "pending",
        usedMb: 0,
        totalMb: 0,
        priority: 2,
      },
    ]);
    const row = await prisma.esimInventory.findUnique();
    row.customerEsims[1].assignedAt = new Date();

    const result = await service.refresh("inventory-1");

    expect(service.packageForOrder(result, "order-topup")).toMatchObject({
      balanceStatus: "WAITING_FOR_FIRST_USE",
      totalMb: 0,
      verificationStatus: "PENDING",
    });
  });

  it("does not modify cached balances when the provider is unavailable", async () => {
    const { service, prisma, connectivity } = context([]);
    connectivity.getUsage.mockRejectedValueOnce(new Error("provider timeout"));

    await expect(service.refresh("inventory-1")).rejects.toThrow(
      "provider timeout",
    );
    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });

  it("reports unknown provider packages as partial without adding their balance", async () => {
    const { service, resilience } = context([
      {
        providerSubscriptionId: "provider-1",
        status: "active",
        usedMb: 250,
        totalMb: 1000,
        priority: 1,
      },
      {
        providerSubscriptionId: "provider-2",
        status: "pending",
        usedMb: 100,
        totalMb: 2000,
        priority: 2,
      },
      {
        providerSubscriptionId: "provider-unknown",
        status: "active",
        usedMb: 9000,
        totalMb: 10000,
        priority: 3,
      },
    ]);

    const result = await service.refresh("inventory-1");

    expect(result.completeness).toBe("PARTIAL");
    expect(result.summary).toMatchObject({
      usedMb: 350,
      totalMb: 3000,
      confirmedPackageCount: 2,
      unconfirmedPackageCount: 1,
      packageCount: 3,
    });
    expect(resilience.attention).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "EsimInventory",
        externalState: "UNKNOWN_PROVIDER_SUBSCRIPTION",
      }),
    );
  });
});
