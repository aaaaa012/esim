import { PrismaClient } from "@prisma/client";
import { TransatelProvider } from "../src/modules/integration/transatel.provider.js";
import { isSellableProviderStatus } from "../src/common/sellable-provider-statuses.js";

const p = new PrismaClient();
const provider = new TransatelProvider(p);

const rows = await p.esimInventory.findMany({
  where: { status: "QUARANTINED" },
  select: { id: true, iccid: true },
});
for (const row of rows) {
  try {
    const details = await provider.getEsimDetails(row.iccid);
    const sellable = isSellableProviderStatus(details.status);
    await p.esimInventory.update({
      where: { id: row.id },
      data: {
        providerStatus: details.status,
        lastProviderCheckedAt: new Date(),
        providerCheckError: null,
        ...(details.smDpAddress ? { smDpAddress: details.smDpAddress } : {}),
        ...(sellable ? { status: "AVAILABLE" } : {}),
      },
    });
    if (sellable) {
      await p.attentionCase.deleteMany({
        where: { dedupeKey: `inventory-mismatch:${row.id}` },
      });
    }
    console.log(`${row.iccid}: ${details.status} -> ${sellable ? "AVAILABLE" : "kept quarantined"}`);
  } catch (error) {
    console.log(`${row.iccid}: check failed - ${error instanceof Error ? error.message : error}`);
  }
}
await p.$disconnect();
