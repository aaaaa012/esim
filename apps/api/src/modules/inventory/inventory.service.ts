import { ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InventoryStatus } from '@prisma/client';
import { CryptoService } from '../../infrastructure/crypto.service.js';
import { PrismaService } from '../../infrastructure/prisma.service.js';

@Injectable()
export class InventoryService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService) {}

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

  async assign(orderId: string, customerId: string, qrPayload: string) {
    if (!this.prisma.enabled) return;
    const inventory = await this.prisma.esimInventory.findUnique({ where: { assignedOrderId: orderId } });
    if (!inventory) throw new NotFoundException('Reserved inventory was not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.esimInventory.update({ where: { id: inventory.id }, data: { status: InventoryStatus.ASSIGNED, version: { increment: 1 } } });
      await tx.customerEsim.upsert({ where: { orderId }, update: { qrPayloadEncrypted: this.crypto.encrypt(qrPayload) }, create: { orderId, inventoryId: inventory.id, customerId, qrPayloadEncrypted: this.crypto.encrypt(qrPayload) } });
    });
  }

  async customerIdForOrder(orderId: string) {
    if (!this.prisma.enabled) return `memory-${orderId}`;
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { customerId: true } });
    if (!order) throw new NotFoundException('Order not found');
    return order.customerId;
  }

  async overview() {
    if (!this.prisma.enabled) return { counts: { available: 0, reserved: 0, assigned: 0, activated: 0 }, lowStockThreshold: 10, lowStock: true, batches: [] };
    const [groups, batches] = await Promise.all([this.prisma.esimInventory.groupBy({ by: ['status'], _count: { _all: true } }), this.prisma.inventoryBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 20 })]);
    const count = (status: InventoryStatus) => groups.find((item) => item.status === status)?._count._all ?? 0;
    const available = count(InventoryStatus.AVAILABLE);
    return { counts: { available, reserved: count(InventoryStatus.RESERVED), assigned: count(InventoryStatus.ASSIGNED), activated: count(InventoryStatus.ACTIVATED) }, lowStockThreshold: 10, lowStock: available <= 10, batches };
  }
}
