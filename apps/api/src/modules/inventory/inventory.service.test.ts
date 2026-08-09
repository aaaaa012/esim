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

describe('InventoryService.release', () => {
  function releasePrisma(profile: { providerSubscriptionId: string | null }) {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    return {
      enabled: true,
      esimInventory: {
        findUnique: vi.fn().mockResolvedValue({ id: 'inv-1', ...profile }),
        updateMany,
      },
    } as unknown as PrismaService;
  }

  it('returns an unreserved, provider-bound profile to AVAILABLE', async () => {
    const prisma = releasePrisma({ providerSubscriptionId: null });
    const inventory = new InventoryService(prisma, cryptoStub(), connectivityStub());
    await inventory.release('order-1');
    expect(prisma.esimInventory.findUnique).toHaveBeenCalledWith({ where: { assignedOrderId: 'order-1' } });
    expect(prisma.esimInventory.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inv-1', assignedOrderId: 'order-1', providerSubscriptionId: null },
        data: expect.objectContaining({ status: 'AVAILABLE', assignedOrderId: null }),
      }),
    );
  });

  it('does not release a profile that the provider has bound a subscription to', async () => {
    const prisma = releasePrisma({ providerSubscriptionId: 'sub-9' });
    const inventory = new InventoryService(prisma, cryptoStub(), connectivityStub());
    await inventory.release('order-1');
    expect(prisma.esimInventory.updateMany).not.toHaveBeenCalled();
  });

  it('is a no-op when no profile is reserved for the order', async () => {
    const prisma = { enabled: true, esimInventory: { findUnique: vi.fn().mockResolvedValue(null), updateMany: vi.fn() } } as unknown as PrismaService;
    const inventory = new InventoryService(prisma, cryptoStub(), connectivityStub());
    await inventory.release('order-1');
    expect(prisma.esimInventory.updateMany).not.toHaveBeenCalled();
  });
});