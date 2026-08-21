-- Performance indexes for the most frequent query patterns.
CREATE INDEX "Order_partnerId_idx" ON "Order"("partnerId");
CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");
CREATE INDEX "PartnerLedgerEntry_orderId_idx" ON "PartnerLedgerEntry"("orderId");
