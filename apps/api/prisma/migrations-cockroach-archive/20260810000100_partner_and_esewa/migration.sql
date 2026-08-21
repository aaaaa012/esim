-- AddEnum
ALTER TYPE "CustomerSource" ADD VALUE 'ESEWA';
-- AddEnum
ALTER TYPE "PaymentProvider" ADD VALUE 'ESEWA';

-- CreateEnum
CREATE TYPE IF NOT EXISTS "PartnerStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE IF NOT EXISTS "PartnerCredentialStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE IF NOT EXISTS "PartnerPriceListStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE IF NOT EXISTS "PartnerSettlementMethod" AS ENUM ('PARTNER_ACCOUNT', 'HOSTED_PAYMENT');

-- CreateEnum
CREATE TYPE IF NOT EXISTS "PartnerQuoteStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE IF NOT EXISTS "PartnerLedgerEntryType" AS ENUM ('CREDIT', 'DEBIT', 'RESERVATION', 'CAPTURE', 'RELEASE', 'REFUND', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE IF NOT EXISTS "PartnerRefundStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE IF NOT EXISTS "PartnerWebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'RETRYING', 'FAILED');

-- CreateEnum
CREATE TYPE IF NOT EXISTS "PartnerIdempotencyStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "Order" SET (schema_locked = false);
ALTER TABLE "Order" ADD COLUMN     "externalOrderId" STRING;
ALTER TABLE "Order" ADD COLUMN     "partnerCustomerId" UUID;
ALTER TABLE "Order" ADD COLUMN     "partnerId" UUID;
ALTER TABLE "Order" ADD COLUMN     "partnerQuoteId" UUID;
ALTER TABLE "Order" ADD COLUMN     "partnerSettlementMethod" "PartnerSettlementMethod";

-- CreateTable
CREATE TABLE "Partner" (
    "id" UUID NOT NULL,
    "code" STRING NOT NULL,
    "name" STRING NOT NULL,
    "status" "PartnerStatus" NOT NULL DEFAULT 'PENDING',
    "allowedSettlementMethods" JSONB NOT NULL,
    "rateLimitPerMinute" INT4 NOT NULL DEFAULT 120,
    "redirectAllowlist" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Partner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerCredential" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "name" STRING NOT NULL,
    "keyPrefix" STRING NOT NULL,
    "secretHash" STRING NOT NULL,
    "scopes" JSONB NOT NULL,
    "status" "PartnerCredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerCustomer" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "externalCustomerId" STRING NOT NULL,
    "customerId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerPriceList" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "name" STRING NOT NULL,
    "version" INT4 NOT NULL,
    "currency" STRING NOT NULL DEFAULT 'NPR',
    "status" "PartnerPriceListStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerPriceList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerPriceListItem" (
    "id" UUID NOT NULL,
    "priceListId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "wholesaleAmountPaisa" INT4 NOT NULL,
    "retailAmountPaisa" INT4 NOT NULL,

    CONSTRAINT "PartnerPriceListItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerQuote" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "priceListId" UUID,
    "settlementMethod" "PartnerSettlementMethod" NOT NULL,
    "wholesaleAmountPaisa" INT4 NOT NULL,
    "retailAmountPaisa" INT4 NOT NULL,
    "currency" STRING NOT NULL DEFAULT 'NPR',
    "pricingSnapshot" JSONB NOT NULL,
    "status" "PartnerQuoteStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerAccount" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "balancePaisa" INT4 NOT NULL DEFAULT 0,
    "creditLimitPaisa" INT4 NOT NULL DEFAULT 0,
    "reservedPaisa" INT4 NOT NULL DEFAULT 0,
    "version" INT4 NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerLedgerEntry" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "orderId" UUID,
    "type" "PartnerLedgerEntryType" NOT NULL,
    "amountPaisa" INT4 NOT NULL,
    "balanceAfterPaisa" INT4 NOT NULL,
    "reference" STRING NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerHostedCheckoutSession" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "tokenHash" STRING NOT NULL,
    "redirectUrl" STRING NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerHostedCheckoutSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerRefundRequest" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "amountPaisa" INT4 NOT NULL,
    "reason" STRING NOT NULL,
    "status" "PartnerRefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerRefundRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerWebhookEndpoint" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "url" STRING NOT NULL,
    "secretEncrypted" STRING NOT NULL,
    "eventTypes" JSONB NOT NULL,
    "active" BOOL NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerWebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerEvent" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "orderId" UUID,
    "type" STRING NOT NULL,
    "version" STRING NOT NULL DEFAULT '1.0',
    "resourceId" STRING NOT NULL,
    "correlationId" STRING NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerWebhookDelivery" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "endpointId" UUID NOT NULL,
    "status" "PartnerWebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INT4 NOT NULL DEFAULT 0,
    "responseStatus" INT4,
    "latencyMs" INT4,
    "nextRetryAt" TIMESTAMP(3),
    "errorMessage" STRING,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerIdempotencyRecord" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "method" STRING NOT NULL,
    "route" STRING NOT NULL,
    "key" STRING NOT NULL,
    "requestHash" STRING NOT NULL,
    "status" "PartnerIdempotencyStatus" NOT NULL DEFAULT 'PROCESSING',
    "responseStatus" INT4,
    "response" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerIdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerRateBucket" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INT4 NOT NULL DEFAULT 0,

    CONSTRAINT "PartnerRateBucket_pkey" PRIMARY KEY ("id")
);

-- Unlock new CockroachDB tables before Prisma creates indexes and constraints.
ALTER TABLE "Partner" SET (schema_locked = false);
ALTER TABLE "PartnerCredential" SET (schema_locked = false);
ALTER TABLE "PartnerCustomer" SET (schema_locked = false);
ALTER TABLE "PartnerPriceList" SET (schema_locked = false);
ALTER TABLE "PartnerPriceListItem" SET (schema_locked = false);
ALTER TABLE "PartnerQuote" SET (schema_locked = false);
ALTER TABLE "PartnerAccount" SET (schema_locked = false);
ALTER TABLE "PartnerLedgerEntry" SET (schema_locked = false);
ALTER TABLE "PartnerHostedCheckoutSession" SET (schema_locked = false);
ALTER TABLE "PartnerRefundRequest" SET (schema_locked = false);
ALTER TABLE "PartnerWebhookEndpoint" SET (schema_locked = false);
ALTER TABLE "PartnerEvent" SET (schema_locked = false);
ALTER TABLE "PartnerWebhookDelivery" SET (schema_locked = false);
ALTER TABLE "PartnerIdempotencyRecord" SET (schema_locked = false);
ALTER TABLE "PartnerRateBucket" SET (schema_locked = false);

-- CreateIndex
CREATE UNIQUE INDEX "Partner_code_key" ON "Partner"("code");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerCredential_keyPrefix_key" ON "PartnerCredential"("keyPrefix");

-- CreateIndex
CREATE INDEX "PartnerCredential_partnerId_status_idx" ON "PartnerCredential"("partnerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerCustomer_customerId_key" ON "PartnerCustomer"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerCustomer_partnerId_externalCustomerId_key" ON "PartnerCustomer"("partnerId", "externalCustomerId");

-- CreateIndex
CREATE INDEX "PartnerPriceList_partnerId_status_effectiveFrom_idx" ON "PartnerPriceList"("partnerId", "status", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerPriceList_partnerId_version_key" ON "PartnerPriceList"("partnerId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerPriceListItem_priceListId_planId_key" ON "PartnerPriceListItem"("priceListId", "planId");

-- CreateIndex
CREATE INDEX "PartnerQuote_partnerId_status_expiresAt_idx" ON "PartnerQuote"("partnerId", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerAccount_partnerId_key" ON "PartnerAccount"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerLedgerEntry_reference_key" ON "PartnerLedgerEntry"("reference");

-- CreateIndex
CREATE INDEX "PartnerLedgerEntry_partnerId_createdAt_idx" ON "PartnerLedgerEntry"("partnerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerHostedCheckoutSession_tokenHash_key" ON "PartnerHostedCheckoutSession"("tokenHash");

-- CreateIndex
CREATE INDEX "PartnerHostedCheckoutSession_partnerId_expiresAt_idx" ON "PartnerHostedCheckoutSession"("partnerId", "expiresAt");

-- CreateIndex
CREATE INDEX "PartnerRefundRequest_partnerId_status_createdAt_idx" ON "PartnerRefundRequest"("partnerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "PartnerEvent_partnerId_occurredAt_idx" ON "PartnerEvent"("partnerId", "occurredAt");

-- CreateIndex
CREATE INDEX "PartnerWebhookDelivery_status_nextRetryAt_idx" ON "PartnerWebhookDelivery"("status", "nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerWebhookDelivery_eventId_endpointId_key" ON "PartnerWebhookDelivery"("eventId", "endpointId");

-- CreateIndex
CREATE INDEX "PartnerIdempotencyRecord_expiresAt_idx" ON "PartnerIdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerIdempotencyRecord_partnerId_method_route_key_key" ON "PartnerIdempotencyRecord"("partnerId", "method", "route", "key");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerRateBucket_partnerId_windowStart_key" ON "PartnerRateBucket"("partnerId", "windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "Order_partnerQuoteId_key" ON "Order"("partnerQuoteId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_partnerId_externalOrderId_key" ON "Order"("partnerId", "externalOrderId");

-- AddForeignKey
ALTER TABLE "PartnerCredential" ADD CONSTRAINT "PartnerCredential_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerCustomer" ADD CONSTRAINT "PartnerCustomer_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerCustomer" ADD CONSTRAINT "PartnerCustomer_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerPriceList" ADD CONSTRAINT "PartnerPriceList_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerPriceListItem" ADD CONSTRAINT "PartnerPriceListItem_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "PartnerPriceList"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerPriceListItem" ADD CONSTRAINT "PartnerPriceListItem_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerQuote" ADD CONSTRAINT "PartnerQuote_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerQuote" ADD CONSTRAINT "PartnerQuote_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerAccount" ADD CONSTRAINT "PartnerAccount_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerLedgerEntry" ADD CONSTRAINT "PartnerLedgerEntry_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerLedgerEntry" ADD CONSTRAINT "PartnerLedgerEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerHostedCheckoutSession" ADD CONSTRAINT "PartnerHostedCheckoutSession_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerHostedCheckoutSession" ADD CONSTRAINT "PartnerHostedCheckoutSession_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerRefundRequest" ADD CONSTRAINT "PartnerRefundRequest_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerRefundRequest" ADD CONSTRAINT "PartnerRefundRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerWebhookEndpoint" ADD CONSTRAINT "PartnerWebhookEndpoint_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerEvent" ADD CONSTRAINT "PartnerEvent_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerEvent" ADD CONSTRAINT "PartnerEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerWebhookDelivery" ADD CONSTRAINT "PartnerWebhookDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "PartnerEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerWebhookDelivery" ADD CONSTRAINT "PartnerWebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "PartnerWebhookEndpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerIdempotencyRecord" ADD CONSTRAINT "PartnerIdempotencyRecord_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerRateBucket" ADD CONSTRAINT "PartnerRateBucket_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_partnerCustomerId_fkey" FOREIGN KEY ("partnerCustomerId") REFERENCES "PartnerCustomer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_partnerQuoteId_fkey" FOREIGN KEY ("partnerQuoteId") REFERENCES "PartnerQuote"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE TABLE "PartnerDocumentUploadIntent" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "externalOrderId" STRING NOT NULL,
    "type" "DocumentType" NOT NULL,
    "fileName" STRING NOT NULL,
    "contentType" STRING NOT NULL,
    "declaredSizeBytes" INT4 NOT NULL,
    "privateAssetId" STRING NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedOrderId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerDocumentUploadIntent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PartnerDocumentUploadIntent" SET (schema_locked = false);

CREATE UNIQUE INDEX "PartnerDocumentUploadIntent_privateAssetId_key" ON "PartnerDocumentUploadIntent"("privateAssetId");
CREATE INDEX "PartnerDocumentUploadIntent_partnerId_externalOrderId_expiresAt_idx" ON "PartnerDocumentUploadIntent"("partnerId", "externalOrderId", "expiresAt");
CREATE INDEX "PartnerDocumentUploadIntent_partnerId_consumedAt_idx" ON "PartnerDocumentUploadIntent"("partnerId", "consumedAt");

ALTER TABLE "PartnerDocumentUploadIntent" ADD CONSTRAINT "PartnerDocumentUploadIntent_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Plan" SET (schema_locked = false);
ALTER TABLE "Plan" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Order" SET (schema_locked = false);
ALTER TABLE "Order" ADD COLUMN "partnerPaymentProvider" "PaymentProvider";
ALTER TABLE "Order" ADD COLUMN "partnerMetadata" JSONB;
ALTER TABLE "Traveler" SET (schema_locked = false);
DROP INDEX "Traveler_passportNumberHash_key";
CREATE INDEX "Traveler_passportNumberHash_idx" ON "Traveler"("passportNumberHash");
