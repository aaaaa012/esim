import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

const batch = await p.inventoryBatch.create({
  data: { batchReference: `AUDIT3-${Date.now()}`, totalProfiles: 6, importedCount: 6, status: "APPROVED", approvedAt: new Date() },
});
for (let i = 0; i < 6; i++) {
  await p.esimInventory.create({
    data: {
      batchId: batch.id,
      iccid: `89882470760100${randomBytes(3).toString("hex")}${i}`,
      eid: `EID-AUDIT3-${Date.now()}-${i}`,
      status: "AVAILABLE",
      providerStatus: "available",
      lastProviderCheckedAt: new Date(),
    },
  });
}
const upd = await p.order.updateMany({ where: { status: "QR_READY" }, data: { status: "COMPLETED" } });
console.log(`inventory added: 6; QR_READY->COMPLETED: ${upd.count}`);
await p.$disconnect();
