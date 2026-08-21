import { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const shouldDelete = process.argv.includes('--delete');

// Hard safety gate: never wipe a production database. This script is a local
// development tool only.
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run wipe against NODE_ENV=production.');
  process.exit(1);
}

// Order matters: children are deleted before the parents they reference, so
// every foreign key is satisfied. The only rows preserved are the SUPER_ADMIN
// user(s), their UserRole link(s) and the base Role rows.
const order = [
  'customerConsent',
  'subscription',
  'customerEsim',
  'notification',
  'provisioningAttempt',
  'orderEvent',
  'orderReview',
  'traveler',
  'travelerDocument',
  'manualRefund',
  'payment',
  'esimInventory',
  'inventoryBatch',
  'staffInvitation',
  'auditLog',
  'partnerDocumentUploadIntent',
  'partnerDocumentVerification',
  'partnerWebhookDelivery',
  'partnerEvent',
  'partnerIdempotencyRecord',
  'partnerRateBucket',
  'partnerLedgerEntry',
  'partnerRefundRequest',
  'transatelLifecycleOperation',
  'provisioningOperation',
  'partnerHostedCheckoutSession',
  'partnerQuote',
  'partnerPriceListItem',
  'partnerPriceList',
  'partnerAccount',
  'partnerCredential',
  'partnerCustomer',
  'partnerWebhookEndpoint',
  'order',
  'customer',
  'partner',
  'userRole',
  'user',
  'plan',
  'country',
  'partnerShowcase',
  'integrationLog',
  'webhookEvent',
] as const;

async function main() {
  const superAdmins = await prisma.user.findMany({
    where: { accountType: 'SUPER_ADMIN' },
  });
  console.log(`Super admins to keep (${superAdmins.length}):`);
  for (const sa of superAdmins) console.log('  -', sa.email, '|', sa.clerkId);

  if (!shouldDelete) {
    console.log('\nRun with --delete to wipe all non-super-admin data.');
    await prisma.$disconnect();
    return;
  }

  console.log('\n=== DELETING ALL DATA ===');
  for (const t of order) {
    const r = await (prisma as any)[t].deleteMany();
    console.log(`deleted ${r.count} from ${t}`);
  }

  console.log('\n=== RE-SEEDING ROLES ===');
  for (const name of ['CUSTOMER', 'OPERATIONS', 'SUPER_ADMIN'] as const) {
    await prisma.role.upsert({ where: { name }, update: {}, create: { name } });
  }
  const adminRole = await prisma.role.findUnique({ where: { name: 'SUPER_ADMIN' } });
  if (!adminRole) throw new Error('SUPER_ADMIN role missing after reseed');

  console.log('\n=== RESTORING SUPER ADMIN ACCOUNTS ===');
  for (const sa of superAdmins) {
    const restored = await prisma.user.create({
      data: {
        clerkId: sa.clerkId,
        email: sa.email,
        accountType: 'SUPER_ADMIN',
        status: sa.status,
        mustChangePassword: sa.mustChangePassword,
        createdAt: sa.createdAt,
        updatedAt: sa.updatedAt,
      },
    });
    await prisma.userRole.create({
      data: { userId: restored.id, roleId: adminRole.id },
    });
    console.log('restored', sa.email);
  }

  console.log('\nDone. All data wiped; super admins and roles preserved.');
  await prisma.$disconnect();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());