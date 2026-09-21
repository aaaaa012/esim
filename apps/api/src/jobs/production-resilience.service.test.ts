import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionResilienceService } from "./production-resilience.service.js";

describe("worker operational health", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("stores independent instance heartbeats with the running build", async () => {
    vi.stubEnv("INSTANCE_ID", "instance-a");
    vi.stubEnv("DEPLOY_SHA", "commit-a");
    const upsert = vi.fn().mockResolvedValue({});
    const service = new ProductionResilienceService(
      { enabled: true, workerHeartbeat: { upsert } } as never,
      {} as never,
    );
    await service.heartbeat("ocr-worker", { queue: "documents" });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          worker_instanceId: { worker: "ocr-worker", instanceId: "instance-a" },
        },
        create: expect.objectContaining({ buildVersion: "commit-a" }),
      }),
    );
  });

  it("degrades when a required worker is stale or from another build", async () => {
    vi.stubEnv("DEPLOY_SHA", "commit-current");
    const fresh = new Date();
    const prisma = {
      workerHeartbeat: {
        findMany: vi.fn().mockResolvedValue([
          {
            worker: "workflow-worker",
            instanceId: "a",
            buildVersion: "commit-current",
            lastSeenAt: fresh,
          },
          {
            worker: "ocr-worker",
            instanceId: "b",
            buildVersion: "commit-old",
            lastSeenAt: fresh,
          },
          {
            worker: "reconciliation",
            instanceId: "c",
            buildVersion: "commit-current",
            lastSeenAt: fresh,
          },
        ]),
      },
      attentionCase: { count: vi.fn().mockResolvedValue(0) },
      outboxMessage: {
        count: vi.fn().mockResolvedValue(0),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      webhookEvent: { count: vi.fn().mockResolvedValue(0) },
      payment: { findFirst: vi.fn().mockResolvedValue(null) },
      order: { groupBy: vi.fn().mockResolvedValue([]) },
      esimInventory: { count: vi.fn().mockResolvedValue(0) },
      paymentDispute: { count: vi.fn().mockResolvedValue(0) },
      partnerApiAudit: { count: vi.fn().mockResolvedValue(0) },
    };
    const service = new ProductionResilienceService(
      prisma as never,
      {
        stats: vi.fn().mockResolvedValue({}),
      } as never,
    );
    const health = await service.platformHealth();
    expect(health.status).toBe("degraded");
    expect(health.missingWorkers).toContain("ocr-worker");
  });
});
