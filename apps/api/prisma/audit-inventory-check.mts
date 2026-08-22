import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

const batches = await p.inventoryBatch.findMany({
  orderBy: { createdAt: "desc" },
  take: 5,
  select: { id: true, batchReference: true, totalProfiles: true, status: true },
});
console.log("BATCHES:", JSON.stringify(batches, null, 1));

const byProvider = await p.esimInventory.groupBy({ by: ["providerStatus"], _count: { _all: true } });
console.log("PROVIDER STATUS:", JSON.stringify(byProvider.map((g) => ({ s: g.providerStatus, n: g._count._all }))));
const byLocal = await p.esimInventory.groupBy({ by: ["status"], _count: { _all: true } });
console.log("LOCAL STATUS:", JSON.stringify(byLocal.map((g) => ({ s: g.status, n: g._count._all }))));

const errs = await p.esimInventory.findMany({
  where: { OR: [{ providerCheckError: { not: null } }, { quarantineReason: { not: null } }] },
  select: { iccid: true, status: true, providerStatus: true, providerCheckError: true, quarantineReason: true },
  take: 10,
});
console.log("ERRORS:", JSON.stringify(errs, null, 1));

const cases = await p.attentionCase.findMany({
  select: { category: true, summary: true, detail: true, externalState: true, entityId: true },
  take: 8,
});
console.log("ATTENTION CASES:", JSON.stringify(cases, null, 1));
await p.$disconnect();
