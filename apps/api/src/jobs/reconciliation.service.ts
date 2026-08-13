import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { ConnectivityService } from '../modules/integration/connectivity.service.js';
import { NotificationService } from '../modules/notification/notification.service.js';
import { MetricsService } from '../observability/metrics.service.js';
import { QueueService } from './queue.service.js';
import { QUEUES } from './queues.js';
import { OrdersService } from '../modules/orders/orders.service.js';
import { PaymentsService } from '../modules/payments/payments.service.js';
import { InventoryService } from '../modules/inventory/inventory.service.js';
import { TransatelOperationsService } from '../modules/integration/transatel-operations.service.js';

/**
 * Background reconciliation of active Transatel subscriptions.
 *
 * Periodically scans active subscriptions whose usage is stale, then polls the
 * connectivity provider for fresh usage balances and persists them. Jobs are
 * processed through the queue (or in-process when the queue is simulated) and
 * are idempotent per subscription id.
 */
@Injectable()
export class ReconciliationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationService.name);
  private timer?: ReturnType<typeof setInterval>;
  private pendingPaymentTimer?: ReturnType<typeof setInterval>;
  private repairedReusableInventory = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectivity: ConnectivityService,
    private readonly queues: QueueService,
    private readonly notifications: NotificationService,
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
    private readonly inventory: InventoryService,
    private readonly transatelOperations: TransatelOperationsService,
    private readonly metrics?: MetricsService,
  ) {}

  onModuleInit() {
    this.queues.registerWorker(QUEUES.reconciliation, (job) => {
      const data = job.data as { id: string; kind?: string };
      return data.kind === 'inventory-profile' ? this.inventory.reconcileProviderProfile(String(data.id)) : this.reconcile(String(data.id));
    });
    const minutes = Number(process.env.RECONCILIATION_INTERVAL_MINUTES ?? 15);
    const intervalMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 15 * 60_000;
    this.timer = setInterval(() => void this.runAsLeader().catch(() => undefined), intervalMs);
    void this.runAsLeader().catch(() => undefined);
    // Separate, faster sweep for pending payments that are still inside their
    // payment window (PAYMENT_RECONCILE_INTERVAL_SECONDS, default 45s). This is
    // a backstop for browser verification: it confirms Completed payments and
    // leaves Pending ones alone. It is kept apart from the expiry-phase
    // reconcile so a normal pending result is never treated as a failure. On
    // Render this only runs while the instance is awake — the browser return
    // (which wakes the API) plus an external health cron are the primary
    // recovery path.
    const pendingSeconds = Number(process.env.PAYMENT_RECONCILE_INTERVAL_SECONDS ?? 45);
    const pendingMs = Number.isFinite(pendingSeconds) && pendingSeconds > 0 ? pendingSeconds * 1000 : 45_000;
    this.pendingPaymentTimer = setInterval(() => void this.pendingPaymentsAsLeader().catch(() => undefined), pendingMs);
    void this.pendingPaymentsAsLeader().catch(() => undefined);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.pendingPaymentTimer) clearInterval(this.pendingPaymentTimer);
  }

  private async runAsLeader() {
    const result = await this.queues.withDistributedLock('reconciliation', 10 * 60_000, () => this.run());
    if (!result.acquired) this.logger.debug('Skipped reconciliation; another replica holds the lease');
    return result.value;
  }

  private async pendingPaymentsAsLeader() {
    const result = await this.queues.withDistributedLock('pending-payment-reconciliation', 60_000, () => this.payments.reconcileRecentPendingPayments());
    if (!result.acquired) this.logger.debug('Skipped pending-payment reconciliation; another replica holds the lease');
    return result.value;
  }

  private async run() {
    await this.reconcileProvisioningOperations();
    await this.reconcileLifecycleOperations();
    await this.orders.reconcileStaleActivationOrders();
    await this.orders.recoverStuckProvisioningOrders();
    await this.payments.reconcilePendingPayments();
    if (!this.prisma.enabled) return;
    if (!this.repairedReusableInventory) { await this.repairReusableEsims(); this.repairedReusableInventory = true; }
    await this.sweepLifecycle();
    await this.queueInventoryReconciliation();
    const subscriptions = await this.prisma.subscription.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        usageLastCheckedAt: true,
        customerEsim: { select: { inventory: { select: { iccid: true } } } },
      },
      take: 500,
    });
    if (!subscriptions.length) return;
    const minutes = Number(process.env.RECONCILIATION_INTERVAL_MINUTES ?? 15);
    const stalenessMs = (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60_000;
    const now = Date.now();
    let queued = 0;
    for (const subscription of subscriptions) {
      if (!subscription.customerEsim?.inventory?.iccid) continue;
      const lastChecked = subscription.usageLastCheckedAt?.getTime();
      if (lastChecked && now - lastChecked < stalenessMs) continue;
      await this.queues.add(
        QUEUES.reconciliation,
        'reconcile-usage',
        { id: subscription.id },
        `reconcile-${subscription.id}-${now}`,
      );
      queued += 1;
      if (!this.queues.enabled) await this.reconcile(subscription.id);
    }
    if (queued) this.logger.log(`Queued ${queued} subscription usage reconciliation job(s)`);
  }

  private async reconcileLifecycleOperations() {
    if (!this.prisma.enabled) return;
    const operations = await this.prisma.transatelLifecycleOperation.findMany({ where: { state: { in: ['ACCEPTED', 'RECONCILE_REQUIRED'] } }, select: { orderId: true }, distinct: ['orderId'], take: 100 });
    for (const operation of operations) {
      await this.transatelOperations.reconcile(operation.orderId).catch((error) => {
        this.metrics?.recordFailure('reconciliation', 'transatel-lifecycle');
        this.logger.warn(`Lifecycle reconciliation failed for ${operation.orderId}: ${error instanceof Error ? error.message : 'unknown error'}`);
      });
    }
  }

  private async queueInventoryReconciliation() {
    const batchSize = Math.min(100, Math.max(1, Number(process.env.TRANSATEL_INVENTORY_RECONCILE_BATCH_SIZE ?? 25)));
    const staleHours = Math.max(1, Number(process.env.TRANSATEL_INVENTORY_RECONCILE_HOURS ?? 24));
    const staleBefore = new Date(Date.now() - staleHours * 60 * 60_000);
    const profiles = await this.prisma.esimInventory.findMany({
      where: { assignedOrderId: null, status: { in: ['IMPORTED', 'AVAILABLE', 'QUARANTINED'] }, OR: [{ lastProviderCheckedAt: null }, { lastProviderCheckedAt: { lte: staleBefore } }] },
      select: { id: true },
      orderBy: [{ lastProviderCheckedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
      take: batchSize,
    });
    for (const profile of profiles) {
      await this.queues.add(QUEUES.reconciliation, 'reconcile-inventory-profile', { id: profile.id, kind: 'inventory-profile' }, `inventory-reconcile-${profile.id}-${new Date().toISOString().slice(0, 13)}`);
      if (!this.queues.enabled) await this.inventory.reconcileProviderProfile(profile.id).catch(() => undefined);
    }
  }

  private async reconcileProvisioningOperations() {
    if (!this.prisma.enabled) return;
    const now = new Date();
    const operations = await this.prisma.provisioningOperation.findMany({
      where: { state: { in: ['SUBMITTING', 'ACCEPTED', 'WAITING_FOR_QR', 'RECONCILE_REQUIRED'] }, OR: [{ nextReconcileAt: null }, { nextReconcileAt: { lte: now } }] },
      include: { order: { select: { id: true, providerSubscriptionId: true } } },
      take: 200,
    });
    for (const operation of operations) {
      if (operation.reconcileDeadlineAt && operation.reconcileDeadlineAt <= now) {
        await this.prisma.provisioningOperation.update({ where: { id: operation.id }, data: { state: 'MANUAL_REVIEW', nextReconcileAt: null, lastErrorCategory: 'RECONCILIATION_DEADLINE', lastErrorMessage: 'Automatic reconciliation deadline elapsed', version: { increment: 1 } } });
        await this.orders.markProvisioningManualReview(operation.orderId, 'Transatel submission requires manual reconciliation; inventory remains quarantined');
        continue;
      }
      try {
        const details = await this.connectivity.getEsimDetails(operation.iccid);
        const qrPayload = 'qrPayload' in details ? details.qrPayload : undefined;
        if (qrPayload && operation.order.providerSubscriptionId && details.status.toLowerCase() === 'active') {
          await this.orders.applyProviderEvent({ eventType: 'AUTOMATIC_RECONCILIATION', orderId: operation.orderId, iccid: operation.iccid, subscriptionId: operation.order.providerSubscriptionId, status: 'ACTIVATED', qrPayload });
          await this.prisma.provisioningOperation.update({ where: { id: operation.id }, data: { state: 'ACTIVATED', completedAt: new Date(), nextReconcileAt: null, lastErrorCategory: null, lastErrorMessage: null, version: { increment: 1 } } });
          continue;
        }
        const nextState = operation.order.providerSubscriptionId ? (qrPayload ? 'QR_READY' : 'WAITING_FOR_QR') : 'RECONCILE_REQUIRED';
        await this.prisma.provisioningOperation.update({ where: { id: operation.id }, data: { state: nextState, nextReconcileAt: new Date(Date.now() + 5 * 60_000), lastErrorCategory: null, lastErrorMessage: null, version: { increment: 1 } } });
      } catch (error) {
        await this.prisma.provisioningOperation.update({ where: { id: operation.id }, data: { nextReconcileAt: new Date(Date.now() + 5 * 60_000), lastErrorCategory: 'TRANSIENT_PROVIDER', lastErrorMessage: error instanceof Error ? error.message.slice(0, 2000) : 'unknown error', version: { increment: 1 } } });
        this.metrics?.recordFailure('reconciliation', 'provisioning-operation');
      }
    }
  }

  /** An explicit, audited Ops recovery path for a delayed or dead-lettered
   * provider submission. It reconciles one order only; it never re-submits a
   * preload command, so an uncertain provider outcome cannot create a second
   * subscription. */
  async reconcileProvisioningOperationNow(operationId: string) {
    if (!this.prisma.enabled) throw new Error('Provisioning reconciliation requires database persistence');
    const operation = await this.prisma.provisioningOperation.findUnique({ where: { id: operationId }, include: { order: { select: { id: true, providerSubscriptionId: true, status: true } } } });
    if (!operation) throw new Error('Provisioning operation not found');
    if (!['ACCEPTED', 'WAITING_FOR_QR', 'RECONCILE_REQUIRED', 'MANUAL_REVIEW'].includes(operation.state)) throw new Error(`Operation in ${operation.state} cannot be reconciled`);
    const details = await this.connectivity.getEsimDetails(operation.iccid);
    const qrPayload = 'qrPayload' in details ? details.qrPayload : undefined;
    const providerSubscriptionId = operation.order.providerSubscriptionId ?? operation.providerSubscriptionId;
    if (qrPayload && providerSubscriptionId && details.status.toLowerCase() === 'active') {
      await this.orders.applyProviderEvent({ eventType: 'OPS_MANUAL_RECONCILIATION', orderId: operation.orderId, iccid: operation.iccid, subscriptionId: providerSubscriptionId, status: 'ACTIVATED', qrPayload });
      await this.prisma.provisioningOperation.update({ where: { id: operation.id }, data: { state: 'ACTIVATED', completedAt: new Date(), nextReconcileAt: null, lastErrorCategory: null, lastErrorMessage: null, version: { increment: 1 } } });
      return { id: operation.id, state: 'ACTIVATED', recovered: true };
    }
    const state = providerSubscriptionId ? 'WAITING_FOR_QR' : 'RECONCILE_REQUIRED';
    await this.prisma.provisioningOperation.update({ where: { id: operation.id }, data: { state, nextReconcileAt: new Date(Date.now() + 5 * 60_000), lastErrorCategory: null, lastErrorMessage: null, version: { increment: 1 } } });
    return { id: operation.id, state, recovered: false, providerStatus: details.status };
  }

  private async sweepLifecycle() {
    const now = new Date();
    const subscriptions = await this.prisma.subscription.findMany({
      where: { status: 'ACTIVE' },
      include: { customerEsim: { include: { inventory: true, order: { include: { traveler: true } } } } },
      take: 500,
    });
    for (const subscription of subscriptions) {
      const inventory = subscription.customerEsim?.inventory;
      const order = subscription.customerEsim?.order;
      if (!inventory || !order) continue;
      const expiry = subscription.expiresAt ?? inventory.expiresAt;
      const expiredByDate = expiry !== null && expiry <= now;
      const exhausted = subscription.totalMb > 0 && subscription.usedMb >= subscription.totalMb;
      if (!expiredByDate && !exhausted) continue;
      await this.prisma.subscription.update({ where: { id: subscription.id }, data: { status: 'EXPIRED' } });
      this.logger.log(`Marked subscription ${subscription.id} as EXPIRED (${expiredByDate ? 'date elapsed' : 'data exhausted'})`);
      await this.notifyLifecycle(order, expiredByDate ? 'PLAN_EXPIRED' : 'PLAN_EXHAUSTED');
    }
  }

  private async notifyLifecycle(order: { id: string; orderNumber: string; traveler: { email: string } | null; pricingSnapshot: unknown }, template: 'PLAN_EXPIRED' | 'PLAN_EXHAUSTED') {
    const recipient = order.traveler?.email ?? (order.pricingSnapshot as { topUpEmail?: string } | null)?.topUpEmail;
    if (!recipient) return;
    try {
      await this.notifications.enqueue({ orderId: order.id, channel: 'EMAIL', template, recipient, orderNumber: order.orderNumber });
    } catch (error) {
      this.logger.warn(`Lifecycle notification failed for ${order.id}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  private async reconcile(subscriptionId: string) {
    try {
      const subscription = await this.prisma.subscription.findUnique({
        where: { id: subscriptionId },
        include: { customerEsim: { include: { inventory: true } } },
      });
      if (!subscription?.customerEsim?.inventory?.iccid) return;
      const usage = await this.connectivity.getUsage(subscription.customerEsim.inventory.iccid);
      const own = usage.subscriptions?.find((item) => item.providerSubscriptionId === subscription.providerSubscriptionId);
      if (usage.subscriptions && !own) { this.logger.warn(`Provider subscription ${subscription.providerSubscriptionId} was not found on its assigned eSIM`); return; }
      await this.prisma.subscription.update({
        where: { id: subscriptionId },
        data: { usedMb: own?.usedMb ?? usage.usedMb, totalMb: own?.totalMb ?? usage.totalMb, usageLastCheckedAt: new Date(), ...(own ? { providerLastSeenAt: new Date(), assignmentVerificationStatus: 'VERIFIED', assignmentVerifiedAt: subscription.assignmentVerifiedAt ?? new Date() } : {}) },
      });
      this.logger.debug(`Reconciled usage for subscription ${subscriptionId}: ${usage.usedMb}/${usage.totalMb} MB`);
    } catch (error) {
      this.metrics?.recordFailure('reconciliation', 'usage');
      const json = process.env.LOG_FORMAT === 'json';
      if (json) {
        this.logger.warn(JSON.stringify({ event: 'reconciliation_failed', subscriptionId, error: error instanceof Error ? error.message : 'unknown' }));
      } else {
        this.logger.warn(`Usage reconciliation failed for ${subscriptionId}: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
  }

  private async repairReusableEsims() {
    await this.prisma.esimInventory.updateMany({ where: { status: 'EXPIRED', activatedAt: { not: null }, customerEsims: { some: {} } }, data: { status: 'ACTIVATED' } });
    await this.prisma.esimInventory.updateMany({ where: { status: 'EXPIRED', activatedAt: null, customerEsims: { some: {} } }, data: { status: 'ASSIGNED' } });
  }
}
