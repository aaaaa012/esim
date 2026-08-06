-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "UserRoleName" AS ENUM ('CUSTOMER', 'OPERATIONS', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "CustomerSource" AS ENUM ('WEBSITE', 'PARTNER', 'KHALTI');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DISABLED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('INITIAL_PURCHASE', 'TOPUP');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'REVIEW_PENDING', 'AWAITING_CUSTOMER', 'APPROVED', 'PROVISIONING', 'COMPLETED', 'PAYMENT_FAILED', 'CANCELLED', 'PROVISIONING_FAILED', 'REFUND_PENDING', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('KHALTI');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('INITIATED', 'PENDING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('PASSPORT', 'TICKET', 'VISA');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REUPLOAD_REQUIRED');

-- CreateEnum
CREATE TYPE "InventoryStatus" AS ENUM ('IMPORTED', 'AVAILABLE', 'RESERVED', 'ASSIGNED', 'ACTIVATED', 'EXPIRED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('APPROVED', 'REJECTED', 'REUPLOAD_REQUIRED');

-- CreateEnum
CREATE TYPE "ProvisioningStatus" AS ENUM ('QUEUED', 'RUNNING', 'DELAYED', 'SUCCEEDED', 'RETRYING', 'FAILED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'TERMINATED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "clerkId" STRING NOT NULL,
    "email" STRING NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" UUID NOT NULL,
    "name" "UserRoleName" NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "customerCode" STRING NOT NULL,
    "source" "CustomerSource" NOT NULL DEFAULT 'WEBSITE',
    "email" STRING NOT NULL,
    "phone" STRING,
    "preferredLanguage" STRING NOT NULL DEFAULT 'en',
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Country" (
    "id" UUID NOT NULL,
    "isoCode" STRING NOT NULL,
    "name" STRING NOT NULL,
    "active" BOOL NOT NULL DEFAULT true,

    CONSTRAINT "Country_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" UUID NOT NULL,
    "countryId" UUID NOT NULL,
    "providerPlanId" STRING NOT NULL,
    "name" STRING NOT NULL,
    "dataAllowance" STRING NOT NULL,
    "validityDays" INT4 NOT NULL,
    "costPrice" DECIMAL(12,2) NOT NULL,
    "sellingPrice" DECIMAL(12,2) NOT NULL,
    "currency" STRING NOT NULL DEFAULT 'NPR',
    "coverage" JSONB NOT NULL,
    "popular" BOOL NOT NULL DEFAULT false,
    "status" "PlanStatus" NOT NULL DEFAULT 'DRAFT',

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL,
    "orderNumber" STRING NOT NULL,
    "customerId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "orderType" "OrderType" NOT NULL DEFAULT 'INITIAL_PURCHASE',
    "status" "OrderStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" STRING NOT NULL DEFAULT 'NPR',
    "subtotal" DECIMAL(12,2) NOT NULL,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "pricingSnapshot" JSONB NOT NULL,
    "compatibilityAcceptedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INT4 NOT NULL DEFAULT 0,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Traveler" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "title" STRING NOT NULL,
    "firstName" STRING NOT NULL,
    "middleName" STRING,
    "surname" STRING NOT NULL,
    "dateOfBirthEncrypted" STRING NOT NULL,
    "nationality" STRING NOT NULL,
    "city" STRING NOT NULL,
    "countryOfResidence" STRING NOT NULL,
    "employerOrBusinessName" STRING,
    "email" STRING NOT NULL,
    "mobile" STRING NOT NULL,
    "passportNumberEncrypted" STRING NOT NULL,
    "passportNumberHash" STRING NOT NULL,
    "passportExpiryEncrypted" STRING NOT NULL,
    "pointOfSaleCode" STRING,
    "countryOfPurchase" STRING NOT NULL DEFAULT 'NP',
    "subscriberLanguage" STRING NOT NULL DEFAULT 'en',

    CONSTRAINT "Traveler_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TravelerDocument" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "type" "DocumentType" NOT NULL,
    "fileName" STRING NOT NULL,
    "privateAssetId" STRING NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TravelerDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerTransactionId" STRING,
    "providerCorrelationId" STRING,
    "paymentReference" STRING NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" STRING NOT NULL DEFAULT 'NPR',
    "status" "PaymentStatus" NOT NULL DEFAULT 'INITIATED',
    "paidAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "returnUrl" STRING,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryBatch" (
    "id" UUID NOT NULL,
    "batchReference" STRING NOT NULL,
    "totalProfiles" INT4 NOT NULL,
    "importedCount" INT4 NOT NULL DEFAULT 0,
    "failedCount" INT4 NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EsimInventory" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "iccid" STRING NOT NULL,
    "eid" STRING NOT NULL,
    "status" "InventoryStatus" NOT NULL DEFAULT 'IMPORTED',
    "assignedOrderId" UUID,
    "activationCodeEncrypted" STRING,
    "smDpAddress" STRING,
    "version" INT4 NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EsimInventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerEsim" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "inventoryId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "qrPayloadEncrypted" STRING NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerEsim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" UUID NOT NULL,
    "customerEsimId" UUID NOT NULL,
    "provider" STRING NOT NULL,
    "providerSubscriptionId" STRING NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "activatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderReview" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "reviewerId" UUID NOT NULL,
    "decision" "ReviewDecision" NOT NULL,
    "reasons" JSONB NOT NULL,
    "comments" STRING,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderEvent" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "fromStatus" "OrderStatus",
    "toStatus" "OrderStatus" NOT NULL,
    "actorId" STRING,
    "reason" STRING,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvisioningAttempt" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "provider" STRING NOT NULL,
    "status" "ProvisioningStatus" NOT NULL,
    "correlationId" STRING NOT NULL,
    "attempt" INT4 NOT NULL,
    "requestSnapshot" JSONB NOT NULL,
    "responseSnapshot" JSONB,
    "errorCode" STRING,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ProvisioningAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" UUID NOT NULL,
    "source" STRING NOT NULL,
    "eventId" STRING NOT NULL,
    "payload" JSONB NOT NULL,
    "signatureValid" BOOL NOT NULL,
    "processedAt" TIMESTAMP(3),
    "errorMessage" STRING,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "orderId" UUID,
    "channel" STRING NOT NULL,
    "template" STRING NOT NULL,
    "status" STRING NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerConsent" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "type" STRING NOT NULL,
    "version" STRING NOT NULL,
    "ipAddress" STRING NOT NULL,
    "userAgent" STRING NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "module" STRING NOT NULL,
    "entity" STRING NOT NULL,
    "entityId" STRING NOT NULL,
    "action" STRING NOT NULL,
    "performedById" UUID,
    "previousValue" JSONB,
    "newValue" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_clerkId_key" ON "User"("clerkId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_userId_key" ON "Customer"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_customerCode_key" ON "Customer"("customerCode");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_email_key" ON "Customer"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Country_isoCode_key" ON "Country"("isoCode");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_countryId_providerPlanId_key" ON "Plan"("countryId", "providerPlanId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");

-- CreateIndex
CREATE INDEX "Order_customerId_status_idx" ON "Order"("customerId", "status");

-- CreateIndex
CREATE INDEX "Order_status_createdAt_idx" ON "Order"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Traveler_orderId_key" ON "Traveler"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Traveler_passportNumberHash_key" ON "Traveler"("passportNumberHash");

-- CreateIndex
CREATE INDEX "TravelerDocument_status_idx" ON "TravelerDocument"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TravelerDocument_orderId_type_key" ON "TravelerDocument"("orderId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_paymentReference_key" ON "Payment"("paymentReference");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_provider_providerTransactionId_key" ON "Payment"("provider", "providerTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryBatch_batchReference_key" ON "InventoryBatch"("batchReference");

-- CreateIndex
CREATE UNIQUE INDEX "EsimInventory_iccid_key" ON "EsimInventory"("iccid");

-- CreateIndex
CREATE UNIQUE INDEX "EsimInventory_eid_key" ON "EsimInventory"("eid");

-- CreateIndex
CREATE UNIQUE INDEX "EsimInventory_assignedOrderId_key" ON "EsimInventory"("assignedOrderId");

-- CreateIndex
CREATE INDEX "EsimInventory_status_idx" ON "EsimInventory"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerEsim_inventoryId_key" ON "CustomerEsim"("inventoryId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerEsim_orderId_key" ON "CustomerEsim"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_providerSubscriptionId_key" ON "Subscription"("providerSubscriptionId");

-- CreateIndex
CREATE INDEX "OrderEvent_orderId_createdAt_idx" ON "OrderEvent"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProvisioningAttempt_correlationId_key" ON "ProvisioningAttempt"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_source_eventId_key" ON "WebhookEvent"("source", "eventId");

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "Country"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Traveler" ADD CONSTRAINT "Traveler_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TravelerDocument" ADD CONSTRAINT "TravelerDocument_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EsimInventory" ADD CONSTRAINT "EsimInventory_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "InventoryBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EsimInventory" ADD CONSTRAINT "EsimInventory_assignedOrderId_fkey" FOREIGN KEY ("assignedOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerEsim" ADD CONSTRAINT "CustomerEsim_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerEsim" ADD CONSTRAINT "CustomerEsim_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "EsimInventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerEsim" ADD CONSTRAINT "CustomerEsim_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_customerEsimId_fkey" FOREIGN KEY ("customerEsimId") REFERENCES "CustomerEsim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReview" ADD CONSTRAINT "OrderReview_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReview" ADD CONSTRAINT "OrderReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisioningAttempt" ADD CONSTRAINT "ProvisioningAttempt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerConsent" ADD CONSTRAINT "CustomerConsent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
