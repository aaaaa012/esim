ALTER TABLE "HomepageCampaign"
  ADD COLUMN "eyebrow" TEXT,
  ADD COLUMN "summary" TEXT,
  ADD COLUMN "priceLabel" TEXT,
  ADD COLUMN "termsLabel" TEXT,
  ADD COLUMN "ctaHrefOverride" TEXT,
  ADD COLUMN "mobileImageUrl" TEXT,
  ADD COLUMN "mobileAssetKey" TEXT,
  ADD COLUMN "mobileImageWidth" INTEGER,
  ADD COLUMN "mobileImageHeight" INTEGER,
  ADD COLUMN "mobileFormat" "HomepageCampaignFormat";

CREATE TABLE "HomepageFeaturedPlan" (
  "id" UUID NOT NULL,
  "planId" UUID NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HomepageFeaturedPlan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HomepageFeaturedPlan_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "HomepageFeaturedPlan_active_sortOrder_idx" ON "HomepageFeaturedPlan"("active", "sortOrder");
CREATE INDEX "HomepageFeaturedPlan_planId_startsAt_endsAt_idx" ON "HomepageFeaturedPlan"("planId", "startsAt", "endsAt");

INSERT INTO "HomepageFeaturedPlan" ("id", "planId", "sortOrder", "active", "createdAt", "updatedAt")
SELECT gen_random_uuid(), "id", ROW_NUMBER() OVER (ORDER BY "sellingPrice" ASC, "id" ASC) - 1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Plan"
WHERE "popular" = true AND "status" = 'ACTIVE'
ORDER BY "sellingPrice" ASC, "id" ASC
LIMIT 12;

-- Record and repair canonical catalogue labels before traffic is sent to the
-- new merchandising surfaces. Unlimited is removed when the catalogue only
-- provides a finite allowance and no authoritative throttled-service rule.
INSERT INTO "AuditLog" ("id", "module", "entity", "entityId", "action", "previousValue", "newValue", "createdAt")
SELECT gen_random_uuid(), 'CATALOG_DATA_QUALITY', 'Country', "id", 'CANONICALIZED',
       jsonb_build_object('name', "name"), jsonb_build_object('name', 'Côte d’Ivoire'), CURRENT_TIMESTAMP
FROM "Country"
WHERE "isoCode" = 'CI' AND "name" IS DISTINCT FROM 'Côte d’Ivoire';

UPDATE "Country"
SET "name" = 'Côte d’Ivoire'
WHERE "isoCode" = 'CI' AND "name" IS DISTINCT FROM 'Côte d’Ivoire';

INSERT INTO "AuditLog" ("id", "module", "entity", "entityId", "action", "previousValue", "newValue", "createdAt")
SELECT gen_random_uuid(), 'CATALOG_DATA_QUALITY', 'Plan', "id", 'CANONICALIZED',
       jsonb_build_object('name', "name"),
       jsonb_build_object(
         'name', trim(regexp_replace(regexp_replace(regexp_replace("name", '\mUsa\M', 'USA', 'g'), '\mSim\M', 'eSIM', 'g'), 'unlimited\s+data', "dataAllowance", 'gi'))
       ), CURRENT_TIMESTAMP
FROM "Plan"
WHERE "name" ~ '\mUsa\M|\mSim\M' OR "name" ~* 'unlimited\s+data';

UPDATE "Plan"
SET "name" = trim(regexp_replace(regexp_replace(regexp_replace("name", '\mUsa\M', 'USA', 'g'), '\mSim\M', 'eSIM', 'g'), 'unlimited\s+data', "dataAllowance", 'gi')),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "name" ~ '\mUsa\M|\mSim\M' OR "name" ~* 'unlimited\s+data';
