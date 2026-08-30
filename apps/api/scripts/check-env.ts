import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const total = await prisma.esimInventory.count();
const rows = await prisma.esimInventory.groupBy({ by: ["status"], _count: { _all: true } });
console.log("profiles total", total);
console.log("by status:", rows.map((r) => `${r.status}=${r._count._all}`).join(", "));
const activePlans = await prisma.plan.count({ where: { status: "ACTIVE" } });
console.log("salePlans(ACTIVE)", activePlans);
const plan = await prisma.plan.findFirst({
  where: { status: "ACTIVE" },
  include: { country: true },
  orderBy: { updatedAt: "desc" },
});
console.log("samplePlan id", plan?.id, "| country", plan?.country?.isoCode, "| price", plan?.sellingPrice, "| name", plan?.name);
await prisma.$disconnect();