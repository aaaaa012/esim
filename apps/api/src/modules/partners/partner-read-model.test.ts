import { describe, expect, it, vi } from "vitest";
import { PartnerService } from "./partner.service.js";

function service(prisma: Record<string, unknown>, usageService?: object) {
  return new PartnerService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    usageService as never,
  );
}

describe("partner bounded read models", () => {
  it("aggregates account totals in the database and reports prepaid-only credit", async () => {
    const groupBy = vi.fn().mockResolvedValue([
      {
        status: "COMPLETED",
        _count: { _all: 2 },
        _sum: { totalAmount: "25.50" },
      },
      {
        status: "PROVISIONING_FAILED",
        _count: { _all: 1 },
        _sum: { totalAmount: "10.00" },
      },
    ]);
    const aggregate = vi
      .fn()
      .mockResolvedValueOnce({ _sum: { amountPaisa: 2550 } })
      .mockResolvedValueOnce({ _sum: { amountPaisa: 10_000 } })
      .mockResolvedValueOnce({ _sum: { amountPaisa: 0 } })
      .mockResolvedValueOnce({ _sum: { amountPaisa: 0 } });
    const instance = service({
      partner: {
        findUnique: vi.fn().mockResolvedValue({
          id: "partner-1",
          status: "ACTIVE",
        }),
      },
      partnerAccount: {
        upsert: vi.fn().mockResolvedValue({
          balancePaisa: 10_000,
          reservedPaisa: 2_000,
          updatedAt: new Date("2026-09-23T00:00:00.000Z"),
        }),
      },
      partnerLedgerEntry: { aggregate },
      order: { groupBy },
    });

    await expect(instance.account("partner-1")).resolves.toMatchObject({
      creditLimitPaisa: 0,
      availableBalancePaisa: 8_000,
      ordersCreated: 3,
      ordersByStatus: { COMPLETED: 2, PROVISIONING_FAILED: 1 },
      totalOrderValuePaisa: 3_550,
      averageOrderValuePaisa: 1_183,
    });
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["status"],
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
    );
  });

  it("returns a stable bounded event page and cursor", async () => {
    const first = {
      id: "00000000-0000-4000-8000-000000000001",
      occurredAt: new Date("2026-09-23T00:00:00.000Z"),
    };
    const second = {
      id: "00000000-0000-4000-8000-000000000002",
      occurredAt: new Date("2026-09-23T00:00:01.000Z"),
    };
    const findMany = vi.fn().mockResolvedValue([first, second]);
    const instance = service({
      order: {
        findFirst: vi.fn().mockResolvedValue({ id: "order-1" }),
      },
      partnerEvent: { findMany },
    });

    const result = await instance.events("partner-1", "order-1", {
      limit: 1,
    });
    expect(result.items).toEqual([first]);
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2,
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      }),
    );
  });

  it("fails explicitly when customer usage is not configured", async () => {
    const instance = service({});
    await expect(
      instance.customerUsage("partner-1", "customer-1"),
    ).rejects.toMatchObject({
      response: { code: "PARTNER_USAGE_UNAVAILABLE" },
      status: 503,
    });
  });
});
