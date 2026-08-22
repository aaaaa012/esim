import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const ctx: any = await p.$queryRawUnsafe(
  `SELECT current_database() AS db, current_schema() AS cs, setting AS search_path FROM pg_settings WHERE name='search_path'`,
);
console.log("CONTEXT:", JSON.stringify(ctx));
const dups: any = await p.$queryRawUnsafe(
  `SELECT schemaname, tablename FROM pg_tables WHERE tablename IN ('EsimInventory','Order','_prisma_migrations') ORDER BY tablename, schemaname`,
);
console.log("TABLE LOCATIONS:", JSON.stringify(dups, null, 1));
try {
  const rows = await p.order.findMany({ take: 1 });
  console.log("MODEL QUERY OK, rows:", rows.length);
} catch (e: any) {
  console.log("MODEL QUERY FAILED:", e.code ?? "", String(e.message).slice(0, 160));
}
await p.$disconnect();
