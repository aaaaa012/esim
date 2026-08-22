import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

const steps: [string, () => Promise<unknown>][] = [
  ["inventoryReconciliationItems", () => p.inventoryReconciliationItem.deleteMany({})],
  ["inventoryReconciliationRuns", () => p.inventoryReconciliationRun.deleteMany({})],
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
console.log("remaining orders:", await p.order.count(), "| esims:", await p.esimInventory.count(), "| batches:", await p.inventoryBatch.count());
console.log("kept: users", await p.user.count(), "| customers", await p.customer.count(), "| plans", await p.plan.count());
await p.$disconnect();
