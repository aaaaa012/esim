export const AttentionAction = {
  RECHECK_PAYMENT: "RECHECK_PAYMENT",
  RECHECK_INVENTORY: "RECHECK_INVENTORY",
  RECHECK_ORDER_PROVIDER: "RECHECK_ORDER_PROVIDER",
  RECONCILE_RESERVATION: "RECONCILE_RESERVATION",
  RECONCILE_PROVISIONING: "RECONCILE_PROVISIONING",
  RECONCILE_ORDER_PROVISIONING: "RECONCILE_ORDER_PROVISIONING",
  RETRY_PROVISIONING: "RETRY_PROVISIONING",
  RETRY_NOTIFICATION: "RETRY_NOTIFICATION",
  REVIEW_FINANCIAL_DISPUTE: "REVIEW_FINANCIAL_DISPUTE",
  REVIEW_MANUAL_REFUND: "REVIEW_MANUAL_REFUND",
  REPLAY_WEBHOOK: "REPLAY_WEBHOOK",
} as const;

export type AttentionAction =
  (typeof AttentionAction)[keyof typeof AttentionAction];

const attentionActions = new Set<string>(Object.values(AttentionAction));

export const isAttentionAction = (value: unknown): value is AttentionAction =>
  typeof value === "string" && attentionActions.has(value);

export const attentionActionLabel = (action: AttentionAction): string => {
  const labels: Record<AttentionAction, string> = {
    RECHECK_PAYMENT: "Check payment status",
    RECHECK_INVENTORY: "Check eSIM stock",
    RECHECK_ORDER_PROVIDER: "Check provider status",
    RECONCILE_RESERVATION: "Reconcile stock reservation",
    RECONCILE_PROVISIONING: "Reconcile activation",
    RECONCILE_ORDER_PROVISIONING: "Reconcile order activation",
    RETRY_PROVISIONING: "Retry activation",
    RETRY_NOTIFICATION: "Retry message delivery",
    REVIEW_FINANCIAL_DISPUTE: "Review payment dispute",
    REVIEW_MANUAL_REFUND: "Review refund request",
    REPLAY_WEBHOOK: "Replay provider update",
  };
  return labels[action];
};
