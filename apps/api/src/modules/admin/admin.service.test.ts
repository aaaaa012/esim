import { describe, expect, it, vi } from 'vitest';
import { AdminService } from './admin.service.js';
import type { PrismaService } from '../../infrastructure/prisma.service.js';
import type { ConnectivityService } from '../integration/connectivity.service.js';

function prismaStub() {
  return {
    enabled: true,
    country: {
      upsert: vi.fn().mockResolvedValue({ id: 'country-1' }),
    },
    plan: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaService;
}

function connectivityStub() {
  return {} as unknown as ConnectivityService;
}

const headers = ['countryiso2,name,providerplanid,dataallowance,validitydays,costprice,sellingprice'];

function csv(validityDays: string, country = 'NP') {
  return [...headers, `${country},Travel 5GB,TRVL-5GB-15D,5120 MB,${validityDays},8,10`].join('\n');
}

describe('AdminService.importPlansFromTabular validity parsing', () => {
  it('accepts a plain integer of days', async () => {
    const prisma = prismaStub();
    const admin = new AdminService(prisma, connectivityStub());
    const result = await admin.importPlansFromTabular(csv('7'));
    expect(result).toMatchObject({ imported: 1, updated: 0, skipped: 0 });
    expect(prisma.plan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ validityDays: 7 }),
      }),
    );
  });

  it.each([
    ['7 days', 7],
    ['7days', 7],
    ['7D', 7],
    [' 14 days ', 14],
    ['1 months', 30],
    ['2 month', 60],
    ['3 mo', 90],
  ])('parses "%s" as %i days', async (value, days) => {
    const prisma = prismaStub();
    const admin = new AdminService(prisma, connectivityStub());
    await admin.importPlansFromTabular(csv(value));
    expect(prisma.plan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ validityDays: days }),
      }),
    );
  });

  it.each(['', 'soon', '7 hours', 'three', '1.5 days'])('rejects invalid validity "%s"', async (value) => {
    const prisma = prismaStub();
    const admin = new AdminService(prisma, connectivityStub());
    const result = await admin.importPlansFromTabular(csv(value));
    expect(result).toMatchObject({ imported: 0, skipped: 1 });
    expect(prisma.plan.create).not.toHaveBeenCalled();
  });

  it('updates an existing plan when the provider plan already exists', async () => {
    const prisma = prismaStub();
    prisma.plan.findUnique = vi.fn().mockResolvedValue({ id: 'plan-1' });
    const admin = new AdminService(prisma, connectivityStub());
    const result = await admin.importPlansFromTabular(csv('7 days'));
    expect(result).toMatchObject({ imported: 0, updated: 1, skipped: 0 });
    expect(prisma.plan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'plan-1' },
        data: expect.objectContaining({ validityDays: 7 }),
      }),
    );
  });
});
