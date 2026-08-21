ALTER TABLE "ProvisioningOperation" SET (schema_locked = false);
ALTER TABLE "ProvisioningOperation" ADD COLUMN IF NOT EXISTS "profileSwapCount" INT4 NOT NULL DEFAULT 0;
ALTER TABLE "ProvisioningOperation" SET (schema_locked = true);
