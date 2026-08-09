import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaService;
}

function connectivityStub() {
  return {
    catalogReport: vi.fn().mockResolvedValue({ rows: [], skipped: [] }),
  } as unknown as ConnectivityService;
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

describe('AdminService.importPlansFromTabular role-based default status', () => {
  it('imports as DRAFT when no actor is resolved', async () => {
    const prisma = prismaStub();
    const admin = new AdminService(prisma, connectivityStub());
    await admin.importPlansFromTabular(csv('7'));
    expect(prisma.plan.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'DRAFT' }) }),
    );
  });

  it('imports as ACTIVE when the actor is a SUPER_ADMIN', async () => {
    const prisma = prismaStub();
    prisma.user.findUnique = vi.fn().mockResolvedValue({ id: 'u-1', accountType: 'SUPER_ADMIN' });
    const admin = new AdminService(prisma, connectivityStub());
    await admin.importPlansFromTabular(csv('7'), undefined, 'clerk-1');
    expect(prisma.plan.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) }),
    );
  });

  it('imports as DRAFT when the actor is an OPERATIONS user', async () => {
    const prisma = prismaStub();
    prisma.user.findUnique = vi.fn().mockResolvedValue({ id: 'u-2', accountType: 'OPERATIONS' });
    const admin = new AdminService(prisma, connectivityStub());
    await admin.importPlansFromTabular(csv('7'), undefined, 'clerk-2');
    expect(prisma.plan.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'DRAFT' }) }),
    );
  });

  it('keeps an explicit status column value', async () => {
    const prisma = prismaStub();
    const admin = new AdminService(prisma, connectivityStub());
    const fullHeaders = 'countryiso2,countryname,name,providerplanid,dataallowance,validitydays,costprice,sellingprice,currency,coveragecountries,status';
    const explicit = `${fullHeaders}\nNP,Nepal,Travel 5GB,TRVL-5GB-15D,5120 MB,7,8,10,NPR,NPL,DISABLED`;
    await admin.importPlansFromTabular(explicit);
    expect(prisma.plan.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'DISABLED' }) }),
    );
  });

  it('defaults costPrice to sellingPrice when the cost column is blank', async () => {
    const prisma = prismaStub();
    const admin = new AdminService(prisma, connectivityStub());
    const blankCost = [...headers, 'NP,Travel 5GB,TRVL-5GB-15D,5120 MB,7,,10'].join('\n');
    await admin.importPlansFromTabular(blankCost);
    expect(prisma.plan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ costPrice: 10, sellingPrice: 10 }),
      }),
    );
  });
});

describe('AdminService.exportTransatelCatalog', () => {
  const envKeys = ['TRANSATEL_BASE_URL', 'TRANSATEL_CLIENT_ID', 'TRANSATEL_CLIENT_SECRET', 'TRANSATEL_MVNO_REF'];
  const previous: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of envKeys) {
      previous[key] = process.env[key];
      process.env[key] = 'configured';
    }
  });
  afterAll(() => {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  it('renders the catalog rows as a CSV report with import-compatible headers', async () => {
    const connectivity = {
      catalogReport: vi.fn().mockResolvedValue({
        rows: [{
          countryiso2: 'NP', countryname: 'Nepal', name: 'Travel 5GB', providerplanid: 'TRVL-5GB-15D',
          dataallowance: '5120 MB', validitydays: 15, costprice: 8, sellingprice: 10,
          currency: 'NPR', coveragecountries: 'NPL', status: '',
        }],
        skipped: ['SKIP-1'],
      }),
    } as unknown as ConnectivityService;
    const admin = new AdminService(prismaStub(), connectivity);
    const result = await admin.exportTransatelCatalog();
    expect(connectivity.catalogReport).toHaveBeenCalled();
    expect(result.count).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.csv).toContain('countryiso2,countryname,name,providerplanid,dataallowance,validitydays,costprice,sellingprice,currency,coveragecountries,status');
    expect(result.csv).toContain('NP,Nepal,Travel 5GB,TRVL-5GB-15D,5120 MB,15,8,10,NPR,NPL');
    expect(result.fileName).toMatch(/^transatel-catalog-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
