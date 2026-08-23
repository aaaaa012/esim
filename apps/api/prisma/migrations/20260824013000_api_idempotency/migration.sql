CREATE TYPE "ApiIdempotencyStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

CREATE TABLE "ApiIdempotencyRecord" (
    "id" UUID NOT NULL,
    "principalId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "ApiIdempotencyStatus" NOT NULL DEFAULT 'PROCESSING',
    "responseStatus" INTEGER,
    "response" JSONB,
    "claimExpiresAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ApiIdempotencyRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiIdempotencyRecord_principalId_method_route_key_key"
ON "ApiIdempotencyRecord"("principalId", "method", "route", "key");
CREATE INDEX "ApiIdempotencyRecord_status_claimExpiresAt_idx"
ON "ApiIdempotencyRecord"("status", "claimExpiresAt");
CREATE INDEX "ApiIdempotencyRecord_expiresAt_idx"
ON "ApiIdempotencyRecord"("expiresAt");
