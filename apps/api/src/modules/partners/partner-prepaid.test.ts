import { describe, expect, it, vi } from "vitest";
import { PartnerService } from "./partner.service.js";

function service(prisma: Record<string, unknown>) {
  return new PartnerService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe("partner prepaid settlement", () => {
  it("rejects hosted payment before creating an order", async () => {
    const instance = service({
      partner: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: "partner-1", status: "ACTIVE" }),
      },
    });
    await expect(
      instance.createCompleteOrder(
        "partner-1",
        {
          externalOrderId: "external-1",
          externalCustomerId: "customer-1",
          planId: "00000000-0000-4000-8000-000000000001",
          settlement: {
            method: "HOSTED_PAYMENT",
            provider: "KHALTI",
            redirectUrl: "https://partner.example/return",
          },
          documentVerificationId: "00000000-0000-4000-8000-000000000002",
          consent: {
            compatibilityAccepted: true,
            termsAccepted: true,
            privacyAccepted: true,
            acceptedAt: new Date().toISOString(),
          },
        },
        { ipAddress: "127.0.0.1", userAgent: "test" },
      ),
    ).rejects.toMatchObject({
      response: { code: "HOSTED_PAYMENT_DEPRECATED" },
    });
  });

  it("does not allow a debit beyond the prepaid balance", async () => {
    const tx = {
      partnerAccount: {
        upsert: vi
          .fn()
          .mockResolvedValue({
            id: "account-1",
            balancePaisa: 999,
            version: 2,
          }),
        updateMany: vi.fn(),
      },
      partnerLedgerEntry: { create: vi.fn() },
    };
    const instance = service({});
    await expect(
      (
        instance as unknown as {
          debitAccount(...args: unknown[]): Promise<void>;
        }
      ).debitAccount(tx, "partner-1", "order-1", 1000, "external-1"),
    ).rejects.toMatchObject({
      response: { code: "INSUFFICIENT_PARTNER_BALANCE" },
    });
    expect(tx.partnerAccount.updateMany).not.toHaveBeenCalled();
    expect(tx.partnerLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("creates one order-linked debit using a guarded balance update", async () => {
    const tx = {
      partnerAccount: {
        upsert: vi
          .fn()
          .mockResolvedValue({
            id: "account-1",
            balancePaisa: 5000,
            version: 2,
          }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      partnerLedgerEntry: {
        create: vi.fn().mockResolvedValue({ id: "ledger-1" }),
      },
    };
    const instance = service({});
    await (
      instance as unknown as { debitAccount(...args: unknown[]): Promise<void> }
    ).debitAccount(tx, "partner-1", "order-1", 2500, "external-1");
    expect(tx.partnerAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          version: 2,
          balancePaisa: { gte: 2500 },
        }),
      }),
    );
    expect(tx.partnerLedgerEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: "order-1",
        amountPaisa: 2500,
        balanceAfterPaisa: 2500,
        reference: "debit:partner-1:external-1",
      }),
    });
  });
});
