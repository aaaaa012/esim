import { describe, expect, it, vi } from "vitest";
import { ReconciliationService } from "./reconciliation.service.js";

describe("ReconciliationService provisioning-operation recovery", () => {
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
