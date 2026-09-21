import { describe, expect, it, vi } from "vitest";
import { PartnerService } from "./partner.service.js";

function service(
  prisma: Record<string, unknown>,
  applicationOrders: Record<string, unknown> = {},
  partnerWebhooks: Record<string, unknown> = {},
  storage: Record<string, unknown> = {},
  queues: Record<string, unknown> = {},
) {
  const resolvedStorage = {
    finalizeDocument: vi.fn(async (assetId: string) => ({
      temporaryAssetId: assetId,
      finalizedAssetId: `${assetId}-finalized`,
      sha256: "a".repeat(64),
      byteSize: 500,
      contentType: "image/png",
      storageVersionId: null,
    })),
    ...storage,
  };
  return new PartnerService(
    prisma as never,
    {} as never,
    resolvedStorage as never,
    {} as never,
    {} as never,
    partnerWebhooks as never,
    queues as never,
    applicationOrders as never,
    {} as never,
  );
}

describe("partner prepaid settlement", () => {
  it("keeps verification polling read-only while OCR is processing", async () => {
    const update = vi.fn();
    const instance = service({
      partnerDocumentVerification: {
        findFirst: vi.fn().mockResolvedValue({
          id: "verification-1",
          partnerId: "partner-1",
          externalOrderId: "external-1",
          status: "PROCESSING",
          reviewPolicy: "AUTO_OCR",
          failureCode: null,
          expiresAt: new Date(Date.now() + 60_000),
          checkoutReleaseAt: new Date(Date.now() - 60_000),
          consumedAt: new Date(),
          consumedOrderId: "order-1",
          documents: [
            {
              id: "passport-1",
              type: "PASSPORT",
              uploadVerified: true,
              verificationStatus: "UPLOADED",
              verificationCode: null,
              verifiedAt: null,
            },
            {
              id: "ticket-1",
              type: "TICKET",
              uploadVerified: true,
              verificationStatus: "VERIFIED",
              verificationCode: null,
              verifiedAt: new Date(),
              contentSha256: "a".repeat(64),
              temporaryAssetId: "asset-passport-temp",
              storageVersionId: null,
              declaredSizeBytes: 500,
              contentType: "image/jpeg",
            },
          ],
        }),
        update,
      },
      order: {
        findUnique: vi.fn().mockResolvedValue({
          status: "REVIEW_PENDING",
          documentReviewPolicy: "AUTO_OCR",
          documentReviewStatus: "OCR_PENDING",
        }),
      },
    });

    await expect(
      instance.documentVerification("partner-1", "verification-1"),
    ).resolves.toMatchObject({
      status: "PROCESSING",
      fulfillmentAllowed: false,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("offers replacement only for the affected mandatory document", async () => {
    const instance = service({
      partnerDocumentVerification: {
        findFirst: vi.fn().mockResolvedValue({
          id: "verification-1",
          partnerId: "partner-1",
          externalOrderId: "external-1",
          status: "REUPLOAD_REQUIRED",
          reviewPolicy: "AUTO_OCR",
          failureCode: "PASSPORT_REUPLOAD_REQUIRED",
          expiresAt: new Date(Date.now() + 60_000),
          consumedAt: new Date(),
          consumedOrderId: "order-1",
          documents: [
            {
              id: "passport-1",
              type: "PASSPORT",
              uploadVerified: true,
              verificationStatus: "REUPLOAD_REQUIRED",
            },
            {
              id: "ticket-1",
              type: "TICKET",
              uploadVerified: true,
              verificationStatus: "VERIFIED",
            },
          ],
        }),
      },
      order: {
        findUnique: vi.fn().mockResolvedValue({
          status: "AWAITING_CUSTOMER",
          documentReviewPolicy: "AUTO_OCR",
          documentReviewStatus: "REUPLOAD_REQUIRED",
        }),
      },
    });

    const result = await instance.documentVerification(
      "partner-1",
      "verification-1",
    );

    expect(result.documents).toEqual([
      expect.objectContaining({
        type: "PASSPORT",
        replacementEligible: true,
      }),
      expect.objectContaining({
        type: "TICKET",
        replacementEligible: false,
      }),
    ]);
  });

  it("rejects malformed opaque pagination cursors", async () => {
    const instance = service({ order: { findMany: vi.fn() } });
    await expect(
      instance.listOrders("partner-1", { cursor: "not-a-composite-cursor" }),
    ).rejects.toMatchObject({ response: { code: "INVALID_CURSOR" } });
  });

  it("decodes a returned composite cursor for keyset pagination", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const instance = service({ order: { findMany } });
    const id = "00000000-0000-4000-8000-000000000001";
    const cursor = Buffer.from(`2026-08-31T12:00:00.000Z|${id}`).toString(
      "base64url",
    );
    await instance.listOrders("partner-1", { cursor });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { createdAt: { lt: new Date("2026-08-31T12:00:00.000Z") } },
            {
              createdAt: new Date("2026-08-31T12:00:00.000Z"),
              id: { lt: id },
            },
          ],
        }),
      }),
    );
  });
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

  it("records a partner API top-up purchaser separately from its beneficiary", async () => {
    const orderCreate = vi.fn();
    const tx = {
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
      customerConsent: { createMany: vi.fn() },
      partnerAccount: {
        upsert: vi.fn().mockResolvedValue({
          id: "account-1",
          balancePaisa: 10_000,
          version: 1,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      partnerLedgerEntry: { create: vi.fn() },
      partnerWebhookEndpoint: { findMany: vi.fn().mockResolvedValue([]) },
      partnerEvent: { create: vi.fn() },
      outboxMessage: { create: vi.fn() },
    };
    const applicationOrders = {
      resolveSubscriber: vi.fn().mockResolvedValue({
        customerId: "beneficiary-owner",
        inventory: {
          id: "beneficiary-esim",
          msisdn: "882470015492842",
        },
      }),
      checkTopUpEligibility: vi.fn().mockResolvedValue({ allowed: true }),
      refreshFromPersistence: vi.fn().mockResolvedValue(undefined),
      approveToProvisioning: vi.fn().mockResolvedValue(undefined),
    };
    const instance = service(
      {
        partner: {
          findUnique: vi.fn().mockResolvedValue({
            id: "partner-1",
            code: "DEMO",
            status: "ACTIVE",
          }),
        },
        plan: {
          findFirst: vi.fn().mockResolvedValue({
            id: "plan-1",
            name: "Asia 1 GB",
            sellingPrice: 50,
            dataAllowance: "1 GB",
            validityDays: 7,
            country: { isoCode: "SG" },
          }),
        },
        $transaction: vi.fn((callback) => callback(tx)),
      },
      applicationOrders,
      { enqueuePending: vi.fn().mockResolvedValue(undefined) },
    );
    vi.spyOn(instance, "order").mockResolvedValue({
      id: "topup-order",
    } as never);

    await instance.createCompleteOrder(
      "partner-1",
      {
        externalOrderId: "cross-channel-topup-1",
        externalCustomerId: "partner-user-91",
        planId: "plan-1",
        topUpMobile: "882470015492842",
        consent: {
          compatibilityAccepted: true,
          termsAccepted: true,
          privacyAccepted: true,
          acceptedAt: new Date().toISOString(),
        },
      },
      { ipAddress: "127.0.0.1", userAgent: "test" },
    );

    expect(orderCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        customerId: "beneficiary-owner",
        partnerCustomerId: "partner-purchaser",
        targetInventoryId: "beneficiary-esim",
        orderType: "TOPUP",
      }),
    });
  });

  it("does not allow a debit beyond the prepaid balance", async () => {
    const tx = {
      partnerAccount: {
        upsert: vi.fn().mockResolvedValue({
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

  it("does not reserve money already held for another order", async () => {
    const tx = {
      partnerAccount: {
        upsert: vi.fn().mockResolvedValue({
          id: "account-1",
          balancePaisa: 1000,
          reservedPaisa: 300,
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
          reserveAccount(...args: unknown[]): Promise<void>;
        }
      ).reserveAccount(tx, "partner-1", "order-2", 800, "external-2"),
    ).rejects.toMatchObject({
      status: 402,
      response: { code: "INSUFFICIENT_PARTNER_BALANCE" },
    });
    expect(tx.partnerAccount.updateMany).not.toHaveBeenCalled();
    expect(tx.partnerLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("creates one order-linked debit using a guarded balance update", async () => {
    const tx = {
      partnerAccount: {
        upsert: vi.fn().mockResolvedValue({
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

  it("creates a funded REVIEW_PENDING order with an order-linked reservation", async () => {
    const tx = {
      order: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
      partnerDocumentUploadIntent: {
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      partnerDocumentVerification: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          id: "verification-1",
          status: "VERIFIED",
          reviewPolicy: "AUTO_OCR",
          travelerSnapshot: {},
          documents: [
            {
              id: "passport-1",
              type: "PASSPORT",
              fileName: "passport.jpg",
              privateAssetId: "asset-passport",
              uploadVerified: true,
              verificationStatus: "VERIFIED",
              verificationResult: {
                method: "ocr",
                matchedFields: ["passportNumber"],
                confidence: 0.99,
              },
              verifiedAt: new Date(),
              contentSha256: "a".repeat(64),
              temporaryAssetId: "asset-passport-temp",
              storageVersionId: null,
              declaredSizeBytes: 500,
              contentType: "image/jpeg",
            },
            {
              id: "ticket-1",
              type: "TICKET",
              fileName: "ticket.jpg",
              privateAssetId: "asset-ticket",
              uploadVerified: true,
              verificationStatus: "VERIFIED",
              verificationResult: null,
              contentSha256: "b".repeat(64),
              temporaryAssetId: "asset-ticket-temp",
              storageVersionId: null,
              declaredSizeBytes: 500,
              contentType: "image/jpeg",
            },
          ],
        }),
      },
      partnerCustomer: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: "pc-1", customerId: "customer-1" }),
      },
      customerConsent: { createMany: vi.fn() },
      partnerWebhookEndpoint: { findMany: vi.fn().mockResolvedValue([]) },
      partnerEvent: { create: vi.fn() },
      outboxMessage: { create: vi.fn() },
      partnerAccount: {
        upsert: vi.fn().mockResolvedValue({
          id: "account-1",
          balancePaisa: 1000,
          reservedPaisa: 0,
          version: 1,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      partnerLedgerEntry: { create: vi.fn() },
      travelerDocument: {
        findMany: vi.fn().mockResolvedValue([
          { id: "order-passport", type: "PASSPORT", privateAssetId: "asset-passport" },
          { id: "order-ticket", type: "TICKET", privateAssetId: "asset-ticket" },
        ]),
        update: vi.fn().mockResolvedValue({}),
      },
      documentAssetVersion: {
        create: vi
          .fn()
          .mockResolvedValueOnce({ id: "version-passport" })
          .mockResolvedValueOnce({ id: "version-ticket" }),
      },
    };
    const prisma = {
      partner: {
        findUnique: vi.fn().mockResolvedValue({
          id: "partner-1",
          code: "DEMO",
          status: "ACTIVE",
        }),
      },
      plan: {
        findFirst: vi.fn().mockResolvedValue({
          id: "plan-1",
          name: "Test plan",
          sellingPrice: 2,
          dataAllowance: "1 GB",
          validityDays: 1,
          country: { isoCode: "JP" },
        }),
      },
      partnerDocumentVerification: {
        findFirst: vi.fn().mockResolvedValue({
          id: "verification-1",
          partnerId: "partner-1",
          externalOrderId: "external-1",
          status: "PROCESSING_BACKGROUND",
          reviewPolicy: "AUTO_OCR",
          expiresAt: new Date(Date.now() + 60_000),
          consumedAt: null,
          travelerSnapshot: {},
          documents: [
            {
              id: "passport-1",
              type: "PASSPORT",
              fileName: "passport.jpg",
              privateAssetId: "asset-passport",
              uploadVerified: true,
              verificationResult: null,
            },
            {
              id: "ticket-1",
              type: "TICKET",
              fileName: "ticket.jpg",
              privateAssetId: "asset-ticket",
              uploadVerified: true,
              verificationResult: null,
            },
          ],
        }),
      },
      $transaction: vi.fn((callback) => callback(tx)),
    };
    const instance = service(
      prisma,
      { refreshFromPersistence: vi.fn().mockResolvedValue(undefined) },
      { enqueuePending: vi.fn().mockResolvedValue(undefined) },
    );
    vi.spyOn(instance, "order").mockResolvedValue({ id: "order-1" } as never);

    await instance.createCompleteOrder(
      "partner-1",
      {
        externalOrderId: "external-1",
        externalCustomerId: "customer-1",
        planId: "plan-1",
        documentVerificationId: "verification-1",
        consent: {
          compatibilityAccepted: true,
          termsAccepted: true,
          privacyAccepted: true,
          acceptedAt: new Date().toISOString(),
        },
      },
      { ipAddress: "127.0.0.1", userAgent: "test" },
    );

    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "REVIEW_PENDING",
          documentReviewStatus: "VERIFIED",
        }),
      }),
    );
    expect(tx.partnerAccount.updateMany).toHaveBeenCalledWith({
      where: { id: "account-1", version: 1 },
      data: {
        reservedPaisa: { increment: 200 },
        version: { increment: 1 },
      },
    });
    expect(tx.partnerLedgerEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "RESERVATION",
        orderId: expect.any(String),
        amountPaisa: 200,
        reference: "reserve:partner-1:external-1",
      }),
    });
    expect(tx.outboxMessage.create).not.toHaveBeenCalled();
  });

  it("atomically captures reserved funds and queues provisioning when finalized", async () => {
    const tx = {
      order: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      partnerAccount: {
        findUnique: vi.fn().mockResolvedValue({
          id: "account-1",
          balancePaisa: 1000,
          reservedPaisa: 200,
          version: 1,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      partnerLedgerEntry: {
        findFirst: vi.fn().mockResolvedValue({ id: "reservation-1" }),
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
      orderEvent: { create: vi.fn() },
      partnerWebhookEndpoint: { findMany: vi.fn().mockResolvedValue([]) },
      partnerEvent: { create: vi.fn() },
      outboxMessage: { create: vi.fn() },
    };
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: "order-1",
          partnerId: "partner-1",
          externalOrderId: "external-1",
          planId: "plan-1",
          totalAmount: 2,
          version: 4,
          status: "REVIEW_PENDING",
          documentReviewPolicy: "MANUAL_REVIEW",
          documentReviewStatus: "MANUALLY_APPROVED",
          plan: { country: { isoCode: "JP" } },
          documents: [
            { type: "PASSPORT", uploadVerified: true, status: "APPROVED" },
            { type: "TICKET", uploadVerified: true, status: "APPROVED" },
          ],
        }),
      },
      plan: { findFirst: vi.fn().mockResolvedValue({ id: "plan-1" }) },
      $transaction: vi.fn((callback) => callback(tx)),
    };
    const applicationOrders = {
      assertInventoryAvailableForNewOrder: vi.fn().mockResolvedValue(undefined),
      refreshFromPersistence: vi.fn().mockResolvedValue(undefined),
      approveToProvisioning: vi.fn().mockResolvedValue(undefined),
    };
    const instance = service(prisma, applicationOrders, {
      enqueuePending: vi.fn().mockResolvedValue(undefined),
    });
    vi.spyOn(instance, "order").mockResolvedValue({ id: "order-1" } as never);

    await instance.finalizeOrder("partner-1", "order-1");

    expect(tx.partnerLedgerEntry.create).toHaveBeenCalledTimes(1);
    expect(tx.partnerLedgerEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "CAPTURE",
        orderId: "order-1",
        amountPaisa: 200,
      }),
    });
    expect(tx.outboxMessage.create).toHaveBeenCalledTimes(1);
    expect(applicationOrders.approveToProvisioning).toHaveBeenCalledWith(
      "order-1",
      "Partner finalized verified order",
    );
  });

  it("blocks finalization while OCR or manual review is unresolved", async () => {
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: "order-1",
          partnerId: "partner-1",
          status: "REVIEW_PENDING",
          documentReviewPolicy: "AUTO_OCR",
          documentReviewStatus: "OCR_BACKGROUND",
          plan: { country: { isoCode: "JP" } },
          documents: [],
        }),
      },
      $transaction: vi.fn(),
    };
    const applicationOrders = {
      assertInventoryAvailableForNewOrder: vi.fn(),
    };
    const instance = service(prisma, applicationOrders);

    await expect(
      instance.finalizeOrder("partner-1", "order-1"),
    ).rejects.toMatchObject({
      response: { code: "VERIFICATION_NOT_READY" },
    });
    expect(
      applicationOrders.assertInventoryAvailableForNewOrder,
    ).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("declares a replacement only for a requested mandatory document", async () => {
    const intentUpdate = vi.fn().mockResolvedValue({});
    const verificationUpdate = vi.fn().mockResolvedValue({});
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: "order-1",
          status: "AWAITING_CUSTOMER",
          documents: [{ type: "PASSPORT", status: "REUPLOAD_REQUIRED" }],
        }),
      },
      partnerDocumentVerification: {
        findFirst: vi.fn().mockResolvedValue({
          id: "verification-1",
          expiresAt: new Date(Date.now() + 60_000),
          documents: [
            {
              id: "passport-1",
              type: "PASSPORT",
              fileName: "old.jpg",
            },
          ],
        }),
        update: verificationUpdate,
      },
      partnerDocumentUploadIntent: { update: intentUpdate },
      orderEvent: { create: vi.fn().mockResolvedValue({}) },
      partnerWebhookEndpoint: { findMany: vi.fn().mockResolvedValue([]) },
      partnerEvent: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn((callback) =>
        callback({
          partnerDocumentUploadIntent: { update: intentUpdate },
          partnerDocumentVerification: { update: verificationUpdate },
          orderEvent: { create: vi.fn().mockResolvedValue({}) },
          partnerWebhookEndpoint: { findMany: vi.fn().mockResolvedValue([]) },
          partnerEvent: { create: vi.fn().mockResolvedValue({}) },
        }),
      ),
    };
    const instance = service(
      prisma,
      {},
      {},
      {
        createPartnerDocumentUpload: vi.fn().mockResolvedValue({
          assetId: "replacement-asset",
          upload: { mode: "local-simulator", expiresInSeconds: 900 },
        }),
      },
    );

    const result = await instance.declareDocumentReplacement(
      "partner-1",
      "order-1",
      {
        type: "PASSPORT",
        fileName: "new.jpg",
        contentType: "image/jpeg",
        sizeBytes: 500,
      },
    );

    expect(result).toMatchObject({
      verificationId: "verification-1",
      documentId: "passport-1",
      type: "PASSPORT",
    });
    expect(intentUpdate).toHaveBeenCalledWith({
      where: { id: "passport-1" },
      data: expect.objectContaining({
        privateAssetId: "replacement-asset",
        declaredSizeBytes: 500,
        uploadVerified: false,
        verificationStatus: "AWAITING_UPLOAD",
      }),
    });
    expect(verificationUpdate).toHaveBeenCalledWith({
      where: { id: "verification-1" },
      data: { status: "AWAITING_UPLOAD", failureCode: null },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("returns a confirmed passport replacement to OCR processing", async () => {
    const orderUpdate = vi.fn().mockResolvedValue({});
    const documentUpdate = vi.fn().mockResolvedValue({});
    const verificationUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const queueAdd = vi.fn().mockResolvedValue(undefined);
    const orderEventCreate = vi.fn().mockResolvedValue({});
    const partnerEventCreate = vi.fn().mockResolvedValue({});
    const prisma = {
      partnerDocumentVerification: {
        findFirst: vi.fn().mockResolvedValue({
          id: "verification-1",
          partnerId: "partner-1",
          consumedOrderId: "order-1",
          reviewPolicy: "AUTO_OCR",
          status: "AWAITING_UPLOAD",
          documents: [
            {
              id: "passport-1",
              type: "PASSPORT",
              fileName: "replacement.png",
              privateAssetId: "asset-1",
              contentType: "image/png",
              declaredSizeBytes: 500,
              uploadVerified: false,
              verificationResult: { replacement: true },
            },
            {
              id: "ticket-1",
              type: "TICKET",
              uploadVerified: true,
            },
          ],
        }),
        updateMany: verificationUpdate,
        update: vi.fn().mockResolvedValue({}),
      },
      partnerDocumentUploadIntent: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
      travelerDocument: {
        updateMany: documentUpdate,
        findFirst: vi.fn().mockResolvedValue(null),
      },
      order: { update: orderUpdate },
      orderEvent: { create: orderEventCreate },
      partnerWebhookEndpoint: { findMany: vi.fn().mockResolvedValue([]) },
      partnerEvent: { create: partnerEventCreate },
      $transaction: vi.fn((operation) =>
        typeof operation === "function"
          ? operation({
              partnerWebhookEndpoint: {
                findMany: vi.fn().mockResolvedValue([]),
              },
              partnerEvent: { create: partnerEventCreate },
            })
          : Promise.resolve(operation),
      ),
    };
    const instance = service(
      prisma,
      {},
      {},
      {
        verifyDocument: vi
          .fn()
          .mockResolvedValue({ bytes: 500, format: "png" }),
      },
      { add: queueAdd },
    );

    await expect(
      instance.confirmVerificationDocument(
        "partner-1",
        "verification-1",
        "passport-1",
      ),
    ).resolves.toMatchObject({ verificationQueued: true, remaining: 0 });
    expect(orderUpdate).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: {
        status: "REVIEW_PENDING",
        documentReviewStatus: "OCR_PENDING",
        version: { increment: 1 },
      },
    });
    expect(documentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: "order-1", type: "PASSPORT" },
        data: expect.objectContaining({ status: "PENDING" }),
      }),
    );
    expect(verificationUpdate).toHaveBeenCalledWith({
      where: { id: "verification-1", status: "AWAITING_UPLOAD" },
      data: { status: "PROCESSING" },
    });
    expect(queueAdd).toHaveBeenCalled();
    expect(queueAdd).toHaveBeenCalledWith(
      "documents",
      "verify-partner-documents",
      { verificationId: "verification-1" },
      expect.stringMatching(
        /^document-verification-verification-1-[a-f0-9]{16}$/,
      ),
      expect.any(Object),
    );
    expect(orderEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: "order-1",
          reason: "Passport replacement uploaded and confirmed",
        }),
      }),
    );
    expect(partnerEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: "order-1",
          type: "document.replacement_confirmed",
          resourceId: "passport-1",
        }),
      }),
    );
  });

  it("rejects a confirmed upload whose bytes differ from its declaration", async () => {
    const intentUpdate = vi.fn();
    const prisma = {
      partnerDocumentVerification: {
        findFirst: vi.fn().mockResolvedValue({
          id: "verification-1",
          partnerId: "partner-1",
          reviewPolicy: "AUTO_OCR",
          documents: [
            {
              id: "passport-1",
              type: "PASSPORT",
              privateAssetId: "asset-1",
              contentType: "image/jpeg",
              declaredSizeBytes: 500,
              uploadVerified: false,
            },
          ],
        }),
      },
      partnerDocumentUploadIntent: { update: intentUpdate },
    };
    const instance = service(
      prisma,
      {},
      {},
      {
        verifyDocument: vi
          .fn()
          .mockResolvedValue({ bytes: 499, format: "jpg" }),
      },
    );

    await expect(
      instance.confirmVerificationDocument(
        "partner-1",
        "verification-1",
        "passport-1",
      ),
    ).rejects.toMatchObject({
      response: { code: "UPLOAD_DECLARATION_MISMATCH" },
    });
    expect(intentUpdate).not.toHaveBeenCalled();
  });
});
