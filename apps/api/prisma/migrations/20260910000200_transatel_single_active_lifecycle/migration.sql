CREATE UNIQUE INDEX "TransatelLifecycleOperation_one_active_per_order_key"
ON "TransatelLifecycleOperation"("orderId")
WHERE "state" IN (
  'APPROVAL_REQUIRED',
  'CREATED',
  'SUBMITTING',
  'ACCEPTED',
  'RECONCILE_REQUIRED'
);
