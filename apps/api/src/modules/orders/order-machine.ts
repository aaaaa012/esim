import { OrderStatus } from '@visa-compass/shared';

const transitions: Record<OrderStatus, readonly OrderStatus[]> = {
  DRAFT: [OrderStatus.PAYMENT_PENDING, OrderStatus.CANCELLED],
  PAYMENT_PENDING: [OrderStatus.PAYMENT_CONFIRMED, OrderStatus.PAYMENT_FAILED, OrderStatus.CANCELLED],
  PAYMENT_CONFIRMED: [OrderStatus.REVIEW_PENDING],
  REVIEW_PENDING: [OrderStatus.AWAITING_CUSTOMER, OrderStatus.APPROVED, OrderStatus.REFUND_PENDING],
  AWAITING_CUSTOMER: [OrderStatus.REVIEW_PENDING, OrderStatus.REFUND_PENDING],
  APPROVED: [OrderStatus.PROVISIONING, OrderStatus.REFUND_PENDING],
  PROVISIONING: [OrderStatus.COMPLETED, OrderStatus.PROVISIONING_FAILED],
  PROVISIONING_FAILED: [OrderStatus.PROVISIONING, OrderStatus.REFUND_PENDING],
  REFUND_PENDING: [OrderStatus.REFUNDED],
  PAYMENT_FAILED: [], CANCELLED: [], COMPLETED: [], REFUNDED: [],
};
export function canTransition(from: OrderStatus, to: OrderStatus) { return transitions[from].includes(to); }
export function assertTransition(from: OrderStatus, to: OrderStatus) { if (!canTransition(from, to)) throw new Error(`Invalid order transition: ${from} -> ${to}`); }
