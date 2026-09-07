import { describe, expect, it, vi } from "vitest";
import { PartnerService } from "./partner.service.js";

const usageView = {
  esim: {
    id: "esim-1",
    iccid: "8988247076000000319",
    msisdn: "33612345678",
    status: "ACTIVATED",
  },
  usageStatus: "AVAILABLE" as const,
  completeness: "FULL" as const,
  freshness: "FRESH" as const,
  lastConfirmedAt: "2026-09-02T10:00:00.000Z",
  oldestConfirmedAt: "2026-09-02T10:00:00.000Z",
  summary: {
    usedMb: 300,
    totalMb: 3000,
    remainingMb: 2700,
    confirmedPackageCount: 2,
    unconfirmedPackageCount: 0,
    packageCount: 2,
  },
  packages: [
    {
      id: "subscription-1",
      packageReference: "pkg_owned",
      orderId: "order-1",
      orderNumber: "VC-1",
      externalOrderId: "external-1",
      partnerId: "partner-1",
      purchaseType: "INITIAL_PURCHASE",
      channel: "PARTNER_API",
      plan: {
        id: "plan-1",
        name: "Asia 1 GB",
        countryCode: "SG",
        countryName: "Singapore",
        dataAllowance: "1 GB",
        validityDays: 7,
      },
      subscriptionId: "subscription-1",
      providerSubscriptionId: "provider-owned",
      status: "ACTIVE",
      balanceStatus: "CONFIRMED",
      usedMb: 100,
      totalMb: 1000,
      remainingMb: 900,
      activatedAt: null,
      expiresAt: null,
      lastConfirmedAt: "2026-09-02T10:00:00.000Z",
      lastCheckedAt: "2026-09-02T10:00:00.000Z",
      verificationStatus: "VERIFIED",
      assignmentVerificationStatus: "VERIFIED",
    },
    {
      id: "subscription-2",
      packageReference: "pkg_other",
      orderId: "order-2",
      orderNumber: "VC-2",
      externalOrderId: "other-external-id",
      partnerId: "partner-2",
      purchaseType: "TOPUP",
      channel: "PARTNER_API",
      plan: {
        id: "plan-2",
        name: "Thailand 2 GB",
        countryCode: "TH",
        countryName: "Thailand",
        dataAllowance: "2 GB",
        validityDays: 10,
      },
      subscriptionId: "subscription-2",
      providerSubscriptionId: "provider-other",
      status: "ACTIVE",
      balanceStatus: "CONFIRMED",
      usedMb: 200,
      totalMb: 2000,
      remainingMb: 1800,
      activatedAt: null,
      expiresAt: null,
      lastConfirmedAt: "2026-09-02T10:00:00.000Z",
      lastCheckedAt: "2026-09-02T10:00:00.000Z",
      verificationStatus: "VERIFIED",
      assignmentVerificationStatus: "VERIFIED",
    },
  ],
};

function service(managementAccess = true) {
  const prisma = {
    order: {
      findFirst: vi.fn().mockResolvedValue({
        id: "order-1",
        partnerId: "partner-1",
        customerEsim: { inventoryId: "esim-1" },
      }),
    },
    customerEsim: {
      findFirst: vi
        .fn()
        .mockResolvedValue(managementAccess ? { id: "owner-link" } : null),
    },
  };
  const usage = {
    cached: vi.fn().mockResolvedValue(usageView),
    refresh: vi.fn().mockResolvedValue(usageView),
  };
  const instance = new PartnerService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { consumeRateLimit: vi.fn().mockResolvedValue({ count: 1 }) } as never,
    {} as never,
    {} as never,
    usage as never,
  );
  return { instance, usage };
}

describe("partner eSIM usage", () => {
  it("returns the physical aggregate while redacting other-channel order metadata", async () => {
    const { instance } = service();

    const result = (await instance.usage("partner-1", "order-1")) as any;

    expect(result).toMatchObject({
      scope: "PHYSICAL_ESIM",
      usedMb: 300,
      totalMb: 3000,
      usageAvailable: true,
    });
    expect(result.packages[0]).toMatchObject({
      ownedByRequester: true,
      orderId: "order-1",
      externalOrderId: "external-1",
      providerSubscriptionId: "provider-owned",
    });
    expect(result.packages[1]).toMatchObject({
      ownedByRequester: false,
      packageReference: "pkg_other",
    });
    expect(result.packages[1]).not.toHaveProperty("orderId");
    expect(result.packages[1]).not.toHaveProperty("externalOrderId");
    expect(result.packages[1]).not.toHaveProperty("providerSubscriptionId");
  });

  it("does not grant usage access merely because the partner bought a top-up", async () => {
    const { instance, usage } = service(false);

    await expect(instance.usage("partner-1", "order-1")).rejects.toMatchObject({
      response: { code: "PARTNER_ESIM_NOT_FOUND" },
    });
    expect(usage.cached).not.toHaveBeenCalled();
  });
});
