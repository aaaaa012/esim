import { BadRequestException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma.service.js';
import { ConnectivityService } from '../integration/connectivity.service.js';

@Injectable()
export class CustomerEsimsService {
  private readonly refreshedAt = new Map<string, number>();
  constructor(private readonly prisma: PrismaService, private readonly connectivity: ConnectivityService) {}

  async list(ownerId: string) {
    if (!this.prisma.enabled) return [];
    const customer = await this.customer(ownerId);
    if (!customer) return [];
    const rows = await this.prisma.esimInventory.findMany({
      where: { customerEsims: { some: { customerId: customer.id } } },
      include: { customerEsims: { where: { customerId: customer.id }, include: { order: { include: { plan: { include: { country: true } } } }, subscriptions: true }, orderBy: { assignedAt: 'desc' } } },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((row) => this.toView(row));
  }

  async get(ownerId: string, id: string) {
    const items = await this.list(ownerId);
    const item = items.find((candidate) => candidate.id === id);
    if (!item) throw new NotFoundException('eSIM not found');
    return item;
  }

  async refresh(ownerId: string, id: string) {
    const customer = await this.customer(ownerId);
    if (!customer) throw new NotFoundException('eSIM not found');
    const row = await this.prisma.esimInventory.findFirst({ where: { id, customerEsims: { some: { customerId: customer.id } } }, include: { customerEsims: { where: { customerId: customer.id }, include: { subscriptions: true } } } });
    if (!row) throw new NotFoundException('eSIM not found');
    const last = this.refreshedAt.get(`${customer.id}:${id}`) ?? 0;
    if (Date.now() - last < 30_000) throw new HttpException('Usage was refreshed recently. Please wait before trying again.', HttpStatus.TOO_MANY_REQUESTS);
    if (!row.iccid) throw new BadRequestException('Usage is unavailable until the eSIM is provisioned');
    const usage = await this.connectivity.getUsage(row.iccid);
    const subscriptions = row.customerEsims.flatMap((item) => item.subscriptions).filter((item) => item.status === 'ACTIVE' || item.status === 'PENDING');
    const checkedAt = new Date();
    if (usage.subscriptions?.length) {
      const providerBalances = new Map(usage.subscriptions.map((item) => [item.providerSubscriptionId, item]));
      await Promise.all(subscriptions.map((subscription) => {
        const balance = providerBalances.get(subscription.providerSubscriptionId);
        if (!balance) return Promise.resolve();
        return this.prisma.subscription.update({ where: { id: subscription.id }, data: { usedMb: balance.usedMb, totalMb: balance.totalMb, usageLastCheckedAt: checkedAt, providerLastSeenAt: checkedAt, assignmentVerificationStatus: 'VERIFIED', assignmentVerifiedAt: subscription.assignmentVerifiedAt ?? checkedAt } });
      }));
    }
    this.refreshedAt.set(`${customer.id}:${id}`, Date.now());
    return { usedMb: usage.usedMb, totalMb: usage.totalMb, remainingMb: Math.max(0, usage.totalMb - usage.usedMb), lastCheckedAt: checkedAt.toISOString() };
  }

  private async customer(ownerId: string) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(ownerId);
    return this.prisma.customer.findFirst({ where: { OR: [{ user: { clerkId: ownerId } }, ...(isUuid ? [{ id: ownerId }] : [])] }, select: { id: true } });
  }

  private toView(row: any) {
    const subscriptions = row.customerEsims.flatMap((link: any) => link.subscriptions.map((subscription: any) => ({
      id: subscription.id,
      orderId: link.order.id,
      orderNumber: link.order.orderNumber,
      status: subscription.status,
      plan: { id: link.order.plan.id, name: link.order.plan.name, countryCode: link.order.plan.country.isoCode, countryName: link.order.plan.country.name, dataAllowance: link.order.plan.dataAllowance, validityDays: link.order.plan.validityDays },
      usedMb: subscription.usedMb,
      totalMb: subscription.totalMb,
      remainingMb: Math.max(0, subscription.totalMb - subscription.usedMb),
      activatedAt: subscription.activatedAt?.toISOString(),
      expiresAt: subscription.expiresAt?.toISOString(),
      lastCheckedAt: subscription.usageLastCheckedAt?.toISOString(),
      assignmentVerificationStatus: subscription.assignmentVerificationStatus,
      assignmentVerifiedAt: subscription.assignmentVerifiedAt?.toISOString(),
      providerLastSeenAt: subscription.providerLastSeenAt?.toISOString(),
    })));
    const active = subscriptions.filter((item: any) => item.status === 'ACTIVE' || item.status === 'PENDING');
    const measured = active.filter((item: any) => item.lastCheckedAt);
    const lastCheckedAt = measured.map((item: any) => item.lastCheckedAt).sort().at(-1);
    const usage = measured.length ? measured.reduce((sum: any, item: any) => ({ usedMb: sum.usedMb + item.usedMb, totalMb: sum.totalMb + item.totalMb, remainingMb: sum.remainingMb + item.remainingMb }), { usedMb: 0, totalMb: 0, remainingMb: 0 }) : null;
    const qrOrder = row.customerEsims.find((link: any) => link.order.status === 'COMPLETED' || link.order.status === 'QR_READY');
    const mask = (value?: string | null) => value ? `${value.slice(0, 4)}••••${value.slice(-4)}` : undefined;
    return {
      id: row.id,
      status: active.length ? row.status : 'NO_ACTIVE_PLAN',
      iccidMasked: mask(row.iccid),
      msisdnMasked: mask(row.msisdn),
      activatedAt: row.activatedAt?.toISOString(),
      expiresAt: row.expiresAt?.toISOString(),
      usage: usage ? { ...usage, lastCheckedAt } : null,
      subscriptions: subscriptions.sort((a: any, b: any) => (b.activatedAt ?? '').localeCompare(a.activatedAt ?? '')),
      qrOrderId: qrOrder?.order.id,
      activity: row.customerEsims.map((link: any) => ({ orderId: link.order.id, orderNumber: link.order.orderNumber, orderStatus: link.order.status, purchaseType: link.order.orderType ?? 'INITIAL_PURCHASE', planName: link.order.plan.name, countryCode: link.order.plan.country.isoCode, createdAt: link.order.createdAt?.toISOString?.() ?? link.assignedAt?.toISOString?.() ?? new Date(0).toISOString() })).sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt)),
    };
  }
}
