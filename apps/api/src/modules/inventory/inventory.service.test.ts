import { describe, expect, it, vi } from 'vitest';
import { InventoryService } from './inventory.service.js';
import type { PrismaService } from '../../infrastructure/prisma.service.js';
import type { CryptoService } from '../../infrastructure/crypto.service.js';
import type { ConnectivityService } from '../integration/connectivity.service.js';

function prismaStub() {
  return {
    enabled: true,
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        inventoryBatch: { create: vi.fn().mockResolvedValue({ id: 'batch-1' }) },
        esimInventory: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      };
      return callback(tx);
    }),
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: 'local-user-1', clerkId: 'user_clerk' }),
    },
    esimInventory: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    inventoryBatch: {
      create: vi.fn().mockResolvedValue({ id: 'batch-1' }),
    },
  } as unknown as PrismaService;
}

function cryptoStub() {
  return { encrypt: (value: string) => `enc:${value}` } as unknown as CryptoService;
}

function connectivityStub() {
  return {} as unknown as ConnectivityService;
}

describe('InventoryService.importBatchCsv', () => {
  it('rejects an invalid MSISDN and does not import that row', async () => {
    const prisma = prismaStub();
    const inventory = new InventoryService(prisma, cryptoStub(), connectivityStub());
    const content = ['iccid,msisdn', '899770100000000001,not-a-number'].join('\n');
    const result = await inventory.importBatchCsv(content);
    expect(result).toMatchObject({ imported: 0, skipped: 1 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('accepts a valid MSISDN row', async () => {
    const prisma = prismaStub();
    const inventory = new InventoryService(prisma, cryptoStub(), connectivityStub());
    const content = ['iccid,msisdn', '899770100000000001,882470001850263'].join('\n');
    const result = await inventory.importBatchCsv(content);
    expect(result).toMatchObject({ imported: 1, skipped: 0 });
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('stores the resolved local user id in submittedById (not the Clerk id)', async () => {
    const txBatchCreate = vi.fn().mockResolvedValue({ id: 'batch-1' });
    const prisma = prismaStub();
    (prisma as unknown as { $transaction: unknown }).$transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        inventoryBatch: { create: txBatchCreate },
        esimInventory: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      };
      return callback(tx);
    });
    const inventory = new InventoryService(prisma, cryptoStub(), connectivityStub());
    const content = ['iccid,msisdn', '899770100000000001,882470001850263'].join('\n');
    await inventory.importBatchCsv(content, 'ops', 'file.csv', 'user_clerk');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { clerkId: 'user_clerk' } });
    const call = txBatchCreate.mock.calls[0];
    expect(call?.[0]).toBeDefined();
    const { submittedById } = (call?.[0]?.data ?? {}) as { submittedById?: string };
    expect(submittedById).toBe('local-user-1');
  });
});

describe('InventoryService.releaseToStock', () => {
  function releaseStockPrisma(profile: { providerSubscriptionId?: string | null; providerStatus?: string | null; status?: string }) {
    const update = vi.fn().mockResolvedValue({ id: 'inv-1', iccid: '8988247076000000319', ...profile, lastProviderCheckedAt: new Date() });
    const auditCreate = vi.fn().mockResolvedValue({ id: 'audit-1' });
    return {
      enabled: true,
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({ esimInventory: { update }, auditLog: { create: auditCreate } })),
      auditLog: { create: auditCreate },
      esimInventory: {
        findUnique: vi.fn().mockResolvedValue({ id: 'inv-1', iccid: '8988247076000000319', ...profile }),
        update,
      },
    } as unknown as PrismaService;
  }

  it('submits a provider terminate and only restocks when the provider confirms a sellable state', async () => {
    const prisma = releaseStockPrisma({ status: 'QUARANTINED' });
    const connectivity = {
      terminate: vi.fn().mockResolvedValue({ accepted: true, transactionId: 'tx-1' }),
      getEsimDetails: vi.fn().mockResolvedValue({ subscriptionId: '8988247076000000319', status: 'released' }),
    } as unknown as ConnectivityService;
    const inventory = new InventoryService(prisma, cryptoStub(), connectivity);
    const result = await inventory.releaseToStock('inv-1', 'ops-user');
    expect(connectivity.terminate).toHaveBeenCalledWith('8988247076000000319', expect.stringMatching(/^ops:release:8988247076000000319:/));
    expect(result).toMatchObject({ localStatus: 'AVAILABLE', inStock: true, terminateSubmitted: true, providerTransactionId: 'tx-1' });
    expect(prisma.esimInventory.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'inv-1' }, data: expect.objectContaining({ status: 'AVAILABLE' }) }));
  });

  it('keeps the profile QUARANTINED when the provider still reports a non-sellable state', async () => {
    const prisma = releaseStockPrisma({ status: 'QUARANTINED' });
    const connectivity = {
      terminate: vi.fn().mockResolvedValue({ accepted: true, transactionId: 'tx-1' }),
      getEsimDetails: vi.fn().mockResolvedValue({ subscriptionId: '8988247076000000319', status: 'enabled' }),
    } as unknown as ConnectivityService;
    const inventory = new InventoryService(prisma, cryptoStub(), connectivity);
    const result = await inventory.releaseToStock('inv-1', 'ops-user');
    expect(result).toMatchObject({ localStatus: 'QUARANTINED', inStock: false });
    expect(prisma.esimInventory.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'inv-1' }, data: expect.objectContaining({ status: 'QUARANTINED', quarantineReason: expect.any(String) }) }));
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'RELEASED_TO_STOCK' }) }));
  });

  it('records terminate submission failures instead of quenching the restock path', async () => {
    const prisma = releaseStockPrisma({ status: 'QUARANTINED' });
    const connectivity = {
      terminate: vi.fn().mockRejectedValue(new Error('provider down')),
      getEsimDetails: vi.fn().mockResolvedValue({ subscriptionId: '8988247076000000319', status: 'released' }),
    } as unknown as ConnectivityService;
    const inventory = new InventoryService(prisma, cryptoStub(), connectivity);
    const result = await inventory.releaseToStock('inv-1', 'ops-user');
    expect(result).toMatchObject({ localStatus: 'AVAILABLE', inStock: true, terminateSubmitted: false });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'RELEASED_TO_STOCK' }) }));
  });
});

describe('InventoryService.release', () => {
  function releasePrisma(profile: { providerSubscriptionId: string | null; providerStatus?: string | null }) {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    return {
      enabled: true,
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({ esimInventory: { update: vi.fn().mockResolvedValue({ id: 'inv-1' }) }, auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) } })),
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
      esimInventory: {
        findUnique: vi.fn().mockResolvedValue({ id: 'inv-1', iccid: '8988247076000000319', ...profile }),
        updateMany,
      },
    } as unknown as PrismaService;
  }

  function connectivityWith(status: string) {
    return { getEsimDetails: vi.fn().mockResolvedValue({ subscriptionId: '8988247076000000319', status }) } as unknown as ConnectivityService;
  }

  it('returns a provider-confirmed sellable profile to AVAILABLE', async () => {
    const prisma = releasePrisma({ providerSubscriptionId: null });
    const inventory = new InventoryService(prisma, cryptoStub(), connectivityWith('available'));
    await inventory.release('order-1');
    expect(prisma.esimInventory.findUnique).toHaveBeenCalledWith({ where: { assignedOrderId: 'order-1' } });
    expect(prisma.esimInventory.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inv-1', assignedOrderId: 'order-1', providerSubscriptionId: null },
        data: expect.objectContaining({ status: 'AVAILABLE', assignedOrderId: null }),
      }),
    );
  });

  it('relies on a stored resellable providerStatus without another provider call', async () => {
    const prisma = releasePrisma({ providerSubscriptionId: null, providerStatus: 'released' });
    const connectivity = connectivityWith('available');
    const inventory = new InventoryService(prisma, cryptoStub(), connectivity);
    await inventory.release('order-1');
    expect(connectivity.getEsimDetails).not.toHaveBeenCalled();
    expect(prisma.esimInventory.updateMany).toHaveBeenCalled();
  });

  it('does not release a profile that the provider has bound a subscription to', async () => {
    const prisma = releasePrisma({ providerSubscriptionId: 'sub-9' });
    const inventory = new InventoryService(prisma, cryptoStub(), connectivityWith('available'));
    await inventory.release('order-1');
    expect(prisma.esimInventory.updateMany).not.toHaveBeenCalled();
  });

  it('quarantines a profile the provider reports as previously onboarded (enabled/disabled/downloaded)', async () => {
    const prisma = releasePrisma({ providerSubscriptionId: null });
    const inventory = new InventoryService(prisma, cryptoStub(), connectivityWith('downloaded'));
    await inventory.release('order-1');
    expect(prisma.esimInventory.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('keeps the profile reserved when the provider cannot be reached', async () => {
    const prisma = releasePrisma({ providerSubscriptionId: null });
    const connectivity = { getEsimDetails: vi.fn().mockRejectedValue(new Error('socket timeout')) } as unknown as ConnectivityService;
    const inventory = new InventoryService(prisma, cryptoStub(), connectivity);
    await inventory.release('order-1');
    expect(prisma.esimInventory.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('is a no-op when no profile is reserved for the order', async () => {
    const prisma = { enabled: true, esimInventory: { findUnique: vi.fn().mockResolvedValue(null), updateMany: vi.fn() } } as unknown as PrismaService;
    const inventory = new InventoryService(prisma, cryptoStub(), connectivityWith('available'));
    await inventory.release('order-1');
    expect(prisma.esimInventory.updateMany).not.toHaveBeenCalled();
  });
});

describe('InventoryService.reconcileProviderProfile', () => {
  function reconciliationPrisma() {
    const update = vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'inv-1', iccid: '8988247076000000319', status: data.status ?? 'AVAILABLE', lastProviderCheckedAt: data.lastProviderCheckedAt }));
    return {
      enabled: true,
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
      esimInventory: {
        findUnique: vi.fn().mockResolvedValue({ id: 'inv-1', iccid: '8988247076000000319', status: 'AVAILABLE', assignedOrderId: null }),
        update,
      },
    } as unknown as PrismaService;
  }

  it('keeps an unassigned profile available when Transatel reports a safe stock state', async () => {
    const prisma = reconciliationPrisma();
    const connectivity = { getEsimDetails: vi.fn().mockResolvedValue({ subscriptionId: '8988247076000000319', status: 'available' }) } as unknown as ConnectivityService;
    const inventory = new InventoryService(prisma, cryptoStub(), connectivity);
    const result = await inventory.reconcileProviderProfile('inv-1');
    expect(result).toMatchObject({ localStatus: 'AVAILABLE', providerStatus: 'available', inSync: true });
    expect(prisma.esimInventory.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.not.objectContaining({ status: 'QUARANTINED' }) }));
  });

  it('quarantines unassigned inventory that Transatel reports as already downloaded', async () => {
    const prisma = reconciliationPrisma();
    const connectivity = { getEsimDetails: vi.fn().mockResolvedValue({ subscriptionId: '8988247076000000319', status: 'downloaded' }) } as unknown as ConnectivityService;
    const inventory = new InventoryService(prisma, cryptoStub(), connectivity);
    const result = await inventory.reconcileProviderProfile('inv-1');
    expect(result).toMatchObject({ localStatus: 'QUARANTINED', providerStatus: 'downloaded', inSync: false });
    expect(prisma.esimInventory.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'QUARANTINED' }) }));
  });
});
