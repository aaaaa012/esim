import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const marker = `pg-smoke-${Date.now()}`;
const rollback = new Error("ROLLBACK_SMOKE_TRANSACTION");

async function catalogChecks() {
  const [tables, enums, foreignKeys, indexes] = await Promise.all([
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM information_schema.tables
      WHERE table_schema = 'visa_compass' AND table_type = 'BASE TABLE'
    `,
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'visa_compass' AND t.typtype = 'e'
    `,
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM information_schema.table_constraints
      WHERE constraint_schema = 'visa_compass' AND constraint_type = 'FOREIGN KEY'
    `,
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM pg_indexes WHERE schemaname = 'visa_compass'
    `,
  ]);
  const actual = {
    tables: Number(tables[0]?.count ?? 0n),
    enums: Number(enums[0]?.count ?? 0n),
    foreignKeys: Number(foreignKeys[0]?.count ?? 0n),
    indexes: Number(indexes[0]?.count ?? 0n),
  };
  if (actual.tables < 51 || actual.enums !== 41 || actual.foreignKeys < 65) {
    throw new Error(
      `Unexpected PostgreSQL catalogue: ${JSON.stringify(actual)}`,
    );
  }
  process.stdout.write(`Catalogue OK ${JSON.stringify(actual)}\n`);
}

async function domainTransactionChecks() {
  try {
    await prisma.$transaction(
      async (tx) => {
        const user = await tx.user.create({
          data: { clerkId: marker, email: `${marker}@example.invalid` },
        });
        const customer = await tx.customer.create({
          data: {
            userId: user.id,
            customerCode: marker,
            email: `${marker}-customer@example.invalid`,
          },
        });
        const country = await tx.country.create({
          data: { isoCode: `X${marker.slice(-7)}`, name: marker },
        });
        const plan = await tx.plan.create({
          data: {
            countryId: country.id,
            providerPlanId: marker,
            name: marker,
            dataAllowance: "500 MB",
            validityDays: 7,
            costPrice: new Prisma.Decimal("10.25"),
            sellingPrice: new Prisma.Decimal("12.50"),
            coverage: { countries: ["NP"], smoke: true },
          },
        });
        const order = await tx.order.create({
          data: {
            orderNumber: marker,
            customerId: customer.id,
            planId: plan.id,
            subtotal: new Prisma.Decimal("12.50"),
            totalAmount: new Prisma.Decimal("12.50"),
            pricingSnapshot: { planId: plan.id, amount: "12.50" },
            compatibilityAcceptedAt: new Date(),
          },
        });
        await tx.payment.create({
          data: {
            orderId: order.id,
            provider: "KHALTI",
            paymentReference: marker,
            amount: new Prisma.Decimal("12.50"),
          },
        });
        const batch = await tx.inventoryBatch.create({
          data: { batchReference: marker, totalProfiles: 1 },
        });
        await tx.esimInventory.create({
          data: {
            batchId: batch.id,
            iccid: marker,
            eid: `${marker}-eid`,
            assignedOrderId: order.id,
          },
        });
        const partner = await tx.partner.create({
          data: {
            code: marker,
            name: marker,
            allowedSettlementMethods: ["PREPAID"],
            redirectAllowlist: ["https://example.invalid"],
          },
        });
        await tx.partnerAccount.create({
          data: { partnerId: partner.id, balancePaisa: 1000 },
        });
        await tx.order.update({
          where: { id: order.id },
          data: { version: { increment: 1 } },
        });
        const loaded = await tx.order.findUniqueOrThrow({
          where: { id: order.id },
          include: { payments: true, inventory: true, plan: true },
        });
        if (
          loaded.version !== 1 ||
          loaded.payments.length !== 1 ||
          !loaded.inventory ||
          !loaded.plan.sellingPrice.equals("12.50")
        ) {
          throw new Error("Relational or Decimal round-trip failed");
        }
        throw rollback;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 15_000,
        timeout: 30_000,
      },
    );
  } catch (error) {
    if (error !== rollback) throw error;
  }
  const leaked = await prisma.order.count({ where: { orderNumber: marker } });
  if (leaked !== 0)
    throw new Error("Rollback test left application records behind");
  process.stdout.write("Domain transaction and rollback OK\n");
}

async function uniquenessCheck() {
  try {
    await prisma.$transaction(async (tx) => {
      const isoCode = `U${marker.slice(-7)}`;
      await tx.country.create({ data: { isoCode, name: marker } });
      await tx.country.create({
        data: { isoCode, name: `${marker}-duplicate` },
      });
    });
    throw new Error("Unique constraint accepted a duplicate value");
  } catch (error) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== "P2002"
    ) {
      throw error;
    }
  }
  process.stdout.write("Unique constraint enforcement OK\n");
}

async function serializableConcurrencyCheck() {
  const partner = await prisma.partner.create({
    data: {
      code: `${marker}-concurrency`,
      name: marker,
      allowedSettlementMethods: ["PREPAID"],
      redirectAllowlist: [],
      account: { create: { balancePaisa: 0 } },
    },
    include: { account: true },
  });
  const accountId = partner.account!.id;
  let retries = 0;
  const increment = async () => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        await prisma.$transaction(
          async (tx) => {
            await tx.partnerAccount.findUniqueOrThrow({
              where: { id: accountId },
            });
            await new Promise((resolve) => setTimeout(resolve, 75));
            await tx.partnerAccount.update({
              where: { id: accountId },
              data: { balancePaisa: { increment: 1 } },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        return;
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== "P2034" ||
          attempt === 4
        ) {
          throw error;
        }
        retries += 1;
      }
    }
  };
  try {
    await Promise.all([increment(), increment()]);
    const account = await prisma.partnerAccount.findUniqueOrThrow({
      where: { id: accountId },
    });
    if (account.balancePaisa !== 2)
      throw new Error("Concurrent increments were lost");
    process.stdout.write(`Serializable concurrency OK (retries=${retries})\n`);
  } finally {
    await prisma.partnerAccount.deleteMany({
      where: { partnerId: partner.id },
    });
    await prisma.partner.delete({ where: { id: partner.id } });
  }
}

async function main() {
  await catalogChecks();
  await domainTransactionChecks();
  await uniquenessCheck();
  await serializableConcurrencyCheck();
  process.stdout.write(
    "PostgreSQL smoke suite passed with no retained test records.\n",
  );
}

main()
  .catch((error) => {
    process.stderr.write(
      `PostgreSQL smoke suite failed: ${error instanceof Error ? error.message : "unknown"}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
