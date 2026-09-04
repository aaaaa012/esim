import { describe, expect, it, vi } from "vitest";
import { InventoryService } from "./inventory.service.js";
import type { PrismaService } from "../../infrastructure/prisma.service.js";
import type { CryptoService } from "../../infrastructure/crypto.service.js";
import type { ConnectivityService } from "../integration/connectivity.service.js";
import { ApiException } from "../../common/api-error.js";
import { ApiErrorCode } from "@visa-compass/shared";

function prismaStub() {
  return {
    enabled: true,
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        inventoryBatch: {
          create: vi.fn().mockResolvedValue({ id: "batch-1" }),
        },
        esimInventory: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      };
      return callback(tx);
    }),
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: "local-user-1", clerkId: "user_clerk" }),
    },
    esimInventory: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    inventoryBatch: {
      create: vi.fn().mockResolvedValue({ id: "batch-1" }),
    },
  } as unknown as PrismaService;
}

function cryptoStub() {
  return {
    encrypt: (value: string) => `enc:${value}`,
  } as unknown as CryptoService;
}

function connectivityStub() {
  return {} as unknown as ConnectivityService;
}

describe("InventoryService.assign", () => {
  it("upserts the same customer eSIM and provider subscription on recovery retries", async () => {
    const customerEsimUpsert = vi
      .fn()
      .mockResolvedValue({ id: "customer-esim-1" });
    const subscriptionUpsert = vi.fn().mockResolvedValue({ id: "sub-row-1" });
    const tx = {
      esimInventory: { update: vi.fn().mockResolvedValue(undefined) },
      customerEsim: { upsert: customerEsimUpsert },
      subscription: { upsert: subscriptionUpsert },
    };
    const prisma = {
      enabled: true,
      esimInventory: {
        findUnique: vi.fn().mockResolvedValue({ id: "inventory-1" }),
      },
      $transaction: vi.fn(
        async (callback: (client: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    } as unknown as PrismaService;
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
    );
    const providerInfo = {
      provider: "TRANSATEL",
      providerSubscriptionId: "provider-sub-1",
    };

    await inventory.assign(
      "order-1",
      "customer-1",
      "LPA:1$recovered",
      providerInfo,
    );
    await inventory.assign(
      "order-1",
      "customer-1",
      "LPA:1$recovered",
      providerInfo,
    );

    expect(customerEsimUpsert).toHaveBeenCalledTimes(2);
    expect(customerEsimUpsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { orderId: "order-1" } }),
    );
    expect(subscriptionUpsert).toHaveBeenCalledTimes(2);
    expect(subscriptionUpsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { providerSubscriptionId: "provider-sub-1" },
      }),
    );
  });
});

describe("InventoryService.applyLifecycle", () => {
  it("does not regress an existing subscription to PENDING for an old PRELOADED event", async () => {
    const subscriptionUpsert = vi.fn().mockResolvedValue({ id: "sub-row-1" });
    const tx = {
      esimInventory: { update: vi.fn().mockResolvedValue(undefined) },
      customerEsim: {
        findUnique: vi.fn().mockResolvedValue({ id: "customer-esim-1" }),
      },
      subscription: { upsert: subscriptionUpsert },
    };
    const prisma = {
      enabled: true,
      esimInventory: {
        findUnique: vi.fn().mockResolvedValue({
          id: "inventory-1",
          iccid: "8988247076000000319",
          providerSubscriptionId: "sub-1",
          status: "ACTIVATED",
        }),
      },
      $transaction: vi.fn(
        async (callback: (client: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    } as unknown as PrismaService;
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
    );

    await inventory.applyLifecycle("order-1", {
      provider: "TRANSATEL",
      status: "PRELOADED",
      subscriptionId: "sub-1",
      iccid: "8988247076000000319",
    });

    expect(subscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.not.objectContaining({ status: expect.anything() }),
        create: expect.objectContaining({ status: "PENDING" }),
      }),
    );
  });

  it("preserves an active subscription when a recurring product is canceled", async () => {
    const subscriptionUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const subscriptionUpsert = vi.fn();
    const tx = {
      esimInventory: { update: vi.fn().mockResolvedValue(undefined) },
      customerEsim: {
        findUnique: vi.fn().mockResolvedValue({ id: "customer-esim-1" }),
      },
      subscription: {
        updateMany: subscriptionUpdateMany,
        upsert: subscriptionUpsert,
      },
    };
    const prisma = {
      enabled: true,
      esimInventory: {
        findUnique: vi.fn().mockImplementation(({ where }) =>
          Promise.resolve(
            where.assignedOrderId
              ? {
                  id: "inventory-1",
                  iccid: "8988247076000000319",
                  msisdn: "33612345678",
                }
              : {
                  id: "inventory-1",
                  iccid: "8988247076000000319",
                  providerSubscriptionId: "sub-1",
                  status: "ACTIVATED",
                },
          ),
        ),
      },
      customerEsim: { findUnique: vi.fn() },
      $transaction: vi.fn(
        async (callback: (client: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    } as unknown as PrismaService;
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
    );

    await inventory.applyLifecycle("order-1", {
      provider: "TRANSATEL",
      status: "CANCELED",
      subscriptionId: "sub-1",
      iccid: "8988247076000000319",
      expiresAt: "2026-09-19T00:00:00Z",
    });

    expect(subscriptionUpdateMany).toHaveBeenCalledWith({
      where: { providerSubscriptionId: "sub-1" },
      data: {
        providerLastSeenAt: expect.any(Date),
        expiresAt: new Date("2026-09-19T00:00:00Z"),
      },
    });
    expect(subscriptionUpsert).not.toHaveBeenCalled();
  });
});

describe("InventoryService.importBatchCsv", () => {
  it("rejects a row without an MSISDN", async () => {
    const prisma = prismaStub();
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
    );
    const content = ["iccid,msisdn", "899770100000000001,"].join("\n");
    const result = await inventory.importBatchCsv(content);
    expect(result).toMatchObject({ imported: 0, skipped: 1 });
    expect(result.errors?.[0]).toContain("MSISDN is required");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects an invalid MSISDN and does not import that row", async () => {
    const prisma = prismaStub();
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
    );
    const content = ["iccid,msisdn", "899770100000000001,not-a-number"].join(
      "\n",
    );
    const result = await inventory.importBatchCsv(content);
    expect(result).toMatchObject({ imported: 0, skipped: 1 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("accepts a valid MSISDN row", async () => {
    const prisma = prismaStub();
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
    );
    const content = ["iccid,msisdn", "899770100000000001,882470001850263"].join(
      "\n",
    );
    const result = await inventory.importBatchCsv(content);
    expect(result).toMatchObject({ imported: 1, skipped: 0 });
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it("stores the resolved local user id in submittedById (not the Clerk id)", async () => {
    const txBatchCreate = vi.fn().mockResolvedValue({ id: "batch-1" });
    const prisma = prismaStub();
    (prisma as unknown as { $transaction: unknown }).$transaction = vi.fn(
      async (callback: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          inventoryBatch: { create: txBatchCreate },
          esimInventory: {
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        };
        return callback(tx);
      },
    );
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
    );
    const content = ["iccid,msisdn", "899770100000000001,882470001850263"].join(
      "\n",
    );
    await inventory.importBatchCsv(content, "ops", "file.csv", "user_clerk");
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { clerkId: "user_clerk" },
    });
    const call = txBatchCreate.mock.calls[0];
    expect(call?.[0]).toBeDefined();
    const { submittedById } = (call?.[0]?.data ?? {}) as {
      submittedById?: string;
    };
    expect(submittedById).toBe("local-user-1");
  });
});

describe("InventoryService.release", () => {
  function releasePrisma(profile: { providerSubscriptionId: string | null }) {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    return {
      enabled: true,
      esimInventory: {
        findUnique: vi.fn().mockResolvedValue({ id: "inv-1", ...profile }),
        updateMany,
      },
    } as unknown as PrismaService;
  }

  it("returns a provider-unbound reservation to pending provider check", async () => {
    const prisma = releasePrisma({ providerSubscriptionId: null });
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
    );
    await inventory.release("order-1");
    expect(prisma.esimInventory.findUnique).toHaveBeenCalledWith({
      where: { assignedOrderId: "order-1" },
    });
    expect(prisma.esimInventory.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "inv-1",
          assignedOrderId: "order-1",
          providerSubscriptionId: null,
        },
        data: expect.objectContaining({
          status: "PENDING_PROVIDER_CHECK",
          assignedOrderId: null,
          lastProviderCheckedAt: null,
        }),
      }),
    );
  });

  it("does not release a profile that the provider has bound a subscription to", async () => {
    const prisma = releasePrisma({ providerSubscriptionId: "sub-9" });
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
    );
    await inventory.release("order-1");
    expect(prisma.esimInventory.updateMany).not.toHaveBeenCalled();
  });

  it("is a no-op when no profile is reserved for the order", async () => {
    const prisma = {
      enabled: true,
      esimInventory: {
        findUnique: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn(),
      },
    } as unknown as PrismaService;
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
    );
    await inventory.release("order-1");
    expect(prisma.esimInventory.updateMany).not.toHaveBeenCalled();
  });
});

describe("InventoryService bulk reconciliation selection", () => {
  it("includes locally available profiles with unsafe or missing provider state regardless of freshness", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = {
      enabled: true,
      esimInventory: { findMany },
    } as unknown as PrismaService;
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
    );

    await expect(
      inventory.startProviderReconciliation({
        trigger: "OPS_MANUAL",
        selection: "STALE_OR_UNVERIFIED",
      }),
    ).resolves.toMatchObject({ run: null });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            {
              status: "AVAILABLE",
              OR: [
                { providerStatus: null },
                {
                  providerStatus: {
                    notIn: expect.arrayContaining([
                      "available",
                      "allocated",
                      "released",
                      "AVAILABLE",
                      "ALLOCATED",
                      "RELEASED",
                    ]),
                  },
                },
              ],
            },
          ]),
        }),
      }),
    );
  });
});

describe("InventoryService.replacePermanentlyRejectedProfile", () => {
  it("quarantines the rejected profile and advances provider idempotency atomically", async () => {
    const inventoryUpdate = vi.fn().mockResolvedValue({});
    const inventoryUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const operationUpdate = vi.fn().mockResolvedValue({});
    const orderUpdate = vi.fn().mockResolvedValue({});
    const tx = {
      esimInventory: {
        findUnique: vi.fn().mockResolvedValue({
          id: "old-inventory",
          iccid: "8988247000000000001",
          providerSubscriptionId: null,
        }),
        findFirst: vi.fn().mockResolvedValue({
          id: "new-inventory",
          iccid: "8988247000000000002",
          eid: "new-eid",
        }),
        update: inventoryUpdate,
        updateMany: inventoryUpdateMany,
      },
      provisioningOperation: {
        findUnique: vi.fn().mockResolvedValue({ profileSwapCount: 0 }),
        update: operationUpdate,
      },
      order: { update: orderUpdate },
    };
    const prisma = {
      enabled: true,
      $transaction: vi.fn(async (work: (client: typeof tx) => unknown) =>
        work(tx),
      ),
    } as unknown as PrismaService;
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
    );

    await expect(
      inventory.replacePermanentlyRejectedProfile(
        "order-1",
        "Permanent provider rejection",
      ),
    ).resolves.toMatchObject({
      previousIccid: "8988247000000000001",
      generation: 1,
      replacement: { iccid: "8988247000000000002" },
    });
    expect(inventoryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "old-inventory" },
        data: expect.objectContaining({
          status: "QUARANTINED",
          assignedOrderId: null,
        }),
      }),
    );
    expect(operationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          profileSwapCount: 1,
          idempotencyKey: "transatel:preload:order-1:profile-1",
          iccid: "8988247000000000002",
        }),
      }),
    );
    expect(orderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerStatus: null,
          providerSubscriptionId: null,
        }),
      }),
    );
  });

  it("never replaces a profile with provider subscription evidence", async () => {
    const tx = {
      esimInventory: {
        findUnique: vi.fn().mockResolvedValue({
          id: "old-inventory",
          providerSubscriptionId: "provider-subscription",
        }),
      },
    };
    const prisma = {
      enabled: true,
      $transaction: vi.fn(async (work: (client: typeof tx) => unknown) =>
        work(tx),
      ),
    } as unknown as PrismaService;
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
    );

    await expect(
      inventory.replacePermanentlyRejectedProfile("order-1", "rejected"),
    ).rejects.toThrow("provider-bound");
  });
});

describe("InventoryService.assertAvailableForNewOrder", () => {
  it("rejects order admission when no fresh, approved provider stock exists", async () => {
    const count = vi.fn().mockResolvedValue(0);
    const prisma = {
      enabled: true,
      esimInventory: { count, findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
    );

    await expect(inventory.assertAvailableForNewOrder()).rejects.toThrow(
      "No eSIM inventory is currently available",
    );
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "AVAILABLE",
          assignedOrderId: null,
          providerSubscriptionId: null,
          batch: { status: "APPROVED" },
        }),
      }),
    );
  });

  it("allows order admission when at least one eligible profile exists", async () => {
    const prisma = {
      enabled: true,
      esimInventory: { count: vi.fn().mockResolvedValue(1) },
    } as unknown as PrismaService;
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
    );

    await expect(
      inventory.assertAvailableForNewOrder(),
    ).resolves.toBeUndefined();
  });

  it("refreshes stale safe stock on demand before rejecting checkout", async () => {
    const count = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const findFirst = vi.fn().mockResolvedValueOnce({ id: "stale-inv-1" });
    const prisma = {
      enabled: true,
      esimInventory: { count, findFirst },
    } as unknown as PrismaService;
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
    );
    const reconcile = vi
      .spyOn(inventory, "reconcileProviderProfile")
      .mockResolvedValue({
        id: "stale-inv-1",
        iccid: "8988247076000000319",
        localStatus: "AVAILABLE",
        providerStatus: "released",
        inSync: true,
        checkedAt: new Date().toISOString(),
      });

    await expect(
      inventory.assertAvailableForNewOrder(),
    ).resolves.toBeUndefined();
    expect(reconcile).toHaveBeenCalledWith("stale-inv-1");
    expect(count).toHaveBeenCalledTimes(2);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "AVAILABLE",
          assignedOrderId: null,
          providerSubscriptionId: null,
          providerStatus: {
            in: expect.arrayContaining(["released", "RELEASED"]),
          },
        }),
      }),
    );
  });

  it("fails closed when stale stock cannot be freshly verified", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({ id: "stale-inv-1" })
      .mockResolvedValueOnce(null);
    const prisma = {
      enabled: true,
      esimInventory: {
        count: vi.fn().mockResolvedValue(0),
        findFirst,
      },
    } as unknown as PrismaService;
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
    );
    vi.spyOn(inventory, "reconcileProviderProfile").mockRejectedValue(
      new Error("provider unavailable"),
    );

    await expect(inventory.assertAvailableForNewOrder()).rejects.toThrow(
      "No eSIM inventory is currently available",
    );
  });
});

describe("InventoryService.reconcileProviderProfile", () => {
  function reconciliationPrisma() {
    const update = vi.fn().mockImplementation(({ data }) =>
      Promise.resolve({
        id: "inv-1",
        iccid: "8988247076000000319",
        status: data.status ?? "AVAILABLE",
        lastProviderCheckedAt: data.lastProviderCheckedAt,
      }),
    );
    return {
      enabled: true,
      esimInventory: {
        findUnique: vi.fn().mockResolvedValue({
          id: "inv-1",
          iccid: "8988247076000000319",
          status: "AVAILABLE",
          assignedOrderId: null,
          batch: { status: "APPROVED" },
        }),
        update,
      },
    } as unknown as PrismaService;
  }

  it("keeps an unassigned profile available when Transatel reports a safe stock state", async () => {
    const prisma = reconciliationPrisma();
    const connectivity = {
      getEsimDetails: vi.fn().mockResolvedValue({
        subscriptionId: "8988247076000000319",
        status: "available",
      }),
    } as unknown as ConnectivityService;
    const inventory = new InventoryService(prisma, cryptoStub(), connectivity);
    const result = await inventory.reconcileProviderProfile("inv-1");
    expect(result).toMatchObject({
      localStatus: "AVAILABLE",
      providerStatus: "available",
      inSync: true,
    });
    expect(prisma.esimInventory.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ status: "QUARANTINED" }),
      }),
    );
  });

  it("keeps unassigned stock sellable when Transatel reports released", async () => {
    const prisma = reconciliationPrisma();
    const connectivity = {
      getEsimDetails: vi.fn().mockResolvedValue({
        subscriptionId: "8988247076000000319",
        status: "released",
      }),
    } as unknown as ConnectivityService;
    const inventory = new InventoryService(prisma, cryptoStub(), connectivity);
    const result = await inventory.reconcileProviderProfile("inv-1");
    expect(result).toMatchObject({
      localStatus: "AVAILABLE",
      providerStatus: "released",
      inSync: true,
    });
    expect(prisma.esimInventory.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ status: "QUARANTINED" }),
      }),
    );
  });

  it("quarantines unassigned inventory that Transatel reports as already downloaded", async () => {
    const prisma = reconciliationPrisma();
    const connectivity = {
      getEsimDetails: vi.fn().mockResolvedValue({
        subscriptionId: "8988247076000000319",
        status: "downloaded",
      }),
    } as unknown as ConnectivityService;
    const inventory = new InventoryService(prisma, cryptoStub(), connectivity);
    const result = await inventory.reconcileProviderProfile("inv-1");
    expect(result).toMatchObject({
      localStatus: "QUARANTINED",
      providerStatus: "downloaded",
      inSync: false,
    });
    expect(prisma.esimInventory.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "QUARANTINED" }),
      }),
    );
  });

  it("records a provider not-found result without presenting it as a usage error", async () => {
    const prisma = reconciliationPrisma();
    const connectivity = {
      getEsimDetails: vi.fn().mockRejectedValue(
        new ApiException({
          code: ApiErrorCode.ESIM_NOT_FOUND,
          message: "This ICCID was not found in the Transatel inventory.",
          status: 404,
        }),
      ),
    } as unknown as ConnectivityService;
    const inventory = new InventoryService(prisma, cryptoStub(), connectivity);

    await expect(inventory.reconcileProviderProfile("inv-1")).rejects.toThrow(
      "ICCID was not found",
    );
    expect(prisma.esimInventory.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "QUARANTINED",
          providerStatus: "not_found",
          providerCheckError:
            "This ICCID was not found in the Transatel inventory.",
        }),
      }),
    );
  });
});

describe("InventoryService.restoreQuarantinedProfile", () => {
  function restorePrisma(providerStatus = "released") {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const auditCreate = vi.fn().mockResolvedValue({});
    const prisma = {
      enabled: true,
      user: { findUnique: vi.fn().mockResolvedValue({ id: "local-user-1" }) },
      esimInventory: {
        findUnique: vi.fn().mockResolvedValue({
          id: "inv-1",
          iccid: "8988247076000000319",
          status: "QUARANTINED",
          assignedOrderId: null,
          providerSubscriptionId: null,
          providerStatus,
          batch: {
            id: "batch-1",
            status: "APPROVED",
            batchReference: "MANUAL-1",
          },
        }),
      },
      $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          esimInventory: { updateMany },
          auditLog: { create: auditCreate },
        }),
      ),
    } as unknown as PrismaService;
    return { prisma, updateMany, auditCreate };
  }

  it("restores freshly verified safe stock and records an audit event", async () => {
    const { prisma, updateMany, auditCreate } = restorePrisma();
    const connectivity = {
      getEsimDetails: vi.fn().mockResolvedValue({ status: "available" }),
    } as unknown as ConnectivityService;
    const inventory = new InventoryService(prisma, cryptoStub(), connectivity);

    await expect(
      inventory.restoreQuarantinedProfile("inv-1", "user_clerk"),
    ).resolves.toMatchObject({
      localStatus: "AVAILABLE",
      providerStatus: "available",
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "AVAILABLE",
          providerStatus: "available",
        }),
      }),
    );
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "QUARANTINE_RESTORED",
          performedById: "local-user-1",
        }),
      }),
    );
  });

  it("refuses restoration while the provider still reports an unsafe state", async () => {
    const { prisma, updateMany, auditCreate } = restorePrisma();
    const connectivity = {
      getEsimDetails: vi.fn().mockResolvedValue({ status: "downloaded" }),
    } as unknown as ConnectivityService;
    const inventory = new InventoryService(prisma, cryptoStub(), connectivity);

    await expect(
      inventory.restoreQuarantinedProfile("inv-1", "user_clerk"),
    ).rejects.toThrow("only sellable stock");
    expect(updateMany).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("restores released stock because reseller profiles ship ready to download", async () => {
    const { prisma, updateMany } = restorePrisma();
    const connectivity = {
      getEsimDetails: vi.fn().mockResolvedValue({ status: "released" }),
    } as unknown as ConnectivityService;
    const inventory = new InventoryService(prisma, cryptoStub(), connectivity);

    await expect(
      inventory.restoreQuarantinedProfile("inv-1", "user_clerk"),
    ).resolves.toMatchObject({
      localStatus: "AVAILABLE",
      providerStatus: "released",
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "AVAILABLE" }),
      }),
    );
  });
});

describe("InventoryService.profiles search", () => {
  it("applies one server-side query to identifiers, assignments, batches, and customers", async () => {
    const count = vi.fn().mockResolvedValue(0);
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = {
      enabled: true,
      esimInventory: { count, findMany },
    } as unknown as PrismaService;
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
    );

    await inventory.profiles({
      q: "VC-2026-TEST",
      status: "ASSIGNED" as never,
      limit: 50,
      offset: 0,
    });

    const where = count.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({ status: "ASSIGNED" });
    expect(where.OR).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ iccid: expect.any(Object) }),
        expect.objectContaining({ batch: expect.any(Object) }),
        expect.objectContaining({ assignedOrder: expect.any(Object) }),
      ]),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where, take: 50, skip: 0 }),
    );
  });
});

describe("InventoryService.reserve provider safety", () => {
  it("requires an approved batch and a fresh safe provider state", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = {
      enabled: true,
      esimInventory: { findUnique: vi.fn().mockResolvedValue(null), findFirst },
    } as unknown as PrismaService;
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
    );

    await expect(inventory.reserve("order-1")).rejects.toThrow(
      "No eSIM inventory",
    );

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "AVAILABLE",
          assignedOrderId: null,
          providerSubscriptionId: null,
          providerStatus: {
            in: expect.arrayContaining(["available", "allocated"]),
          },
          lastProviderCheckedAt: { gte: expect.any(Date) },
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
          batch: { status: "APPROVED" },
        }),
      }),
    );
  });

  it("allows only one concurrent order to claim the last eligible profile", async () => {
    let claimed = false;
    const candidate = {
      id: "inv-last",
      iccid: "8988247000000000999",
      eid: "eid-last",
      status: "AVAILABLE",
      assignedOrderId: null,
    };
    const prisma = {
      enabled: true,
      esimInventory: {
        findUnique: vi.fn(async () => null),
        findFirst: vi.fn(async () => (claimed ? null : candidate)),
        updateMany: vi.fn(async () => {
          if (claimed) return { count: 0 };
          claimed = true;
          return { count: 1 };
        }),
      },
    } as unknown as PrismaService;
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
    );

    const results = await Promise.allSettled([
      inventory.reserve("order-a"),
      inventory.reserve("order-b"),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  it("rechecks stale safe stock before reserving it", async () => {
    const candidate = {
      id: "stale-inv-1",
      iccid: "8988247000000000999",
      eid: "eid-stale",
      status: "AVAILABLE",
      assignedOrderId: null,
      providerStatus: "released",
    };
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: candidate.id })
      .mockResolvedValueOnce(candidate);
    const prisma = {
      enabled: true,
      esimInventory: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst,
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaService;
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
    );
    vi.spyOn(inventory, "reconcileProviderProfile").mockResolvedValue({
      id: candidate.id,
      iccid: candidate.iccid,
      localStatus: "AVAILABLE",
      providerStatus: "released",
      inSync: true,
      checkedAt: new Date().toISOString(),
    });

    await expect(inventory.reserve("order-1")).resolves.toMatchObject({
      id: candidate.id,
      status: "RESERVED",
      assignedOrderId: "order-1",
    });
  });
});

describe("InventoryService stale reservation reconciliation", () => {
  it("releases only a provider-unbound reservation for a terminal order", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      enabled: true,
      esimInventory: {
        findMany: vi.fn(async () => [
          {
            id: "inv-1",
            iccid: "8988247000000000001",
            status: "RESERVED",
            assignedOrderId: "order-1",
            providerSubscriptionId: null,
            providerStatus: "available",
            assignedOrder: {
              id: "order-1",
              orderNumber: "VC-1",
              status: "CANCELLED",
              provisioningOperation: {
                state: "CREATED",
                providerOrderId: null,
              },
            },
          },
        ]),
        updateMany,
      },
    } as unknown as PrismaService;
    const attention = vi.fn();
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
      { attention } as never,
    );

    await expect(inventory.reconcileStaleReservations()).resolves.toEqual({
      released: ["inv-1"],
      attention: [],
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          providerSubscriptionId: null,
          assignedOrderId: "order-1",
        }),
        data: expect.objectContaining({
          status: "PENDING_PROVIDER_CHECK",
          assignedOrderId: null,
          lastProviderCheckedAt: null,
        }),
      }),
    );
    expect(attention).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous reservation locked and creates an Ops case", async () => {
    const updateMany = vi.fn();
    const prisma = {
      enabled: true,
      esimInventory: {
        findMany: vi.fn(async () => [
          {
            id: "inv-2",
            iccid: "8988247000000000002",
            status: "RESERVED",
            assignedOrderId: "order-2",
            providerSubscriptionId: null,
            providerStatus: "allocated",
            assignedOrder: {
              id: "order-2",
              orderNumber: "VC-2",
              status: "PROVISIONING",
              provisioningOperation: {
                state: "SUBMITTING",
                providerOrderId: null,
              },
            },
          },
        ]),
        updateMany,
      },
    } as unknown as PrismaService;
    const attention = vi.fn(async () => undefined);
    const inventory = new InventoryService(
      prisma,
      cryptoStub(),
      connectivityStub(),
      { attention } as never,
    );

    await expect(inventory.reconcileStaleReservations()).resolves.toEqual({
      released: [],
      attention: ["inv-2"],
    });
    expect(updateMany).not.toHaveBeenCalled();
    expect(attention).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "INVENTORY_RESERVATION_STALE",
        availableActions: ["RECONCILE_RESERVATION"],
      }),
    );
  });
});
