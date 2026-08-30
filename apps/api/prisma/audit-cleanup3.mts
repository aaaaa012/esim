import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const r = await p.order.deleteMany({});
console.log("deleted", r.count);
console.log("remaining orders:", await p.order.count());
await p.$disconnect();
