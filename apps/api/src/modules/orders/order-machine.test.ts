import { describe, expect, it } from 'vitest';
import { OrderStatus } from '@visa-compass/shared';
import { canTransition } from './order-machine.js';

describe('order lifecycle', () => {
  it('never provisions before approval', () => expect(canTransition(OrderStatus.PAYMENT_CONFIRMED, OrderStatus.PROVISIONING)).toBe(false));
  it('auto-approves a confirmed payment', () => expect(canTransition(OrderStatus.PAYMENT_CONFIRMED, OrderStatus.APPROVED)).toBe(true));
  it('allows an approved order to provision', () => expect(canTransition(OrderStatus.APPROVED, OrderStatus.PROVISIONING)).toBe(true));
  it('never returns completed orders to an active state', () => expect(canTransition(OrderStatus.COMPLETED, OrderStatus.PROVISIONING)).toBe(false));
  it('moves a provisioned order to QR_READY before completion', () => expect(canTransition(OrderStatus.PROVISIONING, OrderStatus.QR_READY)).toBe(true));
  it('only completes an order once activated', () => expect(canTransition(OrderStatus.QR_READY, OrderStatus.COMPLETED)).toBe(true));
  it('auto-fails a stale ready order (activation window expired)', () => expect(canTransition(OrderStatus.QR_READY, OrderStatus.PROVISIONING_FAILED)).toBe(true));
  it('never completes before qr delivered', () => expect(canTransition(OrderStatus.APPROVED, OrderStatus.COMPLETED)).toBe(false));
  it('never moves a QR order straight to provisioning', () => expect(canTransition(OrderStatus.QR_READY, OrderStatus.PROVISIONING)).toBe(false));
});
