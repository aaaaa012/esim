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

  it("returns final manual approval without depending on OCR or workflow queues", async () => {
    const orderUpdate = vi.fn();
    const instance = service({
      partnerHostedCheckoutSession: {
        findUnique: vi.fn().mockResolvedValue(session),
      },
      order: {
        findUnique: vi.fn().mockResolvedValue({
          ...order([
            {
              id: "passport-1",
              type: "PASSPORT",
              status: "APPROVED",
              passportVerificationStatus: "FAILED",
            },
            { id: "ticket-1", type: "TICKET", status: "APPROVED" },
          ]),
          documentReviewStatus: "MANUALLY_APPROVED",
        }),
        update: orderUpdate,
      },
    });

    await expect(
      instance.verifyHostedPassport("abcdefghijklmnopqrstuvwxyz012345"),
    ).resolves.toMatchObject({
      status: "MANUALLY_APPROVED",
      method: "manual",
    });
    expect(orderUpdate).not.toHaveBeenCalled();
  });

  it("does not start hosted OCR until every required upload is confirmed", async () => {
    const orderUpdate = vi.fn();
    const instance = service({
      partnerHostedCheckoutSession: {
        findUnique: vi.fn().mockResolvedValue(session),
      },
      order: {
        findUnique: vi.fn().mockResolvedValue({
          ...order([
            {
              id: "passport-1",
              type: "PASSPORT",
              status: "PENDING",
              uploadVerified: true,
            },
          ]),
          documentReviewStatus: "NOT_STARTED",
        }),
        update: orderUpdate,
      },
    });

    await expect(
      instance.verifyHostedPassport("abcdefghijklmnopqrstuvwxyz012345"),
    ).rejects.toMatchObject({
      response: { code: "DOCUMENT_UPLOADS_INCOMPLETE" },
    });
    expect(orderUpdate).not.toHaveBeenCalled();
  });

  it("repairs a legacy hosted order when every required document is approved", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const instance = service({
      partnerHostedCheckoutSession: {
        findUnique: vi.fn().mockResolvedValue(session),
      },
      order: {
        findUnique: vi.fn().mockResolvedValue({
          ...order([
            {
              id: "passport-1",
              type: "PASSPORT",
              status: "APPROVED",
              fileName: "passport.jpg",
              passportVerificationStatus: null,
            },
            {
              id: "ticket-1",
              type: "TICKET",
              status: "APPROVED",
              fileName: "ticket.jpg",
              passportVerificationStatus: null,
            },
          ]),
          orderType: "INITIAL_PURCHASE",
          documentReviewStatus: "MANUAL_REVIEW",
          partner: { name: "Test partner", slug: "test", brand: {} },
          plan: {
            id: "plan-1",
            name: "India 500MB",
            dataAllowance: "500 MB",
            validityDays: 1,
            country: { name: "India", isoCode: "IN" },
          },
        }),
        updateMany,
      },
    });

    await expect(
      instance.hostedCheckout("abcdefghijklmnopqrstuvwxyz012345"),
    ).resolves.toMatchObject({
      order: { documentReviewStatus: "MANUALLY_APPROVED" },
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          documentReviewStatus: "MANUALLY_APPROVED",
        }),
      }),
    );
  });

  it("enriches the same partner customer and keeps the hosted order attached", async () => {
    const customerUpdate = vi.fn().mockResolvedValue({ id: "customer-1" });
    const travelerUpsert = vi.fn().mockResolvedValue({ id: "traveler-1" });
    const instance = service({
      partnerHostedCheckoutSession: {
        findUnique: vi.fn().mockResolvedValue(session),
      },
      order: {
        findUnique: vi.fn().mockResolvedValue({
          ...order([]),
          partnerCustomerId: "partner-customer-1",
          orderType: "INITIAL_PURCHASE",
          partner: { name: "Test partner", slug: "test", brand: {} },
        }),
      },
      $transaction: vi.fn((callback) =>
        callback({
          order: {
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          traveler: { upsert: travelerUpsert },
          customer: {
            findUnique: vi.fn().mockResolvedValue(null),
            update: customerUpdate,
          },
          partnerCustomer: {
            findFirst: vi.fn().mockResolvedValue({ id: "partner-customer-1" }),
          },
        }),
      ),
    });
    (instance as unknown as { crypto: Record<string, unknown> }).crypto = {
      encrypt: vi.fn((value: string) => `encrypted:${value}`),
      blindIndex: vi.fn((value: string) => `hash:${value}`),
    };
    vi.spyOn(instance, "hostedCheckout").mockResolvedValue({
      ok: true,
    } as never);

    await instance.setHostedTraveler("abcdefghijklmnopqrstuvwxyz012345", {
      title: "MR",
      firstName: "Samir",
      surname: "Majhi",
      dateOfBirth: "1995-01-01",
      nationality: "NP",
      city: "Kathmandu",
      countryOfResidence: "NP",
      email: "Customer@Example.com",
      mobile: "+9779800000000",
      passportNumber: "PA1234567",
      passportExpiryDate: "2030-01-01",
    });

    expect(travelerUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: "order-1" } }),
    );
    expect(customerUpdate).toHaveBeenCalledWith({
      where: { id: "customer-1" },
      data: {
        email: "customer@example.com",
        phone: "+9779800000000",
      },
    });
  });

  it("rejects completion when a required document is missing", async () => {
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
