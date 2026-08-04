export const QUEUES = {
  provisioning: 'provisioning',
  providerCallbacks: 'provider-callbacks',
  payments: 'payments',
  notifications: 'notifications',
  reconciliation: 'reconciliation',
} as const;

export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: 500,
  removeOnFail: 2_000,
} as const;
