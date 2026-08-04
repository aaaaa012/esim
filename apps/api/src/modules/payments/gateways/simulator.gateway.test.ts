import { describe,expect,it } from 'vitest';
import { PaymentStatus } from '@visa-compass/shared';
import { PaymentSimulatorGateway } from './simulator.gateway.js';

describe('PaymentSimulatorGateway',()=>{
  async function initiated(){const gateway=new PaymentSimulatorGateway();const context={orderId:'order-1',amountNpr:2499};const payment=await gateway.initiate({orderId:context.orderId,orderNumber:'VC-1',amountNpr:context.amountNpr,returnUrl:'http://localhost/return'});return {gateway,reference:payment.reference,context}}
  it('normalizes successful payment',async()=>{const {gateway,reference,context}=await initiated();gateway.apply(reference,'SUCCESS');expect((await gateway.verify(reference,context)).status).toBe(PaymentStatus.COMPLETED)});
  it('detects wrong amount scenario',async()=>{const {gateway,reference,context}=await initiated();gateway.apply(reference,'WRONG_AMOUNT');expect((await gateway.verify(reference,context)).amountNpr).toBe(2500)});
  it('normalizes cancellation and refund',async()=>{const {gateway,reference,context}=await initiated();gateway.apply(reference,'CANCELLED');expect((await gateway.verify(reference,context)).status).toBe(PaymentStatus.CANCELLED);gateway.apply(reference,'REFUNDED');expect((await gateway.verify(reference,context)).status).toBe(PaymentStatus.REFUNDED)});
  it('verifies signed simulator payloads',()=>{const gateway=new PaymentSimulatorGateway();const payload='{"eventId":"evt-1"}';expect(gateway.verifySignature(payload,gateway.sign(payload))).toBe(true);expect(gateway.verifySignature(payload,'invalid')).toBe(false)});
});
