-- Staff accounts provisioned by a Super Admin are created with a one-time
-- password. The account must set its own password at first sign-in before it
-- can use the operations console (enforced by the ops middleware redirect and
-- the API AccountGuard).

-- AlterTable
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
