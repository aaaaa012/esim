ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PAYMENT_REVIEW_REQUIRED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'ACTIVATION_ATTENTION';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'REVIEW_REQUIRED';
ALTER TYPE "InventoryStatus" ADD VALUE IF NOT EXISTS 'PENDING_PROVIDER_CHECK';
ALTER TYPE "DocumentReviewPolicy" ADD VALUE IF NOT EXISTS 'NO_REVIEW';

CREATE TYPE "OperationalDisposition" AS ENUM ('RETRY_AUTOMATIC', 'RECONCILE_PROVIDER', 'MANUAL_ACTION', 'REFUND_ELIGIBLE', 'TERMINAL_REJECTION');
CREATE TYPE "AttentionCaseStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED');
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'DISPATCHED', 'FAILED');

ALTER TABLE "Order" ADD COLUMN "operationalDisposition" "OperationalDisposition";
ALTER TABLE "Notification" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Notification" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);
ALTER TABLE "Notification" ADD COLUMN "errorMessage" TEXT;
ALTER TABLE "Notification" ADD COLUMN "recipient" TEXT;
ALTER TABLE "Notification" ADD COLUMN "orderNumber" TEXT;
ALTER TABLE "Notification" ADD COLUMN "reason" TEXT;
ALTER TABLE "PartnerDocumentUploadIntent" ADD COLUMN "uploadVerified" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "AttentionCase" (
  "id" UUID NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "status" "AttentionCaseStatus" NOT NULL DEFAULT 'OPEN',
  "severity" TEXT NOT NULL DEFAULT 'WARNING',
  "orderId" UUID,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "detail" TEXT,
  "localState" TEXT,
  "externalState" TEXT,
  "lastSuccessfulStep" TEXT,
  "failureCategory" TEXT,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "nextRetryAt" TIMESTAMP(3),
  "availableActions" JSONB NOT NULL,
  "assignedToId" UUID,
  "resolvedById" UUID,
  "resolution" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AttentionCase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OutboxMessage" (
  "id" UUID NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "jobName" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "orderId" UUID,
  "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dispatchedAt" TIMESTAMP(3),
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OutboxMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkerHeartbeat" (
  "worker" TEXT NOT NULL,
  "instanceId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("worker")
);

CREATE UNIQUE INDEX "AttentionCase_dedupeKey_key" ON "AttentionCase"("dedupeKey");
CREATE INDEX "AttentionCase_status_category_createdAt_idx" ON "AttentionCase"("status", "category", "createdAt");
CREATE INDEX "AttentionCase_orderId_status_idx" ON "AttentionCase"("orderId", "status");
CREATE UNIQUE INDEX "OutboxMessage_dedupeKey_key" ON "OutboxMessage"("dedupeKey");
CREATE INDEX "OutboxMessage_status_nextAttemptAt_idx" ON "OutboxMessage"("status", "nextAttemptAt");
CREATE INDEX "WebhookEvent_processedAt_deadLetteredAt_nextAttemptAt_idx" ON "WebhookEvent"("processedAt", "deadLetteredAt", "nextAttemptAt");
CREATE INDEX "Notification_status_nextAttemptAt_idx" ON "Notification"("status", "nextAttemptAt");

ALTER TABLE "AttentionCase" ADD CONSTRAINT "AttentionCase_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OutboxMessage" ADD CONSTRAINT "OutboxMessage_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
