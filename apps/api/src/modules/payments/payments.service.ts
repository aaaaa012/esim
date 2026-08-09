import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { OrderStatus, PaymentProvider, PaymentStatus } from '@visa-compass/shared';
import { OrdersService } from '../orders/orders.service.js';
import { KhaltiGateway } from './gateways/khalti.gateway.js';
import { PaymentSimulatorGateway } from './gateways/simulator.gateway.js';
import { MetricsService } from '../../observability/metrics.service.js';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly verifyAttempts = new Map<string, number>();
  private readonly maxVerifyAttempts = (() => { const parsed = Number(process.env.PAYMENT_VERIFY_ATTEMPTS); return Number.isFinite(parsed) && parsed > 0 ? parsed : 3; })();
  constructor(private orders: OrdersService, private khalti: KhaltiGateway, private simulator: PaymentSimulatorGateway, private readonly metrics?: MetricsService) {}
  async initiate(orderId: string, ownerId: string | null, provider: PaymentProvider) { const order = this.orders.get(orderId, ownerId ?? undefined); const existing = order.payment; if (existing && existing.status === PaymentStatus.PENDING && existing.expiresAt && new Date(existing.expiresAt).getTime() > Date.now() && existing.redirectUrl) { return { reference: existing.reference, redirectUrl: existing.redirectUrl, expiresAt: existing.expiresAt, ...(existing.correlationId ? { correlationId: existing.correlationId } : {}) }; } const returnUrl = `${process.env.CUSTOMER_WEB_URL ?? 'http://localhost:3000'}/esim/checkout?order=${orderId}`; const result = await this.gateway().initiate({ orderId, orderNumber: order.orderNumber, amountNpr: order.totalAmountNpr, returnUrl }); await this.orders.beginPayment(orderId, ownerId, provider, { ...result, returnUrl }); return result; }
  async verify(orderId:string,ownerId:string|null,reference:string){const order=this.orders.get(orderId,ownerId ?? undefined);const context=this.context(order,reference);const result=await this.gateway().verify(reference,context);if(result.status!==PaymentStatus.COMPLETED||result.orderId!==order.id||result.amountNpr!==order.totalAmountNpr)throw new BadRequestException(`Payment lookup did not confirm the order: ${result.status}`);return this.orders.confirmPayment(orderId,reference,result.providerTransactionId)}
  async verifyCallback(orderId:string,reference:string){const order=this.orders.get(orderId);const context=this.context(order,reference);if(order.payment!.status===PaymentStatus.COMPLETED)return this.orders.view(orderId);const result=await this.gateway().verify(reference,context);if(result.status!==PaymentStatus.COMPLETED||result.orderId!==order.id||result.amountNpr!==order.totalAmountNpr)throw new BadRequestException(`Payment lookup did not confirm the order: ${result.status}`);return this.orders.confirmPayment(orderId,reference,result.providerTransactionId)}
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
        const result = await this.gateway(order.payment.provider).verify(reference, this.context(order, reference));
        if (result.status === PaymentStatus.COMPLETED && result.orderId === order.id && result.amountNpr === order.totalAmountNpr) {
          await this.orders.confirmPayment(order.id, reference, result.providerTransactionId);
          this.verifyAttempts.delete(order.id);
          verified.push(order.id);
        } else {
          await this.orders.resolvePaymentFailure(order.id, null, `Payment completion could not be confirmed at the gateway (${result.status})`);
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
  private gateway(provider?: PaymentProvider) { return process.env.PAYMENT_MODE === 'sandbox' || process.env.NODE_ENV === 'production' ? this.khalti : this.simulator; }
}
