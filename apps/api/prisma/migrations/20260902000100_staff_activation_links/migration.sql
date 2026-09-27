ALTER TABLE "StaffInvitation"
ADD COLUMN "activationTokenHash" TEXT;

CREATE UNIQUE INDEX "StaffInvitation_activationTokenHash_key"
ON "StaffInvitation"("activationTokenHash");
