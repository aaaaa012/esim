import { describe, expect, it, vi } from "vitest";
import { PartnerService } from "./partner.service.js";
import { hostedCheckoutSessionSchema } from "./partners.controller.js";

function service(
  prisma: Record<string, unknown>,
  storage: Record<string, unknown> = {
    verifyDocument: vi.fn().mockResolvedValue({ simulated: true }),
  },
  applicationOrders: Record<string, unknown> = {},
) {
  return new PartnerService(
    prisma as never,
    {} as never,
    storage as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    applicationOrders as never,
  );
}

const session = {
  id: "session-1",
  partnerId: "partner-1",
  orderId: "order-1",
  redirectUrl: "",
  expiresAt: new Date(Date.now() + 60_000),
  consumedAt: null,
};

function order(documents: Array<Record<string, unknown>>) {
  return {
    id: "order-1",
    partnerId: "partner-1",
    externalOrderId: "ext-1",
    customerId: "customer-1",
    orderNumber: "VC-2026-ABC12345",
    status: "DRAFT",
    version: 1,
    currency: "NPR",
    totalAmount: "2499",
    plan: { country: { isoCode: "AE" } },
    traveler: { id: "traveler-1" },
    documents,
  };
}

describe("partner hosted checkout", () => {
  it("accepts a valid hosted checkout session request", () => {
    expect(
      hostedCheckoutSessionSchema.safeParse({
        planId: "00000000-0000-4000-8000-000000000001",
        externalOrderId: "flow-customer-order-1",
        externalCustomerId: "customer-91",
      }).success,
    ).toBe(true);
  });

  it("rejects completion when the passport is not verified", async () => {
    const instance = service({
      partnerHostedCheckoutSession: {
        findUnique: vi.fn().mockResolvedValue(session),
      },
      order: {
        findUnique: vi.fn().mockResolvedValue(
          order([
            {
              type: "PASSPORT",
              privateAssetId: "passport-1",
              passportVerificationStatus: null,
            },
            {
              type: "TICKET",
              privateAssetId: "ticket-1",
              passportVerificationStatus: null,
            },
          ]),
        ),
      },
    });
    await expect(
      instance.completeHostedCheckout("abcdefghijklmnopqrstuvwxyz012345", {
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
      }),
    ).rejects.toMatchObject({
      response: { code: "PASSPORT_VERIFICATION_REQUIRED" },
    });
  });

  it("rejects completion when a required document is missing", async () => {
    const instance = service({
      partnerHostedCheckoutSession: {
        findUnique: vi.fn().mockResolvedValue(session),
      },
      order: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            order([
              {
                type: "PASSPORT",
                privateAssetId: "passport-1",
                passportVerificationStatus: "VERIFIED",
              },
            ]),
          ),
      },
    });
    await expect(
      instance.completeHostedCheckout("abcdefghijklmnopqrstuvwxyz012345", {
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
      }),
    ).rejects.toMatchObject({
      response: { code: "DOCUMENT_REQUIRED" },
    });
  });

  it("does not debit or complete a hosted purchase when inventory is empty", async () => {
    const transaction = vi.fn();
    const assertInventory = vi
      .fn()
      .mockRejectedValue(new Error("No eSIM inventory is currently available"));
    const instance = service(
      {
        partnerHostedCheckoutSession: {
          findUnique: vi.fn().mockResolvedValue(session),
        },
        order: {
          findUnique: vi.fn().mockResolvedValue({
            ...order([
              { type: "PASSPORT", privateAssetId: "passport-1" },
              { type: "TICKET", privateAssetId: "ticket-1" },
            ]),
            orderType: "INITIAL_PURCHASE",
            documentReviewStatus: "VERIFIED",
          }),
        },
        $transaction: transaction,
      },
      undefined,
      { assertInventoryAvailableForNewOrder: assertInventory },
    );

    await expect(
      instance.completeHostedCheckout("abcdefghijklmnopqrstuvwxyz012345", {
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
      }),
    ).rejects.toThrow("No eSIM inventory is currently available");
    expect(assertInventory).toHaveBeenCalledOnce();
    expect(transaction).not.toHaveBeenCalled();
  });
});
