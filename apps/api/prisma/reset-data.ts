import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const shouldDelete = process.argv.includes('--delete');

// Hard safety gate: local development tool only.
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run reset-data against NODE_ENV=production.');
  process.exit(1);
}

// Children before parents. Plan/Country/Role are preserved (catalog + roles).
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
  'partnerShowcase',
  'integrationLog',
  'webhookEvent',
] as const;

async function main() {
  const superAdmins = await prisma.user.findMany({
    where: { accountType: 'SUPER_ADMIN' },
    select: { id: true, email: true, clerkId: true },
  });
  const superAdminIds = superAdmins.map((s) => s.id);

  if (!shouldDelete) {
    console.log(
      'Super admins to KEEP:',
      superAdmins.map((s) => s.email),
    );
    console.log('\nRun with --delete to wipe. Plan/Country (catalog) + roles + super admins are preserved.');
    await prisma.$disconnect();
    return;
  }

  console.log('=== DELETING TRANSACTION / ORDER / INVENTORY DATA ===');
  for (const t of order) {
    const r = await (prisma as any)[t].deleteMany();
    console.log(`deleted ${r.count} from ${t}`);
  }

  console.log('\n=== CLEANING USER ROLE LINKS (non-super-admin) ===');
  const orphanRoles = await prisma.userRole.deleteMany({
    where: { userId: { notIn: superAdminIds } },
  });
  console.log(`deleted ${orphanRoles.count} orphan userRole links`);

  console.log('\n=== DELETING NON-SUPER-ADMIN USERS ===');
  const users = await prisma.user.deleteMany({
    where: { accountType: { not: 'SUPER_ADMIN' } },
  });
  console.log(`deleted ${users.count} users`);

  console.log('\n=== PRESERVED CATALOG + ROLES + SUPER ADMINS ===');
  const plans = await prisma.plan.count();
  const countries = await prisma.country.count();
  const roles = await prisma.role.count();
  const keptAdmins = await prisma.user.count({ where: { accountType: 'SUPER_ADMIN' } });
  const keptOrders = await prisma.order.count();
  const keptPayments = await prisma.payment.count();
  const keptInventory = await prisma.esimInventory.count();
  console.log({ plans, countries, roles, keptAdmins, keptOrders, keptPayments, keptInventory });

  await prisma.$disconnect();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());