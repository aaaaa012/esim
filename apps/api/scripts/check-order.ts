import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const latest = await prisma.order.findFirst({ where: { externalOrderId: { startsWith: "smoke-order-" } }, orderBy: { createdAt: "desc" }, select: { id: true, externalOrderId: true, status: true, planId: true, partnerId: true, createdAt: true } });
console.log("latest smoke order:", latest ?? "none");
const recent = await prisma.order.findMany({ where: { externalOrderId: { startsWith: "smoke-order-" } }, orderBy: { createdAt: "desc" }, take: 5, select: { externalOrderId: true, status: true, createdAt: true } });
console.log("all smoke orders:", JSON.stringify(recent, null, 0));
const ledger = await prisma.partnerLedgerEntry.findMany({ where: { partner: { code: { startsWith: "smoke_" } } }, orderBy: { createdAt: "desc" }, take: 5, select: { type: true, amountPaisa: true, balanceAfterPaisa: true, orderId: true, reference: true } });
console.log("partner ledger:", JSON.stringify(ledger, null, 0));
await prisma.$disconnect();