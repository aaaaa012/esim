import { PrismaClient, PlanStatus, UserRoleName } from '@prisma/client';
import { readFile } from 'node:fs/promises';
const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
for (const line of env.split(/\r?\n/)) { const index = line.indexOf('='); if (index > 0) process.env[line.slice(0, index)] = line.slice(index + 1); }
const prisma = new PrismaClient();
async function main() {
  for (const name of Object.values(UserRoleName)) await prisma.role.upsert({ where: { name }, update: {}, create: { name } });
  const countries = [{ isoCode: 'AE', name: 'United Arab Emirates' }, { isoCode: 'GB', name: 'United Kingdom' }, { isoCode: 'JP', name: 'Japan' }];
  for (const item of countries) {
    const country = await prisma.country.upsert({ where: { isoCode: item.isoCode }, update: item, create: item });
    await prisma.plan.upsert({ where: { countryId_providerPlanId: { countryId: country.id, providerPlanId: `MOCK-${item.isoCode}-01` } }, update: {}, create: { countryId: country.id, providerPlanId: `MOCK-${item.isoCode}-01`, name: `${item.name} Connect`, dataAllowance: '5 GB', validityDays: 15, costPrice: 1200, sellingPrice: 2499, coverage: [item.name], popular: item.isoCode !== 'JP', status: PlanStatus.ACTIVE } });
  }
}
main().finally(() => prisma.$disconnect());
