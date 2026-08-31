CREATE TABLE "GuestOrderAccessToken" (
  "id" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "recipientHash" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "GuestOrderAccessToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GuestOrderAccessToken_tokenHash_key"
  ON "GuestOrderAccessToken"("tokenHash");

CREATE INDEX "GuestOrderAccessToken_orderId_purpose_revokedAt_expiresAt_idx"
  ON "GuestOrderAccessToken"("orderId", "purpose", "revokedAt", "expiresAt");

ALTER TABLE "GuestOrderAccessToken"
  ADD CONSTRAINT "GuestOrderAccessToken_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
