import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrderStatus, PaymentStatus } from '@visa-compass/shared';
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

function ordersService(seed: DemoOrder[], connectivity: unknown, inventory: unknown = {}) {
  const persistence = {
    load: vi.fn().mockResolvedValue(seed),
    save: vi.fn().mockResolvedValue(undefined),
  } as unknown as OrdersPersistenceService;
  return new OrdersService(
    connectivity as unknown as ConnectivityService,
    {} as unknown as CloudinaryStorageService,
    persistence,
    inventory as unknown as InventoryService,
    {} as unknown as QueueService,
    {} as unknown as NotificationService,
    {} as unknown as CatalogService,
    { enabled: false } as unknown as PrismaService,
    {} as unknown as QrPdfService,
  );
}

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