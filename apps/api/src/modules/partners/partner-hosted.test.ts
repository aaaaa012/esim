import { describe, expect, it, vi } from "vitest";
import { PartnerService } from "./partner.service.js";
import { hostedCheckoutSessionSchema } from "./partners.controller.js";

function service(
  prisma: Record<string, unknown>,
  storage: Record<string, unknown> = {
    verifyDocument: vi.fn().mockResolvedValue({ simulated: true }),
  },
  applicationOrders: Record<string, unknown> = {},
  payments?: Record<string, unknown>,
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
    payments as never,
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

  it("keeps a cross-channel hosted top-up attached to the eSIM owner", async () => {
    const orderCreate = vi.fn().mockResolvedValue({ id: "topup-order" });
    const instance = service(
      {
        partner: {
          findUnique: vi.fn().mockResolvedValue({
            id: "partner-1",
            code: "DEMO",
            status: "ACTIVE",
            integrationType: "CHECKOUT_LINK",
          }),
        },
        plan: {
          findFirst: vi.fn().mockResolvedValue({
            id: "00000000-0000-4000-8000-000000000001",
            name: "Asia 1 GB",
            sellingPrice: 500,
            dataAllowance: "1 GB",
            validityDays: 7,
            country: { isoCode: "SG" },
          }),
        },
        $transaction: vi.fn((callback) =>
          callback({
            order: {
              findFirst: vi.fn().mockResolvedValue(null),
              create: orderCreate,
            },
            partnerCustomer: {
              findUnique: vi.fn().mockResolvedValue({
                id: "partner-purchaser",
                customerId: "purchaser-customer",
              }),
            },
            partnerHostedCheckoutSession: { create: vi.fn() },
          }),
        ),
      },
      undefined,
      {
        resolveSubscriber: vi.fn().mockResolvedValue({
          customerId: "beneficiary-owner",
          inventory: {
            id: "beneficiary-esim",
            msisdn: "882470015492842",
          },
        }),
        checkTopUpEligibility: vi.fn().mockResolvedValue({ allowed: true }),
      },
    );

    await expect(
      instance.createHostedCheckoutSession("partner-1", {
        planId: "00000000-0000-4000-8000-000000000001",
        externalOrderId: "cross-channel-topup-1",
        externalCustomerId: "partner-user-91",
        topUpMobile: "882470015492842",
      }),
    ).resolves.toMatchObject({ orderType: "TOPUP" });

    expect(orderCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        customerId: "beneficiary-owner",
        partnerCustomerId: "partner-purchaser",
        targetInventoryId: "beneficiary-esim",
        orderType: "TOPUP",
      }),
    });
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

  it("invalidates a previous hosted verification when evidence is replaced", async () => {
    const orderUpdate = vi.fn();
    const documentUpsert = vi.fn().mockResolvedValue({
      id: "replacement-passport",
      type: "PASSPORT",
      status: "PENDING",
    });
    const instance = service(
      {
        partnerHostedCheckoutSession: {
          findUnique: vi.fn().mockResolvedValue(session),
        },
        order: {
          findUnique: vi.fn().mockResolvedValue({
            ...order([]),
            orderType: "INITIAL_PURCHASE",
            documentReviewStatus: "VERIFIED",
            partner: { name: "Test partner", slug: "test", brand: {} },
          }),
        },
        $transaction: vi.fn((callback) =>
          callback({
            order: {
              updateMany: vi.fn().mockResolvedValue({ count: 1 }),
              update: orderUpdate,
            },
            travelerDocument: { upsert: documentUpsert },
          }),
        ),
      },
      {
        createDocumentUpload: vi.fn().mockResolvedValue({
          assetId: "replacement-asset",
          upload: { mode: "test" },
        }),
      },
    );

    await instance.addHostedDocument("abcdefghijklmnopqrstuvwxyz012345", {
      type: "PASSPORT",
      fileName: "replacement-passport.jpg",
      contentType: "image/jpeg",
    });

    expect(documentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          uploadVerified: false,
          passportVerificationStatus: null,
        }),
      }),
    );
    expect(orderUpdate).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: {
        documentReviewStatus: "NOT_STARTED",
        documentReviewStartedAt: null,
        documentCheckoutReleaseAt: null,
      },
    });
  });

  it("does not invalidate hosted passport verification when the optional visa is replaced", async () => {
    const orderUpdate = vi.fn();
    const instance = service(
      {
        partnerHostedCheckoutSession: {
          findUnique: vi.fn().mockResolvedValue(session),
        },
        order: {
          findUnique: vi.fn().mockResolvedValue({
            ...order([]),
            orderType: "INITIAL_PURCHASE",
            documentReviewStatus: "VERIFIED",
            partner: { name: "Test partner", slug: "test", brand: {} },
          }),
        },
        $transaction: vi.fn((callback) =>
          callback({
            order: {
              updateMany: vi.fn().mockResolvedValue({ count: 1 }),
              update: orderUpdate,
            },
            travelerDocument: {
              upsert: vi.fn().mockResolvedValue({
                id: "replacement-visa",
                type: "VISA",
                status: "PENDING",
              }),
            },
          }),
        ),
      },
      {
        createDocumentUpload: vi.fn().mockResolvedValue({
          assetId: "replacement-visa-asset",
          upload: { mode: "test" },
        }),
      },
    );

    await instance.addHostedDocument("abcdefghijklmnopqrstuvwxyz012345", {
      type: "VISA",
      fileName: "replacement-visa.jpg",
      contentType: "image/jpeg",
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

  it("claims a draft hosted checkout without changing partner attribution", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const auditCreate = vi.fn().mockResolvedValue({ id: "audit-1" });
    const instance = service({
      partnerHostedCheckoutSession: {
        findUnique: vi.fn().mockResolvedValue(session),
      },
      customer: {
        findFirst: vi.fn().mockResolvedValue({ id: "account-customer" }),
      },
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: "order-1",
          status: "DRAFT",
          channel: "PARTNER_HOSTED",
          customerId: "partner-customer-owner",
          customer: { userId: null },
        }),
      },
      $transaction: vi.fn((callback) =>
        callback({
          order: { updateMany },
          auditLog: { create: auditCreate },
        }),
      ),
    });
    vi.spyOn(instance, "hostedCheckout").mockResolvedValue({
      linked: true,
    } as never);

    await expect(
      instance.claimHostedCheckout(
        "abcdefghijklmnopqrstuvwxyz012345",
        "clerk-customer",
        "local-user-1",
      ),
    ).resolves.toEqual({ linked: true });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "order-1",
        customerId: "partner-customer-owner",
        status: "DRAFT",
      },
      data: { customerId: "account-customer" },
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "HOSTED_ORDER_CLAIMED",
        performedById: "local-user-1",
      }),
    });
  });

  it("refuses to claim a hosted checkout already owned by an account", async () => {
    const transaction = vi.fn();
    const instance = service({
      partnerHostedCheckoutSession: {
        findUnique: vi.fn().mockResolvedValue(session),
      },
      customer: {
        findFirst: vi.fn().mockResolvedValue({ id: "new-customer" }),
      },
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: "order-1",
          status: "DRAFT",
          channel: "PARTNER_HOSTED",
          customerId: "existing-customer",
          customer: { userId: "existing-user" },
        }),
      },
      $transaction: transaction,
    });

    await expect(
      instance.claimHostedCheckout(
        "abcdefghijklmnopqrstuvwxyz012345",
        "clerk-customer",
      ),
    ).rejects.toMatchObject({
      response: { code: "HOSTED_CHECKOUT_ALREADY_CLAIMED" },
    });
    expect(transaction).not.toHaveBeenCalled();
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

  it("blocks payment initiation until hosted review and consent are complete", async () => {
    const initiate = vi.fn();
    const instance = service(
      {
        partnerHostedCheckoutSession: {
          findUnique: vi.fn().mockResolvedValue(session),
        },
        order: {
          findUnique: vi.fn().mockResolvedValue({
            status: "DRAFT",
            channel: "PARTNER_HOSTED",
            partnerSettlementMethod: "HOSTED_PAYMENT",
          }),
        },
      },
      undefined,
      {},
      { initiate },
    );

    await expect(
      instance.hostedCheckoutInitiate(
        "abcdefghijklmnopqrstuvwxyz012345",
        "FONEPAY" as never,
      ),
    ).rejects.toMatchObject({ code: "HOSTED_CHECKOUT_NOT_COMPLETED" });
    expect(initiate).not.toHaveBeenCalled();
  });
});

describe("hosted deposit settlement", () => {
  function ledgerTx(overrides: Record<string, unknown> = {}) {
    return {
      partnerLedgerEntry: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "ledger-1" }),
      },
      partnerAccount: {
        findUnique: vi.fn().mockResolvedValue({
          id: "account-1",
          partnerId: "partner-1",
          balancePaisa: 1_000_000,
          creditLimitPaisa: 0,
          reservedPaisa: 249_900,
          version: 1,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      ...overrides,
    };
  }

  function hostedOrder(status: string) {
    return {
      id: "order-1",
      channel: "PARTNER_HOSTED",
      partnerId: "partner-1",
      externalOrderId: "ext-1",
      partnerSettlementMethod: "PARTNER_ACCOUNT",
      totalAmount: "2499",
      status,
    };
  }

  it("captures the reserved deposit when the order reaches QR_READY", async () => {
    const tx = ledgerTx();
    const instance = service({
      order: {
        findUnique: vi.fn().mockResolvedValue(hostedOrder("QR_READY")),
      },
      $transaction: vi.fn((callback) => callback(tx)),
    });

    const result = await instance.settleHostedReservation("order-1", "CAPTURE");
    expect(result.action).toBe("CAPTURED");
    const update = tx.partnerAccount.updateMany.mock.calls[0]![0];
    expect(update.where).toMatchObject({ reservedPaisa: { gte: 249_900 } });
    expect(update.data).toMatchObject({
      reservedPaisa: { decrement: 249_900 },
      balancePaisa: 750_100,
      version: { increment: 1 },
    });
    const ledger = tx.partnerLedgerEntry.create.mock.calls[0]![0].data;
    expect(ledger.type).toBe("CAPTURE");
    expect(ledger.reference).toBe("capture:order-1");
  });

  it("captures when the order is already completed", async () => {
    const tx = ledgerTx();
    const instance = service({
      order: {
        findUnique: vi.fn().mockResolvedValue(hostedOrder("COMPLETED")),
      },
      $transaction: vi.fn((callback) => callback(tx)),
    });

    const result = await instance.settleHostedReservation("order-1");
    expect(result.action).toBe("CAPTURED");
  });

  it("releases the reserved deposit on PROVISIONING_FAILED", async () => {
    const tx = ledgerTx();
    const instance = service({
      order: {
        findUnique: vi
          .fn()
          .mockResolvedValue(hostedOrder("PROVISIONING_FAILED")),
      },
      $transaction: vi.fn((callback) => callback(tx)),
    });

    const result = await instance.settleHostedReservation("order-1", "RELEASE");
    expect(result.action).toBe("RELEASED");
    const update = tx.partnerAccount.updateMany.mock.calls[0]![0];
    expect(update.data).toMatchObject({
      reservedPaisa: { decrement: 249_900 },
    });
    const ledger = tx.partnerLedgerEntry.create.mock.calls[0]![0].data;
    expect(ledger.type).toBe("RELEASE");
    expect(ledger.reference).toBe("release:order-1");
  });

  it("release is idempotent across retries", async () => {
    const existing = { id: "release-1" };
    const tx = ledgerTx({
      partnerLedgerEntry: {
        findUnique: vi.fn().mockResolvedValue(existing),
        create: vi.fn(),
      },
      partnerAccount: {
        findUnique: vi.fn(),
        updateMany: vi.fn(),
      },
    });
    const instance = service({
      order: {
        findUnique: vi
          .fn()
          .mockResolvedValue(hostedOrder("PROVISIONING_FAILED")),
      },
      $transaction: vi.fn((callback) => callback(tx)),
    });

    const result = await instance.settleHostedReservation("order-1", "RELEASE");
    expect(result).toMatchObject({
      action: "RELEASED",
      applied: false,
      reason: "ALREADY_RELEASED",
    });
    expect(tx.partnerAccount.updateMany).not.toHaveBeenCalled();
    expect(tx.partnerLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("skips non-hosted orders", async () => {
    const instance = service({
      order: {
        findUnique: vi.fn().mockResolvedValue({
          ...hostedOrder("COMPLETED"),
          channel: "CUSTOMER_WEB",
        }),
      },
    });
    const result = await instance.settleHostedReservation("order-1", "CAPTURE");
    expect(result).toMatchObject({ action: "SKIPPED" });
  });

  it("skips orders still in transit", async () => {
    const instance = service({
      order: {
        findUnique: vi.fn().mockResolvedValue(hostedOrder("PROVISIONING")),
      },
    });
    const result = await instance.settleHostedReservation("order-1", "RELEASE");
    expect(result).toMatchObject({ action: "SKIPPED" });
  });

  it("throws a balance conflict when the reservation no longer covers the amount", async () => {
    const tx = ledgerTx({
      partnerAccount: {
        findUnique: vi.fn().mockResolvedValue({
          id: "account-1",
          partnerId: "partner-1",
          balancePaisa: 10_000,
          creditLimitPaisa: 0,
          reservedPaisa: 1_000,
          version: 1,
        }),
        updateMany: vi.fn(),
      },
    });
    const instance = service({
      order: {
        findUnique: vi.fn().mockResolvedValue(hostedOrder("QR_READY")),
      },
      $transaction: vi.fn((callback) => callback(tx)),
    });

    await expect(
      instance.settleHostedReservation("order-1", "CAPTURE"),
    ).rejects.toMatchObject({
      response: { code: "PARTNER_BALANCE_CONFLICT" },
    });
    expect(tx.partnerAccount.updateMany).not.toHaveBeenCalled();
  });
});

it("queues fresh OCR for a passport-only replacement while retaining the confirmed ticket", async () => {
  const passport = {
    id: "passport",
    type: "PASSPORT",
    status: "PENDING",
    fileName: "replacement.png",
    privateAssetId: "replacement-asset-1",
    uploadVerified: false,
    passportVerificationStatus: null,
  };
  const ticket = {
    id: "ticket",
    type: "TICKET",
    status: "PENDING",
    fileName: "ticket.pdf",
    privateAssetId: "saved-ticket",
    uploadVerified: true,
  };
  const current = {
    ...order([passport, ticket]),
    plan: { country: { isoCode: "IN" } },
    documentReviewStatus: "NOT_STARTED",
    documentReviewStartedAt: null,
    traveler: {
      firstName: "Test",
      surname: "Traveller",
      dateOfBirthEncrypted: "1990-01-01",
      passportNumberEncrypted: "PA1234567",
      passportExpiryEncrypted: "2030-01-01",
    },
  };
  const add = vi.fn().mockResolvedValue({});
  const verifyDocument = vi.fn().mockResolvedValue({});
  const prisma = {
    partnerHostedCheckoutSession: {
      findUnique: vi.fn().mockResolvedValue(session),
    },
    order: {
      findUnique: vi.fn().mockResolvedValue(current),
      update: vi.fn(async ({ data }) => {
        Object.assign(current, data);
        return current;
      }),
    },
    travelerDocument: {
      findFirst: vi.fn().mockResolvedValue(passport),
      update: vi.fn(async ({ data }) => {
        Object.assign(passport, data);
        return passport;
      }),
    },
    platformConfiguration: {
      upsert: vi.fn().mockResolvedValue({ documentReviewPolicy: "AUTO_OCR" }),
    },
  };
  const instance = new PartnerService(
    prisma as never,
    { decrypt: (value: string) => value } as never,
    { verifyDocument } as never,
    {} as never,
    {} as never,
    {} as never,
    { add } as never,
    {} as never,
  );
  await instance.confirmHostedDocument(
    "abcdefghijklmnopqrstuvwxyz012345",
    passport.id,
  );
  expect(add).toHaveBeenCalledTimes(1);
  expect(add.mock.calls[0]![2]).toMatchObject({
    documentId: "passport",
    privateAssetId: "replacement-asset-1",
  });
  expect(current.documentReviewStatus).toBe("OCR_PENDING");
  expect(ticket).toMatchObject({
    privateAssetId: "saved-ticket",
    uploadVerified: true,
  });
  const firstJob = add.mock.calls[0]![3];
  passport.privateAssetId = "replacement-asset-2";
  passport.uploadVerified = false;
  current.documentReviewStatus = "NOT_STARTED";
  await instance.confirmHostedDocument(
    "abcdefghijklmnopqrstuvwxyz012345",
    passport.id,
  );
  expect(add.mock.calls[1]![3]).not.toBe(firstJob);
  expect(verifyDocument.mock.calls.map(([asset]) => asset)).toEqual([
    "replacement-asset-1",
    "replacement-asset-2",
  ]);
});
