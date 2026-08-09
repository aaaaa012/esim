export enum UserRole {
  CUSTOMER = 'CUSTOMER',
  OPERATIONS = 'OPERATIONS',
  SUPER_ADMIN = 'SUPER_ADMIN',
}

export enum OrderStatus {
  DRAFT = 'DRAFT',
  PAYMENT_PENDING = 'PAYMENT_PENDING',
  PAYMENT_CONFIRMED = 'PAYMENT_CONFIRMED',
  REVIEW_PENDING = 'REVIEW_PENDING',
  AWAITING_CUSTOMER = 'AWAITING_CUSTOMER',
  APPROVED = 'APPROVED',
  PROVISIONING = 'PROVISIONING',
  QR_READY = 'QR_READY',
  COMPLETED = 'COMPLETED',
  PAYMENT_FAILED = 'PAYMENT_FAILED',
  CANCELLED = 'CANCELLED',
  PROVISIONING_FAILED = 'PROVISIONING_FAILED',
  REFUND_PENDING = 'REFUND_PENDING',
  REFUNDED = 'REFUNDED',
}

export enum PaymentProvider { KHALTI = 'KHALTI', ESEWA = 'ESEWA' }
export enum PaymentStatus { INITIATED = 'INITIATED', PENDING = 'PENDING', COMPLETED = 'COMPLETED', FAILED = 'FAILED', CANCELLED = 'CANCELLED', REFUNDED = 'REFUNDED' }
export enum DocumentType { PASSPORT = 'PASSPORT', TICKET = 'TICKET', VISA = 'VISA' }
export enum DocumentStatus { PENDING = 'PENDING', APPROVED = 'APPROVED', REJECTED = 'REJECTED', REUPLOAD_REQUIRED = 'REUPLOAD_REQUIRED' }
export enum InventoryStatus { IMPORTED = 'IMPORTED', AVAILABLE = 'AVAILABLE', RESERVED = 'RESERVED', ASSIGNED = 'ASSIGNED', ACTIVATED = 'ACTIVATED', EXPIRED = 'EXPIRED', TERMINATED = 'TERMINATED' }
export enum ProvisioningStatus { QUEUED = 'QUEUED', RUNNING = 'RUNNING', DELAYED = 'DELAYED', SUCCEEDED = 'SUCCEEDED', RETRYING = 'RETRYING', FAILED = 'FAILED' }

export type ApiMeta = { correlationId: string; timestamp: string };
export type ApiSuccess<T> = { data: T; meta: ApiMeta };
export type ApiFailure = { data: null; meta: ApiMeta; error: { code: string; message: string; details?: unknown } };

export type PlanSummary = {
  id: string;
  countryCode: string;
  name: string;
  dataAllowance: string;
  validityDays: number;
  sellingPriceNpr: number;
  coverage: string[];
  popular: boolean;
};

export type OrderSummary = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  plan: PlanSummary;
  totalAmountNpr: number;
  createdAt: string;
};
