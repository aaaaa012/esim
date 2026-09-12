CREATE TABLE "PaymentEvent" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "paymentId" UUID,
    "provider" "PaymentProvider" NOT NULL,
    "eventType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "paymentReference" TEXT,
    "fromStatus" "PaymentStatus",
    "toStatus" "PaymentStatus",
    "amount" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'NPR',
    "providerTransactionId" TEXT,
    "providerMessage" TEXT,
    "evidence" JSONB,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FonepayBankDirectoryEntry" (
    "bankCode" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "bankIcon" TEXT,
    "packageName" TEXT,
    "intentScheme" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FonepayBankDirectoryEntry_pkey" PRIMARY KEY ("bankCode")
);

CREATE TABLE "FonepayBankDirectorySync" (
    "id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "requestedById" UUID,
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "addedCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "deactivatedCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "FonepayBankDirectorySync_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentEvent_dedupeKey_key" ON "PaymentEvent"("dedupeKey");
CREATE INDEX "PaymentEvent_orderId_createdAt_idx" ON "PaymentEvent"("orderId", "createdAt");
CREATE INDEX "PaymentEvent_paymentId_createdAt_idx" ON "PaymentEvent"("paymentId", "createdAt");
CREATE INDEX "PaymentEvent_provider_eventType_createdAt_idx" ON "PaymentEvent"("provider", "eventType", "createdAt");
CREATE INDEX "FonepayBankDirectoryEntry_active_bankName_idx" ON "FonepayBankDirectoryEntry"("active", "bankName");
CREATE INDEX "FonepayBankDirectorySync_startedAt_idx" ON "FonepayBankDirectorySync"("startedAt");

ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "PaymentEvent_append_only_guard"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'PaymentEvent is append-only: row % may not be updated (PGERRCODE=42809)', OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PaymentEvent_append_only_update"
AFTER UPDATE ON "PaymentEvent"
FOR EACH ROW
EXECUTE FUNCTION "PaymentEvent_append_only_guard"();

CREATE OR REPLACE FUNCTION "PaymentEvent_no_delete_guard"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'PaymentEvent is append-only: row % may not be deleted (PGERRCODE=42809)', OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PaymentEvent_no_delete"
AFTER DELETE ON "PaymentEvent"
FOR EACH ROW
EXECUTE FUNCTION "PaymentEvent_no_delete_guard"();
