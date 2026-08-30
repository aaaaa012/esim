import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

const existing = await p.partner.findMany({ select: { code: true, name: true } });
console.log("partners before:", JSON.stringify(existing));

const steps: [string, () => Promise<unknown>][] = [
  ["transatelLifecycleOperations", () => p.transatelLifecycleOperation.deleteMany({})],
  ["provisioningAttempts", () => p.provisioningAttempt.deleteMany({})],
  ["provisioningOperations", () => p.provisioningOperation.deleteMany({})],
  ["subscriptions", () => p.subscription.deleteMany({})],
  ["manualRefunds", () => p.manualRefund.deleteMany({})],
  ["paymentDisputes", () => p.paymentDispute.deleteMany({})],
  ["payments", () => p.payment.deleteMany({})],
  ["notifications", () => p.notification.deleteMany({})],
  ["attentionCases", () => p.attentionCase.deleteMany({})],
  ["travelerDocuments", () => p.travelerDocument.deleteMany({})],
  ["travelers", () => p.traveler.deleteMany({})],
  ["orderReviews", () => p.orderReview.deleteMany({})],
  ["orderEvents", () => p.orderEvent.deleteMany({})],
  ["customerEsims", () => p.customerEsim.deleteMany({})],
  ["customerConsents", () => p.customerConsent.deleteMany({})],
  ["partnerHostedCheckoutSessions", () => p.partnerHostedCheckoutSession.deleteMany({})],
  ["partnerDocumentUploadIntents", () => p.partnerDocumentUploadIntent.deleteMany({})],
  ["partnerDocumentVerifications", () => p.partnerDocumentVerification.deleteMany({})],
  ["partnerLedgerEntries", () => p.partnerLedgerEntry.deleteMany({})],
  ["partnerAccounts", () => p.partnerAccount.deleteMany({})],
  ["partnerCredentials", () => p.partnerCredential.deleteMany({})],
  ["partnerCustomers", () => p.partnerCustomer.deleteMany({})],
  ["partnerEvents", () => p.partnerEvent.deleteMany({})],
  ["partnerRateBuckets", () => p.partnerRateBucket.deleteMany({})],
  ["partnerIdempotencyRecords", () => p.partnerIdempotencyRecord.deleteMany({})],
  ["partnerWebhookDeliveries", () => p.partnerWebhookDelivery.deleteMany({})],
  ["partnerWebhookEndpoints", () => p.partnerWebhookEndpoint.deleteMany({})],
  ["partners", () => p.partner.deleteMany({})],
  ["esimInventory", () => p.esimInventory.deleteMany({})],
  ["inventoryBatches", () => p.inventoryBatch.deleteMany({})],
  ["webhookEvents", () => p.webhookEvent.deleteMany({})],
  ["integrationLogs", () => p.integrationLog.deleteMany({})],
  ["outboxMessages", () => p.outboxMessage.deleteMany({})],
  ["auditLogs", () => p.auditLog.deleteMany({})],
];

for (const [name, fn] of steps) {
  const res = (await fn()) as { count: number };
  console.log(`deleted ${res.count}\t${name}`);
}

console.log("remaining orders:", await p.order.count());
console.log("remaining esimInventory:", await p.esimInventory.count());
console.log("kept: users", await p.user.count(), "| customers", await p.customer.count(), "| plans", await p.plan.count(), "| roles", await p.role.count());
await p.$disconnect();
