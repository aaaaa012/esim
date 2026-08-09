import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransatelProvider } from './transatel.provider.js';
import type { PrismaService } from '../../infrastructure/prisma.service.js';

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as Response;
}

function prismaStub(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    plan: { findUnique: vi.fn() },
    esimInventory: { findFirst: vi.fn(), findUnique: vi.fn() },
    subscription: { findUnique: vi.fn() },
    customerEsim: { findUnique: vi.fn() },
    order: { findUnique: vi.fn() },
    integrationLog: { create: vi.fn() },
    $transaction: vi.fn(),
    ...overrides,
  } as unknown as PrismaService;
}

const traveler = { firstName: 'Jane', surname: 'Doe', email: 'jane@example.com', mobile: '9779800000000', city: 'Kathmandu', countryOfResidence: 'NP' };
const ORDER_UUID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

describe('TransatelProvider', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.TRANSATEL_BASE_URL = 'https://api.transatel.com';
    process.env.TRANSATEL_CLIENT_ID = 'test-client';
    process.env.TRANSATEL_CLIENT_SECRET = 'test-secret';
    process.env.TRANSATEL_MVNO_REF = 'visacompass-test';
    process.env.TRANSATEL_COS = 'WW_COS_TEST';
    process.env.TRANSATEL_FX_TO_NPR = '170';
    process.env.TRANSATEL_SUBSCRIBER_IDENTIFIER = 'iccid';
    delete process.env.TRANSATEL_WEBHOOK_TARGET_URL;
    delete process.env.TRANSATEL_WEBHOOK_CONTACT_EMAIL;
    delete process.env.TRANSATEL_WEBHOOK_SECRET;
  });
  afterEach(() => {
    delete process.env.TRANSATEL_BASE_URL;
    delete process.env.TRANSATEL_CLIENT_ID;
    delete process.env.TRANSATEL_CLIENT_SECRET;
    delete process.env.TRANSATEL_MVNO_REF;
    delete process.env.TRANSATEL_COS;
    delete process.env.TRANSATEL_FX_TO_NPR;
    delete process.env.TRANSATEL_SUBSCRIBER_IDENTIFIER;
  });

  function route(routes: Record<string, (init?: FetchInit) => Response>) {
    fetchMock.mockImplementation((url: string, init?: FetchInit) => {
      const handler = Object.entries(routes).find(([path]) => String(url).includes(path))?.[1];
      if (!handler) throw new Error(`No mock route for ${url}`);
      return Promise.resolve(handler(init));
    });
  }

  it('exchanges client credentials for a bearer token and caches it', async () => {
    const provider = new TransatelProvider(prismaStub());
    route({ '/authentication/api/token': () => jsonResponse({ access_token: 'token-1', expires_in: 3600 }) });
    expect(await provider['getAccessToken']()).toBe('token-1');
    const [url, init] = fetchMock.mock.calls[0] as [string, FetchInit];
    expect(url).toBe('https://api.transatel.com/authentication/api/token');
    expect(init.method).toBe('POST');
    expect(init.headers?.['Authorization']).toMatch(/^Basic /);
    expect(init.body).toContain('grant_type=client_credentials');
    expect(await provider['getAccessToken']()).toBe('token-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects authentication when credentials are missing', async () => {
    delete process.env.TRANSATEL_CLIENT_SECRET;
    const provider = new TransatelProvider(prismaStub());
    const error = await provider['getAccessToken']().catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe('CONNECTIVITY_CONFIGURATION');
    expect((error as { message?: string }).message).toBe('Connectivity service is not fully configured.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('places an OCS preload order and returns the activation QR payload', async () => {
    const prisma = prismaStub();
    prisma.plan.findUnique = vi.fn().mockResolvedValue({ id: 'plan-1', providerPlanId: 'TRVL-5GB-15D' });
    prisma.esimInventory.findFirst = vi.fn().mockResolvedValue({ iccid: '8988247076000000319', eid: '890490320000000000000000000001' });
    const provider = new TransatelProvider(prisma);
    route({
      '/authentication/api/token': () => jsonResponse({ access_token: 'token-1', expires_in: 3600 }),
      '/ocs/subscriptions/api/orders/products': () => jsonResponse({ id: 'ord-1', orderReference: 'VC-REF', status: 'done', submissionDate: '2026-08-04T00:00:00Z', bind: { msisdn: '8988247076000000319' }, source: 'api', mvnoRef: 'visacompass-test', subscriptionId: 'sub-123' }),
      '/sim-management/sims/api/esims/sim-serial/8988247076000000319': () => jsonResponse({ simSerial: '8988247076000000319', status: 'downloaded', smdpAddress: 'consumer.rsp.world', qrCode: { value: 'LPA:1$consumer.rsp.world$ABC', dataUrl: 'data:image/png;base64,xxx' } }),
    });
    const result = await provider.provision({ orderId: 'order-1', planId: 'plan-1', eid: '890490320000000000000000000001', traveler });
    expect(result).toEqual({ providerSubscriptionId: 'sub-123', status: 'COMPLETED', qrPayload: 'LPA:1$consumer.rsp.world$ABC', smDpAddress: 'consumer.rsp.world' });
    const orderCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/api/orders/products'));
    expect(orderCall).toBeDefined();
    const payload = JSON.parse(String(orderCall![1].body));
    expect(payload).toMatchObject({ bind: { msisdn: '8988247076000000319' }, source: 'api', orderType: 'preload', mvnoRef: 'visacompass-test', product: { productId: 'TRVL-5GB-15D' }, payment: { provider: 'customer' }, transactionReference: 'order-1' });
    expect(prisma.esimInventory.findFirst).toHaveBeenCalledWith({ where: { OR: [{ assignedOrderId: 'order-1' }, { eid: '890490320000000000000000000001' }] } });
  });

  it('uses the stored MSISDN in bind.msisdn when present', async () => {
    const prisma = prismaStub();
    prisma.plan.findUnique = vi.fn().mockResolvedValue({ id: 'plan-1', providerPlanId: 'TRVL-5GB-15D' });
    prisma.esimInventory.findFirst = vi.fn().mockResolvedValue({ iccid: '8988247076000000319', eid: '890490320000000000000000000001', msisdn: '882470001850263' });
    const provider = new TransatelProvider(prisma);
    route({
      '/authentication/api/token': () => jsonResponse({ access_token: 'token-1', expires_in: 3600 }),
      '/ocs/subscriptions/api/orders/products': () => jsonResponse({ id: 'ord-1', orderReference: 'VC-REF', status: 'done', submissionDate: '2026-08-04T00:00:00Z', bind: { msisdn: '882470001850263' }, source: 'api', mvnoRef: 'visacompass-test', subscriptionId: 'sub-123' }),
      '/sim-management/sims/api/esims/sim-serial/8988247076000000319': () => jsonResponse({ simSerial: '8988247076000000319', status: 'downloaded', smdpAddress: 'consumer.rsp.world', qrCode: { value: 'LPA:1$consumer.rsp.world$ABC', dataUrl: 'data:image/png;base64,xxx' } }),
    });
    await provider.provision({ orderId: 'order-1', planId: 'plan-1', eid: '890490320000000000000000000001', traveler });
    const orderCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/api/orders/products'));
    const payload = JSON.parse(String(orderCall![1].body));
    expect(payload.bind).toEqual({ msisdn: '882470001850263' });
  });

  it('returns a DELAYED result when the QR payload is not yet available', async () => {
    const prisma = prismaStub();
    prisma.plan.findUnique = vi.fn().mockResolvedValue({ id: 'plan-1', providerPlanId: 'TRVL-5GB-15D' });
    prisma.esimInventory.findFirst = vi.fn().mockResolvedValue({ iccid: '8988247076000000319', eid: '890490320000000000000000000001' });
    const provider = new TransatelProvider(prisma);
    route({
      '/authentication/api/token': () => jsonResponse({ access_token: 'token-1', expires_in: 3600 }),
      '/ocs/subscriptions/api/orders/products': () => jsonResponse({ id: 'ord-1', orderReference: 'VC-REF', status: 'done', submissionDate: '2026-08-04T00:00:00Z', bind: { msisdn: '8988247076000000319' }, source: 'api', mvnoRef: 'visacompass-test', subscriptionId: 'sub-123' }),
      '/sim-management/sims/api/esims/sim-serial/8988247076000000319': () => jsonResponse({ simSerial: '8988247076000000319', status: 'allocated' }),
    });
    const result = await provider.provision({ orderId: 'order-1', planId: 'plan-1', eid: '890490320000000000000000000001', traveler });
    expect(result).toEqual({ providerSubscriptionId: 'sub-123', status: 'DELAYED' });
  });

  it('normalizes KB balances into used and total MB', async () => {
    const prisma = prismaStub();
    prisma.esimInventory.findFirst = vi.fn().mockResolvedValue({ iccid: '8988247076000000319' });
    const provider = new TransatelProvider(prisma);
    route({
      '/authentication/api/token': () => jsonResponse({ access_token: 'token-1', expires_in: 3600 }),
      '/ocs/inventory/api/subscriptions/products': () => jsonResponse({
        currentLocale: 'en_US',
        productSubscriptions: [{ subscriptionId: 'sub-1', status: 'active', balances: { data: [{ resourceName: 'DATA', resourceUnit: 'KB', resourceStartValue: 5242880, resourceValue: 1048576 }] } }],
      }),
    });
    const usage = await provider.getUsage(ORDER_UUID);
    expect(usage).toEqual({ usedMb: 4096, totalMb: 5120 });
    const url = String(fetchMock.mock.calls.find((call) => String(call[0]).includes('/api/subscriptions/products'))![0]);
    expect(url).toContain('msisdn=8988247076000000319');
    expect(url).toContain('withBalances=true');
  });

  it('returns the QR payload and SM-DP+ address from eSIM details', async () => {
    const prisma = prismaStub();
    prisma.esimInventory.findFirst = vi.fn().mockResolvedValue({ iccid: '8988247076000000319' });
    const provider = new TransatelProvider(prisma);
    route({
      '/authentication/api/token': () => jsonResponse({ access_token: 'token-1', expires_in: 3600 }),
      '/sim-management/sims/api/esims/sim-serial/8988247076000000319': () => jsonResponse({ simSerial: '8988247076000000319', status: 'downloaded', smdpAddress: 'consumer.rsp.world', qrCode: { value: 'LPA:1$consumer.rsp.world$XYZ', dataUrl: 'data:image/png;base64,xx' } }),
    });
    const details = await provider.getEsimDetails('8988247076000000319');
    expect(details).toEqual({ subscriptionId: '8988247076000000319', status: 'downloaded', smDpAddress: 'consumer.rsp.world', qrPayload: 'LPA:1$consumer.rsp.world$XYZ' });
  });

  it('retries once with a fresh token after a 401', async () => {
    const prisma = prismaStub();
    prisma.esimInventory.findFirst = vi.fn().mockResolvedValue({ iccid: '8988247076000000319' });
    let tokenCalls = 0;
    let productCalls = 0;
    const provider = new TransatelProvider(prisma);
    route({
      '/authentication/api/token': () => jsonResponse({ access_token: `token-${++tokenCalls}`, expires_in: 3600 }),
      '/ocs/inventory/api/subscriptions/products': () => {
        productCalls += 1;
        if (productCalls === 1) return jsonResponse({ error: 'invalid_token' }, 401);
        return jsonResponse({ currentLocale: 'en_US', productSubscriptions: [{ subscriptionId: 'sub-1', status: 'active', balances: { data: [{ resourceName: 'DATA', resourceUnit: 'KB', resourceStartValue: 1024, resourceValue: 1024 }] } }] });
      },
    });
    const usage = await provider.getUsage(ORDER_UUID);
    expect(usage).toEqual({ usedMb: 0, totalMb: 1 });
    expect(tokenCalls).toBe(2);
    expect(productCalls).toBe(2);
  });

  it('normalizes an OCS/PRODUCT/ACTIVATED webhook into a provider event', async () => {
    const prisma = prismaStub();
    prisma.order.findUnique = vi.fn().mockResolvedValue({ id: 'order-1' });
    const provider = new TransatelProvider(prisma);
    route({ '/authentication/api/token': () => jsonResponse({ access_token: 'token-1', expires_in: 3600 }) });
    const result = await provider.handleWebhook({
      header: { eventId: 'evt-1', eventType: 'OCS/PRODUCT/ACTIVATED', eventDate: '2026-08-04T00:00:00Z' },
      body: { mvnoRef: 'visacompass-test', cos: 'WW_COS_TEST', msisdn: '33612345678', iccid: '8988247076000000319', externalReference: 'order-1', productSubscription: { subscriptionId: 'sub-123', activationDate: '2026-08-04T13:30:00Z' } },
    });
    expect(result.handled).toBe(true);
    expect(result.event).toMatchObject({ eventType: 'OCS/PRODUCT/ACTIVATED', orderId: 'order-1', iccid: '8988247076000000319', externalReference: 'order-1', subscriptionId: 'sub-123', status: 'ACTIVATED', activatedAt: '2026-08-04T13:30:00Z' });
    expect(prisma.order.findUnique).toHaveBeenCalledWith({ where: { id: 'order-1' }, select: { id: true } });
    expect(prisma.esimInventory.findUnique).not.toHaveBeenCalled();
  });

  it('routes by externalReference (our order id) and not by ICCID', async () => {
    const prisma = prismaStub();
    prisma.order.findUnique = vi.fn().mockResolvedValue({ id: 'order-9' });
    prisma.esimInventory.findUnique = vi.fn().mockResolvedValue(null);
    const provider = new TransatelProvider(prisma);
    route({ '/authentication/api/token': () => jsonResponse({ access_token: 'token-1', expires_in: 3600 }) });
    const result = await provider.handleWebhook({
      header: { eventId: 'evt-2', eventType: 'OCS/PRODUCT/ACTIVATED' },
      body: { msisdn: '33612345678', iccid: '8988989996000000319', externalReference: 'order-9', productSubscription: { subscriptionId: 'sub-9' } },
    });
    expect(result.handled).toBe(true);
    expect(result.event?.orderId).toBe('order-9');
    expect(prisma.esimInventory.findUnique).not.toHaveBeenCalled();
  });

  it('falls back to ICCID inventory binding when externalReference matches no order', async () => {
    const prisma = prismaStub();
    prisma.order.findUnique = vi.fn().mockResolvedValue(null);
    prisma.esimInventory.findUnique = vi.fn().mockResolvedValue({ assignedOrderId: 'order-3' });
    const provider = new TransatelProvider(prisma);
    route({ '/authentication/api/token': () => jsonResponse({ access_token: 'token-1', expires_in: 3600 }) });
    const result = await provider.handleWebhook({
      header: { eventId: 'evt-3', eventType: 'OCS/PRODUCT/ACTIVATED' },
      body: { msisdn: '33612345678', iccid: '8988247076000000319', externalReference: 'unknown-ref', productSubscription: { subscriptionId: 'sub-3' } },
    });
    expect(result.handled).toBe(true);
    expect(result.event?.orderId).toBe('order-3');
    expect(prisma.esimInventory.findUnique).toHaveBeenCalledWith({ where: { iccid: '8988247076000000319' }, select: { assignedOrderId: true } });
  });

  it('acknowledges webhooks that reference an unknown ICCID as unhandled', async () => {
    const prisma = prismaStub();
    prisma.order.findUnique = vi.fn().mockResolvedValue(null);
    prisma.esimInventory.findUnique = vi.fn().mockResolvedValue(null);
    const provider = new TransatelProvider(prisma);
    const result = await provider.handleWebhook({ header: { eventId: 'evt-4', eventType: 'OCS/PRODUCT/ACTIVATED' }, body: { msisdn: '33612345678', iccid: '8988247076000000319' } });
    expect(result.handled).toBe(false);
    expect(result.reason).toContain('8988247076000000319');
  });

  it('rejects a webhook whose iccid is not present on body.iccid', async () => {
    const prisma = prismaStub();
    const provider = new TransatelProvider(prisma);
    route({ '/authentication/api/token': () => jsonResponse({ access_token: 'token-1', expires_in: 3600 }) });
    const result = await provider.handleWebhook({ header: { eventId: 'evt-5', eventType: 'OCS/PRODUCT/ACTIVATED' }, body: { subscription: { serialNumbers: ['8988247076000000319'] }, subscriptionId: 'sub-5' } });
    expect(result.handled).toBe(false);
    expect(result.reason).toContain('subscriber identifier');
  });

  it('maps an expiration webhook to an EXPIRED status', async () => {
    const prisma = prismaStub();
    prisma.order.findUnique = vi.fn().mockResolvedValue({ id: 'order-2' });
    const provider = new TransatelProvider(prisma);
    route({ '/authentication/api/token': () => jsonResponse({ access_token: 'token-1', expires_in: 3600 }) });
    const result = await provider.handleWebhook({ header: { eventId: 'evt-6', eventType: 'OCS/PRODUCT/EXPIRED' }, body: { msisdn: '33612345678', iccid: '8988247076000000319', externalReference: 'order-2', productSubscription: { subscriptionId: 'sub-2', expirationDate: '2026-08-19T00:00:00Z' } } });
    expect(result.event).toMatchObject({ status: 'EXPIRED', expiresAt: '2026-08-19T00:00:00Z' });
  });

  it('resolves the ICCID and dates from a real OCS webhook envelope', async () => {
    const prisma = prismaStub();
    prisma.order.findUnique = vi.fn().mockResolvedValue({ id: 'order-1' });
    prisma.esimInventory.findUnique = vi.fn().mockResolvedValue({ assignedOrderId: 'order-1' });
    const provider = new TransatelProvider(prisma);
    route({ '/authentication/api/token': () => jsonResponse({ access_token: 'token-1', expires_in: 3600 }) });
    const result = await provider.handleWebhook({
      header: { eventId: 'evt-7', eventType: 'OCS/PRODUCT/ACTIVATED', eventDate: '2026-08-04T13:30:00Z' },
      body: { mvnoRef: 'visacompass-test', cos: 'WW_COS_TEST', msisdn: '33612345678', iccid: '8988247076000000319', externalReference: 'order-1', productSubscription: { subscriptionId: 'sub-123', activationDate: '2026-08-04T13:30:00Z', expirationDate: '2026-09-03T13:30:00Z' } },
    });
    expect(result.handled).toBe(true);
    expect(result.event).toMatchObject({
      eventType: 'OCS/PRODUCT/ACTIVATED',
      orderId: 'order-1',
      iccid: '8988247076000000319',
      subscriptionId: 'sub-123',
      status: 'ACTIVATED',
      activatedAt: '2026-08-04T13:30:00Z',
      expiresAt: '2026-09-03T13:30:00Z',
    });
  });

  it('synchronizes catalog products into per-country plans', async () => {
    const tx = {
      country: { upsert: vi.fn().mockResolvedValue({ id: 'country-1' }) },
      plan: { upsert: vi.fn().mockResolvedValue({ id: 'plan-1' }) },
    };
    const prisma = prismaStub({ $transaction: vi.fn(async (fn: (transaction: unknown) => unknown) => fn(tx)) });
    const provider = new TransatelProvider(prisma);
    route({
      '/authentication/api/token': () => jsonResponse({ access_token: 'token-1', expires_in: 3600 }),
      '/ocs/catalog/api/cos/WW_COS_TEST/products': () => jsonResponse({
        cos: 'WW_COS_TEST',
        products: [{
          availability: { available: true },
          canSubscribe: { allowed: true },
          display: { priority: 1 },
          hasSubProducts: false,
          inventoryActive: false,
          prices: { subscriptionFee: [[{ currency: 'EUR', unit: 'CENTS', amount: 499 }]] },
          productDefinition: {
            productId: 'TRVL-5GB-15D',
            productCategory: 'One-off',
            allowances: { data: [{ resourceName: 'DATA', startValue: 5120, unit: 'MB' }] },
            countryList: ['GBR', 'FRA'],
            validityPeriod: { validityDuration: 15, validityDurationUnit: 'days' },
            description: { productLabel: 'Travel 5GB' },
          },
        }],
      }),
    });
    const result = await provider.syncCatalog();
    expect(result).toEqual({ synced: 2, skipped: 0 });
    expect(tx.plan.upsert).toHaveBeenCalledTimes(2);
    const planArgs = tx.plan.upsert.mock.calls.map((call) => call[0]);
    expect(planArgs[0].where).toEqual({ countryId_providerPlanId: { countryId: 'country-1', providerPlanId: 'TRVL-5GB-15D' } });
    expect(planArgs[0].create).toMatchObject({ name: 'Travel 5GB', dataAllowance: '5120 MB', validityDays: 15, costPrice: 5, sellingPrice: 5, providerPlanId: 'TRVL-5GB-15D', status: 'ACTIVE' });
  });

  it('parses subscription fees expressed in major units without dividing', async () => {
    const tx = {
      country: { upsert: vi.fn().mockResolvedValue({ id: 'country-1' }) },
      plan: { upsert: vi.fn().mockResolvedValue({ id: 'plan-1' }) },
    };
    const prisma = prismaStub({ $transaction: vi.fn(async (fn: (transaction: unknown) => unknown) => fn(tx)) });
    const provider = new TransatelProvider(prisma);
    route({
      '/authentication/api/token': () => jsonResponse({ access_token: 'token-1', expires_in: 3600 }),
      '/ocs/catalog/api/cos/WW_COS_TEST/products': () => jsonResponse({
        cos: 'WW_COS_TEST',
        products: [{
          availability: { available: true },
          canSubscribe: { allowed: true },
          display: { priority: 1 },
          hasSubProducts: false,
          inventoryActive: false,
          prices: { subscriptionFee: [[{ currency: 'EUR', unit: 'EURO', amount: 4.99 }]] },
          productDefinition: {
            productId: 'TRVL-EURO',
            productCategory: 'One-off',
            allowances: { data: [{ resourceName: 'DATA', startValue: 1024, unit: 'MB' }] },
            countryList: ['GBR'],
            validityPeriod: { validityDuration: 15, validityDurationUnit: 'days' },
            description: { productLabel: 'Euro price plan' },
          },
        }],
      }),
    });
    const result = await provider.syncCatalog();
    expect(result).toEqual({ synced: 1, skipped: 0 });
    const create = tx.plan.upsert.mock.calls[0]![0].create;
    expect(create.costPrice).toBe(5);
  });

  it('maps real catalog allowances using resourceValue/resourceUnit and prefers productShortText', async () => {
    const prisma = prismaStub();
    const provider = new TransatelProvider(prisma);
    route({
      '/authentication/api/token': () => jsonResponse({ access_token: 'token-1', expires_in: 3600 }),
      '/ocs/catalog/api/cos/WW_COS_TEST/products': () => jsonResponse({
        cos: 'WW_COS_TEST',
        products: [{
          availability: { available: true },
          canSubscribe: { allowed: true },
          display: { priority: 1 },
          hasSubProducts: false,
          inventoryActive: false,
          prices: { subscriptionFee: [[{ currency: 'EUR', unit: 'CENTS', amount: 1800 }]] },
          productDefinition: {
            productId: 'WW_901O_STACK_ONEOFF_AFG_1GB_7D',
            productCategory: 'One-off',
            allowances: { data: [{ resourceName: 'DATA_BUNDLE_COUNTRY', resourceUnit: 'KB', resourceValue: 1048576 }] },
            countryList: ['AFG'],
            validityPeriod: { validityDuration: 7, validityDurationUnit: 'days' },
            description: { productLabel: 'AFGHANISTAN', productShortText: 'One-off data plan Afghanistan 1GB 7 day(s)' },
          },
        }],
      }),
    });
    const { rows } = await provider.catalogReport();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      countryiso2: 'AF',
      name: 'One-off data plan Afghanistan 1GB 7 day(s)',
      dataallowance: '1024 MB',
      validitydays: 7,
      costprice: 18,
      sellingprice: 18,
      currency: 'NPR',
    });
  });

  it('registers a webhook when none exists for the target URL', async () => {
    process.env.TRANSATEL_WEBHOOK_TARGET_URL = 'https://api.visacompass.example/webhooks/connectivity/transatel';
    process.env.TRANSATEL_WEBHOOK_CONTACT_EMAIL = 'ops@visacompass.example';
    process.env.TRANSATEL_WEBHOOK_SECRET = 'webhook-secret';
    const provider = new TransatelProvider(prismaStub());
    route({
      '/authentication/api/token': () => jsonResponse({ access_token: 'token-1', expires_in: 3600 }),
      '/webhooks/api/webhooks': (init) => {
        if (init?.method === 'POST') return jsonResponse({ id: 'webhook-1', ...JSON.parse(String(init.body)) });
        return jsonResponse({ webhooks: [] });
      },
    });
    const result = await provider.ensureWebhook();
    expect(result.registered).toBe(true);
    expect(result.id).toBe('webhook-1');
    const createCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/webhooks/api/webhooks') && call[1]?.method === 'POST');
    expect(createCall).toBeDefined();
    expect(JSON.parse(String(createCall![1].body))).toMatchObject({
      mvnoRef: 'visacompass-test',
      status: 'active',
      targetUrl: 'https://api.visacompass.example/webhooks/connectivity/transatel',
      secret: 'webhook-secret',
      events: ['OCS/PRODUCT/PRELOADED', 'OCS/PRODUCT/ACTIVATED', 'OCS/PRODUCT/EXPIRED', 'OCS/PRODUCT/TERMINATED'],
    });
  });

  it('updates an existing webhook instead of creating a duplicate', async () => {
    process.env.TRANSATEL_WEBHOOK_TARGET_URL = 'https://api.visacompass.example/webhooks/connectivity/transatel';
    process.env.TRANSATEL_WEBHOOK_CONTACT_EMAIL = 'ops@visacompass.example';
    const provider = new TransatelProvider(prismaStub());
    route({
      '/authentication/api/token': () => jsonResponse({ access_token: 'token-1', expires_in: 3600 }),
      '/webhooks/api/webhooks': (init) => {
        if (init?.method === 'GET') return jsonResponse({ webhooks: [{ id: 'webhook-1', mvnoRef: 'visacompass-test', targetUrl: 'https://api.visacompass.example/webhooks/connectivity/transatel' }] });
        if (init?.method === 'PUT') return jsonResponse({ id: 'webhook-1', ...JSON.parse(String(init.body)) });
        throw new Error('Expected PUT, got POST');
      },
    });
    const result = await provider.ensureWebhook();
    expect(result.registered).toBe(true);
    expect(result.id).toBe('webhook-1');
    const putCall = fetchMock.mock.calls.find((call) => call[1]?.method === 'PUT');
    expect(putCall).toBeDefined();
    expect(String(putCall![0])).toContain('/webhooks/api/webhooks/webhook-1');
  });

  it('does not register a webhook when no target URL is configured', async () => {
    const provider = new TransatelProvider(prismaStub());
    const result = await provider.ensureWebhook();
    expect(result).toEqual({ registered: false, targetUrl: '', events: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports health based on the configured credentials', async () => {
    const provider = new TransatelProvider(prismaStub());
    expect((await provider.health()).ok).toBe(true);
    delete process.env.TRANSATEL_MVNO_REF;
    expect((await provider.health()).ok).toBe(false);
  });
});
