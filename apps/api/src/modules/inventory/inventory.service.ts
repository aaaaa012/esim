import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InventoryStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import { CryptoService } from '../../infrastructure/crypto.service.js';
import { PrismaService } from '../../infrastructure/prisma.service.js';
import { csvToRecords } from '../../common/csv.util.js';
import { ConnectivityService } from '../integration/connectivity.service.js';

@Injectable()
export class InventoryService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService, private readonly connectivity: ConnectivityService) {}

  async onModuleInit() {
    if (!this.prisma.enabled || process.env.NODE_ENV === 'production') return;
    if (await this.prisma.esimInventory.count()) return;
    const batch = await this.prisma.inventoryBatch.create({ data: { batchReference: `DEV-MOCK-${new Date().getUTCFullYear()}`, totalProfiles: 20, importedCount: 20 } });
    await this.prisma.esimInventory.createMany({ data: Array.from({ length: 20 }, (_, index) => ({ batchId: batch.id, iccid: `899770100000000${String(index).padStart(3, '0')}`, eid: `890490320000000000000000000${String(index).padStart(3, '0')}`, status: InventoryStatus.AVAILABLE, activationCodeEncrypted: this.crypto.encrypt(`LPA:1$mock.smdp.visacompass.local$${batch.id}-${index}`), smDpAddress: 'mock.smdp.visacompass.local' })) });
  }

  async reserve(orderId: string) {
    if (!this.prisma.enabled) return { id: `memory-${orderId}`, eid: `mock-${orderId}`, iccid: `mock-${orderId}` };
    const existing = await this.prisma.esimInventory.findUnique({ where: { assignedOrderId: orderId } });
    if (existing) return existing;
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = await this.prisma.esimInventory.findFirst({ where: { status: InventoryStatus.AVAILABLE }, orderBy: { createdAt: 'asc' } });
      if (!candidate) throw new ConflictException('No eSIM inventory is currently available');
      const claimed = await this.prisma.esimInventory.updateMany({ where: { id: candidate.id, status: InventoryStatus.AVAILABLE, assignedOrderId: null }, data: { status: InventoryStatus.RESERVED, assignedOrderId: orderId, version: { increment: 1 } } });
      if (claimed.count === 1) return { ...candidate, status: InventoryStatus.RESERVED, assignedOrderId: orderId };
    }
    throw new ConflictException('Inventory reservation conflict; retry the approval');
  }

  async profileForOrder(orderId: string) { return this.reserve(orderId); }

  async importBatch(iccdsInput: string[], eidsInput?: (string | null)[], source?: string) {
    if (!this.prisma.enabled) throw new BadRequestException('Database persistence is required');
    if (iccdsInput.length > 5000) throw new BadRequestException('A single upload is limited to 5,000 rows');
    const rows = iccdsInput.map((iccid, index) => ({ iccid: iccid.trim(), eid: eidsInput?.[index]?.trim() ?? null }));
    const invalid = rows.filter((row) => !/^\d{15,25}$/.test(row.iccid));
    if (invalid.length) throw new BadRequestException(`Invalid ICCID values: ${invalid.map((row) => row.iccid).join(', ')}`);
    const existing = await this.prisma.esimInventory.findMany({ where: { iccid: { in: rows.map((row) => row.iccid) } }, select: { iccid: true } });
    const existingSet = new Set(existing.map((item) => item.iccid));
    const toImport = rows.filter((row) => !existingSet.has(row.iccid));
    if (!toImport.length) return { imported: 0, skipped: rows.length, batch: null };
    const batchReference = `MANUAL-${source ?? 'ops'}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const batch = await this.prisma.$transaction(async (tx) => {
      const created = await tx.inventoryBatch.create({ data: { batchReference, totalProfiles: rows.length, importedCount: toImport.length } });
      await tx.esimInventory.createMany({
        data: toImport.map((row) => ({
          batchId: created.id,
          iccid: row.iccid,
          eid: row.eid ?? `SYNTH-${createHash('sha256').update(row.iccid).digest('hex').slice(0, 28).toUpperCase()}`,
          status: InventoryStatus.AVAILABLE,
        })),
      });
      return created;
    });
    return { imported: toImport.length, skipped: rows.length - toImport.length, batch: batch.id };
  }

  async importBatchCsv(csv: string, source?: string) {
    if (!this.prisma.enabled) throw new BadRequestException('Database persistence is required');
    const { records, errors } = csvToRecords(csv, ['iccid']);
    if (errors.length) throw new BadRequestException(errors.join('; '));
    if (records.length > 5000) throw new BadRequestException('A single upload is limited to 5,000 rows');
    const rowErrors: string[] = [];
    const candidates: { line: number; iccid: string; eid: string | null }[] = [];
    for (const [index, row] of records.entries()) {
      const line = index + 2;
      const iccid = (row.iccid ?? '').trim();
      const eid = (row.eid ?? '').trim() || null;
      if (!/^\d{15,25}$/.test(iccid)) { rowErrors.push(`Line ${line}: invalid ICCID '${iccid || '(empty)'}'`); continue; }
      if (eid && !/^[A-Z0-9-]{16,80}$/.test(eid)) { rowErrors.push(`Line ${line}: invalid EID '${eid}'`); continue; }
      candidates.push({ line, iccid, eid });
    }
    const seen = new Set<string>();
    const uniqueCandidates: typeof candidates = [];
    for (const candidate of candidates) {
      if (seen.has(candidate.iccid)) { rowErrors.push(`Line ${candidate.line}: duplicate ICCID ${candidate.iccid} within the file`); continue; }
      seen.add(candidate.iccid);
      uniqueCandidates.push(candidate);
    }
    const existingIccids = await this.prisma.esimInventory.findMany({ where: { iccid: { in: uniqueCandidates.map((row) => row.iccid) } }, select: { iccid: true } });
    const existingIccidSet = new Set(existingIccids.map((row) => row.iccid));
    const eidsToCheck = uniqueCandidates.map((row) => row.eid).filter((eid): eid is string => Boolean(eid));
    const existingEids = eidsToCheck.length ? await this.prisma.esimInventory.findMany({ where: { eid: { in: eidsToCheck } }, select: { eid: true } }) : [];
    const existingEidSet = new Set(existingEids.map((row) => row.eid));
    const toImport = uniqueCandidates.filter((row) => {
      if (existingIccidSet.has(row.iccid)) { rowErrors.push(`Line ${row.line}: ICCID ${row.iccid} already exists`); return false; }
      if (row.eid && existingEidSet.has(row.eid)) { rowErrors.push(`Line ${row.line}: EID ${row.eid} already exists`); return false; }
      return true;
    });
    if (!toImport.length) return { imported: 0, skipped: rowErrors.length, errors: rowErrors.slice(0, 100), batch: null };
    const batchReference = `MANUAL-CSV-${source?.trim() || 'ops'}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const batch = await this.prisma.$transaction(async (tx) => {
      const created = await tx.inventoryBatch.create({ data: { batchReference, totalProfiles: toImport.length, importedCount: toImport.length } });
      await tx.esimInventory.createMany({
        data: toImport.map((row) => ({
          batchId: created.id,
          iccid: row.iccid,
          eid: row.eid ?? `SYNTH-${createHash('sha256').update(row.iccid).digest('hex').slice(0, 28).toUpperCase()}`,
          status: InventoryStatus.AVAILABLE,
        })),
      });
      return created;
    });
    return { imported: toImport.length, skipped: rowErrors.length, errors: rowErrors.slice(0, 100), batch: batch.id };
  }

  async assign(orderId: string, customerId: string, qrPayload: string, providerInfo?: { provider: string; providerSubscriptionId?: string }) {
    if (!this.prisma.enabled) return;
    const inventory = await this.prisma.esimInventory.findUnique({ where: { assignedOrderId: orderId } });
    if (!inventory) throw new NotFoundException('Reserved inventory was not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.esimInventory.update({
        where: { id: inventory.id },
        data: {
          status: InventoryStatus.ASSIGNED,
          ...(providerInfo?.providerSubscriptionId ? { providerSubscriptionId: providerInfo.providerSubscriptionId } : {}),
          version: { increment: 1 },
        },
      });
      const customerEsim = await tx.customerEsim.upsert({ where: { orderId }, update: { qrPayloadEncrypted: this.crypto.encrypt(qrPayload) }, create: { orderId, inventoryId: inventory.id, customerId, qrPayloadEncrypted: this.crypto.encrypt(qrPayload) } });
      if (providerInfo?.providerSubscriptionId) {
        await tx.subscription.upsert({
          where: { providerSubscriptionId: providerInfo.providerSubscriptionId },
          update: { provider: providerInfo.provider },
          create: { customerEsimId: customerEsim.id, provider: providerInfo.provider, providerSubscriptionId: providerInfo.providerSubscriptionId, status: 'PENDING' },
        });
      }
    });
  }

  async applyLifecycle(orderId: string, event: { provider: string; status?: 'PRELOADED' | 'ACTIVATED' | 'EXPIRED' | 'TERMINATED' | 'CANCELED' | 'OTHER'; subscriptionId?: string; activatedAt?: string; expiresAt?: string }) {
    if (!this.prisma.enabled) return;
    const inventory = await this.prisma.esimInventory.findUnique({ where: { assignedOrderId: orderId } });
    if (!inventory) throw new NotFoundException('Reserved inventory was not found');

    const inventoryStatus = this.mapInventoryStatus(event.status);
    const subscriptionStatus = this.mapSubscriptionStatus(event.status);

    await this.prisma.$transaction(async (tx) => {
      await tx.esimInventory.update({
        where: { id: inventory.id },
        data: {
          ...(inventoryStatus ? { status: inventoryStatus } : {}),
          ...(event.subscriptionId ? { providerSubscriptionId: event.subscriptionId } : {}),
          ...(event.activatedAt ? { activatedAt: new Date(event.activatedAt) } : {}),
          ...(event.expiresAt ? { expiresAt: new Date(event.expiresAt) } : {}),
          version: { increment: 1 },
        },
      });
      const customerEsim = await tx.customerEsim.findUnique({ where: { orderId } });
      const providerSubscriptionId = event.subscriptionId ?? inventory.providerSubscriptionId;
      if (!customerEsim || !providerSubscriptionId) return;
      await tx.subscription.upsert({
        where: { providerSubscriptionId },
        update: {
          status: subscriptionStatus,
          ...(event.activatedAt ? { activatedAt: new Date(event.activatedAt) } : {}),
          ...(event.expiresAt ? { expiresAt: new Date(event.expiresAt) } : {}),
        },
        create: { customerEsimId: customerEsim.id, provider: event.provider, providerSubscriptionId, status: subscriptionStatus, ...(event.activatedAt ? { activatedAt: new Date(event.activatedAt) } : {}), ...(event.expiresAt ? { expiresAt: new Date(event.expiresAt) } : {}) },
      });
    });
  }

  private mapInventoryStatus(status?: 'PRELOADED' | 'ACTIVATED' | 'EXPIRED' | 'TERMINATED' | 'CANCELED' | 'OTHER') {
    if (status === 'ACTIVATED') return InventoryStatus.ACTIVATED;
    if (status === 'EXPIRED') return InventoryStatus.EXPIRED;
    if (status === 'TERMINATED') return InventoryStatus.TERMINATED;
    return null;
  }

  private mapSubscriptionStatus(status?: 'PRELOADED' | 'ACTIVATED' | 'EXPIRED' | 'TERMINATED' | 'CANCELED' | 'OTHER') {
    if (status === 'ACTIVATED') return 'ACTIVE';
    if (status === 'EXPIRED') return 'EXPIRED';
    if (status === 'TERMINATED' || status === 'CANCELED') return 'TERMINATED';
    return 'PENDING';
  }

  async customerIdForOrder(orderId: string) {
    if (!this.prisma.enabled) return `memory-${orderId}`;
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { customerId: true } });
    if (!order) throw new NotFoundException('Order not found');
    return order.customerId;
  }

  async refreshUsage(orderId: string) {
    if (!this.prisma.enabled) throw new BadRequestException('Database persistence is required');
    const inventory = await this.prisma.esimInventory.findUnique({ where: { assignedOrderId: orderId }, select: { iccid: true } });
    if (!inventory) throw new NotFoundException('No eSIM inventory is assigned to this order');
    const customerEsim = await this.prisma.customerEsim.findUnique({ where: { orderId }, select: { id: true } });
    if (!customerEsim) throw new NotFoundException('No customer eSIM record exists for this order');
    const usage = await this.connectivity.getUsage(inventory.iccid);
    await this.prisma.subscription.updateMany({ where: { customerEsimId: customerEsim.id }, data: { usedMb: usage.usedMb, totalMb: usage.totalMb, usageLastCheckedAt: new Date() } });
    return { orderId, ...usage, lastCheckedAt: new Date().toISOString() };
  }

  async overview() {
    if (!this.prisma.enabled) return { counts: { available: 0, reserved: 0, assigned: 0, activated: 0 }, lowStockThreshold: 10, lowStock: true, batches: [] };
    const [groups, batches] = await Promise.all([this.prisma.esimInventory.groupBy({ by: ['status'], _count: { _all: true } }), this.prisma.inventoryBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 20 })]);
    const count = (status: InventoryStatus) => groups.find((item) => item.status === status)?._count._all ?? 0;
    const available = count(InventoryStatus.AVAILABLE);
    return { counts: { available, reserved: count(InventoryStatus.RESERVED), assigned: count(InventoryStatus.ASSIGNED), activated: count(InventoryStatus.ACTIVATED) }, lowStockThreshold: 10, lowStock: available <= 10, batches };
  }
}
