/**
 * Central plain-language labels for internal status codes and enum values.
 *
 * These maps translate raw API enum values into wording that a natural person
 * (customer, agent, or operator) reads comfortably, instead of leaking
 * developer strings such as `PAYMENT_PENDING` onto the screen.
 */

export const ORDER_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  PAYMENT_PENDING: "Awaiting payment",
  PAYMENT_CONFIRMED: "Payment received",
  REVIEW_PENDING: "Pending review",
  AWAITING_CUSTOMER: "Waiting on you",
  APPROVED: "Approved",
  PROVISIONING: "Activating",
  QR_READY: "Ready to install",
  COMPLETED: "Completed",
  PAYMENT_FAILED: "Payment unsuccessful",
  PAYMENT_REVIEW_REQUIRED: "Payment needs confirmation",
  CANCELLED: "Cancelled",
  PROVISIONING_FAILED: "Activation unsuccessful",
  ACTIVATION_ATTENTION: "Activation needs attention",
  REFUND_PENDING: "Refund in progress",
  REFUNDED: "Refunded",
};

export const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  PASSPORT: "Passport",
  TICKET: "Flight ticket",
  VISA: "Visa",
};

export const DOCUMENT_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  REUPLOAD_REQUIRED: "Re-upload needed",
};

export function documentTypeLabel(type: string | null | undefined): string {
  if (!type) return "";
  return DOCUMENT_TYPE_LABELS[type] ?? humanize(type);
}

export function documentStatusLabel(status: string | null | undefined): string {
  if (!status) return "";
  return DOCUMENT_STATUS_LABELS[status] ?? humanize(status);
}

export const INVENTORY_STATUS_LABELS: Record<string, string> = {
  IMPORTED: "Imported",
  AVAILABLE: "Available",
  RESERVED: "Reserved",
  ASSIGNED: "Assigned",
  ACTIVATED: "Active",
  EXPIRED: "Expired",
  TERMINATED: "Terminated",
  QUARANTINED: "Quarantined",
};

export const PROVISIONING_STATUS_LABELS: Record<string, string> = {
  QUEUED: "Queued",
  RUNNING: "Activating",
  DELAYED: "Delayed",
  SUCCEEDED: "Activated",
  RETRYING: "Retrying",
  FAILED: "Failed",
};

export const NOTIFICATION_TEMPLATE_LABELS: Record<string, string> = {
  ORDER_STATUS: "Order update",
  QR_READY: "Your eSIM is ready",
  DOCUMENT_REUPLOAD: "Document update",
  DOCUMENT_APPROVED: "Documents approved",
  PLAN_EXHAUSTED: "Data used up",
  PLAN_EXPIRED: "Plan expired",
  OPS_ALERT: "System alert",
};

export const NOTIFICATION_CHANNEL_LABELS: Record<string, string> = {
  EMAIL: "Email",
  WHATSAPP: "WhatsApp",
};

export const NOTIFICATION_STATUS_LABELS: Record<string, string> = {
  SENDING: "Sending",
  SENT: "Sent",
  SIMULATED: "Simulated",
  FAILED: "Failed",
};

export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  CUSTOMER: "Customer",
  OPERATIONS: "Operations",
  SUPER_ADMIN: "Super admin",
};

export const PLAN_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  ACTIVE: "Active",
  DISABLED: "Disabled",
  ARCHIVED: "Archived",
};

export const PARTNER_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending approval",
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
  DISABLED: "Disabled",
};

export const USER_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Active",
  DISABLED: "Disabled",
};

/** Fallback: turn an awkward underscore code into a simple title-cased phrase. */
export function humanize(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}

/** Plain-language label for an order status code, with a human fallback. */
export function orderStatusLabel(status: string | null | undefined): string {
  if (!status) return "";
  return ORDER_STATUS_LABELS[status] ?? humanize(status);
}

/** Plain-language label for a notification template code. */
export function notificationTemplateLabel(
  template: string | null | undefined,
): string {
  if (!template) return "";
  return NOTIFICATION_TEMPLATE_LABELS[template] ?? humanize(template);
}

/** Plain-language label for a notification channel code. */
export function notificationChannelLabel(
  channel: string | null | undefined,
): string {
  if (!channel) return "";
  return NOTIFICATION_CHANNEL_LABELS[channel] ?? humanize(channel);
}

/** Plain-language label for a notification status code. */
export function notificationStatusLabel(
  status: string | null | undefined,
): string {
  if (!status) return "";
  return NOTIFICATION_STATUS_LABELS[status] ?? humanize(status);
}
