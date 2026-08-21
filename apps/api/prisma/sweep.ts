import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const shouldDelete = process.argv.includes('--delete');

// Hard safety gate: local development tool only.
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run sweep against NODE_ENV=production.');
  process.exit(1);
}

const tables = [
  'subscription',
  'customerConsent',
  'customerEsim',
  'notification',
  'provisioningAttempt',
  'orderEvent',
  'orderReview',
  'travelerDocument',
  'traveler',
  'payment',
  'esimInventory',
  'inventoryBatch',
  'order',
  'plan',
  'country',
  'customer',
  'userRole',
  'staffInvitation',
  'auditLog',
  'integrationLog',
  'webhookEvent',
  'user',
] as const;

async function main() {
  const counts: Record<string, number> = {};
  for (const t of tables) {
    // @ts-expect-error dynamic table access
    counts[t] = await prisma[t as never].count();
  }
  console.log('=== CURRENT ROW COUNTS (application data, roles excluded) ===');
  for (const t of tables) console.log(String(t).padEnd(20), counts[t] ?? 0);
  const superAdmins = await prisma.user.count({ where: { accountType: 'SUPER_ADMIN' } });
  const operations = await prisma.user.count({ where: { accountType: 'OPERATIONS' } });
  const roles = await prisma.role.count();
  console.log(`roles: ${roles} (kept) | users by type: SUPER_ADMIN=${superAdmins} OPERATIONS=${operations}`);

  if (!shouldDelete) {
    console.log('\nRun with --delete to actually delete all rows above.');
    return;
  }

  console.log('\n=== DELETING APPLICATION DATA ONCE ===');
  for (const t of tables) {
    // @ts-expect-error dynamic table access
    const r = await prisma[t].deleteMany();
    console.log(`deleted ${r.count} from ${t}`);
  }

  // Re-seed base roles (idempotent). Countries/plans are NOT reseeded here;
  // run `pnpm db:seed` if you want the 3 mock plans/countries back.
  console.log('\n=== Re-seeding base ROLES ===');
  for (const name of ['CUSTOMER', 'OPERATIONS', 'SUPER_ADMIN'] as const) {
    await prisma.role.upsert({ where: { name }, update: {}, create: { name } });
  }
  console.log('roles ensured');

  console.log('\nDone. Application data cleared; roles preserved.');
  await prisma.$disconnect();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());