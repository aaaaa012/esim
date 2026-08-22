import { describe, expect, it, vi } from "vitest";
import { TransatelOperationsService } from "./transatel-operations.service.js";
import type { PrismaService } from "../../infrastructure/prisma.service.js";
import type { ConnectivityService } from "./connectivity.service.js";
import type { OrdersService } from "../orders/orders.service.js";

function setup(
  providerResult: unknown = {
    accepted: true,
    transactionId: "tx-1",
    status: "Pending",
  },
) {
  const lifecycleCreate = vi
    .fn()
    .mockResolvedValue({
      id: "operation-1",
      orderId: "order-1",
      action: "SUSPEND",
      state: "CREATED",
    });
  const lifecycleUpdate = vi
    .fn()
    .mockImplementation(({ data }) =>
      Promise.resolve({
        id: "operation-1",
        orderId: "order-1",
        action: "SUSPEND",
        ...data,
      }),
    );
  const auditCreate = vi.fn().mockResolvedValue({});
  const tx = {
    transatelLifecycleOperation: { update: lifecycleUpdate },
    order: { update: vi.fn().mockResolvedValue({}) },
    esimInventory: { update: vi.fn().mockResolvedValue({}) },
    subscription: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: auditCreate },
  };
  const prisma = {
    enabled: true,
    order: {
      findUnique: vi
        .fn()
        .mockResolvedValue({
          id: "order-1",
          providerStatus: "ACTIVE",
          inventory: {
            id: "inventory-1",
            iccid: "8988247076000000319",
            providerSubscriptionId: null,
            status: "ACTIVATED",
          },
          customerEsim: {
            subscriptions: [{ providerSubscriptionId: "sub-1" }],
          },
        }),
      update: vi.fn().mockResolvedValue({}),
    },
    esimInventory: { update: vi.fn().mockResolvedValue({}) },
    subscription: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    transatelLifecycleOperation: {
      create: lifecycleCreate,
      update: lifecycleUpdate,
      findFirst: vi.fn().mockResolvedValue(null),
    },
    $transaction: vi.fn(async (input: unknown) =>
      typeof input === "function"
        ? (input as (value: typeof tx) => Promise<unknown>)(tx)
        : Promise.all(input as Promise<unknown>[]),
    ),
    auditLog: { create: auditCreate },
  } as unknown as PrismaService;
  const connectivity = {
    suspend: vi.fn().mockResolvedValue(providerResult),
    terminate: vi.fn().mockResolvedValue(providerResult),
  } as unknown as ConnectivityService;
  const orders = {
    applyProviderEvent: vi.fn().mockResolvedValue({ accepted: true }),
  } as unknown as OrdersService;
  return {
    service: new TransatelOperationsService(prisma, connectivity, orders),
    prisma,
    connectivity,
    lifecycleCreate,
    lifecycleUpdate,
    auditCreate,
    tx,
    orders,
  };
}

describe("TransatelOperationsService lifecycle", () => {
  it("persists, submits, updates local pending state, and audits a suspension", async () => {
    const context = setup();
    const result = await context.service.suspend({
      orderId: "order-1",
      reason: "Customer reported device theft",
      idempotencyKey: "ops:suspend:12345678",
      actorId: "actor-1",
    });
    expect(context.lifecycleCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "SUSPEND",
        reason: "Customer reported device theft",
        idempotencyKey: "ops:suspend:12345678",
      }),
    });
    expect(context.connectivity.suspend).toHaveBeenCalledWith(
      "8988247076000000319",
      "ops:suspend:12345678",
    );
    expect(context.tx.order.update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { providerStatus: "SUSPEND_PENDING", version: { increment: 1 } },
    });
    expect(context.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        module: "TRANSATEL",
        action: "SUSPEND_ACCEPTED",
        performedById: "actor-1",
      }),
    });
    expect(result).toMatchObject({
      state: "ACCEPTED",
      providerTransactionId: "tx-1",
    });
  });

  it("refuses to suspend an already terminated eSIM before calling Transatel", async () => {
    const context = setup();
    (
      context.prisma.order.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      id: "order-1",
      providerStatus: "TERMINATED",
      inventory: {
        id: "inventory-1",
        iccid: "8988247076000000319",
        status: "TERMINATED",
      },
      customerEsim: { subscriptions: [] },
    });
    await expect(
      context.service.suspend({
        orderId: "order-1",
        reason: "Customer requested suspension",
        idempotencyKey: "ops:suspend:12345678",
        actorId: "actor-1",
      }),
    ).rejects.toThrow("terminated eSIM cannot be suspended");
    expect(context.connectivity.suspend).not.toHaveBeenCalled();
  });

  it("marks a network-ambiguous outcome for reconciliation instead of allowing a replay", async () => {
    const context = setup();
    (
      context.connectivity.suspend as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("socket closed after send"));
    await expect(
      context.service.suspend({
        orderId: "order-1",
        reason: "Customer reported device theft",
        idempotencyKey: "ops:suspend:12345678",
        actorId: "actor-1",
      }),
    ).rejects.toThrow("socket closed");
    expect(context.lifecycleUpdate).toHaveBeenCalledWith({
      where: { id: "operation-1" },
      data: {
        state: "RECONCILE_REQUIRED",
        errorMessage: "socket closed after send",
      },
    });
  });
});

describe("TransatelOperationsService reconciliation", () => {
  it("activates an order only when its Transatel subscription is active", async () => {
    const context = setup();
    (
      context.prisma.order.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      id: "order-1",
      status: "QR_READY",
      providerStatus: "ENABLED",
      providerSubscriptionId: "sub-1",
      inventory: {
        id: "inventory-1",
        iccid: "8988247076000000319",
        status: "ASSIGNED",
      },
      customerEsim: { id: "customer-esim-1", subscriptions: [] },
      transatelLifecycleOperations: [],
    });
    context.connectivity.getEsimDetails = vi.fn().mockResolvedValue({
      subscriptionId: "8988247076000000319",
      status: "enabled",
    });
    context.connectivity.getUsage = vi.fn().mockResolvedValue({
      usedMb: 100,
      totalMb: 500,
      usageAvailable: true,
      subscriptions: [
        {
          providerSubscriptionId: "sub-1",
          status: "active",
          usedMb: 100,
          totalMb: 500,
        },
      ],
    });

    await expect(context.service.reconcile("order-1")).resolves.toMatchObject({
      providerStatus: "ACTIVE",
      esimProfileStatus: "ENABLED",
      subscriptionStatus: "ACTIVE",
      usageAvailable: true,
    });
    expect(context.orders.applyProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ACTIVATED", subscriptionId: "sub-1" }),
    );
  });

  it("does not activate an order from the eSIM profile status alone", async () => {
    const context = setup();
    (
      context.prisma.order.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      id: "order-1",
      status: "QR_READY",
      providerStatus: "ENABLED",
      providerSubscriptionId: "sub-1",
      inventory: {
        id: "inventory-1",
        iccid: "8988247076000000319",
        status: "ASSIGNED",
      },
      customerEsim: { id: "customer-esim-1", subscriptions: [] },
      transatelLifecycleOperations: [],
    });
    context.connectivity.getEsimDetails = vi.fn().mockResolvedValue({
      subscriptionId: "8988247076000000319",
      status: "enabled",
    });
    context.connectivity.getUsage = vi.fn().mockResolvedValue({
      usedMb: 0,
      totalMb: 500,
      usageAvailable: true,
      subscriptions: [
        {
          providerSubscriptionId: "sub-1",
          status: "readyForUse",
          usedMb: 0,
          totalMb: 500,
        },
      ],
    });

    await expect(context.service.reconcile("order-1")).resolves.toMatchObject({
      providerStatus: "READYFORUSE",
      esimProfileStatus: "ENABLED",
      subscriptionStatus: "READYFORUSE",
    });
    expect(context.orders.applyProviderEvent).not.toHaveBeenCalled();
  });
});

describe("TransatelOperationsService dashboard search", () => {
  it("applies each table search on the server before limiting results", async () => {
    const subscriptionFindMany = vi.fn().mockResolvedValue([]);
    const inventoryFindMany = vi.fn().mockResolvedValue([]);
    const logFindMany = vi.fn().mockResolvedValue([]);
    const lifecycleFindMany = vi.fn().mockResolvedValue([]);
    const prisma = {
      enabled: true,
      esimInventory: {
        count: vi.fn().mockResolvedValue(0),
        findMany: inventoryFindMany,
      },
      subscription: {
        count: vi.fn().mockResolvedValue(0),
        findMany: subscriptionFindMany,
      },
      order: { count: vi.fn().mockResolvedValue(0) },
      provisioningOperation: { count: vi.fn().mockResolvedValue(0) },
      webhookEvent: { count: vi.fn().mockResolvedValue(0) },
      integrationLog: { findMany: logFindMany },
      transatelLifecycleOperation: { findMany: lifecycleFindMany },
    } as unknown as PrismaService;
    const connectivity = {
      transatelHealth: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as ConnectivityService;
    const service = new TransatelOperationsService(
      prisma,
      connectivity,
      {} as OrdersService,
    );

    await service.dashboard({ scope: "subscribers", q: "VC-2026-SEARCH" });
    expect(subscriptionFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          provider: "TRANSATEL",
          OR: expect.any(Array),
        }),
        take: 100,
      }),
    );

    await service.dashboard({ scope: "inventory", q: "8988247" });
    expect(inventoryFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          assignedOrderId: null,
          OR: expect.any(Array),
        }),
        take: 100,
      }),
    );

    await service.dashboard({ scope: "failures", q: "timeout" });
    expect(logFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ AND: expect.any(Array) }),
        take: 50,
      }),
    );

    await service.dashboard({ scope: "actions", q: "operator@example.com" });
    expect(lifecycleFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: expect.any(Array) }),
        take: 50,
      }),
    );
  });
});

describe("TransatelOperationsService usage sync", () => {
  it("persists the provider balance for each active subscription", async () => {
    const subscriptionUpdate = vi.fn().mockResolvedValue({});
    const prisma = {
      enabled: true,
      subscription: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "subscription-1",
            providerSubscriptionId: "provider-subscription-1",
            customerEsim: { inventory: { iccid: "8988247076000000319" } },
          },
        ]),
        update: subscriptionUpdate,
      },
    } as unknown as PrismaService;
    const connectivity = {
      getUsage: vi.fn().mockResolvedValue({
        usedMb: 1024,
        totalMb: 5120,
        subscriptions: [
          {
            providerSubscriptionId: "provider-subscription-1",
            status: "active",
            usedMb: 1024,
            totalMb: 5120,
            priority: 1,
          },
        ],
      }),
    } as unknown as ConnectivityService;
    const service = new TransatelOperationsService(
      prisma,
      connectivity,
      {} as OrdersService,
    );

    await expect(service.syncAllUsage()).resolves.toEqual({
      synced: 1,
      failed: 0,
    });
    expect(subscriptionUpdate).toHaveBeenCalledWith({
      where: { id: "subscription-1" },
      data: expect.objectContaining({
        usedMb: 1024,
        totalMb: 5120,
        usageLastCheckedAt: expect.any(Date),
        providerLastSeenAt: expect.any(Date),
        assignmentVerificationStatus: "VERIFIED",
      }),
    });
  });
});
