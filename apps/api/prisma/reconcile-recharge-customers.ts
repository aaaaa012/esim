/** Dry-run by default. --apply --review <report.json> applies only reviewed, unchanged decisions. */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
export type Repair = {
  orderId: string;
  previousCustomerId: string;
  customerId: string;
  inventoryId: string;
  purchasedByUserId: string | null;
  action: "REPAIR" | "UNCHANGED" | "REVIEW";
  reason?: string;
};
export function decideRepair(
  row: {
    id: string;
    customerId: string;
    targetInventoryId: string | null;
    purchasedByUserId: string | null;
    pricingSnapshot: unknown;
    customer: { user: { id: string; clerkId: string } | null };
    customerEsim: { inventoryId: string; customerId: string } | null;
  },
  originals: { customerId: string }[],
): Repair {
  const snapshot = row.pricingSnapshot as { targetEsimId?: string } | null;
  const targets = [
    ...new Set(
      [
        row.targetInventoryId,
        row.customerEsim?.inventoryId,
        snapshot?.targetEsimId,
      ].filter((v): v is string => Boolean(v)),
    ),
  ];
  const base = {
    orderId: row.id,
    previousCustomerId: row.customerId,
    customerId: row.customerId,
    inventoryId: targets[0] ?? "",
    purchasedByUserId: row.purchasedByUserId,
  };
  if (targets.length !== 1 || originals.length !== 1)
    return {
      ...base,
      action: "REVIEW",
      reason: "Missing or conflicting target/original purchase",
    };
  const customerId = originals[0]!.customerId;
  const purchaser =
    row.purchasedByUserId ??
    (!row.targetInventoryId &&
    row.customer.user &&
    !row.customer.user.clerkId.startsWith("guest-")
      ? row.customer.user.id
      : null);
  return {
    ...base,
    customerId,
    purchasedByUserId: purchaser,
    action:
      row.customerId === customerId &&
      (!row.customerEsim || row.customerEsim.customerId === customerId) &&
      row.targetInventoryId === targets[0]
        ? "UNCHANGED"
        : "REPAIR",
  };
}
async function main() {
  const prisma = new PrismaClient();
  const apply = process.argv.includes("--apply");
  const reviewIndex = process.argv.indexOf("--review");
  if (apply && (reviewIndex < 0 || !process.argv[reviewIndex + 1]))
    throw new Error("--apply requires --review <approved dry-run JSON>");
  const approved: Repair[] = apply
    ? JSON.parse(readFileSync(process.argv[reviewIndex + 1]!, "utf8"))
    : [];
  const results: Repair[] = [];
  try {
    const rows = await prisma.order.findMany({
      where: { channel: "CUSTOMER_WEB", orderType: "TOPUP" },
      include: { customerEsim: true, customer: { include: { user: true } } },
      orderBy: { createdAt: "asc" },
    });
    for (const row of rows) {
      const inventoryId =
        row.targetInventoryId ??
        row.customerEsim?.inventoryId ??
        (row.pricingSnapshot as { targetEsimId?: string })?.targetEsimId;
      const originals = inventoryId
        ? await prisma.order.findMany({
            where: {
              orderType: "INITIAL_PURCHASE",
              customerEsim: { is: { inventoryId } },
            },
            select: { customerId: true },
          })
        : [];
      const result = decideRepair(row, originals);
      results.push(result);
      if (!apply || result.action !== "REPAIR") continue;
      const accepted = approved.find(
        (item) => item.orderId === row.id && item.action === "REPAIR",
      );
      if (!accepted || JSON.stringify(accepted) !== JSON.stringify(result))
        throw new Error(
          `Dry-run result changed or was not reviewed: ${row.id}`,
        );
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${row.id}::uuid FOR UPDATE`;
        const latest = await tx.order.findUniqueOrThrow({
          where: { id: row.id },
          include: {
            customerEsim: true,
            customer: { include: { user: true } },
          },
        });
        const origins = await tx.order.findMany({
          where: {
            orderType: "INITIAL_PURCHASE",
            customerEsim: { is: { inventoryId: result.inventoryId } },
          },
          select: { customerId: true },
        });
        if (
          JSON.stringify(decideRepair(latest, origins)) !==
          JSON.stringify(result)
        )
          throw new Error(`Concurrent change: ${row.id}`);
        await tx.order.update({
          where: { id: row.id },
          data: {
            customerId: result.customerId,
            targetInventoryId: result.inventoryId,
            purchasedByUserId: result.purchasedByUserId,
            version: { increment: 1 },
          },
        });
        await tx.customerEsim.updateMany({
          where: { orderId: row.id },
          data: { customerId: result.customerId },
        });
        await tx.auditLog.create({
          data: {
            module: "ORDERS",
            entity: "Order",
            entityId: row.id,
            action: "RECHARGE_BENEFICIARY_RECONCILED",
            previousValue: {
              customerId: row.customerId,
              assignedCustomerId: row.customerEsim?.customerId ?? null,
              purchasedByUserId: row.purchasedByUserId,
            },
            newValue: {
              customerId: result.customerId,
              inventoryId: result.inventoryId,
              purchasedByUserId: result.purchasedByUserId,
            },
          },
        });
      });
    }
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
