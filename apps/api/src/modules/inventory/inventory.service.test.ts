import { describe, expect, it, vi } from "vitest";
import { InventoryService } from "./inventory.service.js";
import type { PrismaService } from "../../infrastructure/prisma.service.js";
import type { CryptoService } from "../../infrastructure/crypto.service.js";
import type { ConnectivityService } from "../integration/connectivity.service.js";

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

describe("InventoryService.importBatchCsv", () => {
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

  it("returns an unreserved, provider-bound profile to AVAILABLE", async () => {
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
          status: "AVAILABLE",
          assignedOrderId: null,
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

describe("InventoryService.reconcileProviderProfile", () => {
  function reconciliationPrisma() {
    const update = vi
      .fn()
      .mockImplementation(({ data }) =>
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
        findUnique: vi
          .fn()
          .mockResolvedValue({
            id: "inv-1",
            iccid: "8988247076000000319",
            status: "AVAILABLE",
            assignedOrderId: null,
          }),
        update,
      },
    } as unknown as PrismaService;
  }

  it("keeps an unassigned profile available when Transatel reports a safe stock state", async () => {
    const prisma = reconciliationPrisma();
    const connectivity = {
      getEsimDetails: vi
        .fn()
        .mockResolvedValue({
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

  it("quarantines unassigned inventory that Transatel reports as already downloaded", async () => {
    const prisma = reconciliationPrisma();
    const connectivity = {
      getEsimDetails: vi
        .fn()
        .mockResolvedValue({
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
      getEsimDetails: vi.fn().mockResolvedValue({ status: "released" }),
    } as unknown as ConnectivityService;
    const inventory = new InventoryService(prisma, cryptoStub(), connectivity);

    await expect(
      inventory.restoreQuarantinedProfile("inv-1", "user_clerk"),
    ).rejects.toThrow("only available or allocated inventory can be restored");
    expect(updateMany).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
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
          batch: { status: "APPROVED" },
        }),
      }),
    );
  });
});
