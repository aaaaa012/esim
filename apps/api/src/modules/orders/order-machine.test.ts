import { describe, expect, it } from 'vitest';
import { OrderStatus } from '@visa-compass/shared';
import { canTransition } from './order-machine.js';

describe('order lifecycle', () => {
  it('never provisions before approval', () => expect(canTransition(OrderStatus.PAYMENT_CONFIRMED, OrderStatus.PROVISIONING)).toBe(false));
  it('allows an approved order to provision', () => expect(canTransition(OrderStatus.APPROVED, OrderStatus.PROVISIONING)).toBe(true));
  it('never returns completed orders to an active state', () => expect(canTransition(OrderStatus.COMPLETED, OrderStatus.PROVISIONING)).toBe(false));
});
