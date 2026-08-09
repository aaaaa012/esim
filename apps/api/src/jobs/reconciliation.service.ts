import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { ConnectivityService } from '../modules/integration/connectivity.service.js';
import { NotificationService } from '../modules/notification/notification.service.js';
import { MetricsService } from '../observability/metrics.service.js';
import { QueueService } from './queue.service.js';
import { QUEUES } from './queues.js';
import { OrdersService } from '../modules/orders/orders.service.js';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectivity: ConnectivityService,
    private readonly queues: QueueService,
    private readonly notifications: NotificationService,
    private readonly orders: OrdersService,
    private readonly metrics?: MetricsService,
  ) {}

  onModuleInit() {
    this.queues.registerWorker(QUEUES.reconciliation, (job) =>
      this.reconcile(String((job.data as { id: string }).id)),
    );
    const minutes = Number(process.env.RECONCILIATION_INTERVAL_MINUTES ?? 15);
    const intervalMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 15 * 60_000;
    this.timer = setInterval(() => void this.run().catch(() => undefined), intervalMs);
    void this.run().catch(() => undefined);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async run() {
    await this.orders.failStaleReadyOrders();
    if (!this.prisma.enabled) return;
    await this.sweepLifecycle();
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
      const remainingActive = await this.prisma.subscription.count({ where: { customerEsim: { inventoryId: inventory.id }, status: 'ACTIVE' } });
      if (remainingActive === 0) {
        await this.prisma.esimInventory.update({ where: { id: inventory.id }, data: { status: 'EXPIRED', expiresAt: expiry } });
      }
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
      await this.prisma.subscription.update({
        where: { id: subscriptionId },
        data: { usedMb: usage.usedMb, totalMb: usage.totalMb, usageLastCheckedAt: new Date() },
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
}
