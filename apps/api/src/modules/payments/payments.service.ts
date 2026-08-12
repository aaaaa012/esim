import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ApiErrorCode, OrderStatus, PaymentProvider, PaymentStatus } from '@visa-compass/shared';
import { ApiException } from '../../common/api-error.js';
import { OrdersService, type DemoOrder } from '../orders/orders.service.js';
import { KhaltiGateway } from './gateways/khalti.gateway.js';
import { PaymentSimulatorGateway } from './gateways/simulator.gateway.js';
import { MetricsService } from '../../observability/metrics.service.js';

type VerifySource = 'verify' | 'callback' | 'recent-reconcile' | 'expiry-reconcile';

type LookupVerdict =
  | { outcome: 'CONFIRMED'; transactionId?: string }
  | { outcome: 'PENDING' }
  | {
      outcome: 'TERMINAL';
      resolve: boolean;
      paymentStatus: PaymentStatus;
      code: string;
      message: string;
      reason: string;
    };

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly verifyAttempts = new Map<string, number>();
  private readonly maxVerifyAttempts = (() => { const parsed = Number(process.env.PAYMENT_VERIFY_ATTEMPTS); return Number.isFinite(parsed) && parsed > 0 ? parsed : 3; })();
  constructor(private orders: OrdersService, private khalti: KhaltiGateway, private simulator: PaymentSimulatorGateway, private readonly metrics?: MetricsService) {}

  async initiate(orderId: string, ownerId: string | null, provider: PaymentProvider) {
    const order = this.orders.get(orderId, ownerId ?? undefined);
    const existing = order.payment;
    if (existing && existing.status === PaymentStatus.PENDING && existing.expiresAt && new Date(existing.expiresAt).getTime() > Date.now() && existing.redirectUrl) {
      return { reference: existing.reference, redirectUrl: existing.redirectUrl, expiresAt: existing.expiresAt, ...(existing.correlationId ? { correlationId: existing.correlationId } : {}) };
    }
    const returnUrl = `${process.env.CUSTOMER_WEB_URL ?? 'http://localhost:3000'}/esim/checkout?order=${orderId}`;
    const result = await this.gateway().initiate({ orderId, orderNumber: order.orderNumber, amountNpr: order.totalAmountNpr, returnUrl });
    await this.orders.beginPayment(orderId, ownerId, provider, { ...result, returnUrl });
    return result;
  }

  /**
   * Confirmative lookup for a checkout initiated on the API. Kinds of verdict:
   * - Completed + matching order/amount -> payment confirmed (advances the order).
   * - Pending / Initiated -> HTTP 200 with the current order so the client can
   *   retry the lookup with backoff (Khalti can report pending for a few
   *   seconds after the wallet redirects back).
   * - Expired / user canceled -> order moved to PAYMENT_FAILED (retryable, a
   *   fresh Khalti session can be created) and a stable error code returned.
   * - Amount/reference mismatch -> security error; the order stays pending.
   */
  async verify(orderId: string, ownerId: string | null, reference: string) {
    const order = this.orders.get(orderId, ownerId ?? undefined);
    const verdict = await this.lookup(order, reference, 'verify');
    return this.applyVerdict(orderId, ownerId, reference, verdict);
  }

  /** Same verdict semantics for the callback/job path (server initiated). */
  async verifyCallback(orderId: string, reference: string) {
    const order = this.orders.get(orderId);
    if (order.payment?.status === PaymentStatus.COMPLETED) return this.orders.view(orderId);
    const verdict = await this.lookup(order, reference, 'callback');
    return this.applyVerdict(orderId, null, reference, verdict);
  }

  /**
   * Fast reconciliation sweep for orders still inside their payment window.
   * Runs on its own short timer (PAYMENT_RECONCILE_INTERVAL_SECONDS); it only
   * confirms a Completed lookup and leaves Pending orders pending — it never
   * fails them, so a normal pending result is not confused with a provider
   * failure. Provider errors are deferred. Expiry enforcement stays with
   * reconcilePendingPayments().
   */
  async reconcileRecentPendingPayments(): Promise<{ confirmed: string[]; stillPending: string[]; terminal: string[]; errored: string[] }> {
    const confirmed: string[] = [];
    const stillPending: string[] = [];
    const terminal: string[] = [];
    const errored: string[] = [];
    const now = Date.now();
    for (const order of this.orders.list()) {
      if (order.status !== OrderStatus.PAYMENT_PENDING || !order.payment || order.payment.status !== PaymentStatus.PENDING || !order.payment.reference) continue;
      const reference = order.payment.reference;
      const expiry = order.payment.expiresAt ?? new Date(new Date(order.createdAt).getTime() + 30 * 60_000).toISOString();
      if (now >= new Date(expiry).getTime()) continue; // hand-off to the expiry-phase reconcile
      try {
        const verdict = await this.lookup(order, reference, 'recent-reconcile');
        if (verdict.outcome === 'CONFIRMED') {
          await this.orders.confirmPayment(order.id, reference);
          confirmed.push(order.id);
        } else if (verdict.outcome === 'TERMINAL') {
          if (verdict.resolve) await this.orders.resolvePaymentFailure(order.id, null, verdict.reason, verdict.paymentStatus);
          if (verdict.code === ApiErrorCode.PAYMENT_REFERENCE_MISMATCH)
            this.logger.warn(JSON.stringify({ event: 'payment_mismatch', orderId: order.id, source: 'recent-reconcile' }));
          terminal.push(order.id);
        } else {
          stillPending.push(order.id);
        }
      } catch (error) {
        errored.push(order.id);
        this.logger.warn(JSON.stringify({ event: 'payment_reconcile_error', orderId: order.id, source: 'recent-reconcile', error: error instanceof Error ? error.message : 'unknown' }));
      }
    }
    return { confirmed, stillPending, terminal, errored };
  }

  private async applyVerdict(orderId: string, ownerId: string | null, reference: string, verdict: LookupVerdict) {
    if (verdict.outcome === 'CONFIRMED') return this.orders.confirmPayment(orderId, reference, verdict.transactionId);
    if (verdict.outcome === 'PENDING') return this.orders.view(orderId, ownerId ?? undefined);
    if (verdict.resolve) await this.orders.resolvePaymentFailure(orderId, ownerId, verdict.reason, verdict.paymentStatus);
    throw new ApiException({ code: verdict.code, message: verdict.message, status: 400, details: verdict.reason });
  }

  /** Performs the gateway lookup and classifies the verdict for the caller. */
  private async lookup(order: DemoOrder, reference: string, source: VerifySource): Promise<LookupVerdict> {
    const context = this.context(order, reference);
    const result = await this.gateway(order.payment?.provider).verify(reference, context);
    this.logger.debug({ event: 'payment_lookup', orderId: order.id, providerStatus: result.status, source });
    if (result.status === PaymentStatus.COMPLETED) {
      if (result.orderId === order.id && result.amountNpr === order.totalAmountNpr)
        return result.providerTransactionId
          ? { outcome: 'CONFIRMED' as const, transactionId: result.providerTransactionId }
          : { outcome: 'CONFIRMED' as const };
      return {
        outcome: 'TERMINAL',
        resolve: false,
        paymentStatus: PaymentStatus.PENDING,
        code: ApiErrorCode.PAYMENT_REFERENCE_MISMATCH,
        message: 'We could not confirm your payment. Please verify with your wallet or contact support.',
        reason: `Payment verification mismatch (order/amount) for order ${order.id}`,
      };
    }
    if (result.status === PaymentStatus.PENDING) return { outcome: 'PENDING' };
    if (result.status === PaymentStatus.CANCELLED) {
      return {
        outcome: 'TERMINAL',
        resolve: true,
        paymentStatus: PaymentStatus.CANCELLED,
        code: ApiErrorCode.PAYMENT_NOT_CONFIRMED,
        message: 'We could not confirm your payment. Please verify with your wallet or retry.',
        reason: 'Customer cancelled the payment at the wallet',
      };
    }
    return {
      outcome: 'TERMINAL',
      resolve: true,
      paymentStatus: PaymentStatus.FAILED,
      code: ApiErrorCode.PAYMENT_EXPIRED,
      message: 'This payment attempt has expired. Please start a new one.',
      reason: `Payment completion could not be confirmed (provider status ${result.status ?? 'unknown'})`,
    };
  }

  /**
   * Reconciliation sweep for pending payments whose payment window has elapsed
   * (plus a short grace period). The gateway is queried one last time so a
   * payment that completed server-side but whose callback was dropped is
   * recovered instead of being failed on a timer. When the gateway is
   * transiently unavailable the verdict is deferred for up to
   * PAYMENT_VERIFY_ATTEMPTS before the payment is failed.
   */
  async reconcilePendingPayments(): Promise<{ verified: string[]; failed: string[]; deferred: string[] }> {
    const now = Date.now();
    const verified: string[] = [];
    const failed: string[] = [];
    const deferred: string[] = [];
    for (const order of this.orders.list()) {
      if (order.status !== OrderStatus.PAYMENT_PENDING || !order.payment || order.payment.status !== PaymentStatus.PENDING || !order.payment.reference) continue;
      const reference = order.payment.reference;
      const expiry = order.payment.expiresAt ?? new Date(new Date(order.createdAt).getTime() + 30 * 60_000).toISOString();
      if (now < new Date(expiry).getTime()) continue;
      const attempt = (this.verifyAttempts.get(order.id) ?? 0) + 1;
      this.verifyAttempts.set(order.id, attempt);
      try {
        const verdict = await this.lookup(order, reference, 'expiry-reconcile');
        if (verdict.outcome === 'CONFIRMED') {
          await this.orders.confirmPayment(order.id, reference, verdict.transactionId);
          this.verifyAttempts.delete(order.id);
          verified.push(order.id);
        } else if (verdict.outcome === 'TERMINAL' && verdict.resolve) {
          await this.orders.resolvePaymentFailure(order.id, null, verdict.reason, verdict.paymentStatus);
          this.verifyAttempts.delete(order.id);
          failed.push(order.id);
        } else {
          await this.orders.resolvePaymentFailure(order.id, null, `Payment completion could not be confirmed at the gateway (${verdict.outcome === 'PENDING' ? 'pending' : 'mismatch'})`);
          this.verifyAttempts.delete(order.id);
          failed.push(order.id);
        }
      } catch (error) {
        if (attempt >= this.maxVerifyAttempts) {
          await this.orders.resolvePaymentFailure(order.id, null, 'Payment completion could not be confirmed with the provider');
          this.verifyAttempts.delete(order.id);
          failed.push(order.id);
        } else {
          deferred.push(order.id);
          this.logger.warn(`Payment verification deferred for order ${order.id} (attempt ${attempt}/${this.maxVerifyAttempts}): ${error instanceof Error ? error.message : 'unknown'}`);
        }
      }
    }
    return { verified, failed, deferred };
  }
  async refund(orderId: string, actorId: string, reason: string) {
    const order = this.orders.get(orderId);
    await this.orders.requestRefund(orderId, actorId, reason);
    const context = this.context(order, order.payment!.reference);
    const gateway = this.gateway(order.payment!.provider);
    if (!gateway.refund) throw new BadRequestException('Selected provider does not support automated refunds');
    const result = await gateway.refund(order.payment!.providerTransactionId ?? order.payment!.reference, context, order.totalAmountNpr);
    // Persist the provider refund outcome on the in-flight order first so the
    // reference survives any subsequent local-state failure and can be
    // reconciled by operations.
    try {
      return await this.orders.markRefunded(orderId, result.reference);
    } catch (error) {
      this.logger.error(`Gateway refund succeeded (ref=${result.reference}) but local order state write failed for ${orderId}: ${error instanceof Error ? error.message : 'unknown'}`);
      this.metrics?.recordFailure('refund', 'state-write-after-gateway');
      throw error;
    }
  }
  async simulate(orderId: string, ownerId: string | null, reference: string, scenario: 'SUCCESS'|'CANCELLED'|'PENDING'|'WRONG_AMOUNT'|'REFUNDED'|'TIMEOUT' = 'SUCCESS') { if (process.env.NODE_ENV === 'production') throw new BadRequestException('Simulator is disabled'); if (scenario === 'TIMEOUT') throw new BadRequestException('Simulated payment provider timeout'); const order = this.orders.get(orderId, ownerId ?? undefined); const context=this.context(order,reference); this.simulator.apply(reference, scenario, context); const result = await this.simulator.verify(reference,context); if (result.status !== PaymentStatus.COMPLETED || result.orderId !== orderId || result.amountNpr !== order.totalAmountNpr) throw new BadRequestException(`Payment verification failed: ${result.status}`); return await this.orders.confirmPayment(orderId, reference, result.providerTransactionId); }
  private context(order:ReturnType<OrdersService['get']>,reference:string){if(order.payment?.reference!==reference)throw new BadRequestException('Payment reference mismatch');return {orderId:order.id,amountNpr:order.totalAmountNpr,...(order.payment.correlationId?{correlationId:order.payment.correlationId}:{})};}
  private gateway(provider?: PaymentProvider) {
    if (process.env.PAYMENT_MODE === 'simulator') return this.simulator;
    if (process.env.NODE_ENV === 'production' || ['khalti', 'sandbox'].includes(process.env.PAYMENT_MODE ?? '')) return this.khalti;
    return this.simulator;
  }
}
