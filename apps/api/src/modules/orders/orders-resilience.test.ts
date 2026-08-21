import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { ApiErrorCode, OrderStatus, PaymentStatus } from '@visa-compass/shared';
import { ApiException } from '../../common/api-error.js';
import { QUEUES } from '../../jobs/queues.js';
import { OrdersService, type DemoOrder } from './orders.service.js';
import type { ConnectivityService } from '../integration/connectivity.service.js';
import type { CloudinaryStorageService } from '../../infrastructure/cloudinary-storage.service.js';
import type { OrdersPersistenceService } from './orders-persistence.service.js';
import type { InventoryService } from '../inventory/inventory.service.js';
import type { QueueService } from '../../jobs/queue.service.js';
import type { NotificationService } from '../notification/notification.service.js';
import type { CatalogService } from '../catalog/catalog.controller.js';
import type { PrismaService } from '../../infrastructure/prisma.service.js';
import type { QrPdfService } from '../notification/qr-pdf.service.js';
import type { PassportVerificationService } from './passport-verification.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { PaymentSimulatorGateway } from '../payments/gateways/simulator.gateway.js';
import type { KhaltiGateway } from '../payments/gateways/khalti.gateway.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function readyOrder(overrides: Partial<DemoOrder> = {}): DemoOrder {
  const now = Date.now();
  return {
    id: 'q-1',
    ownerId: null,
    orderNumber: 'VC-2026-R1',
    status: OrderStatus.QR_READY,
    version: 0,
    plan: { id: 'plan-1', name: 'Nepal 5GB', sellingPriceNpr: 1000, dataAllowance: '5 GB', validityDays: 7, countryCode: 'NP', countryName: 'Nepal' },
    totalAmountNpr: 1000,
    pricingSnapshot: {},
    compatibilityAcceptedAt: new Date(now - 3_600_000).toISOString(),
    documents: [],
    timeline: [],
    createdAt: new Date(now - 3_600_000).toISOString(),
    qrDeliveredAt: new Date(now - 10 * 86_400_000).toISOString(),
    providerSubscriptionId: 'sub-1',
    providerStatus: 'PRELOADED',
    ...overrides,
  } as unknown as DemoOrder;
}

function ordersService(seed: DemoOrder[], connectivity: unknown, inventory: unknown = { release: vi.fn().mockResolvedValue(undefined) }, prisma: unknown = { enabled: false }, queues: unknown = {}) {
  const persistence = {
    load: vi.fn().mockResolvedValue(seed),
    save: vi.fn().mockResolvedValue(undefined),
    provisioningAttempt: vi.fn().mockResolvedValue(undefined),
  } as unknown as OrdersPersistenceService;
  return new OrdersService(
    connectivity as unknown as ConnectivityService,
    {} as unknown as CloudinaryStorageService,
    persistence,
    inventory as unknown as InventoryService,
    queues as unknown as QueueService,
    {} as unknown as NotificationService,
    {} as unknown as CatalogService,
    prisma as unknown as PrismaService,
    {} as unknown as QrPdfService,
    {} as unknown as PassportVerificationService,
  );
}

describe('OrdersService provisioning retry safety', () => {
  it('blocks a retry when Transatel may already have accepted the order', async () => {
    const order = readyOrder({ id: 'failed-1', status: OrderStatus.PROVISIONING_FAILED });
    const prisma = { enabled: true, provisioningOperation: { findUnique: vi.fn().mockResolvedValue({ state: 'WAITING_FOR_QR', providerOrderId: 'provider-order-1', providerSubscriptionId: 'sub-1' }) } };
    const orders = ordersService([order], {}, undefined, prisma);
    await orders.refreshFromPersistence();

    await expect(orders.retry(order.id)).rejects.toThrow('Reconcile its live status');
  });
});

describe('OrdersService asynchronous provisioning', () => {
  it('keeps an accepted delayed preload in PROVISIONING without retrying or releasing inventory', async () => {
    const order = readyOrder({
      id: 'p-1',
      status: OrderStatus.PROVISIONING,
      traveler: { title: 'MS', firstName: 'Jane', surname: 'Doe', dateOfBirth: '1990-01-01', nationality: 'NP', email: 'jane@example.com', mobile: '9779800000000', city: 'Kathmandu', countryOfResidence: 'NP', passportNumber: 'P1234567', passportExpiryDate: '2030-01-01' },
    });
    delete order.qrDeliveredAt;
    delete order.providerSubscriptionId;
    delete order.providerStatus;
    const connectivity = {
      provision: vi.fn().mockResolvedValue({ providerSubscriptionId: 'sub-accepted', status: 'DELAYED' }),
      descriptor: vi.fn().mockReturnValue({ provider: 'TRANSATEL', capabilities: {} }),
    } as unknown as ConnectivityService;
    const inventory = {
      profileForOrder: vi.fn().mockResolvedValue({ id: 'inv-1', eid: 'eid-1', iccid: '8988247076000000319' }),
      release: vi.fn(),
    } as unknown as InventoryService;
    const orders = ordersService([order], connectivity, inventory);
    await orders.refreshFromPersistence();

    await orders.processProvisioning('p-1', 1, false);

    expect(orders.get('p-1')).toMatchObject({ status: OrderStatus.PROVISIONING, providerSubscriptionId: 'sub-accepted', providerStatus: 'PRELOADED' });
    expect(inventory.release).not.toHaveBeenCalled();
    expect(connectivity.provision).toHaveBeenCalledOnce();
  });

  it('marks an out-of-stock order PROVISIONING_FAILED with a safe reason on the final attempt', async () => {
    const order = readyOrder({
      id: 'stock-1',
      orderNumber: 'VC-2026-R3',
      status: OrderStatus.PROVISIONING,
      traveler: { title: 'MR', firstName: 'Sam', surname: 'Rai', dateOfBirth: '1988-05-05', nationality: 'NP', email: 'sam@example.com', mobile: '9779800000001', city: 'Kathmandu', countryOfResidence: 'NP', passportNumber: 'P7654321', passportExpiryDate: '2030-01-01' },
    });
    delete order.qrDeliveredAt;
    delete order.providerSubscriptionId;
    delete order.providerStatus;
    const connectivity = { provision: vi.fn(), descriptor: vi.fn().mockReturnValue({ provider: 'TRANSATEL', capabilities: {} }) } as unknown as ConnectivityService;
    const inventory = {
      profileForOrder: vi.fn().mockRejectedValue(new ConflictException('No eSIM inventory is currently available')),
      release: vi.fn(),
    } as unknown as InventoryService;
    const orders = ordersService([order], connectivity, inventory);
    await orders.refreshFromPersistence();

    await expect(orders.processProvisioning('stock-1', 3, true)).rejects.toThrow('No eSIM inventory is currently available');

    const failed = orders.get('stock-1');
    expect(failed.status).toBe(OrderStatus.PROVISIONING_FAILED);
    expect(failed.provisioningFailure).toEqual({ code: 'INVENTORY_UNAVAILABLE', message: expect.any(String) });
    expect(connectivity.provision).not.toHaveBeenCalled();
    expect(inventory.release).toHaveBeenCalledWith('stock-1');
  });

  it('stays PROVISIONING (retryable) when out of stock before the final attempt', async () => {
    const order = readyOrder({
      id: 'stock-2',
      orderNumber: 'VC-2026-R4',
      status: OrderStatus.PROVISIONING,
      traveler: { title: 'MR', firstName: 'Sam', surname: 'Rai', dateOfBirth: '1988-05-05', nationality: 'NP', email: 'sam@example.com', mobile: '9779800000001', city: 'Kathmandu', countryOfResidence: 'NP', passportNumber: 'P7654321', passportExpiryDate: '2030-01-01' },
    });
    delete order.qrDeliveredAt;
    delete order.providerSubscriptionId;
    delete order.providerStatus;
    const connectivity = { provision: vi.fn(), descriptor: vi.fn().mockReturnValue({ provider: 'TRANSATEL', capabilities: {} }) } as unknown as ConnectivityService;
    const inventory = {
      profileForOrder: vi.fn().mockRejectedValue(new ConflictException('No eSIM inventory is currently available')),
      release: vi.fn(),
    } as unknown as InventoryService;
    const orders = ordersService([order], connectivity, inventory);
    await orders.refreshFromPersistence();

    await expect(orders.processProvisioning('stock-2', 1, false)).rejects.toThrow('No eSIM inventory is currently available');

    expect(orders.get('stock-2').status).toBe(OrderStatus.PROVISIONING);
    expect(orders.get('stock-2').provisioningFailure).toBeUndefined();
    expect(inventory.release).not.toHaveBeenCalled();
  });

  it('auto-fails over to the next profile on a permanent rejection instead of failing the order', async () => {
    const order = readyOrder({
      id: 'swap-1',
      orderNumber: 'VC-2026-R5',
      status: OrderStatus.PROVISIONING,
      traveler: { title: 'MS', firstName: 'Aisha', surname: 'Gurung', dateOfBirth: '1992-02-02', nationality: 'NP', email: 'aisha@example.com', mobile: '9779800000002', city: 'Pokhara', countryOfResidence: 'NP', passportNumber: 'P3333333', passportExpiryDate: '2030-01-01' },
    });
    delete order.qrDeliveredAt;
    delete order.providerSubscriptionId;
    delete order.providerStatus;
    const connectivity = {
      provision: vi.fn().mockRejectedValue(new ApiException({ code: ApiErrorCode.PROVISIONING_FAILED, message: 'We could not activate your eSIM right now.', status: 502, details: 'PERMANENT_INPUT: OCS product activation failed: SUBSCRIBER_STATUS_NOT_ELIGIBLE' })),
      descriptor: vi.fn().mockReturnValue({ provider: 'TRANSATEL', capabilities: {} }),
    } as unknown as ConnectivityService;
    const inventory = {
      profileForOrder: vi.fn().mockResolvedValue({ id: 'inv-1', eid: 'eid-1', iccid: 'OLDICCID' }),
      release: vi.fn().mockResolvedValue(undefined),
      reserveExcluding: vi.fn().mockResolvedValue({ id: 'inv-2', eid: 'eid-2', iccid: 'NEWICCID' }),
    } as unknown as InventoryService;
    const prisma = {
      enabled: true,
      provisioningOperation: { findUnique: vi.fn().mockResolvedValue({ profileSwapCount: 0 }), update: vi.fn().mockResolvedValue({ profileSwapCount: 1 }) },
    } as unknown as PrismaService;
    const queues = { enabled: true, add: vi.fn().mockResolvedValue(undefined) } as unknown as QueueService;
    const orders = ordersService([order], connectivity, inventory, prisma, queues);
    await orders.refreshFromPersistence();

    await orders.processProvisioning('swap-1', 1, false);

    expect(orders.get('swap-1').status).toBe(OrderStatus.PROVISIONING);
    expect(orders.get('swap-1').providerStatus).toBeUndefined();
    expect(inventory.release).toHaveBeenCalledWith('swap-1');
    expect(inventory.reserveExcluding).toHaveBeenCalledWith('swap-1', 'OLDICCID');
    expect(queues.add).toHaveBeenCalledWith(QUEUES.provisioning, 'provision-order', { orderId: 'swap-1' }, expect.stringMatching(/swap-1/));
    expect(orders.get('swap-1').timeline.some((event) => event.reason?.includes('NEWICCID'))).toBe(true);
    expect(prisma.provisioningOperation.update).toHaveBeenCalled();
  });

  it('fails the order once the provisioning swap budget is exhausted', async () => {
    const order = readyOrder({
      id: 'swap-2',
      orderNumber: 'VC-2026-R6',
      status: OrderStatus.PROVISIONING,
      traveler: { title: 'MR', firstName: 'Dawa', surname: 'Sherpa', dateOfBirth: '1985-03-03', nationality: 'NP', email: 'dawa@example.com', mobile: '9779800000003', city: 'Kathmandu', countryOfResidence: 'NP', passportNumber: 'P4444444', passportExpiryDate: '2030-01-01' },
    });
    delete order.qrDeliveredAt;
    delete order.providerSubscriptionId;
    delete order.providerStatus;
    const connectivity = {
      provision: vi.fn().mockRejectedValue(new ApiException({ code: ApiErrorCode.PROVISIONING_FAILED, message: 'We could not activate your eSIM right now.', status: 502, details: 'PERMANENT_ELIGIBILITY: OCS product activation failed: SUBSCRIBER_STATUS_NOT_ELIGIBLE' })),
      descriptor: vi.fn().mockReturnValue({ provider: 'TRANSATEL', capabilities: {} }),
    } as unknown as ConnectivityService;
    const inventory = {
      profileForOrder: vi.fn().mockResolvedValue({ id: 'inv-1', eid: 'eid-1', iccid: 'OLDICCID' }),
      release: vi.fn().mockResolvedValue(undefined),
      reserveExcluding: vi.fn().mockResolvedValue({ id: 'inv-2', eid: 'eid-2', iccid: 'NEWICCID' }),
    } as unknown as InventoryService;
    const prisma = {
      enabled: true,
      provisioningOperation: { findUnique: vi.fn().mockResolvedValue({ profileSwapCount: 2 }), update: vi.fn().mockResolvedValue({ profileSwapCount: 3 }) },
    } as unknown as PrismaService;
    const queues = { enabled: true, add: vi.fn().mockResolvedValue(undefined) } as unknown as QueueService;
    const orders = ordersService([order], connectivity, inventory, prisma, queues);
    await orders.refreshFromPersistence();

    await expect(orders.processProvisioning('swap-2', 1, false)).rejects.toThrow();

    expect(orders.get('swap-2').status).toBe(OrderStatus.PROVISIONING_FAILED);
    expect(inventory.release).toHaveBeenCalledWith('swap-2');
    expect(inventory.reserveExcluding).not.toHaveBeenCalled();
    expect(queues.add).not.toHaveBeenCalled();
  });

  it('adopts an in-memory replacement that lands while the provider call is in flight', async () => {
    const order = readyOrder({
      id: 'race-1',
      orderNumber: 'VC-2026-R7',
      status: OrderStatus.PROVISIONING,
      traveler: { title: 'MR', firstName: 'Bikash', surname: 'Tamang', dateOfBirth: '1990-04-04', nationality: 'NP', email: 'bikash@example.com', mobile: '9779800000004', city: 'Kathmandu', countryOfResidence: 'NP', passportNumber: 'P5555555', passportExpiryDate: '2030-01-01' },
    });
    delete order.qrDeliveredAt;
    delete order.providerSubscriptionId;
    delete order.providerStatus;
    let resolveProvision!: (value: unknown) => void;
    const connectivity = {
      provision: vi.fn().mockImplementation(() => new Promise((resolve) => { resolveProvision = resolve; })),
      descriptor: vi.fn().mockReturnValue({ provider: 'TRANSATEL', capabilities: {} }),
    } as unknown as ConnectivityService;
    const inventory = {
      profileForOrder: vi.fn().mockResolvedValue({ id: 'inv-1', eid: 'eid-1', iccid: 'RACEICCID' }),
      release: vi.fn().mockResolvedValue(undefined),
      assign: vi.fn().mockResolvedValue(undefined),
      customerIdForOrder: vi.fn().mockResolvedValue('cust-1'),
      inventoryForOrder: vi.fn().mockResolvedValue({ id: 'inv-1', iccid: 'RACEICCID' }),
    } as unknown as InventoryService;
    const queues = { enabled: true, add: vi.fn().mockResolvedValue(undefined) } as unknown as QueueService;
    const orders = ordersService([order], connectivity, inventory, { enabled: false }, queues);
    await orders.refreshFromPersistence();

    const pending = orders.processProvisioning('race-1', 1, false);
    // Concurrent payment verification replaces the in-memory entry (refreshOne)
    await vi.waitFor(() => expect(connectivity.provision).toHaveBeenCalled());
    const internal = orders as unknown as { orders: Map<string, DemoOrder> };
    const replacement = structuredClone(internal.orders.get('race-1')) as DemoOrder;
    internal.orders.set('race-1', replacement);
    resolveProvision({ providerSubscriptionId: 'sub-race', status: 'COMPLETED', qrPayload: 'LPA:1$race' });
    await pending;

    expect(orders.get('race-1').status).toBe(OrderStatus.QR_READY);
    expect(orders.get('race-1').qrPayload).toBe('LPA:1$race');
  });
});

describe('OrdersService.reconcileStaleActivationOrders', () => {
  it('recovers a stale QR_READY order when the provider now reports activation details', async () => {
    vi.stubEnv('ACTIVATION_REFETCH_ATTEMPTS', '3');
    const connectivity = {
      descriptor: () => ({ provider: 'MOCK', capabilities: { esimDetails: true } }),
      getEsimDetails: vi.fn().mockResolvedValue({ subscriptionId: 'sub-1', status: 'downloaded', qrPayload: 'LPA:1$recovered' }),
    } as unknown as ConnectivityService;
    const inventory = {
      customerIdForOrder: vi.fn().mockResolvedValue('cust-1'),
      assign: vi.fn().mockResolvedValue(undefined),
      applyLifecycle: vi.fn().mockResolvedValue(undefined),
      inventoryForOrder: vi.fn().mockResolvedValue({ id: 'inventory-1', iccid: '8900000000000000001', msisdn: '882470001' }),
    } as unknown as InventoryService;
    const orders = ordersService([readyOrder()], connectivity, inventory);
    await orders.refreshFromPersistence();

    const result = await orders.reconcileStaleActivationOrders();

    expect(result.recovered).toEqual(['q-1']);
    expect(result.failed).toEqual([]);
    expect(orders.get('q-1').status).toBe(OrderStatus.COMPLETED);
    expect(connectivity.getEsimDetails).toHaveBeenCalledWith('sub-1');
    expect(inventory.assign).toHaveBeenCalled();
    expect(inventory.applyLifecycle).toHaveBeenCalled();
  });

  it('fails the order only once the re-fetch budget is exhausted without activation', async () => {
    vi.stubEnv('ACTIVATION_REFETCH_ATTEMPTS', '1');
    const connectivity = {
      descriptor: () => ({ provider: 'MOCK', capabilities: { esimDetails: true } }),
      getEsimDetails: vi.fn().mockResolvedValue({ subscriptionId: 'sub-1', status: 'allocated' }),
    } as unknown as ConnectivityService;
    const orders = ordersService([readyOrder({ id: 'q-2', orderNumber: 'VC-2026-R2' })], connectivity);
    await orders.refreshFromPersistence();

    await orders.reconcileStaleActivationOrders();
    expect(orders.get('q-2').status).toBe(OrderStatus.QR_READY);

    const result = await orders.reconcileStaleActivationOrders();
    expect(result.failed).toEqual(['q-2']);
    expect(orders.get('q-2').status).toBe(OrderStatus.PROVISIONING_FAILED);
  });

  it('ignores non-stale QR_READY orders', async () => {
    vi.stubEnv('ACTIVATION_REFETCH_ATTEMPTS', '1');
    const connectivity = {
      descriptor: () => ({ provider: 'MOCK', capabilities: { esimDetails: true } }),
      getEsimDetails: vi.fn().mockResolvedValue({ subscriptionId: 'sub-1', qrPayload: 'LPA:1$x' }),
    } as unknown as ConnectivityService;
    const orders = ordersService([readyOrder({ qrDeliveredAt: new Date().toISOString() })], connectivity);
    await orders.refreshFromPersistence();

    const result = await orders.reconcileStaleActivationOrders();

    expect(result.recovered).toEqual([]);
    expect(orders.get('q-1').status).toBe(OrderStatus.QR_READY);
    expect(connectivity.getEsimDetails).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.reconcilePendingPayments', () => {
  function paymentsOrders(order: Record<string, unknown>) {
    return {
      list: vi.fn().mockReturnValue([order]),
      confirmPayment: vi.fn().mockResolvedValue({}),
      resolvePaymentFailure: vi.fn().mockResolvedValue({}),
    } as unknown as OrdersService;
  }

  function expiredPendingOrder(reference: string): Record<string, unknown> {
    return {
      id: 'order-1',
      orderNumber: 'VC-1001',
      status: OrderStatus.PAYMENT_PENDING,
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      totalAmountNpr: 1000,
      payment: { reference, status: PaymentStatus.PENDING, expiresAt: new Date(Date.now() - 60_000).toISOString() },
    };
  }

  it('recovers a payment that completed server-side but whose callback was dropped', async () => {
    vi.stubEnv('PAYMENT_VERIFY_ATTEMPTS', '3');
    const gateway = new PaymentSimulatorGateway();
    const initiation = await gateway.initiate({ orderId: 'order-1', orderNumber: 'VC-1001', amountNpr: 1000, returnUrl: 'http://localhost:3000/esim/checkout' });
    gateway.complete(initiation.reference);
    const orders = paymentsOrders(expiredPendingOrder(initiation.reference));
    const payments = new PaymentsService(orders, {} as unknown as KhaltiGateway, gateway);

    const result = await payments.reconcilePendingPayments();

    expect(result.verified).toEqual(['order-1']);
    expect(result.failed).toEqual([]);
    expect(orders.confirmPayment).toHaveBeenCalledWith('order-1', initiation.reference, `sim-${initiation.reference}`);
    expect(orders.resolvePaymentFailure).not.toHaveBeenCalled();
  });

  it('defers the verdict while the gateway is unreachable, then fails', async () => {
    vi.stubEnv('PAYMENT_VERIFY_ATTEMPTS', '2');
    vi.stubEnv('PAYMENT_MODE', 'sandbox');
    const khalti = { verify: vi.fn().mockRejectedValue(new Error('provider down')) } as unknown as KhaltiGateway;
    const orders = paymentsOrders(expiredPendingOrder('pidx-1'));
    const payments = new PaymentsService(orders, khalti, {} as unknown as PaymentSimulatorGateway);

    const first = await payments.reconcilePendingPayments();
    expect(first.deferred).toEqual(['order-1']);
    expect(orders.resolvePaymentFailure).not.toHaveBeenCalled();

    const second = await payments.reconcilePendingPayments();
    expect(second.failed).toEqual(['order-1']);
    expect(orders.resolvePaymentFailure).toHaveBeenCalledWith('order-1', null, expect.any(String));
  });
});
