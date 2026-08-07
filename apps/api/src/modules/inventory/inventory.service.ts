import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { BatchStatus, InventoryStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import { CryptoService } from '../../infrastructure/crypto.service.js';
import { PrismaService } from '../../infrastructure/prisma.service.js';
import { tabularToRecords } from '../../common/tabular.util.js';
import { ConnectivityService } from '../integration/connectivity.service.js';

@Injectable()
export class InventoryService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService, private readonly connectivity: ConnectivityService) {}

  async onModuleInit() {
    if (!this.prisma.enabled || process.env.NODE_ENV === 'production') return;
    if (await this.prisma.esimInventory.count()) return;
    const batch = await this.prisma.inventoryBatch.create({ data: { batchReference: `DEV-MOCK-${new Date().getUTCFullYear()}`, totalProfiles: 20, importedCount: 20 } });
    await this.prisma.esimInventory.createMany({ data: Array.from({ length: 20 }, (_, index) => ({ batchId: batch.id, iccid: `899770100000000${String(index).padStart(3, '0')}`, eid: `890490320000000000000000000${String(index).padStart(3, '0')}`, msisdn: `8824700018${String(50000 + index)}`, status: InventoryStatus.AVAILABLE, activationCodeEncrypted: this.crypto.encrypt(`LPA:1$mock.smdp.visacompass.local$${batch.id}-${index}`), smDpAddress: 'mock.smdp.visacompass.local' })) });
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

  async importBatch(iccdsInput: string[], eidsInput?: (string | null)[], source?: string, msisdnsInput?: (string | null)[], submittedById?: string) {
    if (!this.prisma.enabled) throw new BadRequestException('Database persistence is required');
    if (iccdsInput.length > 5000) throw new BadRequestException('A single upload is limited to 5,000 rows');
    const rows = iccdsInput.map((iccid, index) => ({ iccid: iccid.trim(), eid: eidsInput?.[index]?.trim() ?? null, msisdn: msisdnsInput?.[index]?.trim() ?? null }));
    const invalid = rows.filter((row) => !/^\d{15,25}$/.test(row.iccid));
    if (invalid.length) throw new BadRequestException(`Invalid ICCID values: ${invalid.map((row) => row.iccid).join(', ')}`);
    const existing = await this.prisma.esimInventory.findMany({ where: { iccid: { in: rows.map((row) => row.iccid) } }, select: { iccid: true } });
    const existingSet = new Set(existing.map((item) => item.iccid));
    const toImport = rows.filter((row) => !existingSet.has(row.iccid));
    if (!toImport.length) return { imported: 0, skipped: rows.length, batch: null };
    const submitter = submittedById ? await this.localUser(submittedById) : null;
    const submittedByLocalId = submitter?.id;
    const batchReference = `MANUAL-${source ?? 'ops'}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const batch = await this.prisma.$transaction(async (tx) => {
      const created = await tx.inventoryBatch.create({ data: { batchReference, totalProfiles: rows.length, importedCount: toImport.length, status: BatchStatus.PENDING, ...(submittedByLocalId ? { submittedById: submittedByLocalId } : {}) } });
      await tx.esimInventory.createMany({
        data: toImport.map((row) => ({
          batchId: created.id,
          iccid: row.iccid,
          eid: row.eid ?? `SYNTH-${createHash('sha256').update(row.iccid).digest('hex').slice(0, 28).toUpperCase()}`,
          ...(row.msisdn ? { msisdn: row.msisdn } : {}),
          status: InventoryStatus.IMPORTED,
        })),
      });
      return created;
    });
    return { imported: toImport.length, skipped: rows.length - toImport.length, batch: batch.id };
  }

  async importBatchCsv(content: string, source?: string, fileName?: string, submittedById?: string) {
    if (!this.prisma.enabled) throw new BadRequestException('Database persistence is required');
    const { records, errors } = await tabularToRecords(content, ['iccid'], fileName ? { fileName, maxRows: 5000 } : { maxRows: 5000 });
    if (errors.length) throw new BadRequestException(errors.join('; '));
    if (records.length > 5000) throw new BadRequestException('A single upload is limited to 5,000 rows');
    const rowErrors: string[] = [];
    const candidates: { line: number; iccid: string; eid: string | null; msisdn: string | null }[] = [];
    for (const [index, row] of records.entries()) {
      const line = index + 2;
      const iccid = (row.iccid ?? '').trim();
      const eid = (row.eid ?? '').trim() || null;
      const msisdn = (row.msisdn ?? '').trim() || null;
      if (!/^\d{15,25}$/.test(iccid)) { rowErrors.push(`Line ${line}: invalid ICCID '${iccid || '(empty)'}'`); continue; }
      if (eid && !/^[A-Z0-9-]{16,80}$/.test(eid)) { rowErrors.push(`Line ${line}: invalid EID '${eid}'`); continue; }
      if (msisdn && !/^\+?\d{6,15}$/.test(msisdn)) { rowErrors.push(`Line ${line}: invalid MSISDN '${msisdn}'`); continue; }
      candidates.push({ line, iccid, eid, msisdn });
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
    const submitter = submittedById ? await this.localUser(submittedById) : null;
    const submittedByLocalId = submitter?.id;
    const batchReference = `MANUAL-CSV-${source?.trim() || 'ops'}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const batch = await this.prisma.$transaction(async (tx) => {
      const created = await tx.inventoryBatch.create({ data: { batchReference, totalProfiles: toImport.length, importedCount: toImport.length, status: BatchStatus.PENDING, ...(submittedByLocalId ? { submittedById: submittedByLocalId } : {}) } });
      await tx.esimInventory.createMany({
        data: toImport.map((row) => ({
          batchId: created.id,
          iccid: row.iccid,
          eid: row.eid ?? `SYNTH-${createHash('sha256').update(row.iccid).digest('hex').slice(0, 28).toUpperCase()}`,
          ...(row.msisdn ? { msisdn: row.msisdn } : {}),
          status: InventoryStatus.IMPORTED,
        })),
      });
      return created;
    });
    return { imported: toImport.length, skipped: rowErrors.length, errors: rowErrors.slice(0, 100), batch: batch.id };
  }

  async importBatchTabular(content: string, fileName?: string, source?: string, submittedById?: string) {
    return this.importBatchCsv(content, source, fileName, submittedById);
  }

  /**
   * Approves a pending upload batch: rows flip from IMPORTED to AVAILABLE and
   * only then enter the sellable FIFO pool. Every decision is audited.
   */
  async approveBatch(batchId: string, actorClerkId: string) {
    if (!this.prisma.enabled) throw new BadRequestException('Database persistence is required');
    const batch = await this.prisma.inventoryBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new NotFoundException('Upload batch not found');
    if (batch.status !== BatchStatus.PENDING) throw new BadRequestException(`Batch is ${batch.status.toLowerCase()}; only pending batches can be approved`);
    const actor = await this.localUser(actorClerkId);
    await this.prisma.$transaction(async (tx) => {
      await tx.inventoryBatch.update({
        where: { id: batchId },
        data: { status: BatchStatus.APPROVED, approvedById: actor?.id ?? null, approvedAt: new Date() },
      });
      await tx.esimInventory.updateMany({
        where: { batchId, status: InventoryStatus.IMPORTED },
        data: { status: InventoryStatus.AVAILABLE, version: { increment: 1 } },
      });
      await tx.auditLog.create({
        data: {
          module: 'INVENTORY',
          entity: 'InventoryBatch',
          entityId: batchId,
          action: 'BATCH_APPROVED',
          ...(actor ? { performedById: actor.id } : {}),
          previousValue: { status: batch.status, reference: batch.batchReference },
          newValue: { status: BatchStatus.APPROVED },
        },
      });
    });
    return { id: batchId, status: BatchStatus.APPROVED, reference: batch.batchReference };
  }

  /**
   * Rejects a pending upload batch. Rows stay IMPORTED so they can never be
   * reserved; the reason is retained on the batch and in the audit trail.
   */
  async rejectBatch(batchId: string, actorClerkId: string, reason?: string) {
    if (!this.prisma.enabled) throw new BadRequestException('Database persistence is required');
    const batch = await this.prisma.inventoryBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new NotFoundException('Upload batch not found');
    if (batch.status !== BatchStatus.PENDING) throw new BadRequestException(`Batch is ${batch.status.toLowerCase()}; only pending batches can be rejected`);
    const actor = await this.localUser(actorClerkId);
    await this.prisma.$transaction(async (tx) => {
      await tx.inventoryBatch.update({
        where: { id: batchId },
        data: { status: BatchStatus.REJECTED, rejectedById: actor?.id ?? null, rejectedAt: new Date(), ...(reason?.trim() ? { rejectionReason: reason.trim() } : {}) },
      });
      await tx.auditLog.create({
        data: {
          module: 'INVENTORY',
          entity: 'InventoryBatch',
          entityId: batchId,
          action: 'BATCH_REJECTED',
          ...(actor ? { performedById: actor.id } : {}),
          previousValue: { status: batch.status, reference: batch.batchReference },
          newValue: { status: BatchStatus.REJECTED, ...(reason?.trim() ? { reason: reason.trim() } : {}) },
        },
      });
    });
    return { id: batchId, status: BatchStatus.REJECTED, reference: batch.batchReference };
  }

  private async localUser(clerkId: string) {
    try {
      return await this.prisma.user.findUnique({ where: { clerkId } });
    } catch {
      return null;
    }
  }

  async assign(orderId: string, customerId: string, qrPayload: string, providerInfo?: { provider: string; providerSubscriptionId?: string; expiresAt?: string }) {
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
          update: { provider: providerInfo.provider, ...(providerInfo.expiresAt ? { expiresAt: new Date(providerInfo.expiresAt) } : {}) },
          create: { customerEsimId: customerEsim.id, provider: providerInfo.provider, providerSubscriptionId: providerInfo.providerSubscriptionId, status: 'PENDING', ...(providerInfo.expiresAt ? { expiresAt: new Date(providerInfo.expiresAt) } : {}) },
        });
      }
    });
  }

  /**
   * Attaches a top-up order to an already-provisioned eSIM (same country). The
   * physical eSIM is not reserved again; a new CustomerEsim row (unique per
   * order) links the order to the existing inventory so data plans can stack,
   * each with its own subscription and expiry.
   */
  async assignTopup(orderId: string, customerId: string, iccid: string, qrPayload: string, providerInfo?: { provider: string; providerSubscriptionId?: string; expiresAt?: string }) {
    if (!this.prisma.enabled) return;
    const inventory = await this.prisma.esimInventory.findUnique({ where: { iccid } });
    if (!inventory) throw new NotFoundException('Existing eSIM was not found');
    await this.prisma.$transaction(async (tx) => {
      const customerEsim = await tx.customerEsim.upsert({ where: { orderId }, update: { qrPayloadEncrypted: this.crypto.encrypt(qrPayload) }, create: { orderId, inventoryId: inventory.id, customerId, qrPayloadEncrypted: this.crypto.encrypt(qrPayload) } });
      if (providerInfo?.providerSubscriptionId) {
        await tx.subscription.upsert({
          where: { providerSubscriptionId: providerInfo.providerSubscriptionId },
          update: { provider: providerInfo.provider, ...(providerInfo.expiresAt ? { expiresAt: new Date(providerInfo.expiresAt) } : {}) },
          create: { customerEsimId: customerEsim.id, provider: providerInfo.provider, providerSubscriptionId: providerInfo.providerSubscriptionId, status: 'PENDING', ...(providerInfo.expiresAt ? { expiresAt: new Date(providerInfo.expiresAt) } : {}) },
        });
      }
    });
  }

  /**
   * Resolves the eSIM inventory backing an order. Initial purchases are found
   * through the reserved `assignedOrderId`; top-up orders reuse an existing
   * eSIM and are resolved through their CustomerEsim row instead.
   */
  async inventoryForOrder(orderId: string) {
    if (!this.prisma.enabled) return null;
    const byAssigned = await this.prisma.esimInventory.findUnique({ where: { assignedOrderId: orderId }, select: { id: true, iccid: true, msisdn: true } });
    if (byAssigned) return byAssigned;
    const viaEsim = await this.prisma.customerEsim.findUnique({ where: { orderId }, select: { inventory: { select: { id: true, iccid: true, msisdn: true } } } });
    return viaEsim?.inventory ?? null;
  }

  async applyLifecycle(orderId: string, event: { provider: string; status?: 'PRELOADED' | 'ACTIVATED' | 'EXPIRED' | 'TERMINATED' | 'CANCELED' | 'OTHER'; subscriptionId?: string; activatedAt?: string; expiresAt?: string }) {
    if (!this.prisma.enabled) return;
    const resolved = await this.inventoryForOrder(orderId);
    if (!resolved) throw new NotFoundException('No inventory is associated with this order');
    const inventory = await this.prisma.esimInventory.findUnique({ where: { id: resolved.id } });
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
    const inventory = await this.inventoryForOrder(orderId);
    if (!inventory?.iccid) throw new NotFoundException('No eSIM inventory is assigned to this order');
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
    return { counts: { available, reserved: count(InventoryStatus.RESERVED), assigned: count(InventoryStatus.ASSIGNED), activated: count(InventoryStatus.ACTIVATED), pending: count(InventoryStatus.IMPORTED), expired: count(InventoryStatus.EXPIRED), terminated: count(InventoryStatus.TERMINATED) }, lowStockThreshold: 10, lowStock: available <= 10, batches: batches.map((batch) => ({ id: batch.id, batchReference: batch.batchReference, totalProfiles: batch.totalProfiles, importedCount: batch.importedCount, failedCount: batch.failedCount, status: batch.status, rejectionReason: batch.rejectionReason, createdAt: batch.createdAt.toISOString() })) };
  }

  /**
   * Lists eSIM profiles with the overseas linkage back to the sale: which order
   * reserved/owns each SIM, which customer bought it, and which package (plan)
   * it belongs to. Available to OPERATIONS and SUPER_ADMIN.
   */
  async profiles(params?: { status?: InventoryStatus; limit?: number; offset?: number }) {
    if (!this.prisma.enabled) return { total: 0, items: [] };
    const limit = Math.min(params?.limit ?? 50, 200);
    const skip = params?.offset ? Number(params.offset) : 0;
    const statusFilter = params?.status ? { status: params.status } : undefined;
    const [total, items] = await Promise.all([
      this.prisma.esimInventory.count({ ...(statusFilter ? { where: statusFilter } : {}) }),
      this.prisma.esimInventory.findMany({
        ...(statusFilter ? { where: statusFilter } : {}),
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          batch: { select: { batchReference: true, status: true } },
          assignedOrder: {
            select: {
              orderNumber: true,
              status: true,
              plan: { select: { name: true, dataAllowance: true, providerPlanId: true, country: { select: { isoCode: true, name: true } } } },
              customer: { select: { email: true, customerCode: true } },
            },
          },
        },
      }),
    ]);
    return {
      total,
      items: items.map((profile) => ({
        id: profile.id,
        iccid: profile.iccid,
        eid: profile.eid,
        msisdn: profile.msisdn,
        status: profile.status,
        smDpAddress: profile.smDpAddress,
        providerSubscriptionId: profile.providerSubscriptionId,
        providerStatus: profile.providerStatus,
        activatedAt: profile.activatedAt?.toISOString() ?? null,
        expiresAt: profile.expiresAt?.toISOString() ?? null,
        batchReference: profile.batch?.batchReference ?? null,
        batchStatus: profile.batch?.status ?? null,
        order: profile.assignedOrder
          ? {
              orderNumber: profile.assignedOrder.orderNumber,
              orderStatus: profile.assignedOrder.status,
              customerEmail: profile.assignedOrder.customer.email,
              customerCode: profile.assignedOrder.customer.customerCode,
              planName: profile.assignedOrder.plan.name,
              planCountry: profile.assignedOrder.plan.country.name,
              planCountryCode: profile.assignedOrder.plan.country.isoCode,
              dataAllowance: profile.assignedOrder.plan.dataAllowance,
            }
          : null,
      })),
      page: { limit, skip },
    };
  }
}
