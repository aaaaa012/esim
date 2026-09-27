CREATE TYPE "HomepageCampaignPlacement" AS ENUM (
  'FEATURED_BANNER',
  'OFFER_GALLERY',
  'HOW_GUIDE',
  'WHY_ESIM_BANNER'
);

CREATE TYPE "HomepageCampaignFormat" AS ENUM (
  'PORTRAIT',
  'SQUARE',
  'LANDSCAPE'
);

CREATE TABLE "HomepageCampaign" (
  "id" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "altText" TEXT NOT NULL,
  "imageUrl" TEXT NOT NULL,
  "assetKey" TEXT,
  "placement" "HomepageCampaignPlacement" NOT NULL,
  "format" "HomepageCampaignFormat" NOT NULL,
  "imageWidth" INTEGER NOT NULL,
  "imageHeight" INTEGER NOT NULL,
  "countryCode" TEXT,
  "ctaLabel" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "HomepageCampaign_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HomepageCampaign_active_placement_sortOrder_idx"
  ON "HomepageCampaign"("active", "placement", "sortOrder");

CREATE INDEX "HomepageCampaign_placement_startsAt_endsAt_idx"
  ON "HomepageCampaign"("placement", "startsAt", "endsAt");

INSERT INTO "HomepageCampaign" (
  "id", "title", "altText", "imageUrl", "placement", "format",
  "imageWidth", "imageHeight", "countryCode", "ctaLabel", "sortOrder",
  "active", "updatedAt"
) VALUES
  ('41000000-0000-4000-8000-000000000001', 'Ubigi eSIM for travellers from Nepal', 'Nepali-language Visa Compass and Ubigi campaign introducing one reusable eSIM for international travel.', '/campaigns/nepali-partnership.webp', 'FEATURED_BANNER', 'LANDSCAPE', 1600, 477, NULL, 'Browse travel plans', 10, true, CURRENT_TIMESTAMP),
  ('41000000-0000-4000-8000-000000000002', 'Australia travel eSIM offer', 'Australia eSIM offer with one reusable eSIM from NPR 550 and Australia data packages from NPR 660.', '/campaigns/australia.webp', 'OFFER_GALLERY', 'PORTRAIT', 768, 1376, 'AU', 'View Australia plans', 20, true, CURRENT_TIMESTAMP),
  ('41000000-0000-4000-8000-000000000003', 'Japan travel eSIM offer', 'Japan eSIM offer with one reusable eSIM from NPR 550 and Japan data packages from NPR 557.', '/campaigns/japan.webp', 'OFFER_GALLERY', 'PORTRAIT', 768, 1376, 'JP', 'View Japan plans', 30, true, CURRENT_TIMESTAMP),
  ('41000000-0000-4000-8000-000000000004', 'Malaysia travel eSIM offer', 'Malaysia eSIM offer with one reusable eSIM from NPR 550 and Malaysia data packages from NPR 989.', '/campaigns/malaysia.webp', 'OFFER_GALLERY', 'PORTRAIT', 768, 1376, 'MY', 'View Malaysia plans', 40, true, CURRENT_TIMESTAMP),
  ('41000000-0000-4000-8000-000000000005', 'Singapore travel eSIM offer', 'Singapore eSIM offer with one reusable eSIM from NPR 550 and Singapore data packages from NPR 495.', '/campaigns/singapore.webp', 'OFFER_GALLERY', 'PORTRAIT', 768, 1376, 'SG', 'View Singapore plans', 50, true, CURRENT_TIMESTAMP),
  ('41000000-0000-4000-8000-000000000006', 'Thailand travel eSIM offer', 'Thailand eSIM offer with one reusable eSIM from NPR 550 and Thailand data packages from NPR 643.', '/campaigns/thailand.webp', 'OFFER_GALLERY', 'PORTRAIT', 768, 1376, 'TH', 'View Thailand plans', 60, true, CURRENT_TIMESTAMP),
  ('41000000-0000-4000-8000-000000000007', 'UAE travel eSIM offer', 'UAE eSIM offer with one reusable eSIM from NPR 550 and UAE data packages from NPR 824.', '/campaigns/uae.webp', 'OFFER_GALLERY', 'PORTRAIT', 768, 1376, 'AE', 'View UAE plans', 70, true, CURRENT_TIMESTAMP),
  ('41000000-0000-4000-8000-000000000008', 'UK travel eSIM offer', 'United Kingdom eSIM offer with one reusable eSIM from NPR 550 and UK data packages from NPR 1154.', '/campaigns/uk.webp', 'OFFER_GALLERY', 'PORTRAIT', 768, 1376, 'GB', 'View UK plans', 80, true, CURRENT_TIMESTAMP),
  ('41000000-0000-4000-8000-000000000009', 'Vietnam travel eSIM offer', 'Vietnam eSIM offer with one reusable eSIM from NPR 550 and Vietnam data packages from NPR 1138.', '/campaigns/vietnam.webp', 'OFFER_GALLERY', 'PORTRAIT', 768, 1376, 'VN', 'View Vietnam plans', 90, true, CURRENT_TIMESTAMP),
  ('41000000-0000-4000-8000-000000000010', 'Purchase and top up in NPR', 'Visa Compass and Ubigi campaign explaining that travellers can purchase and top up an eSIM in Nepali rupees.', '/campaigns/npr-purchase.webp', 'OFFER_GALLERY', 'SQUARE', 1240, 1247, NULL, 'Browse destinations', 100, true, CURRENT_TIMESTAMP),
  ('41000000-0000-4000-8000-000000000011', 'One eSIM for a lifetime of travel', 'Nepali-language Visa Compass and Ubigi campaign describing a reusable eSIM for international trips.', '/campaigns/one-esim-for-life.webp', 'OFFER_GALLERY', 'SQUARE', 1250, 1250, NULL, 'Browse destinations', 110, true, CURRENT_TIMESTAMP),
  ('41000000-0000-4000-8000-000000000012', 'Mobile internet for your next trip', 'Visa Compass campaign summarizing global coverage, NPR payments, secure activation, easy setup, and top-ups.', '/campaigns/mobile-internet-benefits.webp', 'OFFER_GALLERY', 'PORTRAIT', 1165, 1600, NULL, 'Browse destinations', 120, true, CURRENT_TIMESTAMP),
  ('41000000-0000-4000-8000-000000000013', 'Getting started with your eSIM', 'Three-step guide to checking eSIM compatibility, purchasing a plan in NPR, and activating with the emailed QR code.', '/campaigns/getting-started-guide.webp', 'HOW_GUIDE', 'PORTRAIT', 1165, 1600, NULL, 'Check compatibility', 10, true, CURRENT_TIMESTAMP),
  ('41000000-0000-4000-8000-000000000014', 'Visa Compass and Ubigi travel benefits', 'Nepali-language campaign summarizing reusable eSIM, NPR purchase and top-up, QR installation, and global data access.', '/campaigns/partnership-benefits.webp', 'WHY_ESIM_BANNER', 'LANDSCAPE', 1600, 477, NULL, 'Browse travel plans', 10, true, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
