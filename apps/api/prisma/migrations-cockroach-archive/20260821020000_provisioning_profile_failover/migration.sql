-- CockroachDB may schema-lock changefeed-watched tables. Keep the unlock window
-- limited to this additive change and restore the performance protection.
ALTER TABLE "ProvisioningOperation" SET (schema_locked = false);
ALTER TABLE "ProvisioningOperation"
  ADD COLUMN "profileSwapCount" INT4 NOT NULL DEFAULT 0;
ALTER TABLE "ProvisioningOperation" SET (schema_locked = true);
