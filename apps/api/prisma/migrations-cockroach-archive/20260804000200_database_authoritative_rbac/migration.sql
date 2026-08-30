CREATE TYPE IF NOT EXISTS "StaffInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "accountType" "UserRoleName" NOT NULL DEFAULT 'CUSTOMER';

CREATE TABLE IF NOT EXISTS "StaffInvitation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "email" STRING NOT NULL,
  "accountType" "UserRoleName" NOT NULL,
  "status" "StaffInvitationStatus" NOT NULL DEFAULT 'PENDING',
  "clerkInvitationId" STRING,
  "invitedById" UUID NOT NULL,
  "acceptedById" UUID,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StaffInvitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StaffInvitation_clerkInvitationId_key" ON "StaffInvitation"("clerkInvitationId");
CREATE INDEX IF NOT EXISTS "StaffInvitation_email_status_idx" ON "StaffInvitation"("email", "status");
ALTER TABLE "StaffInvitation" ADD CONSTRAINT IF NOT EXISTS "StaffInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

UPDATE "User" AS u
SET "accountType" = CASE
  WHEN EXISTS (
    SELECT 1 FROM "Customer" c
    WHERE c."userId" = u.id
      AND (EXISTS (SELECT 1 FROM "Order" o WHERE o."customerId" = c.id)
        OR EXISTS (SELECT 1 FROM "CustomerEsim" e WHERE e."customerId" = c.id))
  ) THEN 'CUSTOMER'::"UserRoleName"
  WHEN EXISTS (SELECT 1 FROM "UserRole" ur JOIN "Role" r ON r.id = ur."roleId" WHERE ur."userId" = u.id AND r.name = 'SUPER_ADMIN') THEN 'SUPER_ADMIN'::"UserRoleName"
  WHEN EXISTS (SELECT 1 FROM "UserRole" ur JOIN "Role" r ON r.id = ur."roleId" WHERE ur."userId" = u.id AND r.name = 'OPERATIONS') THEN 'OPERATIONS'::"UserRoleName"
  ELSE 'CUSTOMER'::"UserRoleName"
END;

DELETE FROM "Customer" c
USING "User" u
WHERE c."userId" = u.id
  AND u."accountType" IN ('OPERATIONS'::"UserRoleName", 'SUPER_ADMIN'::"UserRoleName")
  AND NOT EXISTS (SELECT 1 FROM "Order" o WHERE o."customerId" = c.id)
  AND NOT EXISTS (SELECT 1 FROM "CustomerEsim" e WHERE e."customerId" = c.id);

DELETE FROM "UserRole" ur
USING "Role" r, "User" u
WHERE ur."roleId" = r.id AND ur."userId" = u.id AND r.name != u."accountType";
