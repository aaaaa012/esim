import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

const tables: [string, () => Promise<number>][] = [
  ["orders", () => p.order.count()],
  ["travelers", () => p.traveler.count()],
  ["travelerDocuments", () => p.travelerDocument.count()],
  ["payments", () => p.payment.count()],
  ["manualRefunds", () => p.manualRefund.count()],
  ["paymentDisputes", () => p.paymentDispute.count()],
  ["orderReviews", () => p.orderReview.count()],
  ["orderEvents", () => p.orderEvent.count()],
  ["customerEsims", () => p.customerEsim.count()],
  ["subscriptions", () => p.subscription.count()],
  ["provisioningAttempts", () => p.provisioningAttempt.count()],
  ["provisioningOperations", () => p.provisioningOperation.count()],
  ["transatelLifecycleOperations", () => p.transatelLifecycleOperation.count()],
  ["esimInventory", () => p.esimInventory.count()],
  ["inventoryBatches", () => p.inventoryBatch.count()],
  ["partners", () => p.partner.count()],
  ["partnerCredentials", () => p.partnerCredential.count()],
  ["partnerAccounts", () => p.partnerAccount.count()],
  ["partnerLedgerEntries", () => p.partnerLedgerEntry.count()],
  ["partnerHostedCheckoutSessions", () => p.partnerHostedCheckoutSession.count()],
  ["partnerIdempotencyRecords", () => p.partnerIdempotencyRecord.count()],
  ["partnerRateBuckets", () => p.partnerRateBucket.count()],
  ["partnerEvents", () => p.partnerEvent.count()],
  ["partnerCustomers", () => p.partnerCustomer.count()],
  ["partnerDocumentUploadIntents", () => p.partnerDocumentUploadIntent.count()],
  ["partnerDocumentVerifications", () => p.partnerDocumentVerification.count()],
  ["webhookEvents", () => p.webhookEvent.count()],
  ["integrationLogs", () => p.integrationLog.count()],
  ["notifications", () => p.notification.count()],
  ["outboxMessages", () => p.outboxMessage.count()],
  ["attentionCases", () => p.attentionCase.count()],
  ["customerConsents", () => p.customerConsent.count()],
  ["auditLogs", () => p.auditLog.count()],
  ["users", () => p.user.count()],
  ["customers", () => p.customer.count()],
];

for (const [name, fn] of tables) {
  try {
    const n = await fn();
    console.log(`${n}\t${name}`);
  } catch {
    console.log(`ERR\t${name}`);
  }
}
await p.$disconnect();
