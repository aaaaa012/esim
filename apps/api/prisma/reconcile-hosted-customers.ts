import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const args = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, ...parts] = argument.replace(/^--/, "").split("=");
    return [key, parts.length ? parts.join("=") : "true"];
  }),
);
const apply = args.get("apply") === "true";
const orderNumber = args.get("order");
const confirmation = args.get("confirm");

if (apply && confirmation !== "MERGE_HOSTED_CUSTOMERS")
  throw new Error(
    "Apply mode requires --confirm=MERGE_HOSTED_CUSTOMERS. Run without --apply first.",
  );

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function normalizeMobile(value: string) {
  return value.replace(/[^0-9]/g, "").replace(/^00/, "");
}

function fingerprint(partnerId: string, email: string, mobile: string) {
  return createHash("sha256")
    .update(`${partnerId}:${normalizeEmail(email)}:${normalizeMobile(mobile)}`)
    .digest("hex")
    .slice(0, 16);
}

const hostedOrders = await prisma.order.findMany({
  where: {
    channel: "PARTNER_HOSTED",
    traveler: { isNot: null },
    partnerId: { not: null },
    partnerCustomerId: { not: null },
    ...(orderNumber ? { orderNumber } : {}),
  },
  include: {
    traveler: true,
    partnerCustomer: { include: { customer: true } },
  },
  orderBy: { createdAt: "asc" },
});

if (orderNumber && hostedOrders.length === 0)
  throw new Error(`Hosted order ${orderNumber} was not found`);

// A scoped order discovers its complete same-partner/contact group without
// exposing contact values in the report.
const seeds = hostedOrders.map((order) => ({
  partnerId: order.partnerId!,
  email: normalizeEmail(order.traveler!.email),
  mobile: normalizeMobile(order.traveler!.mobile),
}));
const candidates = orderNumber
  ? await prisma.order.findMany({
      where: {
        channel: "PARTNER_HOSTED",
        partnerId: seeds[0]!.partnerId,
        traveler: { isNot: null },
        partnerCustomerId: { not: null },
      },
      include: {
        traveler: true,
        partnerCustomer: { include: { customer: true } },
      },
      orderBy: { createdAt: "asc" },
    })
  : hostedOrders;

const groups = new Map<string, typeof candidates>();
for (const order of candidates) {
  if (!order.traveler || !order.partnerCustomer || !order.partnerId) continue;
  const email = normalizeEmail(order.traveler.email);
  const mobile = normalizeMobile(order.traveler.mobile);
  if (
    orderNumber &&
    !seeds.some(
      (seed) =>
        seed.partnerId === order.partnerId &&
        seed.email === email &&
        seed.mobile === mobile,
    )
  )
    continue;
  const key = `${order.partnerId}:${email}:${mobile}`;
  groups.set(key, [...(groups.get(key) ?? []), order]);
}

const proposals = [...groups.values()]
  .map((orders) => {
    const identities = [
      ...new Map(
        orders.map((order) => [
          order.partnerCustomer!.id,
          order.partnerCustomer!,
        ]),
      ).values(),
    ].sort((left, right) => {
      const leftGenerated =
        left.externalCustomerId.startsWith("portal-customer-");
      const rightGenerated =
        right.externalCustomerId.startsWith("portal-customer-");
      if (leftGenerated !== rightGenerated) return leftGenerated ? 1 : -1;
      return left.createdAt.getTime() - right.createdAt.getTime();
    });
    const canonical = identities[0];
    if (!canonical || identities.length < 2) return null;
    return {
      fingerprint: fingerprint(
        orders[0]!.partnerId!,
        orders[0]!.traveler!.email,
        orders[0]!.traveler!.mobile,
      ),
      partnerId: orders[0]!.partnerId!,
      canonical,
      duplicates: identities.slice(1),
      observedOrders: orders.map((order) => order.orderNumber),
    };
  })
  .filter((proposal): proposal is NonNullable<typeof proposal> =>
    Boolean(proposal),
  );

console.log(
  JSON.stringify(
    {
      mode: apply ? "APPLY" : "DRY_RUN",
      scopedOrder: orderNumber ?? null,
      proposalCount: proposals.length,
      proposals: proposals.map((proposal) => ({
        contactFingerprint: proposal.fingerprint,
        partnerId: proposal.partnerId,
        canonicalCustomerId: proposal.canonical.customerId,
        canonicalExternalCustomerId: proposal.canonical.externalCustomerId,
        duplicateCustomerIds: proposal.duplicates.map(
          (item) => item.customerId,
        ),
        duplicateExternalCustomerIds: proposal.duplicates.map(
          (item) => item.externalCustomerId,
        ),
        observedOrders: proposal.observedOrders,
      })),
    },
    null,
    2,
  ),
);

if (apply) {
  for (const proposal of proposals) {
    await prisma.$transaction(
      async (tx) => {
        const duplicateCustomerIds = proposal.duplicates.map(
          (identity) => identity.customerId,
        );
        const duplicateCustomers = await tx.customer.findMany({
          where: { id: { in: duplicateCustomerIds } },
          include: {
            orders: { select: { id: true, partnerId: true, channel: true } },
            partnerIdentity: true,
          },
        });
        if (duplicateCustomers.length !== duplicateCustomerIds.length)
          throw new Error(
            `Reconciliation ${proposal.fingerprint}: customer changed`,
          );
        for (const customer of duplicateCustomers) {
          if (customer.userId)
            throw new Error(
              `Reconciliation ${proposal.fingerprint}: refusing customer with login`,
            );
          if (
            customer.source !== "PARTNER" ||
            customer.partnerIdentity?.partnerId !== proposal.partnerId ||
            customer.orders.some(
              (order) =>
                order.partnerId !== proposal.partnerId ||
                order.channel !== "PARTNER_HOSTED",
            )
          )
            throw new Error(
              `Reconciliation ${proposal.fingerprint}: refusing cross-channel ownership`,
            );
        }

        const orderCount = await tx.order.updateMany({
          where: { customerId: { in: duplicateCustomerIds } },
          data: {
            customerId: proposal.canonical.customerId,
            partnerCustomerId: proposal.canonical.id,
          },
        });
        const esimCount = await tx.customerEsim.updateMany({
          where: { customerId: { in: duplicateCustomerIds } },
          data: { customerId: proposal.canonical.customerId },
        });
        const consentCount = await tx.customerConsent.updateMany({
          where: { customerId: { in: duplicateCustomerIds } },
          data: { customerId: proposal.canonical.customerId },
        });
        await tx.partnerCustomer.deleteMany({
          where: { id: { in: proposal.duplicates.map((item) => item.id) } },
        });
        await tx.customer.deleteMany({
          where: { id: { in: duplicateCustomerIds } },
        });
        await tx.auditLog.create({
          data: {
            module: "CUSTOMER_RECONCILIATION",
            entity: "Customer",
            entityId: proposal.canonical.customerId,
            action: "MERGED_HOSTED_DUPLICATES",
            previousValue: {
              contactFingerprint: proposal.fingerprint,
              duplicateCustomerIds,
            },
            newValue: {
              canonicalCustomerId: proposal.canonical.customerId,
              canonicalExternalCustomerId:
                proposal.canonical.externalCustomerId,
              movedOrders: orderCount.count,
              movedEsims: esimCount.count,
              movedConsents: consentCount.count,
            },
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 30_000,
      },
    );
    console.log(`Applied ${proposal.fingerprint}`);
  }
}

await prisma.$disconnect();
