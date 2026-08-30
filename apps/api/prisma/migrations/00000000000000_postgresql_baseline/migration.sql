-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "visa_compass";
SET search_path TO "visa_compass";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "UserRoleName" AS ENUM ('CUSTOMER', 'OPERATIONS', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "StaffInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CustomerSource" AS ENUM ('WEBSITE', 'PARTNER', 'KHALTI');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DISABLED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('INITIAL_PURCHASE', 'TOPUP');

-- CreateEnum
CREATE TYPE "OrderChannel" AS ENUM ('CUSTOMER_WEB', 'PARTNER_API', 'PARTNER_HOSTED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'REVIEW_PENDING', 'AWAITING_CUSTOMER', 'APPROVED', 'PROVISIONING', 'QR_READY', 'COMPLETED', 'PAYMENT_FAILED', 'PAYMENT_REVIEW_REQUIRED', 'CANCELLED', 'PROVISIONING_FAILED', 'ACTIVATION_ATTENTION', 'REFUND_PENDING', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('KHALTI');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('INITIATED', 'PENDING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REVIEW_REQUIRED', 'REFUNDED', 'DISPUTED', 'CHARGED_BACK');

-- CreateEnum
CREATE TYPE "PaymentDisputeType" AS ENUM ('CHARGEBACK', 'DISPUTE');

-- CreateEnum
CREATE TYPE "PaymentDisputeStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'WON', 'LOST', 'RESOLVED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('PASSPORT', 'TICKET', 'VISA');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REUPLOAD_REQUIRED');

-- CreateEnum
CREATE TYPE "InventoryStatus" AS ENUM ('IMPORTED', 'PENDING_PROVIDER_CHECK', 'AVAILABLE', 'RESERVED', 'ASSIGNED', 'ACTIVATED', 'EXPIRED', 'TERMINATED', 'QUARANTINED');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('APPROVED', 'REJECTED', 'REUPLOAD_REQUIRED');

-- CreateEnum
CREATE TYPE "DocumentReviewPolicy" AS ENUM ('AUTO_OCR', 'MANUAL_REVIEW', 'NO_REVIEW');

-- CreateEnum
CREATE TYPE "OperationalDisposition" AS ENUM ('RETRY_AUTOMATIC', 'RECONCILE_PROVIDER', 'MANUAL_ACTION', 'REFUND_ELIGIBLE', 'TERMINAL_REJECTION');

-- CreateEnum
CREATE TYPE "AttentionCaseStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'DISPATCHED', 'FAILED');

-- CreateEnum
CREATE TYPE "DocumentReviewStatus" AS ENUM ('NOT_STARTED', 'OCR_PENDING', 'OCR_BACKGROUND', 'VERIFIED', 'MANUAL_REVIEW', 'REUPLOAD_REQUIRED', 'MANUALLY_APPROVED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ProvisioningStatus" AS ENUM ('QUEUED', 'RUNNING', 'DELAYED', 'SUCCEEDED', 'RETRYING', 'FAILED');

-- CreateEnum
CREATE TYPE "ProvisioningOperationState" AS ENUM ('CREATED', 'SUBMITTING', 'ACCEPTED', 'WAITING_FOR_QR', 'QR_READY', 'ACTIVATED', 'RECONCILE_REQUIRED', 'REJECTED', 'MANUAL_REVIEW', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TransatelLifecycleAction" AS ENUM ('SUSPEND', 'TERMINATE');

-- CreateEnum
CREATE TYPE "TransatelLifecycleState" AS ENUM ('CREATED', 'SUBMITTING', 'ACCEPTED', 'CONFIRMED', 'RECONCILE_REQUIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "ManualRefundStatus" AS ENUM ('REQUESTED', 'APPROVED', 'COMPLETED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ManualRefundReason" AS ENUM ('PROVISIONING_FAILURE', 'INCORRECT_FULFILLMENT', 'DUPLICATE_CHARGE', 'PROVIDER_SERVICE_FAILURE', 'INTERNAL_OPERATIONAL_ERROR');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'TERMINATED', 'FAILED');

-- CreateEnum
CREATE TYPE "AssignmentVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'MISMATCH');

-- CreateEnum
CREATE TYPE "PartnerStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "PartnerCredentialStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PartnerPriceListStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PartnerSettlementMethod" AS ENUM ('PARTNER_ACCOUNT', 'HOSTED_PAYMENT');

-- CreateEnum
CREATE TYPE "PartnerIntegrationType" AS ENUM ('API', 'CHECKOUT_LINK');

-- CreateEnum
CREATE TYPE "PartnerQuoteStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PartnerLedgerEntryType" AS ENUM ('CREDIT', 'DEBIT', 'RESERVATION', 'CAPTURE', 'RELEASE', 'REFUND', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "PartnerRefundStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "PartnerWebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'RETRYING', 'FAILED');

-- CreateEnum
CREATE TYPE "PartnerIdempotencyStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "clerkId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "accountType" "UserRoleName" NOT NULL DEFAULT 'CUSTOMER',
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffInvitation" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "accountType" "UserRoleName" NOT NULL,
    "status" "StaffInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "clerkInvitationId" TEXT,
    "invitedById" UUID NOT NULL,
    "acceptedById" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffInvitation_pkey" PRIMARY KEY ("id")
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
    "customerCode" TEXT NOT NULL,
    "source" "CustomerSource" NOT NULL DEFAULT 'WEBSITE',
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "preferredLanguage" TEXT NOT NULL DEFAULT 'en',
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Country" (
    "id" UUID NOT NULL,
    "isoCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Country_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" UUID NOT NULL,
    "countryId" UUID NOT NULL,
    "providerPlanId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dataAllowance" TEXT NOT NULL,
    "validityDays" INTEGER NOT NULL,
    "costPrice" DECIMAL(12,2) NOT NULL,
    "sellingPrice" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NPR',
    "coverage" JSONB NOT NULL,
    "popular" BOOLEAN NOT NULL DEFAULT false,
    "status" "PlanStatus" NOT NULL DEFAULT 'DRAFT',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "customerId" UUID NOT NULL,
    "partnerId" UUID,
    "partnerCustomerId" UUID,
    "externalOrderId" TEXT,
    "partnerQuoteId" UUID,
    "partnerSettlementMethod" "PartnerSettlementMethod",
    "partnerPaymentProvider" "PaymentProvider",
    "partnerMetadata" JSONB,
    "planId" UUID NOT NULL,
    "orderType" "OrderType" NOT NULL DEFAULT 'INITIAL_PURCHASE',
    "channel" "OrderChannel" NOT NULL DEFAULT 'CUSTOMER_WEB',
    "status" "OrderStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'NPR',
    "subtotal" DECIMAL(12,2) NOT NULL,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "pricingSnapshot" JSONB NOT NULL,
    "compatibilityAcceptedAt" TIMESTAMP(3) NOT NULL,
    "providerSubscriptionId" TEXT,
    "providerStatus" TEXT,
    "qrDeliveredAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "documentReviewPolicy" "DocumentReviewPolicy" NOT NULL DEFAULT 'AUTO_OCR',
    "documentReviewStatus" "DocumentReviewStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "documentReviewStartedAt" TIMESTAMP(3),
    "documentCheckoutReleaseAt" TIMESTAMP(3),
    "activationRefetchAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastProvisioningRecoveryAt" TIMESTAMP(3),
    "operationalDisposition" "OperationalDisposition",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformConfiguration" (
    "id" TEXT NOT NULL DEFAULT 'platform',
    "documentReviewPolicy" "DocumentReviewPolicy" NOT NULL DEFAULT 'AUTO_OCR',
    "ocrCheckoutWaitMs" INTEGER NOT NULL DEFAULT 8000,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Traveler" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "middleName" TEXT,
    "surname" TEXT NOT NULL,
    "dateOfBirthEncrypted" TEXT NOT NULL,
    "nationality" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "countryOfResidence" TEXT NOT NULL,
    "employerOrBusinessName" TEXT,
    "email" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "passportNumberEncrypted" TEXT NOT NULL,
    "passportNumberHash" TEXT NOT NULL,
    "passportExpiryEncrypted" TEXT NOT NULL,
    "pointOfSaleCode" TEXT,
    "countryOfPurchase" TEXT NOT NULL DEFAULT 'NP',
    "subscriberLanguage" TEXT NOT NULL DEFAULT 'en',

    CONSTRAINT "Traveler_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TravelerDocument" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "type" "DocumentType" NOT NULL,
    "fileName" TEXT NOT NULL,
    "privateAssetId" TEXT NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "uploadVerified" BOOLEAN NOT NULL DEFAULT false,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "passportVerificationStatus" TEXT,
    "passportVerificationMethod" TEXT,
    "passportMatchedFields" JSONB,
    "passportConfidence" DOUBLE PRECISION,
    "passportVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TravelerDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerTransactionId" TEXT,
    "providerCorrelationId" TEXT,
    "paymentReference" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NPR',
    "status" "PaymentStatus" NOT NULL DEFAULT 'INITIATED',
    "paidAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "returnUrl" TEXT,
    "redirectUrl" TEXT,
    "verificationAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryBatch" (
    "id" UUID NOT NULL,
    "batchReference" TEXT NOT NULL,
    "totalProfiles" INTEGER NOT NULL,
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "status" "BatchStatus" NOT NULL DEFAULT 'PENDING',
    "submittedById" UUID,
    "approvedById" UUID,
    "rejectedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EsimInventory" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "iccid" TEXT NOT NULL,
    "eid" TEXT NOT NULL,
    "msisdn" TEXT,
    "status" "InventoryStatus" NOT NULL DEFAULT 'IMPORTED',
    "assignedOrderId" UUID,
    "activationCodeEncrypted" TEXT,
    "smDpAddress" TEXT,
    "providerSubscriptionId" TEXT,
    "providerStatus" TEXT,
    "lastProviderCheckedAt" TIMESTAMP(3),
    "providerCheckError" TEXT,
    "activatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EsimInventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryReconciliationRun" (
    "id" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "selection" TEXT NOT NULL,
    "batchId" UUID,
    "requestedById" UUID,
    "total" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "InventoryReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryReconciliationItem" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "inventoryId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "checkedAt" TIMESTAMP(3),

    CONSTRAINT "InventoryReconciliationItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerEsim" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "inventoryId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "qrPayloadEncrypted" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerEsim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" UUID NOT NULL,
    "customerEsimId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerSubscriptionId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "activatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "usedMb" INTEGER NOT NULL DEFAULT 0,
    "totalMb" INTEGER NOT NULL DEFAULT 0,
    "usageLastCheckedAt" TIMESTAMP(3),
    "assignmentVerificationStatus" "AssignmentVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "assignmentVerifiedAt" TIMESTAMP(3),
    "providerLastSeenAt" TIMESTAMP(3),

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Partner" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "brand" JSONB,
    "status" "PartnerStatus" NOT NULL DEFAULT 'PENDING',
    "integrationType" "PartnerIntegrationType" NOT NULL DEFAULT 'API',
    "allowedSettlementMethods" JSONB NOT NULL,
    "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 120,
    "redirectAllowlist" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Partner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerDocumentUploadIntent" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "verificationId" UUID,
    "externalOrderId" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "declaredSizeBytes" INTEGER NOT NULL,
    "privateAssetId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedOrderId" UUID,
    "verificationStatus" TEXT NOT NULL DEFAULT 'AWAITING_UPLOAD',
    "uploadVerified" BOOLEAN NOT NULL DEFAULT false,
    "verificationCode" TEXT,
    "verificationResult" JSONB,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerDocumentUploadIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerDocumentVerification" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AWAITING_UPLOAD',
    "travelerSnapshot" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedOrderId" UUID,
    "failureCode" TEXT,
    "reviewPolicy" "DocumentReviewPolicy" NOT NULL DEFAULT 'AUTO_OCR',
    "checkoutReleaseAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerDocumentVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerCredential" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
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
    "externalCustomerId" TEXT NOT NULL,
    "customerId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerPriceList" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NPR',
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
    "wholesaleAmountPaisa" INTEGER NOT NULL,
    "retailAmountPaisa" INTEGER NOT NULL,

    CONSTRAINT "PartnerPriceListItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerQuote" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "priceListId" UUID,
    "settlementMethod" "PartnerSettlementMethod" NOT NULL,
    "wholesaleAmountPaisa" INTEGER NOT NULL,
    "retailAmountPaisa" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NPR',
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
    "balancePaisa" INTEGER NOT NULL DEFAULT 0,
    "creditLimitPaisa" INTEGER NOT NULL DEFAULT 0,
    "reservedPaisa" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerLedgerEntry" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "orderId" UUID,
    "type" "PartnerLedgerEntryType" NOT NULL,
    "amountPaisa" INTEGER NOT NULL,
    "balanceAfterPaisa" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerHostedCheckoutSession" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "redirectUrl" TEXT NOT NULL,
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
    "amountPaisa" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
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
    "url" TEXT NOT NULL,
    "secretEncrypted" TEXT NOT NULL,
    "eventTypes" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerWebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerEvent" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "orderId" UUID,
    "type" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1.0',
    "resourceId" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
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
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "responseStatus" INTEGER,
    "latencyMs" INTEGER,
    "nextRetryAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerIdempotencyRecord" (
    "id" UUID NOT NULL,
    "partnerId" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "PartnerIdempotencyStatus" NOT NULL DEFAULT 'PROCESSING',
    "responseStatus" INTEGER,
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
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PartnerRateBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderReview" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "reviewerId" UUID NOT NULL,
    "decision" "ReviewDecision" NOT NULL,
    "reasons" JSONB NOT NULL,
    "comments" TEXT,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderEvent" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "fromStatus" "OrderStatus",
    "toStatus" "OrderStatus" NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvisioningAttempt" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "ProvisioningStatus" NOT NULL,
    "correlationId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "requestSnapshot" JSONB NOT NULL,
    "responseSnapshot" JSONB,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ProvisioningAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvisioningOperation" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'TRANSATEL',
    "state" "ProvisioningOperationState" NOT NULL DEFAULT 'CREATED',
    "idempotencyKey" TEXT NOT NULL,
    "iccid" TEXT NOT NULL,
    "providerProductId" TEXT NOT NULL,
    "providerOrderId" TEXT,
    "providerSubscriptionId" TEXT,
    "requestSnapshot" JSONB NOT NULL,
    "responseSnapshot" JSONB,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "profileSwapCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCategory" TEXT,
    "lastErrorMessage" TEXT,
    "submittedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "nextReconcileAt" TIMESTAMP(3),
    "reconcileDeadlineAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProvisioningOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransatelLifecycleOperation" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "action" "TransatelLifecycleAction" NOT NULL,
    "state" "TransatelLifecycleState" NOT NULL DEFAULT 'CREATED',
    "idempotencyKey" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "performedById" UUID NOT NULL,
    "providerTransactionId" TEXT,
    "requestSnapshot" JSONB NOT NULL,
    "responseSnapshot" JSONB,
    "errorMessage" TEXT,
    "submittedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransatelLifecycleOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualRefund" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "status" "ManualRefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "activeKey" TEXT,
    "reason" "ManualRefundReason" NOT NULL,
    "explanation" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "requestedById" UUID NOT NULL,
    "reviewedById" UUID,
    "reviewNote" TEXT,
    "providerReference" TEXT,
    "completionNote" TEXT,
    "completedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentDispute" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerCaseId" TEXT NOT NULL,
    "openedEventId" TEXT NOT NULL,
    "type" "PaymentDisputeType" NOT NULL,
    "status" "PaymentDisputeStatus" NOT NULL DEFAULT 'OPEN',
    "amount" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'NPR',
    "reason" TEXT,
    "providerEvidence" JSONB,
    "resolutionNote" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentDispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "signatureValid" BOOLEAN NOT NULL,
    "processedAt" TIMESTAMP(3),
    "processingStartedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "deadLetteredAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationLog" (
    "id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "orderId" UUID,
    "channel" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "recipient" TEXT,
    "orderNumber" TEXT,
    "reason" TEXT,
    "status" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
CREATE TABLE "CustomerConsent" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerShowcase" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerShowcase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "module" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
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
CREATE UNIQUE INDEX "StaffInvitation_clerkInvitationId_key" ON "StaffInvitation"("clerkInvitationId");

-- CreateIndex
CREATE INDEX "StaffInvitation_email_status_idx" ON "StaffInvitation"("email", "status");

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
CREATE UNIQUE INDEX "Order_partnerQuoteId_key" ON "Order"("partnerQuoteId");

-- CreateIndex
CREATE INDEX "Order_customerId_status_idx" ON "Order"("customerId", "status");

-- CreateIndex
CREATE INDEX "Order_status_createdAt_idx" ON "Order"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Order_partnerId_idx" ON "Order"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_partnerId_externalOrderId_key" ON "Order"("partnerId", "externalOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Traveler_orderId_key" ON "Traveler"("orderId");

-- CreateIndex
CREATE INDEX "Traveler_passportNumberHash_idx" ON "Traveler"("passportNumberHash");

-- CreateIndex
CREATE INDEX "TravelerDocument_status_idx" ON "TravelerDocument"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TravelerDocument_orderId_type_key" ON "TravelerDocument"("orderId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_paymentReference_key" ON "Payment"("paymentReference");

-- CreateIndex
CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_provider_providerTransactionId_key" ON "Payment"("provider", "providerTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryBatch_batchReference_key" ON "InventoryBatch"("batchReference");

-- CreateIndex
CREATE UNIQUE INDEX "EsimInventory_iccid_key" ON "EsimInventory"("iccid");

-- CreateIndex
CREATE UNIQUE INDEX "EsimInventory_eid_key" ON "EsimInventory"("eid");

-- CreateIndex
CREATE UNIQUE INDEX "EsimInventory_msisdn_key" ON "EsimInventory"("msisdn");

-- CreateIndex
CREATE UNIQUE INDEX "EsimInventory_assignedOrderId_key" ON "EsimInventory"("assignedOrderId");

-- CreateIndex
CREATE INDEX "EsimInventory_status_idx" ON "EsimInventory"("status");

-- CreateIndex
CREATE INDEX "InventoryReconciliationRun_status_createdAt_idx" ON "InventoryReconciliationRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryReconciliationRun_batchId_idx" ON "InventoryReconciliationRun"("batchId");

-- CreateIndex
CREATE INDEX "InventoryReconciliationItem_runId_status_idx" ON "InventoryReconciliationItem"("runId", "status");

-- CreateIndex
CREATE INDEX "InventoryReconciliationItem_inventoryId_idx" ON "InventoryReconciliationItem"("inventoryId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryReconciliationItem_runId_inventoryId_key" ON "InventoryReconciliationItem"("runId", "inventoryId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerEsim_orderId_key" ON "CustomerEsim"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_providerSubscriptionId_key" ON "Subscription"("providerSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "Partner_code_key" ON "Partner"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Partner_slug_key" ON "Partner"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerDocumentUploadIntent_privateAssetId_key" ON "PartnerDocumentUploadIntent"("privateAssetId");

-- CreateIndex
CREATE INDEX "PartnerDocumentUploadIntent_partnerId_externalOrderId_expir_idx" ON "PartnerDocumentUploadIntent"("partnerId", "externalOrderId", "expiresAt");

-- CreateIndex
CREATE INDEX "PartnerDocumentUploadIntent_partnerId_consumedAt_idx" ON "PartnerDocumentUploadIntent"("partnerId", "consumedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerDocumentVerification_consumedOrderId_key" ON "PartnerDocumentVerification"("consumedOrderId");

-- CreateIndex
CREATE INDEX "PartnerDocumentVerification_partnerId_externalOrderId_idx" ON "PartnerDocumentVerification"("partnerId", "externalOrderId");

-- CreateIndex
CREATE INDEX "PartnerDocumentVerification_status_expiresAt_idx" ON "PartnerDocumentVerification"("status", "expiresAt");

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
CREATE INDEX "PartnerLedgerEntry_orderId_idx" ON "PartnerLedgerEntry"("orderId");

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
CREATE INDEX "OrderEvent_orderId_createdAt_idx" ON "OrderEvent"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProvisioningAttempt_correlationId_key" ON "ProvisioningAttempt"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "ProvisioningOperation_orderId_key" ON "ProvisioningOperation"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "ProvisioningOperation_idempotencyKey_key" ON "ProvisioningOperation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ProvisioningOperation_state_nextReconcileAt_idx" ON "ProvisioningOperation"("state", "nextReconcileAt");

-- CreateIndex
CREATE INDEX "ProvisioningOperation_providerSubscriptionId_idx" ON "ProvisioningOperation"("providerSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "TransatelLifecycleOperation_idempotencyKey_key" ON "TransatelLifecycleOperation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "TransatelLifecycleOperation_orderId_createdAt_idx" ON "TransatelLifecycleOperation"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "TransatelLifecycleOperation_state_createdAt_idx" ON "TransatelLifecycleOperation"("state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ManualRefund_activeKey_key" ON "ManualRefund"("activeKey");

-- CreateIndex
CREATE UNIQUE INDEX "ManualRefund_providerReference_key" ON "ManualRefund"("providerReference");

-- CreateIndex
CREATE INDEX "ManualRefund_status_createdAt_idx" ON "ManualRefund"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ManualRefund_orderId_createdAt_idx" ON "ManualRefund"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentDispute_status_openedAt_idx" ON "PaymentDispute"("status", "openedAt");

-- CreateIndex
CREATE INDEX "PaymentDispute_orderId_status_idx" ON "PaymentDispute"("orderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentDispute_provider_providerCaseId_key" ON "PaymentDispute"("provider", "providerCaseId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentDispute_provider_openedEventId_key" ON "PaymentDispute"("provider", "openedEventId");

-- CreateIndex
CREATE INDEX "WebhookEvent_processedAt_deadLetteredAt_nextAttemptAt_idx" ON "WebhookEvent"("processedAt", "deadLetteredAt", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_source_eventId_key" ON "WebhookEvent"("source", "eventId");

-- CreateIndex
CREATE INDEX "IntegrationLog_operation_createdAt_idx" ON "IntegrationLog"("operation", "createdAt");

-- CreateIndex
CREATE INDEX "IntegrationLog_status_idx" ON "IntegrationLog"("status");

-- CreateIndex
CREATE INDEX "Notification_status_nextAttemptAt_idx" ON "Notification"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "AttentionCase_dedupeKey_key" ON "AttentionCase"("dedupeKey");

-- CreateIndex
CREATE INDEX "AttentionCase_status_category_createdAt_idx" ON "AttentionCase"("status", "category", "createdAt");

-- CreateIndex
CREATE INDEX "AttentionCase_orderId_status_idx" ON "AttentionCase"("orderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxMessage_dedupeKey_key" ON "OutboxMessage"("dedupeKey");

-- CreateIndex
CREATE INDEX "OutboxMessage_status_nextAttemptAt_idx" ON "OutboxMessage"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "PartnerShowcase_active_sortOrder_idx" ON "PartnerShowcase"("active", "sortOrder");

-- AddForeignKey
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "Order" ADD CONSTRAINT "Order_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_partnerCustomerId_fkey" FOREIGN KEY ("partnerCustomerId") REFERENCES "PartnerCustomer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_partnerQuoteId_fkey" FOREIGN KEY ("partnerQuoteId") REFERENCES "PartnerQuote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "InventoryReconciliationRun" ADD CONSTRAINT "InventoryReconciliationRun_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "InventoryBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReconciliationItem" ADD CONSTRAINT "InventoryReconciliationItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "InventoryReconciliationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReconciliationItem" ADD CONSTRAINT "InventoryReconciliationItem_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "EsimInventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerEsim" ADD CONSTRAINT "CustomerEsim_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerEsim" ADD CONSTRAINT "CustomerEsim_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "EsimInventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerEsim" ADD CONSTRAINT "CustomerEsim_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_customerEsimId_fkey" FOREIGN KEY ("customerEsimId") REFERENCES "CustomerEsim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerDocumentUploadIntent" ADD CONSTRAINT "PartnerDocumentUploadIntent_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerDocumentUploadIntent" ADD CONSTRAINT "PartnerDocumentUploadIntent_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "PartnerDocumentVerification"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerDocumentVerification" ADD CONSTRAINT "PartnerDocumentVerification_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "OrderReview" ADD CONSTRAINT "OrderReview_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReview" ADD CONSTRAINT "OrderReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisioningAttempt" ADD CONSTRAINT "ProvisioningAttempt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisioningOperation" ADD CONSTRAINT "ProvisioningOperation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransatelLifecycleOperation" ADD CONSTRAINT "TransatelLifecycleOperation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransatelLifecycleOperation" ADD CONSTRAINT "TransatelLifecycleOperation_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualRefund" ADD CONSTRAINT "ManualRefund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualRefund" ADD CONSTRAINT "ManualRefund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualRefund" ADD CONSTRAINT "ManualRefund_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualRefund" ADD CONSTRAINT "ManualRefund_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentDispute" ADD CONSTRAINT "PaymentDispute_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentDispute" ADD CONSTRAINT "PaymentDispute_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttentionCase" ADD CONSTRAINT "AttentionCase_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxMessage" ADD CONSTRAINT "OutboxMessage_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerConsent" ADD CONSTRAINT "CustomerConsent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
