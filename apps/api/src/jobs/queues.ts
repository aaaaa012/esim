export const QUEUES = {
  provisioning: "provisioning",
  providerCallbacks: "provider-callbacks",
  payments: "payments",
  notifications: "notifications",
  reconciliation: "reconciliation",
  partnerWebhooks: "partner-webhooks",
  documents: "documents",
  identityCallbacks: "identity-callbacks",
} as const;

export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2_000 },
  jitter: 0.25,
  removeOnComplete: 500,
  removeOnFail: 2_000,
} as const;
