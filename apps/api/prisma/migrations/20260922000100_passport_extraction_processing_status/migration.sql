ALTER TABLE "PassportExtraction"
DROP CONSTRAINT IF EXISTS "PassportExtraction_status_check";

ALTER TABLE "PassportExtraction"
ADD CONSTRAINT "PassportExtraction_status_check"
CHECK (
  "status" IN (
    'PROCESSING',
    'READY',
    'PARTIAL',
    'MANUAL_ENTRY_REQUIRED',
    'SKIPPED'
  )
);
