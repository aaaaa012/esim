/**
 * One-off audit script: reproduces the "Run check" re-verification flow
 * through the REAL BullMQ queue to prove repeated enqueues of the same
 * logical job id are no longer silently swallowed by completed-job dedupe.
 *
 * Usage:
 *   node --env-file-if-exists=../../.env node_modules/tsx/dist/cli.mjs prisma/audit-reverify.mts <orderId> <documentId>
 */
import { PrismaService } from "../dist/src/infrastructure/prisma.service.js";
import { QueueService } from "../dist/src/jobs/queue.service.js";
import { QUEUES } from "../dist/src/jobs/queues.js";

const [orderId, documentId] = process.argv.slice(2);
if (!orderId || !documentId) {
  console.error("Usage: tsx prisma/audit-reverify.mts <orderId> <documentId>");
  process.exit(1);
}

const p = new PrismaService();
await p.$connect();
const queues = new QueueService();

const before = await p.travelerDocument.findUnique({
  where: { id: documentId },
  select: { status: true, passportVerificationStatus: true },
});
console.log("BEFORE:", JSON.stringify(before));

for (let i = 1; i <= 2; i += 1) {
  const result = await queues.add(
    QUEUES.documents,
    "verify-order-passport",
    { orderId, documentId },
    `order-passport-${orderId}-${documentId}`,
    { attempts: 3, backoff: { type: "exponential", delay: 2_000 } },
  );
  console.log(`ENQUEUE #${i}:`, JSON.stringify(result));
}

let last = "";
for (let waited = 0; waited < 90_000; waited += 2_000) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const doc = await p.travelerDocument.findUnique({
    where: { id: documentId },
    select: { status: true, passportVerificationStatus: true },
  });
  const state = JSON.stringify(doc);
  if (state !== last) {
    console.log(`+${waited + 2_000}ms`, state);
    last = state;
  }
  if (doc?.passportVerificationStatus === "VERIFIED") break;
}
await queues.onModuleDestroy();
await p.$disconnect();
process.exit(0);
