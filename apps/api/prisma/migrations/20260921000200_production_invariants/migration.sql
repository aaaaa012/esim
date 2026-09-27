ALTER TYPE "PaymentInitiationStatus" ADD VALUE IF NOT EXISTS 'RECONCILIATION_REQUIRED';
ALTER TYPE "PaymentInitiationStatus" ADD VALUE IF NOT EXISTS 'REMOTE_CREATED';
ALTER TYPE "PaymentInitiationStatus" ADD VALUE IF NOT EXISTS 'ATTACHED';

CREATE TYPE "PartnerApiAuditStatus" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED');

ALTER TABLE "User"
  ADD COLUMN "passwordChangeRequiredAt" TIMESTAMP(3),
  ADD COLUMN "passwordChangeCompletedAt" TIMESTAMP(3),
  ADD COLUMN "passwordChangeClaimToken" UUID,
  ADD COLUMN "passwordChangeClaimExpiresAt" TIMESTAMP(3);

UPDATE "User"
SET "passwordChangeRequiredAt" = COALESCE("updatedAt", "createdAt")
WHERE "mustChangePassword" = true AND "passwordChangeRequiredAt" IS NULL;

ALTER TABLE "PaymentInitiation"
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'NPR',
  ADD COLUMN "paymentReference" TEXT,
  ADD COLUMN "providerCorrelationId" TEXT,
  ADD COLUMN "remoteCreatedAt" TIMESTAMP(3),
  ADD COLUMN "attachedAt" TIMESTAMP(3),
  ADD COLUMN "lastReconciledAt" TIMESTAMP(3);

UPDATE "PaymentInitiation"
SET "paymentReference" = "result"->>'reference',
    "providerCorrelationId" = "result"->>'correlationId',
    "remoteCreatedAt" = COALESCE("updatedAt", "createdAt")
WHERE "status" = 'COMPLETED';

CREATE INDEX "PaymentInitiation_provider_paymentReference_idx"
  ON "PaymentInitiation"("provider", "paymentReference");

ALTER TABLE "PartnerDocumentUploadIntent"
  ADD COLUMN "temporaryAssetId" TEXT,
  ADD COLUMN "contentSha256" TEXT,
  ADD COLUMN "storageVersionId" TEXT;

CREATE TABLE "DocumentAssetVersion" (
  "id" UUID NOT NULL,
  "documentId" UUID NOT NULL,
  "temporaryAssetId" TEXT NOT NULL,
  "finalizedAssetId" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "contentType" TEXT NOT NULL,
  "storageVersionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supersededAt" TIMESTAMP(3),
  CONSTRAINT "DocumentAssetVersion_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TravelerDocument" ADD COLUMN "activeAssetVersionId" UUID;
CREATE UNIQUE INDEX "TravelerDocument_activeAssetVersionId_key" ON "TravelerDocument"("activeAssetVersionId");
CREATE UNIQUE INDEX "DocumentAssetVersion_finalizedAssetId_key" ON "DocumentAssetVersion"("finalizedAssetId");
CREATE UNIQUE INDEX "DocumentAssetVersion_documentId_sha256_key" ON "DocumentAssetVersion"("documentId", "sha256");
CREATE INDEX "DocumentAssetVersion_documentId_createdAt_idx" ON "DocumentAssetVersion"("documentId", "createdAt");
ALTER TABLE "DocumentAssetVersion" ADD CONSTRAINT "DocumentAssetVersion_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "TravelerDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TravelerDocument" ADD CONSTRAINT "TravelerDocument_activeAssetVersionId_fkey"
  FOREIGN KEY ("activeAssetVersionId") REFERENCES "DocumentAssetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "DocumentAssetVersion" (
  "id", "documentId", "temporaryAssetId", "finalizedAssetId", "sha256", "byteSize", "contentType", "createdAt"
)
SELECT md5("id"::text || ':document-asset-version')::uuid, "id", "privateAssetId", "privateAssetId",
       md5("privateAssetId") || md5(reverse("privateAssetId")), 0, 'application/octet-stream', "createdAt"
FROM "TravelerDocument";

UPDATE "TravelerDocument" d
SET "activeAssetVersionId" = v."id"
FROM "DocumentAssetVersion" v
WHERE v."documentId" = d."id";

ALTER TABLE "WorkerHeartbeat" DROP CONSTRAINT "WorkerHeartbeat_pkey";
ALTER TABLE "WorkerHeartbeat" ADD COLUMN "buildVersion" TEXT;
ALTER TABLE "WorkerHeartbeat" ADD CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("worker", "instanceId");
CREATE INDEX "WorkerHeartbeat_worker_lastSeenAt_idx" ON "WorkerHeartbeat"("worker", "lastSeenAt");

CREATE TABLE "PartnerApiAudit" (
  "id" UUID NOT NULL,
  "requestId" TEXT NOT NULL,
  "partnerId" UUID NOT NULL,
  "credentialId" UUID,
  "method" TEXT NOT NULL,
  "route" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "targetId" TEXT,
  "correlationId" TEXT,
  "requestMeta" JSONB,
  "responseMeta" JSONB,
  "responseStatus" INTEGER,
  "status" "PartnerApiAuditStatus" NOT NULL DEFAULT 'STARTED',
  "errorCode" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PartnerApiAudit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PartnerApiAudit_requestId_key" ON "PartnerApiAudit"("requestId");
CREATE INDEX "PartnerApiAudit_partnerId_startedAt_idx" ON "PartnerApiAudit"("partnerId", "startedAt");
CREATE INDEX "PartnerApiAudit_status_startedAt_idx" ON "PartnerApiAudit"("status", "startedAt");
ALTER TABLE "PartnerApiAudit" ADD CONSTRAINT "PartnerApiAudit_partnerId_fkey"
  FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
