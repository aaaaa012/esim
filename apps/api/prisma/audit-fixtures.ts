import { randomBytes, createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const BATCH_REF = `AUDIT-${Date.now()}`;

const secret = randomBytes(32).toString("base64url");
const keyPrefix = `vc_partner_${randomBytes(6).toString("hex")}`;
const secretHash = createHash("sha256").update(secret).digest("hex");

const partner = await prisma.partner.upsert({
  where: { code: "AUDIT" },
  update: {
    integrationType: "CHECKOUT_LINK",
    status: "ACTIVE",
  },
  create: {
    code: "AUDIT",
    name: "Audit Test Partner",
    slug: "audit-test",
    status: "ACTIVE",
    integrationType: "CHECKOUT_LINK",
    allowedSettlementMethods: ["PREPAID"],
    redirectAllowlist: ["http://localhost:3000"],
    rateLimitPerMinute: 300,
  },
});

await prisma.partnerAccount.upsert({
  where: { partnerId: partner.id },
  update: { balancePaisa: 50_000_000 },
  create: { partnerId: partner.id, balancePaisa: 50_000_000 },
});

const cred = await prisma.partnerCredential.upsert({
  where: { keyPrefix },
  update: { secretHash },
  create: {
    partnerId: partner.id,
    name: "audit-e2e",
    keyPrefix,
    secretHash,
    scopes: [
      "catalog:read",
      "checkout:write",
      "orders:read",
      "orders:write",
      "esims:read",
      "usage:read",
      "documents:write",
      "refunds:write",
    ],
  },
});

const batch = await prisma.inventoryBatch.create({
  data: {
    batchReference: BATCH_REF,
    totalProfiles: 3,
    importedCount: 3,
    status: "APPROVED",
    approvedAt: new Date(),
  },
});

const iccids = [
  "8988247076000099001",
  "8988247076000099002",
  "8988247076000099003",
];
for (let i = 0; i < 3; i++) {
  await prisma.esimInventory.create({
    data: {
      batchId: batch.id,
      iccid: iccids[i],
      eid: `EID-AUDIT-${BATCH_REF}-${i}`,
      status: "AVAILABLE",
      providerStatus: "available",
      lastProviderCheckedAt: new Date(),
    },
  });
}

console.log(
  JSON.stringify(
    { partnerId: partner.id, credentialId: cred.id, apiKey: `${keyPrefix}.${secret}` },
    null,
    2,
  ),
);
await prisma.$disconnect();
