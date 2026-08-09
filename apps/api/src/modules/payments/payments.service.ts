import { BadRequestException, Injectable } from '@nestjs/common';
import { PaymentProvider, PaymentStatus } from '@visa-compass/shared';
import { OrdersService } from '../orders/orders.service.js';
import { KhaltiGateway } from './gateways/khalti.gateway.js';
import { PaymentSimulatorGateway } from './gateways/simulator.gateway.js';

@Injectable()
export class PaymentsService {
  constructor(private orders: OrdersService, private khalti: KhaltiGateway, private simulator: PaymentSimulatorGateway) {}
  async initiate(orderId: string, ownerId: string | null, provider: PaymentProvider) { const order = this.orders.get(orderId, ownerId ?? undefined); const existing = order.payment; if (existing && existing.status === PaymentStatus.PENDING && existing.expiresAt && new Date(existing.expiresAt).getTime() > Date.now() && existing.redirectUrl) { return { reference: existing.reference, redirectUrl: existing.redirectUrl, expiresAt: existing.expiresAt, ...(existing.correlationId ? { correlationId: existing.correlationId } : {}) }; } const returnUrl = `${process.env.CUSTOMER_WEB_URL ?? 'http://localhost:3000'}/esim/checkout?order=${orderId}`; const result = await this.gateway().initiate({ orderId, orderNumber: order.orderNumber, amountNpr: order.totalAmountNpr, returnUrl }); await this.orders.beginPayment(orderId, ownerId, provider, { ...result, returnUrl }); return result; }
  async verify(orderId:string,ownerId:string|null,reference:string){const order=this.orders.get(orderId,ownerId ?? undefined);const context=this.context(order,reference);const result=await this.gateway().verify(reference,context);if(result.status!==PaymentStatus.COMPLETED||result.orderId!==order.id||result.amountNpr!==order.totalAmountNpr)throw new BadRequestException(`Payment lookup did not confirm the order: ${result.status}`);return this.orders.confirmPayment(orderId,reference,result.providerTransactionId)}
  async verifyCallback(orderId:string,reference:string){const order=this.orders.get(orderId);const context=this.context(order,reference);if(order.payment!.status===PaymentStatus.COMPLETED)return this.orders.view(orderId);const result=await this.gateway().verify(reference,context);if(result.status!==PaymentStatus.COMPLETED||result.orderId!==order.id||result.amountNpr!==order.totalAmountNpr)throw new BadRequestException(`Payment lookup did not confirm the order: ${result.status}`);return this.orders.confirmPayment(orderId,reference,result.providerTransactionId)}
  async refund(orderId: string, actorId: string, reason: string) {
    const order = this.orders.get(orderId);
    await this.orders.requestRefund(orderId, actorId, reason);
    const context = this.context(order, order.payment!.reference);
    const gateway = this.gateway();
    if (!gateway.refund) throw new BadRequestException('Selected provider does not support automated refunds');
    const result = await gateway.refund(order.payment!.providerTransactionId ?? order.payment!.reference, context, order.totalAmountNpr);
    return this.orders.markRefunded(orderId, result.reference);
  }
  async simulate(orderId: string, ownerId: string | null, reference: string, scenario: 'SUCCESS'|'CANCELLED'|'PENDING'|'WRONG_AMOUNT'|'REFUNDED'|'TIMEOUT' = 'SUCCESS') { if (process.env.NODE_ENV === 'production') throw new BadRequestException('Simulator is disabled'); if (scenario === 'TIMEOUT') throw new BadRequestException('Simulated payment provider timeout'); const order = this.orders.get(orderId, ownerId ?? undefined); const context=this.context(order,reference); this.simulator.apply(reference, scenario, context); const result = await this.simulator.verify(reference,context); if (result.status !== PaymentStatus.COMPLETED || result.orderId !== orderId || result.amountNpr !== order.totalAmountNpr) throw new BadRequestException(`Payment verification failed: ${result.status}`); return await this.orders.confirmPayment(orderId, reference, result.providerTransactionId); }
  private context(order:ReturnType<OrdersService['get']>,reference:string){if(order.payment?.reference!==reference)throw new BadRequestException('Payment reference mismatch');return {orderId:order.id,amountNpr:order.totalAmountNpr,...(order.payment.correlationId?{correlationId:order.payment.correlationId}:{})};}
  private gateway() { return process.env.PAYMENT_MODE === 'sandbox' || process.env.NODE_ENV === 'production' ? this.khalti : this.simulator; }
}
