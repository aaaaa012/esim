import { PrismaClient, PartnerStatus, PartnerCredentialStatus } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";

const prisma = new PrismaClient();
const prefix = `vc_partner_${randomBytes(8).toString("hex")}`;
const secret = randomBytes(32).toString("base64url");
const apiKey = `${prefix}.${secret}`;
const code = "smoke_" + (10000 + Math.floor(Math.random() * 89999));

const partner = await prisma.partner.create({
  data: {
    code,
    name: "Smoke E2E Partner",
    status: PartnerStatus.ACTIVE,
    allowedSettlementMethods: ["PARTNER_ACCOUNT"],
    redirectAllowlist: [],
    rateLimitPerMinute: 300,
    account: { create: { balancePaisa: 100000000, creditLimitPaisa: 0 } },
    credentials: {
      create: {
        name: "e2e-key",
        keyPrefix: prefix,
        secretHash: createHash("sha256").update(secret).digest("hex"),
        status: PartnerCredentialStatus.ACTIVE,
        scopes: [
          "catalog:read",
          "orders:read",
          "orders:write",
          "documents:write",
          "esims:read",
          "refunds:write",
          "usage:read",
        ],
      },
    },
  },
});
console.log("PARTNER_ID=" + partner.id);
console.log("CODE=" + code);
console.log("APIKEY=" + apiKey);
await prisma.$disconnect();