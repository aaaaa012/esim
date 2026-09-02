import { describe, expect, it, vi } from "vitest";
import { ReconciliationService } from "./reconciliation.service.js";

describe("ReconciliationService provisioning-operation recovery", () => {
  it("moves a stale consumed partner OCR verification and its order to manual review", async () => {
    const verificationUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const orderUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const orderEventCreate = vi.fn().mockResolvedValue({});
    const tx = {
      partnerDocumentVerification: { updateMany: verificationUpdate },
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: "order-1",
          status: "REVIEW_PENDING",
          version: 3,
        }),
        updateMany: orderUpdate,
      },
      orderEvent: { create: orderEventCreate },
    };
    const prisma = {
      enabled: true,
      order: { findMany: vi.fn().mockResolvedValue([]) },
      partnerDocumentVerification: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: "verification-1",
              partnerId: "partner-1",
              externalOrderId: "external-1",
              consumedOrderId: "order-1",
              updatedAt: new Date("2020-01-01T00:00:00.000Z"),
              documents: [{ privateAssetId: "replacement-asset" }],
            },
          ])
          .mockResolvedValueOnce([]),
      },
      partnerWebhookEndpoint: { findMany: vi.fn().mockResolvedValue([]) },
      partnerEvent: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn((callback) => callback(tx)),
    };
    const attention = vi.fn().mockResolvedValue(undefined);
    const service = new ReconciliationService(
      prisma as never,
      {} as never,
      { add: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { attention } as never,
      {} as never,
      {} as never,
    );

    const result = await (
      service as unknown as {
        reconcileOcrAvailability(): Promise<{
          retried: number;
          manual: number;
          expired: number;
        }>;
      }
    ).reconcileOcrAvailability();

    expect(result).toEqual({ retried: 0, manual: 1, expired: 0 });
    expect(verificationUpdate).toHaveBeenCalledWith({
      where: { id: "verification-1", status: "PROCESSING" },
      data: {
        status: "MANUAL_REVIEW",
        failureCode: "OCR_UNAVAILABLE_AFTER_GRACE_PERIOD",
      },
    });
    expect(orderUpdate).toHaveBeenCalledWith({
      where: {
        id: "order-1",
        version: 3,
        documentReviewStatus: { in: ["OCR_PENDING", "OCR_BACKGROUND"] },
      },
      data: {
        documentReviewStatus: "MANUAL_REVIEW",
        version: { increment: 1 },
      },
    });
    expect(orderEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: "order-1",
          metadata: expect.objectContaining({
            failureCategory: "OCR_UNAVAILABLE_AFTER_GRACE_PERIOD",
          }),
        }),
      }),
    );
    expect(attention).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: "document-review:order-1",
        category: "DOCUMENT_MANUAL_REVIEW",
        orderId: "order-1",
      }),
    );
  });

  it("heals a QR-ready operation whose order is still provisioning", async () => {
    const operation = {
      id: "operation-1",
      orderId: "order-1",
      state: "QR_READY",
      iccid: "8988247076000000319",
      providerSubscriptionId: "sub-1",
      completedAt: new Date("2026-01-01T00:00:00Z"),
      reconcileDeadlineAt: null,
      order: {
        id: "order-1",
        providerSubscriptionId: null,
        status: "PROVISIONING",
      },
    };
    const update = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      enabled: true,
      provisioningOperation: {
        findMany: vi.fn().mockResolvedValue([operation]),
        update,
      },
    };
    const connectivity = {
      getEsimDetails: vi.fn().mockResolvedValue({
        status: "preloaded",
        qrPayload: "LPA:1$recovered",
      }),
    };
    const recoverProvisioningQrReady = vi.fn().mockResolvedValue(undefined);
    const service = new ReconciliationService(
      prisma as never,
      connectivity as never,
      {} as never,
      {} as never,
      { recoverProvisioningQrReady } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await (
      service as unknown as {
        reconcileProvisioningOperations(): Promise<void>;
      }
    ).reconcileProvisioningOperations();

    expect(recoverProvisioningQrReady).toHaveBeenCalledWith("order-1", {
      qrPayload: "LPA:1$recovered",
      providerSubscriptionId: "sub-1",
      iccid: "8988247076000000319",
      reason: "Automatic recovery from provider QR-ready state",
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "operation-1" },
        data: expect.objectContaining({ state: "QR_READY" }),
      }),
    );
  });
});
