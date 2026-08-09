import { describe, expect, it, vi } from 'vitest';
import { CustomerEsimsService } from './customer-esims.service.js';

const inventory = {
  id: '10000000-0000-4000-8000-000000000001', iccid: '8988247076000000319', msisdn: '882470001850263', status: 'ACTIVATED', activatedAt: new Date('2026-08-01T00:00:00Z'), expiresAt: null, updatedAt: new Date(),
  customerEsims: [{ assignedAt: new Date(), order: { id: 'order-1', orderNumber: 'VC-1', status: 'COMPLETED', plan: { id: 'plan-1', name: 'UAE 5GB', dataAllowance: '5 GB', validityDays: 15, country: { isoCode: 'AE', name: 'United Arab Emirates' } } }, subscriptions: [{ id: 'sub-1', status: 'ACTIVE', usedMb: 1024, totalMb: 5120, activatedAt: new Date('2026-08-01T00:00:00Z'), expiresAt: new Date('2026-08-16T00:00:00Z'), usageLastCheckedAt: new Date('2026-08-10T00:00:00Z') }] }],
};

describe('CustomerEsimsService', () => {
  it('groups the inventory as one eSIM and reports the freshest aggregate balance', async () => {
    const prisma = { enabled: true, customer: { findFirst: vi.fn().mockResolvedValue({ id: 'customer-1' }) }, esimInventory: { findMany: vi.fn().mockResolvedValue([inventory]) } };
    const service = new CustomerEsimsService(prisma as never, {} as never);
    const result = await service.list('user_1');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: inventory.id, usage: { usedMb: 1024, totalMb: 5120, remainingMb: 4096 }, qrOrderId: 'order-1' });
    expect(result[0]!.iccidMasked).not.toBe(inventory.iccid);
  });

  it('does not return an eSIM not owned by the customer', async () => {
    const prisma = { enabled: true, customer: { findFirst: vi.fn().mockResolvedValue({ id: 'customer-1' }) }, esimInventory: { findMany: vi.fn().mockResolvedValue([]) } };
    const service = new CustomerEsimsService(prisma as never, {} as never);
    await expect(service.get('user_1', inventory.id)).rejects.toThrow('eSIM not found');
  });
});
