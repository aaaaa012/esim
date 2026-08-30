import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

const beats = await p.workerHeartbeat.findMany({
  orderBy: { updatedAt: "desc" },
  take: 5,
  select: { worker: true, lastSeenAt: true, status: true },
});
console.log("HEARTBEATS:", JSON.stringify(beats));

const docs = await p.travelerDocument.findMany({
  orderBy: { createdAt: "desc" },
  take: 3,
  select: { type: true, status: true, uploadVerified: true, passportVerificationStatus: true, passportVerifiedAt: true, createdAt: true },
});
console.log("DOCS:", JSON.stringify(docs, null, 1));
await p.$disconnect();
