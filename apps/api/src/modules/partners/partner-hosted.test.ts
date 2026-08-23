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
  it("resumes the existing active document session for the same external order", async () => {
    const existing = {
      id: "verification-1",
      externalOrderId: "ext-1",
      status: "AWAITING_UPLOAD",
      expiresAt: new Date(Date.now() + 60_000),
      checkoutReleaseAt: new Date(Date.now() + 10_000),
      consumedAt: null,
      documents: [
        {
          id: "document-1",
          type: "PASSPORT",
          fileName: "passport.pdf",
          expiresAt: new Date(Date.now() + 60_000),
        },
      ],
    };
    const create = vi.fn();
    const instance = service(
      {
        partner: {
          findUnique: vi
            .fn()
            .mockResolvedValue({ id: "partner-1", status: "ACTIVE" }),
        },
        platformConfiguration: {
          upsert: vi.fn().mockResolvedValue({
            ocrCheckoutWaitMs: 10_000,
            documentReviewPolicy: "AUTO_OCR",
          }),
        },
        $transaction: vi.fn((callback) =>
          callback({
            partnerDocumentVerification: {
              findUnique: vi.fn().mockResolvedValue(existing),
              create,
              update: vi.fn(),
            },
          }),
        ),
      },
      {
        verifyDocument: vi.fn(),
        createPartnerDocumentUpload: vi.fn().mockReturnValue({
          assetId: "asset-1",
          upload: { mode: "local-simulator" },
        }),
      },
    );

    const result = await instance.createUploadSessions("partner-1", {
      externalOrderId: "ext-1",
      traveler: {
        title: "MR",
        firstName: "Samir",
        surname: "Majhi",
        dateOfBirth: "1995-01-01",
        nationality: "NP",
        city: "Kathmandu",
        countryOfResidence: "NP",
        email: "customer@example.com",
        mobile: "+9779800000000",
        passportNumber: "PA1234567",
        passportExpiryDate: "2030-01-01",
      },
      documents: [
        {
          type: "PASSPORT",
          fileName: "passport.pdf",
          contentType: "application/pdf",
          sizeBytes: 100,
        },
      ],
    });

    expect(result).toMatchObject({
      verificationId: "verification-1",
      externalOrderId: "ext-1",
      resumed: true,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("accepts a valid hosted checkout session request", () => {
    expect(
      hostedCheckoutSessionSchema.safeParse({
        planId: "00000000-0000-4000-8000-000000000001",
        externalOrderId: "flow-customer-order-1",
        externalCustomerId: "customer-91",
      }).success,
    ).toBe(true);
  });

  it("only accepts an explicit initial-purchase fallback consent", () => {
    const base = {
      planId: "00000000-0000-4000-8000-000000000001",
      externalOrderId: "flow-customer-order-2",
      externalCustomerId: "customer-92",
      topUpMobile: "+9779800000000",
    };
    expect(
      hostedCheckoutSessionSchema.safeParse({
        ...base,
        allowInitialPurchaseFallback: true,
      }).success,
    ).toBe(true);
    expect(
      hostedCheckoutSessionSchema.safeParse({
        ...base,
        allowInitialPurchaseFallback: false,
      }).success,
    ).toBe(false);
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
