-- Partner branding + deep-link slug for the no-code hosted checkout track.
ALTER TABLE "Partner" ADD COLUMN IF NOT EXISTS "slug" STRING;
ALTER TABLE "Partner" ADD COLUMN IF NOT EXISTS "brand" JSONB;
CREATE UNIQUE INDEX IF NOT EXISTS "Partner_slug_key" ON "Partner"("slug");