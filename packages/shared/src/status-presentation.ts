import {
  DocumentReviewStatus,
  DocumentStatus,
  OrderStatus,
} from "./contracts.js";

export type StatusPresentation = {
  label: string;
  phase:
    | "INPUT"
    | "PROCESSING"
    | "REVIEW"
    | "ACTION"
    | "SUCCESS"
    | "FAILED"
    | "TERMINAL";
  terminal: boolean;
  customerAction:
    "CONTINUE" | "CHECK_PAYMENT" | "REPLACE_DOCUMENT" | "WAIT" | "NONE";
};

export const ORDER_STATUS_PRESENTATION: Record<
  OrderStatus,
  StatusPresentation
> = {
  DRAFT: {
    label: "Purchase started",
    phase: "INPUT",
    terminal: false,
    customerAction: "CONTINUE",
  },
  PAYMENT_PENDING: {
    label: "Awaiting payment confirmation",
    phase: "PROCESSING",
    terminal: false,
    customerAction: "CHECK_PAYMENT",
  },
  PAYMENT_CONFIRMED: {
    label: "Payment received",
    phase: "PROCESSING",
    terminal: false,
    customerAction: "WAIT",
  },
  PAYMENT_REVIEW_REQUIRED: {
    label: "Payment confirmation in progress",
    phase: "REVIEW",
    terminal: false,
    customerAction: "WAIT",
  },
  PAYMENT_FAILED: {
    label: "Payment needs attention",
    phase: "FAILED",
    terminal: false,
    customerAction: "CONTINUE",
  },
  REVIEW_PENDING: {
    label: "Documents under review",
    phase: "REVIEW",
    terminal: false,
    customerAction: "WAIT",
  },
  AWAITING_CUSTOMER: {
    label: "Action required",
    phase: "ACTION",
    terminal: false,
    customerAction: "CONTINUE",
  },
  APPROVED: {
    label: "Approved",
    phase: "PROCESSING",
    terminal: false,
    customerAction: "WAIT",
  },
  PROVISIONING: {
    label: "Activating",
    phase: "PROCESSING",
    terminal: false,
    customerAction: "WAIT",
  },
  QR_READY: {
    label: "Ready to install",
    phase: "SUCCESS",
    terminal: false,
    customerAction: "CONTINUE",
  },
  COMPLETED: {
    label: "Completed",
    phase: "SUCCESS",
    terminal: true,
    customerAction: "NONE",
  },
  CANCELLED: {
    label: "Cancelled",
    phase: "TERMINAL",
    terminal: true,
    customerAction: "NONE",
  },
  PROVISIONING_FAILED: {
    label: "eSIM preparation needs attention",
    phase: "FAILED",
    terminal: false,
    customerAction: "WAIT",
  },
  ACTIVATION_ATTENTION: {
    label: "Activation needs attention",
    phase: "REVIEW",
    terminal: false,
    customerAction: "WAIT",
  },
  REFUND_PENDING: {
    label: "Refund in progress",
    phase: "PROCESSING",
    terminal: false,
    customerAction: "WAIT",
  },
  REFUNDED: {
    label: "Refunded",
    phase: "TERMINAL",
    terminal: true,
    customerAction: "NONE",
  },
};

export const DOCUMENT_STATUS_PRESENTATION: Record<
  DocumentStatus,
  StatusPresentation
> = {
  PENDING: {
    label: "Pending review",
    phase: "REVIEW",
    terminal: false,
    customerAction: "WAIT",
  },
  APPROVED: {
    label: "Approved",
    phase: "SUCCESS",
    terminal: true,
    customerAction: "NONE",
  },
  REJECTED: {
    label: "Not accepted",
    phase: "ACTION",
    terminal: false,
    customerAction: "REPLACE_DOCUMENT",
  },
  REUPLOAD_REQUIRED: {
    label: "Re-upload needed",
    phase: "ACTION",
    terminal: false,
    customerAction: "REPLACE_DOCUMENT",
  },
};

export const DOCUMENT_REVIEW_PRESENTATION: Record<
  DocumentReviewStatus,
  StatusPresentation
> = {
  NOT_STARTED: {
    label: "Ready for verification",
    phase: "INPUT",
    terminal: false,
    customerAction: "CONTINUE",
  },
  OCR_PENDING: {
    label: "Checking your documents",
    phase: "PROCESSING",
    terminal: false,
    customerAction: "WAIT",
  },
  OCR_BACKGROUND: {
    label: "Verification in progress",
    phase: "PROCESSING",
    terminal: false,
    customerAction: "WAIT",
  },
  VERIFIED: {
    label: "Verification complete",
    phase: "SUCCESS",
    terminal: true,
    customerAction: "CONTINUE",
  },
  CORRECTION_REQUIRED: {
    label: "Traveller details need checking",
    phase: "ACTION",
    terminal: false,
    customerAction: "CONTINUE",
  },
  MANUAL_REVIEW: {
    label: "Under manual review",
    phase: "REVIEW",
    terminal: false,
    customerAction: "WAIT",
  },
  REUPLOAD_REQUIRED: {
    label: "A replacement document is required",
    phase: "ACTION",
    terminal: false,
    customerAction: "REPLACE_DOCUMENT",
  },
  MANUALLY_APPROVED: {
    label: "Approved",
    phase: "SUCCESS",
    terminal: true,
    customerAction: "CONTINUE",
  },
  SKIPPED: {
    label: "Document check not required",
    phase: "SUCCESS",
    terminal: true,
    customerAction: "CONTINUE",
  },
};

export const UNKNOWN_STATUS_PRESENTATION: StatusPresentation = {
  label: "Status unavailable",
  phase: "REVIEW",
  terminal: false,
  customerAction: "NONE",
};

export function orderStatusPresentation(value: unknown): StatusPresentation {
  return typeof value === "string" && value in ORDER_STATUS_PRESENTATION
    ? ORDER_STATUS_PRESENTATION[value as OrderStatus]
    : UNKNOWN_STATUS_PRESENTATION;
}

export function documentStatusPresentation(value: unknown): StatusPresentation {
  return typeof value === "string" && value in DOCUMENT_STATUS_PRESENTATION
    ? DOCUMENT_STATUS_PRESENTATION[value as DocumentStatus]
    : UNKNOWN_STATUS_PRESENTATION;
}

export function documentReviewPresentation(value: unknown): StatusPresentation {
  return typeof value === "string" && value in DOCUMENT_REVIEW_PRESENTATION
    ? DOCUMENT_REVIEW_PRESENTATION[value as DocumentReviewStatus]
    : UNKNOWN_STATUS_PRESENTATION;
}
