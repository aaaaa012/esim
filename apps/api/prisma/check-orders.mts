import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const orders = await p.order.findMany({
  orderBy: { createdAt: "desc" },
  take: 12,
});
for (const o of orders) {
  const t: any = (o as any).travelerJson ?? {};
  console.log(
    `${(o as any).orderNumber} | ${(o as any).status} | ${t.firstName ?? ""} ${t.surname ?? ""}`,
  );
}
await p.$disconnect();
