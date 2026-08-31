import { describe, expect, it, vi } from "vitest";
import { PartnerService } from "./partner.service.js";

function service(
  prisma: Record<string, unknown>,
  applicationOrders: Record<string, unknown> = {},
  partnerWebhooks: Record<string, unknown> = {},
  storage: Record<string, unknown> = {},
) {
  return new PartnerService(
    prisma as never,
    {} as never,
    storage as never,
    {} as never,
    {} as never,
    partnerWebhooks as never,
    {} as never,
    applicationOrders as never,
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

  it("creates an uncharged REVIEW_PENDING order before document finalization", async () => {
    const tx = {
      order: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
      partnerDocumentUploadIntent: {
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      partnerDocumentVerification: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
      partnerAccount: { updateMany: vi.fn() },
      partnerLedgerEntry: { create: vi.fn() },
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
        data: expect.objectContaining({ status: "REVIEW_PENDING" }),
      }),
    );
    expect(tx.partnerAccount.updateMany).not.toHaveBeenCalled();
    expect(tx.partnerLedgerEntry.create).not.toHaveBeenCalled();
    expect(tx.outboxMessage.create).not.toHaveBeenCalled();
  });

  it("atomically debits and queues provisioning only when a pending order is finalized", async () => {
    const tx = {
      order: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      partnerAccount: {
        upsert: vi.fn().mockResolvedValue({
          id: "account-1",
          balancePaisa: 1000,
          version: 1,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      partnerLedgerEntry: { create: vi.fn() },
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
        type: "DEBIT",
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
      $transaction: vi.fn().mockResolvedValue([]),
    };
    const instance = service(prisma, {}, {}, {
      createPartnerDocumentUpload: vi.fn().mockResolvedValue({
        assetId: "replacement-asset",
        upload: { mode: "local-simulator", expiresInSeconds: 900 },
      }),
    });

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
    const instance = service(prisma, {}, {}, {
      verifyDocument: vi.fn().mockResolvedValue({ bytes: 499, format: "jpg" }),
    });

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
