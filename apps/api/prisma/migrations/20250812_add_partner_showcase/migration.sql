-- CreateTable
CREATE TABLE "PartnerShowcase" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" STRING NOT NULL,
    "logoUrl" STRING,
    "sortOrder" INT4 NOT NULL DEFAULT 0,
    "active" BOOL NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PartnerShowcase_pkey" PRIMARY KEY ("id")
);

-- CockroachDB schemas using changefeeds may create tables schema-locked.
-- Explicitly unlock only for the secondary index, then restore the lock.
ALTER TABLE "PartnerShowcase" SET (schema_locked = false);

-- CreateIndex
CREATE INDEX "PartnerShowcase_active_sortOrder_idx" ON "PartnerShowcase"("active", "sortOrder");

ALTER TABLE "PartnerShowcase" SET (schema_locked = true);
