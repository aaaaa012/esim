import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DocumentStatus, DocumentType, OrderStatus, PaymentProvider, PaymentStatus, type TravelerInput } from '@visa-compass/shared';
import { CatalogService,type CatalogPlan } from '../catalog/catalog.controller.js';
import { assertTransition } from './order-machine.js';
import { ConnectivityService } from '../integration/connectivity.service.js';
import type { ProviderWebhookEvent } from '../integration/connectivity-provider.js';
import { CloudinaryStorageService } from '../../infrastructure/cloudinary-storage.service.js';
import { ApiException } from '../../common/api-error.js';
import { OrdersPersistenceService } from './orders-persistence.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { QueueService } from '../../jobs/queue.service.js';
import { QUEUES } from '../../jobs/queues.js';
import { NotificationService } from '../notification/notification.service.js';
import { PrismaService } from '../../infrastructure/prisma.service.js';
import { MetricsService } from '../../observability/metrics.service.js';
import { normalizeMsisdn, msisdnVariants } from '../../common/msisdn.util.js';

type Timeline = { from: OrderStatus | null; to: OrderStatus; at: string; reason?: string };
export type DemoOrder = {
  id: string; ownerId: string | null; orderNumber: string; status: OrderStatus; version: number; plan: CatalogPlan; totalAmountNpr: number;
  pricingSnapshot: object; compatibilityAcceptedAt: string; traveler?: TravelerInput; documents: { id: string; type: DocumentType; fileName: string; privateAssetId: string; status: DocumentStatus; uploadVerified?: boolean }[];
  payment?: { provider: PaymentProvider; reference: string; status: PaymentStatus; correlationId?: string; expiresAt?: string; returnUrl?: string; redirectUrl?: string; providerTransactionId?: string }; timeline: Timeline[]; qrPayload?: string; createdAt: string;
  providerSubscriptionId?: string; providerStatus?: string; qrDeliveredAt?: string; activatedAt?: string; usage?: { usedMb: number; totalMb: number; lastCheckedAt?: string };
  purchaseType?: 'INITIAL_PURCHASE' | 'TOPUP';
  topUpMobile?: string;
};

@Injectable()
export class OrdersService implements OnModuleInit {
  private readonly orders = new Map<string, DemoOrder>();
  private readonly logger = new Logger(OrdersService.name);
  constructor(private readonly connectivity: ConnectivityService, private readonly storage: CloudinaryStorageService, private readonly persistence: OrdersPersistenceService, private readonly inventory: InventoryService, private readonly queues: QueueService, private readonly notifications: NotificationService, private readonly catalog: CatalogService, private readonly prisma: PrismaService, private readonly metrics?: MetricsService) {}
  async refreshFromPersistence(orderId?: string) { for (const order of await this.persistence.load()) if (!orderId || order.id === orderId) this.orders.set(order.id, order); }
  async onModuleInit() { for (const order of await this.persistence.load()) this.orders.set(order.id, order); this.logger.log(`Hydrated ${this.orders.size} persisted order(s)`); }
  list(ownerId?: string) { return [...this.orders.values()].filter((o) => !ownerId || o.ownerId === ownerId).map((order) => ownerId ? this.redact(order) : this.expand(order)); }
  audit() { return this.persistence.audit(); }
  get(id: string, ownerId?: string) { const order = this.orders.get(id); if (!order || (ownerId && order.ownerId !== ownerId)) throw new NotFoundException('Order not found'); return order; }
  view(id: string, ownerId?: string) { return ownerId ? this.redact(this.get(id, ownerId)) : this.expand(this.get(id)); }
  async customerProfile(ownerId: string) {
    if (!this.prisma.enabled) {
      const orders = this.list(ownerId);
      return { ownerId, orders: orders.map((order) => ({ id: order.id, orderNumber: order.orderNumber, status: order.status, plan: order.plan, createdAt: order.createdAt, totalAmountNpr: order.totalAmountNpr, usage: order.usage })) };
    }
    const customer = await this.prisma.customer.findFirst({ where: { OR: this.customerMatch(ownerId) }, include: { user: true } });
    if (!customer) throw new NotFoundException('Customer not found');
    const orders = await this.prisma.order.findMany({ where: { customerId: customer.id }, include: { plan: { include: { country: true } }, traveler: true, customerEsim: { include: { inventory: true, subscriptions: true } } }, orderBy: { createdAt: 'desc' } });
    return {
      ownerId: customer.user?.clerkId ?? customer.id,
      customerCode: customer.customerCode,
      email: customer.email,
      name: orders.find((order) => order.traveler)?.traveler?.firstName,
      orders: orders.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        plan: { id: order.plan.id, name: order.plan.name, dataAllowance: order.plan.dataAllowance, validityDays: order.plan.validityDays, countryCode: order.plan.country.isoCode, countryName: order.plan.country.name },
        createdAt: order.createdAt.toISOString(),
        totalAmountNpr: Number(order.totalAmount),
        traveler: order.traveler ? { firstName: order.traveler.firstName, surname: order.traveler.surname, mobile: order.traveler.mobile, email: order.traveler.email } : undefined,
        ...(order.customerEsim ? { esim: { iccid: order.customerEsim.inventory.iccid, status: order.customerEsim.inventory.status, ...(order.customerEsim.inventory.activatedAt ? { activatedAt: order.customerEsim.inventory.activatedAt.toISOString() } : {}), ...(order.customerEsim.inventory.expiresAt ? { expiresAt: order.customerEsim.inventory.expiresAt.toISOString() } : {}), usage: (() => { const latest = [...order.customerEsim.subscriptions].sort((a, b) => (b.usageLastCheckedAt?.getTime() ?? 0) - (a.usageLastCheckedAt?.getTime() ?? 0))[0]; if (!latest || latest.usageLastCheckedAt === null) return undefined; return { usedMb: latest.usedMb, totalMb: latest.totalMb, lastCheckedAt: latest.usageLastCheckedAt.toISOString() }; })() } } : {}),
      })),
    };
  }
  async create(ownerId: string | null, planId: string, compatibilityAccepted: boolean, meta?: { ipAddress?: string; userAgent?: string; mobile?: string; email?: string }) {
    if (!compatibilityAccepted) throw new BadRequestException('Compatibility declaration is required');
    const plan = await this.catalog.findActive(planId); if (!plan) throw new BadRequestException('Invalid or inactive plan');
    const id = randomUUID(); const now = new Date().toISOString();
    const purchaseType = await this.resolvePurchaseType(ownerId, meta?.mobile);
    const topUpEmail = purchaseType === 'TOPUP' ? (meta?.mobile ? await this.priorOrderEmail(meta.mobile) : ownerId ? await this.customerEmail(ownerId) : undefined) : undefined;
    const order: DemoOrder = { id, ownerId, orderNumber: `VC-${new Date().getUTCFullYear()}-${id.slice(0, 8).toUpperCase()}`, status: OrderStatus.DRAFT, version: 0, plan, totalAmountNpr: plan.sellingPriceNpr, pricingSnapshot: { planId, name: plan.name, amount: plan.sellingPriceNpr, currency: 'NPR', ...(meta?.mobile ? { topUpMobile: meta.mobile } : {}), ...(topUpEmail ? { topUpEmail } : {}) }, compatibilityAcceptedAt: now, documents: [], timeline: [{ from: null, to: OrderStatus.DRAFT, at: now }], createdAt: now, purchaseType, ...(meta?.mobile ? { topUpMobile: meta.mobile } : {}) };
    this.orders.set(id, order); await this.persistence.save(order);
    if (meta?.ipAddress || meta?.userAgent) {
      await this.persistence.recordConsent(id, ownerId ?? 'guest', 'E_SIM_COMPATIBILITY', '1.0', meta.ipAddress ?? 'unknown', meta.userAgent ?? 'unknown').catch((error) => this.logger.warn(`Consent recording failed for order ${id}: ${error instanceof Error ? error.message : 'unknown'}`));
    }
    return this.redact(order);
  }
  /**
   * Builds the Prisma `OR` filter for looking up a customer by either its
   * internal UUID id or the Clerk identity id. Clerk ids are not UUIDs, so the
   * `id` clause is only included when the value can legally cast to the UUID
   * column, otherwise CockroachDB rejects the query with a cast error.
   */
  private customerMatch(ownerId: string) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return [{ user: { clerkId: ownerId } }, ...(uuid.test(ownerId) ? [{ id: ownerId }] : [])];
  }
  private async priorOrderEmail(mobile: string): Promise<string | undefined> {
    const target = normalizeMsisdn(mobile);
    const prior = [...this.orders.values()].find((order) => order.status === OrderStatus.COMPLETED && order.traveler && normalizeMsisdn(order.traveler.mobile) === target);
    if (prior?.traveler?.email) return prior.traveler.email;
    if (!this.prisma.enabled) return undefined;
    const variants = [...msisdnVariants(mobile)];
    const found = await this.prisma.order.findFirst({ where: { status: 'COMPLETED', traveler: { is: { mobile: { in: variants } } } }, select: { traveler: { select: { mobile: true, email: true } } } });
    if (found?.traveler && normalizeMsisdn(found.traveler.mobile) === target) return found.traveler.email;
    return undefined;
  }
  private async customerEmail(ownerId: string): Promise<string | undefined> {
    if (!this.prisma.enabled) return [...this.orders.values()].find((order) => order.ownerId === ownerId && order.traveler)?.traveler?.email;
    const customer = await this.prisma.customer.findFirst({ where: { OR: this.customerMatch(ownerId) }, select: { email: true } });
    return customer?.email ?? undefined;
  }
  private async resolvePurchaseType(ownerId: string | null, mobile?: string) {
    if (ownerId && (await this.hasCompletedOrderForOwner(ownerId))) return 'TOPUP' as const;
    if (mobile) {
      const target = normalizeMsisdn(mobile);
      const prior = [...this.orders.values()].find((order) => order.status === OrderStatus.COMPLETED && order.traveler && normalizeMsisdn(order.traveler.mobile) === target);
      if (prior) return 'TOPUP' as const;
      if (this.prisma.enabled) {
        const variants = [...msisdnVariants(mobile)];
        const found = await this.prisma.order.findFirst({ where: { status: 'COMPLETED', traveler: { is: { mobile: { in: variants } } } }, select: { id: true, traveler: { select: { mobile: true } } } });
        if (found?.traveler && normalizeMsisdn(found.traveler.mobile) === target) return 'TOPUP' as const;
      }
    }
    return 'INITIAL_PURCHASE' as const;
  }
  private async hasCompletedOrderForOwner(ownerId: string) {
    const anyCompleted = [...this.orders.values()].some((order) => order.ownerId === ownerId && order.status === OrderStatus.COMPLETED);
    if (anyCompleted) return true;
    if (!this.prisma.enabled) return false;
    const customer = await this.prisma.customer.findFirst({ where: { OR: this.customerMatch(ownerId) }, select: { id: true } });
    if (!customer) return false;
    return Boolean(await this.prisma.order.findFirst({ where: { customerId: customer.id, status: 'COMPLETED' }, select: { id: true } }));
  }
  async usageFor(orderId: string) {
    const order = this.get(orderId);
    if (this.prisma.enabled) {
      const inventory = await this.inventory.inventoryForOrder(orderId);
      if (!inventory?.iccid) throw new NotFoundException('eSIM is not yet provisioned');
      return this.connectivity.getUsage(inventory.iccid);
    }
    if (order.usage) return order.usage;
    throw new NotFoundException('Usage is available after provisioning');
  }
  async setTraveler(id: string, ownerId: string | null, traveler: TravelerInput) { const order = this.get(id, ownerId ?? undefined); if (order.status !== OrderStatus.DRAFT) throw new BadRequestException('Submitted order is immutable'); order.traveler = traveler; await this.persistence.save(order); return this.redact(order); }
  async addDocument(id: string, ownerId: string | null, input: { type: DocumentType; fileName: string; contentType?: string }) { const order = this.get(id, ownerId ?? undefined); if (![OrderStatus.DRAFT, OrderStatus.AWAITING_CUSTOMER].includes(order.status)) throw new BadRequestException('Documents cannot be changed now'); const signed = this.storage.createDocumentUpload(id, input.type); const document = { id: randomUUID(), type: input.type, fileName: input.fileName, privateAssetId: signed.assetId, status: DocumentStatus.PENDING }; order.documents = order.documents.filter((d) => d.type !== input.type).concat(document); await this.persistence.save(order); return { ...document, upload: signed.upload }; }
  async confirmDocument(id: string, documentId: string, ownerId: string | null) { const order = this.get(id, ownerId ?? undefined); const document = order.documents.find((item) => item.id === documentId); if (!document) throw new NotFoundException('Document not found'); await this.storage.verifyDocument(document.privateAssetId); document.uploadVerified = true; if (order.status === OrderStatus.AWAITING_CUSTOMER && !order.documents.some((item) => item.status === DocumentStatus.REUPLOAD_REQUIRED)) this.transition(order, OrderStatus.REVIEW_PENDING, 'Customer supplied requested document'); await this.persistence.save(order); return { id: document.id, type: document.type, status: document.status, uploadVerified: true }; }
  async documentPreview(id: string, documentId: string) { const order = this.get(id); const document = order.documents.find((item) => item.id === documentId); if (!document) throw new NotFoundException('Document not found'); return { url: this.storage.signedReadUrl(document.privateAssetId), fileName: document.fileName, contentType: document.fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image', expiresInSeconds: 300 } }
  async documentContent(id: string, documentId: string) { const order = this.get(id); const document = order.documents.find((item) => item.id === documentId); if (!document) throw new NotFoundException('Document not found'); return { ...(await this.storage.downloadDocument(document.privateAssetId)), fileName: document.fileName }; }
  async beginPayment(id: string, ownerId: string | null, provider: PaymentProvider, initiation: { reference: string; correlationId?: string; expiresAt?: string; returnUrl: string; redirectUrl?: string }) { const order = this.get(id, ownerId ?? undefined); if (order.purchaseType !== 'TOPUP') { const required = order.documents.filter((d) => [DocumentType.PASSPORT, DocumentType.TICKET].includes(d.type)); if (!order.traveler || required.length !== 2) throw new BadRequestException('Traveler, passport, and ticket are required'); await Promise.all(required.map((document) => this.storage.verifyDocument(document.privateAssetId))); required.forEach((document) => { document.uploadVerified = true; }); } if (order.status !== OrderStatus.PAYMENT_PENDING) this.transition(order, OrderStatus.PAYMENT_PENDING); order.payment = { provider, reference: initiation.reference, status: PaymentStatus.PENDING, ...(initiation.correlationId ? { correlationId: initiation.correlationId } : {}), ...(initiation.expiresAt ? { expiresAt: initiation.expiresAt } : {}), returnUrl: initiation.returnUrl, ...(initiation.redirectUrl ? { redirectUrl: initiation.redirectUrl } : {}) }; await this.persistence.save(order); return this.redact(order); }
  async confirmPayment(id: string, reference: string, transactionId?: string) {
    const order = this.get(id);
    if (order.payment?.reference !== reference) throw new BadRequestException('Payment reference mismatch');
    if (order.payment.status === PaymentStatus.COMPLETED) return this.redact(order);
    order.payment.status = PaymentStatus.COMPLETED;
    if (transactionId) order.payment.providerTransactionId = transactionId;
    this.transition(order, OrderStatus.PAYMENT_CONFIRMED);
    await this.autoApprove(order);
    await this.persistence.save(order);
    return this.redact(order);
  }
  async resolvePaymentFailure(id: string, ownerId: string | null, reason: string) {
    const order = this.get(id, ownerId ?? undefined);
    if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.REFUNDED) return this.redact(order);
    if (![OrderStatus.PAYMENT_PENDING, OrderStatus.PAYMENT_FAILED].includes(order.status)) return this.redact(order);
    if (order.payment && order.payment.status !== PaymentStatus.COMPLETED) order.payment.status = PaymentStatus.FAILED;
    if (order.status !== OrderStatus.PAYMENT_FAILED) this.transition(order, OrderStatus.PAYMENT_FAILED, reason);
    await this.persistence.save(order);
    return this.redact(order);
  }
  async cancel(id: string, ownerId: string | null, reason: string) {
    const order = this.get(id, ownerId ?? undefined);
    if (![OrderStatus.DRAFT, OrderStatus.PAYMENT_PENDING, OrderStatus.PAYMENT_FAILED].includes(order.status)) throw new BadRequestException(`Order in ${order.status} cannot be cancelled`);
    if (order.payment && order.payment.status === PaymentStatus.PENDING) order.payment.status = PaymentStatus.CANCELLED;
    this.transition(order, OrderStatus.CANCELLED, reason);
    await this.persistence.save(order);
    return this.redact(order);
  }
  async requestRefund(id: string, actorId: string, reason: string) {
    const order = this.get(id);
    if (!order.payment) throw new BadRequestException('No payment recorded for this order');
    if (order.payment.status === PaymentStatus.REFUNDED) throw new BadRequestException('Order is already refunded');
    if (order.payment.status !== PaymentStatus.COMPLETED) throw new BadRequestException('Only paid orders can be refunded');
    if (order.status === OrderStatus.REFUND_PENDING || order.status === OrderStatus.REFUNDED) throw new BadRequestException('Refund is already in progress');
    if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.DRAFT || order.status === OrderStatus.PAYMENT_PENDING || order.status === OrderStatus.PAYMENT_FAILED) throw new BadRequestException(`Order in ${order.status} cannot be refunded`);
    this.transition(order, OrderStatus.REFUND_PENDING, `${reason} (requested by ${actorId})`);
    await this.persistence.save(order);
    return this.redact(order);
  }
  async markRefunded(id: string, reference: string) {
    const order = this.get(id);
    if (order.payment) order.payment.status = PaymentStatus.REFUNDED;
    if (order.status !== OrderStatus.REFUNDED) this.transition(order, OrderStatus.REFUNDED, `Refund completed (${reference})`);
    await this.persistence.save(order);
    return this.redact(order);
  }
  async expireStalePayments() {
    const now = Date.now();
    let expired = 0;
    for (const order of this.orders.values()) {
      if (order.status !== OrderStatus.PAYMENT_PENDING || !order.payment?.expiresAt) continue;
      if (new Date(order.payment.expiresAt).getTime() > now) continue;
      if (order.payment.status === PaymentStatus.PENDING) order.payment.status = PaymentStatus.FAILED;
      this.transition(order, OrderStatus.PAYMENT_FAILED, 'Payment window expired');
      await this.persistence.save(order);
      expired += 1;
    }
    return { expired };
  }
  async topUpLookup(mobile: string, options?: { includeIdentity?: boolean }) {
    const target = normalizeMsisdn(mobile);
    if (!target) throw new BadRequestException('A valid mobile number is required');
    const includeIdentity = Boolean(options?.includeIdentity);
    const fromOrders = [...this.orders.values()].filter((order) => order.status === OrderStatus.COMPLETED && order.traveler).find((order) => normalizeMsisdn(order.traveler!.mobile) === target);
    if (fromOrders) return { found: true, mobile, ...this.topUpSubscriber(fromOrders, includeIdentity) };
    if (this.prisma.enabled) {
      const variants = [...msisdnVariants(mobile)];
      const dbOrder = await this.prisma.order.findFirst({ where: { status: 'COMPLETED', traveler: { is: { mobile: { in: variants } } } }, include: { plan: { include: { country: true } }, customerEsim: { include: { inventory: true, subscriptions: true } }, traveler: true }, orderBy: { createdAt: 'desc' } });
      if (dbOrder?.traveler && normalizeMsisdn(dbOrder.traveler.mobile) === target) {
        return { found: true, mobile, ...this.dbTopUpSubscriber(dbOrder, includeIdentity) };
      }
    }
    return { found: false, mobile };
  }
  private topUpSubscriber(order: DemoOrder, includeIdentity: boolean) {
    const expiredAt = order.createdAt && order.plan.validityDays ? new Date(new Date(order.createdAt).getTime() + order.plan.validityDays * 86_400_000).toISOString() : undefined;
    const subscriber: Record<string, unknown> = {
      currentPlan: { name: order.plan.name, dataAllowance: order.plan.dataAllowance, validityDays: order.plan.validityDays, countryCode: order.plan.countryCode, countryName: order.plan.countryName },
      countryCode: order.plan.countryCode,
      countryName: order.plan.countryName,
      ...(order.usage ? { usage: order.usage } : {}),
      ...(expiredAt ? { expiresAt: expiredAt } : {}),
      hasActiveEsim: Boolean(order.qrPayload),
      ...(includeIdentity && order.traveler ? { identity: { firstName: order.traveler.firstName, surname: order.traveler.surname, email: order.traveler.email, countryOfResidence: order.traveler.countryOfResidence } } : {}),
    };
    return { subscriber, topUpAvailable: Boolean(order.qrPayload) };
  }
  private dbTopUpSubscriber(dbOrder: { plan: { name: string; dataAllowance: string; validityDays: number; country: { isoCode: string; name: string } }; customerEsim?: { inventory: { iccid: string; status: string; activatedAt: Date | null; expiresAt: Date | null } | null; subscriptions: { usedMb: number; totalMb: number; usageLastCheckedAt: Date | null; status: string; expiresAt: Date | null }[] } | null; traveler: { firstName: string; surname: string; email: string; countryOfResidence: string; mobile: string } | null }, includeIdentity: boolean) {
    const traveler = dbOrder.traveler;
    if (!traveler) return { subscriber: { countryCode: dbOrder.plan.country.isoCode, countryName: dbOrder.plan.country.name }, topUpAvailable: false };
    const latest = [...(dbOrder.customerEsim?.subscriptions ?? [])].sort((a, b) => (b.usageLastCheckedAt?.getTime() ?? 0) - (a.usageLastCheckedAt?.getTime() ?? 0))[0];
    const activeSubscriptions = (dbOrder.customerEsim?.subscriptions ?? []).filter((subscription) => subscription.status !== 'EXPIRED' && subscription.status !== 'TERMINATED');
    const expiresAt = (() => {
      const dates = activeSubscriptions.map((subscription) => subscription.expiresAt?.getTime()).filter((value): value is number => value !== undefined && value !== null);
      if (dates.length) return new Date(Math.min(...dates)).toISOString();
      return dbOrder.customerEsim?.inventory?.expiresAt ? dbOrder.customerEsim.inventory.expiresAt.toISOString() : undefined;
    })();
    const subscriber: Record<string, unknown> = {
      currentPlan: { name: dbOrder.plan.name, dataAllowance: dbOrder.plan.dataAllowance, validityDays: dbOrder.plan.validityDays, countryCode: dbOrder.plan.country.isoCode, countryName: dbOrder.plan.country.name },
      countryCode: dbOrder.plan.country.isoCode,
      countryName: dbOrder.plan.country.name,
      ...(expiresAt ? { expiresAt } : {}),
      ...(latest?.usageLastCheckedAt ? { usage: { usedMb: latest.usedMb, totalMb: latest.totalMb, lastCheckedAt: latest.usageLastCheckedAt.toISOString() } } : {}),
      hasActiveEsim: Boolean(dbOrder.customerEsim?.inventory),
      ...(includeIdentity ? { identity: { firstName: traveler.firstName, surname: traveler.surname, email: traveler.email, countryOfResidence: traveler.countryOfResidence } } : {}),
    };
    return { subscriber, topUpAvailable: Boolean(dbOrder.customerEsim?.inventory) };
  }
  /**
   * Resolves the most recent completed order for a subscriber number, with the
   * plaintext fields needed to provision a top-up (identity, plan country and
   * the physical eSIM to reuse). Returns null when no completed order matches.
   */
  private async priorCompletedOrderFor(mobile: string) {
    const target = normalizeMsisdn(mobile);
    if (!target) return null;
    if (!this.prisma.enabled) {
      const prior = [...this.orders.values()].find((order) => order.status === OrderStatus.COMPLETED && order.traveler && normalizeMsisdn(order.traveler.mobile) === target);
      if (!prior?.traveler) return null;
      return { planCountryCode: prior.plan.countryCode, traveler: { firstName: prior.traveler.firstName, surname: prior.traveler.surname, email: prior.traveler.email, mobile: prior.traveler.mobile, city: prior.traveler.city, countryOfResidence: prior.traveler.countryOfResidence }, inventory: null };
    }
    const variants = [...msisdnVariants(mobile)];
    const prior = await this.prisma.order.findFirst({ where: { status: 'COMPLETED', traveler: { is: { mobile: { in: variants } } } }, include: { plan: { include: { country: true } }, customerEsim: { include: { inventory: true } }, traveler: true }, orderBy: { createdAt: 'desc' } });
    if (!prior?.traveler || normalizeMsisdn(prior.traveler.mobile) !== target) return null;
    return {
      planCountryCode: prior.plan.country.isoCode,
      traveler: { firstName: prior.traveler.firstName, surname: prior.traveler.surname, email: prior.traveler.email, mobile: prior.traveler.mobile, city: prior.traveler.city, countryOfResidence: prior.traveler.countryOfResidence },
      inventory: prior.customerEsim?.inventory ? { eid: prior.customerEsim.inventory.eid, iccid: prior.customerEsim.inventory.iccid } : null,
    };
  }
  async requestReupload(id: string, reason: string) { const order = this.get(id); this.transition(order, OrderStatus.AWAITING_CUSTOMER, reason); order.documents.forEach((d) => { d.status = DocumentStatus.REUPLOAD_REQUIRED; }); await this.persistence.save(order); return order; }
  async reviewDocument(id: string, documentId: string, actorId: string, decision: 'APPROVE' | 'REUPLOAD', reason?: string) { const order = this.get(id); if (order.status !== OrderStatus.REVIEW_PENDING) throw new BadRequestException('Order is not awaiting review'); const document = order.documents.find((item) => item.id === documentId); if (!document) throw new NotFoundException('Document not found'); if (decision === 'APPROVE') { document.status = DocumentStatus.APPROVED; order.timeline.push({ from: order.status, to: order.status, at: new Date().toISOString(), reason: `${document.type} approved by ${actorId}` }); } else { if (!reason?.trim()) throw new BadRequestException('Re-upload reason is required'); document.status = DocumentStatus.REUPLOAD_REQUIRED; this.transition(order, OrderStatus.AWAITING_CUSTOMER, `${document.type}: ${reason.trim()} (requested by ${actorId})`); } await this.persistence.save(order); await this.persistence.recordReview(order.id, documentId, actorId, decision, reason); return this.redact(order); }
  async approve(id: string, actorId: string) { const order = this.get(id); const required = order.documents.filter((document) => [DocumentType.PASSPORT, DocumentType.TICKET].includes(document.type)); if (required.length !== 2 || required.some((document) => document.status !== DocumentStatus.APPROVED)) throw new BadRequestException('Passport and ticket must be individually approved first'); const profile = await this.inventory.reserve(order.id); this.transition(order, OrderStatus.APPROVED, `Approved by ${actorId}; inventory ${profile.iccid} reserved`); this.transition(order, OrderStatus.PROVISIONING); await this.persistence.save(order); await this.queues.add(QUEUES.provisioning, 'provision-order', { orderId: order.id }, `provision-${order.id}`); if (!this.queues.enabled) await this.processLocally(order.id); return this.redact(order); }
  async approveToProvisioning(orderId: string, note: string) { const order = this.get(orderId); if (order.status !== OrderStatus.APPROVED) throw new BadRequestException(`Order in ${order.status} cannot be auto-approved`); const profile = await this.inventory.reserve(order.id); this.transition(order, OrderStatus.PROVISIONING, `${note}; inventory ${profile.iccid} reserved`); await this.persistence.save(order); let queued = true; try { await this.queues.add(QUEUES.provisioning, 'provision-order', { orderId: order.id }, `provision-${order.id}`); } catch (error) { this.logger.warn(`Provisioning queue unavailable for ${order.id}; provisioning locally: ${error instanceof Error ? error.message : 'unknown'}`); queued = false; } if (!queued || !this.queues.enabled) await this.processLocally(order.id); return this.redact(order); }
  async processProvisioning(id: string, attempt: number, finalAttempt: boolean) { const order = this.get(id); const isTopUp = order.purchaseType === 'TOPUP'; const prior = isTopUp && order.topUpMobile ? await this.priorCompletedOrderFor(order.topUpMobile) : null; const reuseExisting = Boolean(isTopUp && prior?.inventory && prior.planCountryCode === order.plan.countryCode); const profile = reuseExisting ? prior!.inventory! : await this.inventory.profileForOrder(order.id); const identity = isTopUp ? prior?.traveler ?? { email: (order.pricingSnapshot as { topUpEmail?: string }).topUpEmail ?? '', mobile: order.topUpMobile ?? '', firstName: 'Existing', surname: 'Customer', city: '', countryOfResidence: 'NP' } : { firstName: order.traveler!.firstName, surname: order.traveler!.surname, email: order.traveler!.email, mobile: order.traveler!.mobile, city: order.traveler!.city, countryOfResidence: order.traveler!.countryOfResidence }; const request = { orderId: order.id, planId: order.plan.id, eid: profile.eid, traveler: identity }; try { const result = await this.connectivity.provision(request); await this.persistence.provisioningAttempt(order.id, attempt, request, { response: result }); if (!result.qrPayload) throw new Error('Connectivity provider has not delivered activation details'); order.qrPayload = result.qrPayload; order.providerSubscriptionId = result.providerSubscriptionId; order.providerStatus = 'PRELOADED'; order.qrDeliveredAt = new Date().toISOString(); const expiresAt = new Date(Date.now() + order.plan.validityDays * 86_400_000).toISOString(); const providerInfo = { provider: this.connectivity.descriptor().provider, ...(result.providerSubscriptionId ? { providerSubscriptionId: result.providerSubscriptionId } : {}), expiresAt }; if (reuseExisting) await this.inventory.assignTopup(order.id, await this.inventory.customerIdForOrder(order.id), profile.iccid, result.qrPayload, providerInfo); else await this.inventory.assign(order.id, await this.inventory.customerIdForOrder(order.id), result.qrPayload, providerInfo); this.transition(order, OrderStatus.QR_READY, `Provisioned on attempt ${attempt}; activation QR delivered`); await this.persistence.save(order); await this.safeNotify(order,'QR_READY'); return this.redact(order); } catch (error) {
    const errorCode = error instanceof ApiException
      ? `${error.code} (HTTP ${error.getStatus()})${error.internalDetail !== undefined ? `: ${typeof error.internalDetail === 'string' ? error.internalDetail : JSON.stringify(error.internalDetail)}` : ''}`.slice(0, 2000)
      : (error instanceof Error ? error.name : 'UNKNOWN');
    await this.persistence.provisioningAttempt(order.id, attempt, request, { errorCode });
    if (finalAttempt) {
      this.metrics?.recordFailure('provisioning', 'exhausted');
      this.transition(order, OrderStatus.PROVISIONING_FAILED, 'Provisioning retries exhausted');
      await this.inventory.release(order.id);
      await this.persistence.save(order);
      await this.alertProvisioningFailure(order);
    }
    throw error;
  } }
  async applyProviderEvent(event: ProviderWebhookEvent) {
    if (!event.orderId) throw new BadRequestException('Provider event did not include an order id');
    const order = this.get(event.orderId);
    if (!order) throw new NotFoundException(`No active order found for ${event.orderId}`);
    const provider = this.connectivity.descriptor().provider;
    const lifecycle = {
      provider,
      ...(event.status ? { status: event.status } : {}),
      ...(event.subscriptionId ? { subscriptionId: event.subscriptionId } : {}),
      ...(event.activatedAt ? { activatedAt: event.activatedAt } : {}),
      ...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
    };

    if (event.status === 'ACTIVATED' && (order.status === OrderStatus.PROVISIONING || order.status === OrderStatus.QR_READY)) {
      const qrPayload = event.qrPayload ?? order.qrPayload;
      if (!qrPayload) throw new BadRequestException('Activation event is missing activation details');
      const wasReady = order.status === OrderStatus.QR_READY;
      order.qrPayload = qrPayload;
      if (event.subscriptionId) order.providerSubscriptionId = event.subscriptionId;
      order.providerStatus = 'ACTIVATED';
      order.activatedAt = event.activatedAt ?? new Date().toISOString();
      await this.activateOrder(order, qrPayload, provider, event.subscriptionId);
      await this.inventory.applyLifecycle(order.id, lifecycle);
      this.transition(order, OrderStatus.COMPLETED, `Provider ${event.eventType} delivered activation`);
      await this.persistence.save(order);
      if (!wasReady) await this.safeNotify(order, 'QR_READY');
      return { accepted: true, eventType: event.eventType };
    }

    await this.inventory.applyLifecycle(order.id, lifecycle);
    if (event.subscriptionId) order.providerSubscriptionId = event.subscriptionId;
    if (event.status) order.providerStatus = event.status;
    await this.persistence.save(order);
    return { accepted: true, eventType: event.eventType };
  }
  retry(id: string) { const order = this.get(id); if (order.status !== OrderStatus.PROVISIONING_FAILED) throw new BadRequestException('Order is not retryable'); return this.approveProvisioning(order); }
  async failStaleReadyOrders() {
    const now = Date.now();
    for (const order of this.orders.values()) {
      if (order.status !== OrderStatus.QR_READY || !order.qrDeliveredAt || !order.plan.validityDays) continue;
      const expiry = new Date(new Date(order.qrDeliveredAt).getTime() + order.plan.validityDays * 86_400_000).getTime();
      if (now <= expiry) continue;
      this.transition(order, OrderStatus.PROVISIONING_FAILED, 'Activation window expired without an ACTIVATED event');
      await this.persistence.save(order);
      await this.alertProvisioningFailure(order);
      this.logger.warn(`Order ${order.orderNumber} (${order.id}) QR_READY activation window expired; marked PROVISIONING_FAILED`);
    }
  }
  private async activateOrder(order: DemoOrder, qrPayload: string, provider: string, subscriptionId?: string) {
    const customerId = await this.inventory.customerIdForOrder(order.id);
    const providerInfo = { provider, ...(subscriptionId ? { providerSubscriptionId: subscriptionId } : {}) };
    if (order.purchaseType === 'TOPUP') {
      const prior = order.topUpMobile ? await this.priorCompletedOrderFor(order.topUpMobile) : null;
      if (prior?.inventory && prior.planCountryCode === order.plan.countryCode) {
        await this.inventory.assignTopup(order.id, customerId, prior.inventory.iccid, qrPayload, providerInfo);
        return;
      }
    }
    await this.inventory.assign(order.id, customerId, qrPayload, providerInfo);
  }
  private async autoApprove(order: DemoOrder) { this.transition(order, OrderStatus.APPROVED, 'Auto-approved after payment'); this.transition(order, OrderStatus.PROVISIONING); await this.queues.add(QUEUES.provisioning, 'provision-order', { orderId: order.id }, `provision-${order.id}`); if (!this.queues.enabled) await this.processLocally(order.id); }
  private async approveProvisioning(order: DemoOrder) { this.transition(order, OrderStatus.PROVISIONING, 'Manual retry'); await this.persistence.save(order); await this.queues.add(QUEUES.provisioning, 'provision-order', { orderId: order.id }, `retry-${order.id}-${Date.now()}`); if (!this.queues.enabled) return this.processLocally(order.id); return this.redact(order); }
  private async processLocally(orderId:string){let failure:unknown;for(let attempt=1;attempt<=3;attempt++){try{return await this.processProvisioning(orderId,attempt,attempt===3)}catch(error){failure=error}}throw failure}
  private transition(order: DemoOrder, to: OrderStatus, reason?: string) { assertTransition(order.status, to); const from = order.status; order.status = to; order.timeline.push({ from, to, at: new Date().toISOString(), ...(reason ? { reason } : {}) }); }
  private notifyEmailFor(order: DemoOrder) { return order.traveler?.email ?? (order.pricingSnapshot as { topUpEmail?: string }).topUpEmail; }
  private async safeNotify(order:DemoOrder,template:'QR_READY'|'DOCUMENT_REUPLOAD',reason?:string){const recipient=this.notifyEmailFor(order);if(!recipient)return;try{await this.notifications.enqueue({orderId:order.id,channel:'EMAIL',template,recipient,orderNumber:order.orderNumber,...(reason?{reason}:{})})}catch(error){this.logger.error(`Notification enqueue failed for order ${order.id}: ${error instanceof Error?error.message:'unknown'}`)}}
  /**
   * Alerts operators (OPS_ALERT_EMAIL) when a provisioning run fails after its
   * retries are exhausted. The alert is best-effort and never blocks the order
   * failure path.
   */
  private async alertProvisioningFailure(order: DemoOrder) {
    const recipient = process.env.OPS_ALERT_EMAIL;
    if (!recipient) {
      this.logger.error(`PROVISIONING_FAILED for order ${order.orderNumber} (${order.id}). Configure OPS_ALERT_EMAIL to receive an alert.`);
      return;
    }
    try {
      await this.notifications.enqueue({ orderId: order.id, channel: 'EMAIL', template: 'OPS_ALERT', recipient, orderNumber: order.orderNumber, reason: `PROVISIONING_FAILED: provisioning retries exhausted for order ${order.orderNumber}` });
      this.logger.error(`Ops alert queued for PROVISIONING_FAILED order ${order.orderNumber}`);
    } catch (error) {
      this.logger.error(`Ops alert enqueue failed for order ${order.id}: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
  private expand(order: DemoOrder) { const { qrPayload: _qrPayload, ...safe } = order; return safe; }
  private redact(order: DemoOrder) {
    const { ownerId: _ownerId, providerSubscriptionId: _providerSubscriptionId, providerStatus: _providerStatus, ...safe } = order;
    const documents = safe.documents.map(({ privateAssetId: _privateAssetId, ...document }) => document);
    const payment = safe.payment ? (({ correlationId: _correlationId, providerTransactionId: _providerTransactionId, ...rest }) => rest)(safe.payment) : undefined;
    const timeline = safe.timeline.map((event) => ({ ...event, ...(event.reason ? { reason: event.reason.replace(/\s+\(?(requested by|approved by|assigned by)\s+user_[A-Za-z0-9_]+\)?\.?$/i, '').trim() || undefined } : {}) }));
    const pricingSnapshot = { ...(safe.pricingSnapshot as Record<string, unknown>) };
    delete pricingSnapshot.topUpEmail;
    delete pricingSnapshot.topUpIdentity;
    return { ...safe, pricingSnapshot, documents, ...(payment ? { payment } : {}), timeline } as DemoOrder;
  }
}
