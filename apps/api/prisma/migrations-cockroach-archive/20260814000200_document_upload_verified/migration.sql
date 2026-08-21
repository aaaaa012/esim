ALTER TABLE "TravelerDocument" SET (schema_locked = false);

ALTER TABLE "TravelerDocument" ADD COLUMN "uploadVerified" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "TravelerDocument" SET (schema_locked = true);
