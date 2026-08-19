import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DocumentStatus, DocumentType, ApiErrorCode, OrderStatus, PaymentProvider, PaymentStatus, provisioningFailure, type ProvisioningFailure, type TravelerInput } from '@visa-compass/shared';
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
import { QrPdfService } from '../notification/qr-pdf.service.js';
import { PrismaService } from '../../infrastructure/prisma.service.js';
import { MetricsService } from '../../observability/metrics.service.js';
import { normalizeMsisdn, msisdnVariants } from '../../common/msisdn.util.js';
import type { PassportVerificationResult } from './passport-verification.service.js';

type Timeline = { from: OrderStatus | null; to: OrderStatus; at: string; reason?: string };
export type DemoOrder = {
  id: string; ownerId: string | null; orderNumber: string; status: OrderStatus; version: number; plan: CatalogPlan; totalAmountNpr: number;
  pricingSnapshot: object; compatibilityAcceptedAt: string; traveler?: TravelerInput; documents: { id: string; type: DocumentType; fileName: string; privateAssetId: string; status: DocumentStatus; uploadVerified?: boolean }[];
  payment?: { provider: PaymentProvider; reference: string; status: PaymentStatus; correlationId?: string; expiresAt?: string; returnUrl?: string; redirectUrl?: string; providerTransactionId?: string; verificationAttempts?: number }; timeline: Timeline[]; qrPayload?: string; createdAt: string;
  providerSubscriptionId?: string; providerStatus?: string; qrDeliveredAt?: string; activatedAt?: string; usage?: { usedMb: number; totalMb: number; lastCheckedAt?: string };
  activationRefetchAttempts?: number; lastProvisioningRecoveryAt?: string;
  purchaseType?: 'INITIAL_PURCHASE' | 'TOPUP';
  topUpMobile?: string;
  passportVerification?: PassportVerificationResult;
  documentReviewPolicy?: 'AUTO_OCR' | 'MANUAL_REVIEW';
  documentReviewStatus?: 'NOT_STARTED' | 'OCR_PENDING' | 'OCR_BACKGROUND' | 'VERIFIED' | 'MANUAL_REVIEW' | 'REUPLOAD_REQUIRED' | 'MANUALLY_APPROVED' | 'SKIPPED';
  documentReviewStartedAt?: string;
  documentCheckoutReleaseAt?: string;
  assignment?: { inventoryId: string; iccid: string; msisdn?: string; providerSubscriptionId?: string; verificationStatus?: string; verifiedAt?: string; providerLastSeenAt?: string };
  partner?: { id: string; code: string; name: string };
  externalOrderId?: string;
  provisioningFailure?: ProvisioningFailure;
};

@Injectable()
export class OrdersService implements OnModuleInit {
  private readonly orders = new Map<string, DemoOrder>();
  private readonly logger = new Logger(OrdersService.name);
  private readonly confirmLocks = new Map<string, Promise<unknown>>();
  private readonly maxActivationRefetches = (() => { const parsed = Number(process.env.ACTIVATION_REFETCH_ATTEMPTS); return Number.isFinite(parsed) && parsed > 0 ? parsed : 3; })();
  constructor(private readonly connectivity: ConnectivityService, private readonly storage: CloudinaryStorageService, private readonly persistence: OrdersPersistenceService, private readonly inventory: InventoryService, private readonly queues: QueueService, private readonly notifications: NotificationService, private readonly catalog: CatalogService, private readonly prisma: PrismaService, private readonly qrPdf: QrPdfService, private readonly metrics?: MetricsService) {}
  async refreshFromPersistence(orderId?: string) { for (const order of await this.persistence.load()) if (!orderId || order.id === orderId) this.orders.set(order.id, order); }
  async refreshOne(orderId: string, force = false) { if (!force && this.orders.has(orderId)) return; for (const order of await this.persistence.load(orderId)) if (order.id === orderId) this.orders.set(order.id, order); }
  async onModuleInit() {
    for (const order of await this.persistence.load()) this.orders.set(order.id, order);
    this.logger.log(`Hydrated ${this.orders.size} persisted order(s)`);
    for (const order of this.orders.values()) {
      if (![OrderStatus.APPROVED, OrderStatus.PROVISIONING].includes(order.status)) continue;
      const recovery = order.status === OrderStatus.APPROVED
        ? this.approveToProvisioning(order.id, 'Recovered accepted order')
        : this.queues.add(QUEUES.provisioning, 'provision-order', { orderId: order.id }, `provision-${order.id}`);
      void recovery.catch((error) =>
        this.logger.error(`Could not recover order ${order.id} at boot: ${error instanceof Error ? error.message : 'unknown'}`),
      );
    }
  }
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
        ...(order.customerEsim ? { esim: { iccid: order.customerEsim.inventory.iccid, status: order.customerEsim.inventory.status, providerStatus: order.providerStatus ?? order.customerEsim.inventory.providerStatus, ...(order.customerEsim.inventory.activatedAt ? { activatedAt: order.customerEsim.inventory.activatedAt.toISOString() } : {}), ...(order.customerEsim.inventory.expiresAt ? { expiresAt: order.customerEsim.inventory.expiresAt.toISOString() } : {}), usage: (() => { const latest = [...order.customerEsim.subscriptions].sort((a, b) => (b.usageLastCheckedAt?.getTime() ?? 0) - (a.usageLastCheckedAt?.getTime() ?? 0))[0]; if (!latest || latest.usageLastCheckedAt === null) return undefined; return { usedMb: latest.usedMb, totalMb: latest.totalMb, remainingMb: Math.max(0, latest.totalMb - latest.usedMb), lastCheckedAt: latest.usageLastCheckedAt.toISOString() }; })() } } : {}),
      })),
    };
  }
  async create(ownerId: string | null, planId: string, compatibilityAccepted: boolean, meta?: { ipAddress?: string; userAgent?: string; mobile?: string; email?: string; targetEsimId?: string }) {
    if (!compatibilityAccepted) throw new BadRequestException('Compatibility declaration is required');
    const plan = await this.catalog.findActive(planId); if (!plan) throw new BadRequestException('Invalid or inactive plan');
    const id = randomUUID(); const now = new Date().toISOString();
    const target = meta?.targetEsimId && ownerId ? await this.targetEsim(ownerId, meta.targetEsimId) : null;
    const mobileTarget = !target && meta?.mobile ? await this.targetForMobile(meta.mobile) : null;
    const selectedTarget = target ?? mobileTarget;
    const purchaseType = selectedTarget?.countryCodes.includes(plan.countryCode) ? 'TOPUP' as const : 'INITIAL_PURCHASE' as const;
    const topUpEmail = purchaseType === 'TOPUP' ? (meta?.mobile ? await this.priorOrderEmail(meta.mobile) : ownerId ? await this.customerEmail(ownerId) : undefined) : undefined;
    const reusableTraveler = target && purchaseType === 'INITIAL_PURCHASE' ? target.traveler : undefined;
    const order: DemoOrder = { id, ownerId, orderNumber: `VC-${new Date().getUTCFullYear()}-${id.slice(0, 8).toUpperCase()}`, status: OrderStatus.DRAFT, version: 0, plan, totalAmountNpr: plan.sellingPriceNpr, pricingSnapshot: { planId, name: plan.name, amount: plan.sellingPriceNpr, currency: 'NPR', ...(selectedTarget ? { targetEsimId: selectedTarget.inventoryId } : {}), ...(meta?.mobile ? { topUpMobile: meta.mobile } : {}), ...(topUpEmail ? { topUpEmail } : {}) }, compatibilityAcceptedAt: now, ...(reusableTraveler ? { traveler: reusableTraveler } : {}), documents: [], timeline: [{ from: null, to: OrderStatus.DRAFT, at: now }], createdAt: now, purchaseType, ...(meta?.mobile ? { topUpMobile: meta.mobile } : {}) };
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
  private async targetEsim(ownerId: string, inventoryId: string) {
    if (!this.prisma.enabled) throw new BadRequestException('Target eSIM selection requires database persistence');
    const customer = await this.prisma.customer.findFirst({ where: { OR: this.customerMatch(ownerId) }, select: { id: true } });
    if (!customer) throw new NotFoundException('eSIM not found');
    const rows = await this.prisma.customerEsim.findMany({ where: { customerId: customer.id, inventoryId }, select: { inventoryId: true, orderId: true, assignedAt: true, order: { select: { plan: { select: { country: { select: { isoCode: true } } } } } } }, orderBy: { assignedAt: 'desc' } });
    if (!rows.length) throw new NotFoundException('eSIM not found');
    const traveler = rows.map((row) => this.orders.get(row.orderId)?.traveler).find(Boolean);
    return { inventoryId, countryCodes: [...new Set(rows.map((row) => row.order.plan.country.isoCode))], ...(traveler ? { traveler } : {}) };
  }
  private async targetForMobile(mobile: string) {
    const prior = await this.priorCompletedOrderFor(mobile);
    return prior?.inventory ? { inventoryId: prior.inventory.id, countryCodes: [prior.planCountryCode] } : null;
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
  async addDocument(id: string, ownerId: string | null, input: { type: DocumentType; fileName: string; contentType?: string }) { const order = this.get(id, ownerId ?? undefined); const replacement = order.documentReviewStatus === 'REUPLOAD_REQUIRED'; if (![OrderStatus.DRAFT, OrderStatus.AWAITING_CUSTOMER].includes(order.status) && !replacement) throw new BadRequestException('Documents cannot be changed now'); const signed = this.storage.createDocumentUpload(id, input.type); const document = { id: randomUUID(), type: input.type, fileName: input.fileName, privateAssetId: signed.assetId, status: DocumentStatus.PENDING }; order.documents = order.documents.filter((d) => d.type !== input.type).concat(document); if (replacement) order.documentReviewStatus = 'NOT_STARTED'; await this.persistence.save(order); return { ...document, upload: signed.upload }; }
  async confirmDocument(id: string, documentId: string, ownerId: string | null) { const order = this.get(id, ownerId ?? undefined); const document = order.documents.find((item) => item.id === documentId); if (!document) throw new NotFoundException('Document not found'); await this.storage.verifyDocument(document.privateAssetId); document.uploadVerified = true; if (order.status === OrderStatus.AWAITING_CUSTOMER && !order.documents.some((item) => item.status === DocumentStatus.REUPLOAD_REQUIRED)) this.transition(order, OrderStatus.REVIEW_PENDING, 'Customer supplied requested document'); await this.persistence.save(order); return { id: document.id, type: document.type, status: document.status, uploadVerified: true }; }
  async documentPreview(id: string, documentId: string) { const order = this.get(id); const document = order.documents.find((item) => item.id === documentId); if (!document) throw new NotFoundException('Document not found'); return { url: this.storage.signedReadUrl(document.privateAssetId), fileName: document.fileName, contentType: document.fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image', expiresInSeconds: 300 } }
  async documentContent(id: string, documentId: string) { const order = this.get(id); const document = order.documents.find((item) => item.id === documentId); if (!document) throw new NotFoundException('Document not found'); return { ...(await this.storage.downloadDocument(document.privateAssetId)), fileName: document.fileName }; }
  async verifyPassport(id: string, ownerId: string | null) {
    const order = this.get(id, ownerId ?? undefined);
    if (order.purchaseType === 'TOPUP') throw new BadRequestException('Passport verification is not required for top-ups');
    const passport = order.documents.find((document) => document.type === DocumentType.PASSPORT && document.uploadVerified);
    if (!passport || !order.traveler) throw new BadRequestException('Confirmed passport and traveller details are required');
    const config = this.prisma.enabled
      ? await this.prisma.platformConfiguration.upsert({ where: { id: 'platform' }, update: {}, create: { id: 'platform' } })
      : { documentReviewPolicy: 'AUTO_OCR' as const, ocrCheckoutWaitMs: 8000 };
    const now = new Date();
    order.documentReviewPolicy = config.documentReviewPolicy;
    order.documentReviewStartedAt ??= now.toISOString();
    order.documentCheckoutReleaseAt ??= new Date(now.getTime() + config.ocrCheckoutWaitMs).toISOString();
    if (config.documentReviewPolicy === 'MANUAL_REVIEW') {
      order.documentReviewStatus = 'MANUAL_REVIEW';
      order.passportVerification = { status: 'NOT_READY', matchedFields: [], checkedAt: now.toISOString(), method: 'ocr-error', detail: 'Documents will be reviewed manually without delaying fulfillment' };
      await this.persistence.save(order);
      return this.redact(order);
    }
    if (!['OCR_PENDING', 'OCR_BACKGROUND'].includes(order.documentReviewStatus ?? '')) {
      order.documentReviewStatus = 'OCR_PENDING';
      await this.persistence.save(order);
      try {
        await this.queues.add(QUEUES.documents, 'verify-order-passport', { orderId: order.id, documentId: passport.id }, `order-passport-${order.id}-${passport.id}`, { attempts: 3, backoff: { type: 'exponential', delay: 2_000 } });
      } catch (error) {
        order.documentReviewStatus = 'MANUAL_REVIEW';
        order.passportVerification = { status: 'NOT_READY', matchedFields: [], checkedAt: now.toISOString(), method: 'ocr-error', detail: `OCR queue unavailable; routed to manual review (${error instanceof Error ? error.message : 'unknown error'})` };
        await this.persistence.save(order);
      }
    } else if (order.documentCheckoutReleaseAt && new Date(order.documentCheckoutReleaseAt) <= now && order.documentReviewStatus === 'OCR_PENDING') {
      order.documentReviewStatus = 'OCR_BACKGROUND';
      await this.persistence.save(order);
    }
    return this.redact(order);
  }
  async beginPayment(id: string, ownerId: string | null, provider: PaymentProvider, initiation: { reference: string; correlationId?: string; expiresAt?: string; returnUrl: string; redirectUrl?: string }) { const order = this.get(id, ownerId ?? undefined); if (order.purchaseType !== 'TOPUP') { const required = order.documents.filter((d) => [DocumentType.PASSPORT, DocumentType.TICKET].includes(d.type)); if (!order.traveler || required.length !== 2) throw new BadRequestException('Traveler, passport, and ticket are required'); await Promise.all(required.map((document) => this.storage.verifyDocument(document.privateAssetId))); required.forEach((document) => { document.uploadVerified = true; }); const review = order.documentReviewStatus; const timedOut = Boolean(order.documentCheckoutReleaseAt && new Date(order.documentCheckoutReleaseAt) <= new Date()); if (review === 'REUPLOAD_REQUIRED') throw new ApiException({ code: 'PASSPORT_VERIFICATION_REQUIRED', message: 'Upload a clearer passport before payment' }); if (!['VERIFIED', 'MANUAL_REVIEW', 'MANUALLY_APPROVED', 'SKIPPED', 'OCR_BACKGROUND'].includes(review ?? '') && !(review === 'OCR_PENDING' && timedOut)) throw new ApiException({ code: 'PASSPORT_VERIFICATION_REQUIRED', message: 'Passport verification is still processing' }); if (review === 'OCR_PENDING' && timedOut) order.documentReviewStatus = 'OCR_BACKGROUND'; } if (order.status !== OrderStatus.PAYMENT_PENDING) this.transition(order, OrderStatus.PAYMENT_PENDING); order.payment = { provider, reference: initiation.reference, status: PaymentStatus.PENDING, ...(initiation.correlationId ? { correlationId: initiation.correlationId } : {}), ...(initiation.expiresAt ? { expiresAt: initiation.expiresAt } : {}), returnUrl: initiation.returnUrl, ...(initiation.redirectUrl ? { redirectUrl: initiation.redirectUrl } : {}) }; await this.persistence.save(order); return this.redact(order); }
  async confirmPayment(id: string, reference: string, transactionId?: string) {
    if (this.prisma.enabled) return this.confirmPaymentPersisted(id, reference, transactionId);
    return this.runExclusive(id, () => this.confirmPaymentUnlocked(id, reference, transactionId));
  }

  private async confirmPaymentPersisted(id: string, reference: string, transactionId?: string) {
    await this.persistence.confirmPaymentAtomically(id, reference, transactionId);
    await this.refreshOne(id, true);
    const order = this.get(id);
    if (order.payment?.reference !== reference) throw new BadRequestException('Payment reference mismatch');
    // Another replica may already have handed this order to provisioning. The
    // canonical database state determines the response and prevents duplicate
    // provisioning commands.
    if (order.status === OrderStatus.PAYMENT_CONFIRMED) {
      const approved = structuredClone(order) as DemoOrder;
      this.markAutoApproved(approved);
      try {
        await this.persistence.save(approved);
        this.orders.set(id, approved);
      } catch (error) {
        await this.refreshOne(id, true);
        const current = this.get(id);
        if (![OrderStatus.PROVISIONING, OrderStatus.QR_READY, OrderStatus.COMPLETED].includes(current.status)) throw error;
      }
    }
    const current = this.get(id);
    if (current.status === OrderStatus.PROVISIONING) await this.enqueueProvisioning(current, `provision-${current.id}`);
    return this.redact(current);
  }

  /**
   * Guards payment confirmation per order id. Browser verification, the
   * callback path and the background reconcile can all reach confirmation for
   * the same order simultaneously; without this, two callers could read
   * PENDING before either persists COMPLETED and both auto-approve/provision.
   * This is a single-instance safeguard — multi-instance deployments need an
   * atomic database transition (see plan follow-up).
   */
  private async confirmPaymentUnlocked(id: string, reference: string, transactionId?: string) {
    const order = this.get(id);
    if (order.payment?.reference !== reference) throw new BadRequestException('Payment reference mismatch');
    if (order.payment.status === PaymentStatus.COMPLETED) return this.redact(order);
    // Persist the paid/provisioning state before attempting best-effort queue
    // delivery.  In particular, a Redis outage must never make a successful
    // gateway confirmation disappear from durable storage.
    const confirmed = structuredClone(order) as DemoOrder;
    confirmed.payment!.status = PaymentStatus.COMPLETED;
    if (transactionId) confirmed.payment!.providerTransactionId = transactionId;
    this.transition(confirmed, OrderStatus.PAYMENT_CONFIRMED);
    this.markAutoApproved(confirmed);
    await this.persistence.save(confirmed);
    this.orders.set(id, confirmed);
    await this.enqueueProvisioning(confirmed, `provision-${confirmed.id}`);
    return this.redact(confirmed);
  }
  async resolvePaymentFailure(id: string, ownerId: string | null, reason: string, paymentStatus: PaymentStatus = PaymentStatus.FAILED) {
    const order = this.get(id, ownerId ?? undefined);
    if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.REFUNDED) return this.redact(order);
    if (![OrderStatus.PAYMENT_PENDING, OrderStatus.PAYMENT_FAILED].includes(order.status)) return this.redact(order);
    if (order.payment && order.payment.status !== PaymentStatus.COMPLETED) order.payment.status = paymentStatus;
    if (order.status !== OrderStatus.PAYMENT_FAILED) this.transition(order, OrderStatus.PAYMENT_FAILED, reason);
    await this.persistence.save(order);
    return this.redact(order);
  }

  /** Serializes async tasks that share a key (e.g. per-order confirmation). */
  private runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = (this.confirmLocks.get(key) ?? Promise.resolve()) as Promise<unknown>;
    const run = previous.catch(() => undefined).then(task);
    this.confirmLocks.set(key, run);
    void run.finally(() => {
      if (this.confirmLocks.get(key) === run) this.confirmLocks.delete(key);
    });
    return run;
  }
  async cancel(id: string, ownerId: string | null, reason: string) {
    const order = this.get(id, ownerId ?? undefined);
    if (![OrderStatus.DRAFT, OrderStatus.PAYMENT_PENDING, OrderStatus.PAYMENT_FAILED].includes(order.status)) throw new BadRequestException(`Order in ${order.status} cannot be cancelled`);
    if (order.payment && order.payment.status === PaymentStatus.PENDING) order.payment.status = PaymentStatus.CANCELLED;
    this.transition(order, OrderStatus.CANCELLED, reason);
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
      inventory: prior.customerEsim?.inventory ? { id: prior.customerEsim.inventory.id, eid: prior.customerEsim.inventory.eid, iccid: prior.customerEsim.inventory.iccid } : null,
    };
  }
  async resolveSubscriber(mobile: string) {
    const target = normalizeMsisdn(mobile);
    if (!target) return null;
    if (!this.prisma.enabled) {
      const prior = [...this.orders.values()].find((order) => order.status === OrderStatus.COMPLETED && order.traveler && normalizeMsisdn(order.traveler.mobile) === target);
      if (!prior?.traveler) return null;
      return { planCountryCode: prior.plan.countryCode, traveler: { firstName: prior.traveler.firstName, surname: prior.traveler.surname, email: prior.traveler.email, mobile: prior.traveler.mobile, city: prior.traveler.city, countryOfResidence: prior.traveler.countryOfResidence }, inventory: null };
    }
    return this.priorCompletedOrderFor(mobile);
  }
  async requestReupload(id: string, reason: string) { const order = this.get(id); if (!reason.trim()) throw new BadRequestException('Re-upload reason is required'); order.documentReviewStatus = 'REUPLOAD_REQUIRED'; order.documents.forEach((d) => { d.status = DocumentStatus.REUPLOAD_REQUIRED; }); order.timeline.push({ from: order.status, to: order.status, at: new Date().toISOString(), reason: `Documents requested again: ${reason.trim()}` }); await this.persistence.save(order); return order; }
  async reviewDocument(id: string, documentId: string, actorId: string, decision: 'APPROVE' | 'REUPLOAD', reason?: string) { const order = this.get(id); const document = order.documents.find((item) => item.id === documentId); if (!document) throw new NotFoundException('Document not found'); if (decision === 'APPROVE') { document.status = DocumentStatus.APPROVED; if (order.documents.filter((item) => [DocumentType.PASSPORT, DocumentType.TICKET].includes(item.type)).every((item) => item.id === documentId || item.status === DocumentStatus.APPROVED)) order.documentReviewStatus = 'MANUALLY_APPROVED'; order.timeline.push({ from: order.status, to: order.status, at: new Date().toISOString(), reason: `${document.type} approved by ${actorId}` }); } else { if (!reason?.trim()) throw new BadRequestException('Re-upload reason is required'); document.status = DocumentStatus.REUPLOAD_REQUIRED; order.documentReviewStatus = 'REUPLOAD_REQUIRED'; order.timeline.push({ from: order.status, to: order.status, at: new Date().toISOString(), reason: `${document.type}: ${reason.trim()} (requested by ${actorId})` }); } await this.persistence.save(order); await this.persistence.recordReview(order.id, documentId, actorId, decision, reason); return this.redact(order); }
  async approve(id: string, actorId: string) { const order = this.get(id); const required = order.documents.filter((document) => [DocumentType.PASSPORT, DocumentType.TICKET].includes(document.type)); if (required.length !== 2 || required.some((document) => document.status !== DocumentStatus.APPROVED)) throw new BadRequestException('Passport and ticket must be individually approved first'); const profile = await this.inventory.reserve(order.id); this.transition(order, OrderStatus.APPROVED, `Approved by ${actorId}; inventory ${profile.iccid} reserved`); this.transition(order, OrderStatus.PROVISIONING); await this.persistence.save(order); let queued = true; try { await this.queues.add(QUEUES.provisioning, 'provision-order', { orderId: order.id }, `provision-${order.id}`); } catch (error) { this.logger.error(`Provisioning queue unavailable for ${order.id}: ${error instanceof Error ? error.message : 'unknown'}`); if (process.env.NODE_ENV === 'production') throw error; queued = false; } if ((!queued || !this.queues.enabled) && process.env.NODE_ENV !== 'production') await this.processLocally(order.id); return this.redact(order); }
  async approveToProvisioning(orderId: string, note: string) { const order = this.get(orderId); if (order.status !== OrderStatus.APPROVED) throw new BadRequestException(`Order in ${order.status} cannot be auto-approved`); if (order.purchaseType === 'TOPUP') { const target = await this.provisioningTarget(order); this.transition(order, OrderStatus.PROVISIONING, target?.inventory ? `${note}; top-up on existing eSIM ${target.inventory.iccid}` : note); } else { const profile = await this.inventory.reserve(order.id); this.transition(order, OrderStatus.PROVISIONING, `${note}; inventory ${profile.iccid} reserved`); } await this.persistence.save(order); let queued = true; try { await this.queues.add(QUEUES.provisioning, 'provision-order', { orderId: order.id }, `provision-${order.id}`); } catch (error) { this.logger.error(`Provisioning queue unavailable for ${order.id}: ${error instanceof Error ? error.message : 'unknown'}`); if (process.env.NODE_ENV === 'production') throw error; queued = false; } if ((!queued || !this.queues.enabled) && process.env.NODE_ENV !== 'production') await this.processLocally(order.id); return this.redact(order); }
  async processProvisioning(id: string, attempt: number, finalAttempt: boolean) { const order = this.get(id); if (order.status !== OrderStatus.PROVISIONING || order.qrPayload) { this.logger.debug(`Order ${id} is not eligible for provisioning; skipping`); return; } const target = await this.provisioningTarget(order); const reuseExisting = Boolean(target); let profile: { id: string; eid: string; iccid: string } | undefined; let request: { orderId: string; planId: string; eid: string; traveler: { firstName: string; surname: string; email: string; mobile: string; city: string; countryOfResidence: string } } | undefined; try { profile = target?.inventory ?? await this.inventory.profileForOrder(order.id); const identity = order.purchaseType === 'TOPUP' ? target?.traveler ?? { email: (order.pricingSnapshot as { topUpEmail?: string }).topUpEmail ?? '', mobile: order.topUpMobile ?? '', firstName: 'Existing', surname: 'Customer', city: '', countryOfResidence: 'NP' } : { firstName: order.traveler!.firstName, surname: order.traveler!.surname, email: order.traveler!.email, mobile: order.traveler!.mobile, city: order.traveler!.city, countryOfResidence: order.traveler!.countryOfResidence }; request = { orderId: order.id, planId: order.plan.id, eid: profile.eid, traveler: identity }; const result = await this.connectivity.provision(request); await this.persistence.provisioningAttempt(order.id, attempt, request, { response: result }); if (!result.providerSubscriptionId) throw new Error('Connectivity provider did not return a subscription id'); order.providerSubscriptionId = result.providerSubscriptionId; order.providerStatus = 'PRELOADED'; if (result.status === 'DELAYED' || !result.qrPayload) { await this.persistence.save(order); this.logger.log(`Transatel accepted order ${order.id} as ${result.providerSubscriptionId}; waiting for activation details`); return this.redact(order); } order.qrPayload = result.qrPayload; order.qrDeliveredAt = new Date().toISOString(); const expiresAt = new Date(Date.now() + order.plan.validityDays * 86_400_000).toISOString(); const providerInfo = { provider: this.connectivity.descriptor().provider, providerSubscriptionId: result.providerSubscriptionId, expiresAt }; if (reuseExisting) await this.inventory.assignTopup(order.id, await this.inventory.customerIdForOrder(order.id), profile.iccid, result.qrPayload, providerInfo); else await this.inventory.assign(order.id, await this.inventory.customerIdForOrder(order.id), result.qrPayload, providerInfo); const assigned = await this.inventory.inventoryForOrder(order.id); if (assigned) order.assignment = { inventoryId: assigned.id, iccid: assigned.iccid, ...(assigned.msisdn ? { msisdn: assigned.msisdn } : {}), providerSubscriptionId: result.providerSubscriptionId, verificationStatus: 'PENDING' }; this.transition(order, OrderStatus.QR_READY, `Provisioned on attempt ${attempt}; activation QR delivered`); await this.persistence.save(order); await this.safeNotify(order,'QR_READY'); return this.redact(order); } catch (error) {
    const errorCode = error instanceof ApiException
      ? `${error.code} (HTTP ${error.getStatus()})${error.internalDetail !== undefined ? `: ${typeof error.internalDetail === 'string' ? error.internalDetail : JSON.stringify(error.internalDetail)}` : ''}`.slice(0, 2000)
      : (error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 2000) : 'UNKNOWN');
    if (request) await this.persistence.provisioningAttempt(order.id, attempt, request, { errorCode });
    const ambiguousOutcome = error instanceof ApiException && String(error.internalDetail ?? '').includes('refusing to submit a duplicate command');
    if (ambiguousOutcome) {
      this.logger.warn(`Order ${order.id} has an ambiguous Transatel submission; leaving it in PROVISIONING for reconciliation`);
      throw error;
    }
    const permanentRejection = error instanceof ApiException && String(error.internalDetail ?? '').startsWith('PERMANENT_');
    if (finalAttempt || permanentRejection) {
      this.metrics?.recordFailure('provisioning', 'exhausted');
      if (permanentRejection) order.providerStatus = 'REJECTED';
      order.provisioningFailure = this.classifyProvisioningFailure(error);
      this.transition(order, OrderStatus.PROVISIONING_FAILED, permanentRejection ? 'Transatel permanently rejected the provisioning request' : 'Provisioning retries exhausted');
      // release() itself refuses profiles with a provider subscription, so it
      // is safe for every terminal failure, not only explicit rejections.
      await this.inventory.release(order.id);
      await this.persistence.save(order);
      await this.alertProvisioningFailure(order);
    }
    throw error;
  } }
  /**
   * Finishes the local side of a provisioning operation that already succeeded
   * at the provider. This path deliberately never calls provision(), making it
   * safe for automatic and manual reconciliation after an uncertain DB commit.
   */
  async recoverProvisioningQrReady(id: string, input: { qrPayload: string; providerSubscriptionId: string; iccid?: string; reason?: string }) {
    await this.refreshOne(id, true);
    const order = this.get(id);
    if ([OrderStatus.QR_READY, OrderStatus.COMPLETED].includes(order.status)) return this.redact(order);
    if (order.status !== OrderStatus.PROVISIONING) throw new BadRequestException(`Order in ${order.status} cannot be recovered to QR ready`);

    const target = await this.provisioningTarget(order);
    const customerId = await this.inventory.customerIdForOrder(order.id);
    const expiresAt = new Date(Date.now() + order.plan.validityDays * 86_400_000).toISOString();
    const providerInfo = { provider: this.connectivity.descriptor().provider, providerSubscriptionId: input.providerSubscriptionId, expiresAt };
    if (target) {
      await this.inventory.assignTopup(order.id, customerId, input.iccid ?? target.inventory.iccid, input.qrPayload, providerInfo);
    } else {
      await this.inventory.assign(order.id, customerId, input.qrPayload, providerInfo);
    }

    order.qrPayload = input.qrPayload;
    order.qrDeliveredAt = new Date().toISOString();
    order.providerSubscriptionId = input.providerSubscriptionId;
    order.providerStatus = 'PRELOADED';
    const assigned = await this.inventory.inventoryForOrder(order.id);
    if (assigned) order.assignment = { inventoryId: assigned.id, iccid: assigned.iccid, ...(assigned.msisdn ? { msisdn: assigned.msisdn } : {}), providerSubscriptionId: input.providerSubscriptionId, verificationStatus: 'PENDING' };
    this.transition(order, OrderStatus.QR_READY, input.reason ?? 'Recovered provider QR after local persistence failure');
    await this.persistence.save(order);
    await this.safeNotify(order, 'QR_READY');
    return this.redact(order);
  }
  async markProvisioningManualReview(id: string, reason: string) {
    const order = this.get(id);
    if (order.status !== OrderStatus.PROVISIONING) return;
    this.transition(order, OrderStatus.PROVISIONING_FAILED, reason);
    order.provisioningFailure = this.classifyProvisioningFailure(new ApiException({ code: ApiErrorCode.PROVISIONING_FAILED, message: reason, status: 502, details: reason }));
    await this.persistence.save(order);
    await this.alertProvisioningFailure(order);
  }
  async applyProviderEvent(event: ProviderWebhookEvent) {
    if (!event.orderId) throw new BadRequestException('Provider event did not include an order id');
    const order = this.get(event.orderId);
    if (!order) throw new NotFoundException(`No active order found for ${event.orderId}`);
    const provider = this.connectivity.descriptor().provider;
    if (this.prisma.enabled && event.orderId) {
      const state = event.status === 'ACTIVATED' ? 'ACTIVATED' : event.status === 'PRELOADED' ? 'WAITING_FOR_QR' : undefined;
      if (state) await this.prisma.provisioningOperation.updateMany({ where: { orderId: event.orderId }, data: { state, ...(event.subscriptionId ? { providerSubscriptionId: event.subscriptionId } : {}), ...(state === 'ACTIVATED' ? { completedAt: new Date(), nextReconcileAt: null } : { nextReconcileAt: new Date(Date.now() + 60_000) }), version: { increment: 1 } } });
    }
    const lifecycle = {
      provider,
      ...(event.iccid ? { iccid: event.iccid } : {}),
      ...(event.status ? { status: event.status } : {}),
      ...(event.subscriptionId ? { subscriptionId: event.subscriptionId } : {}),
      ...(event.activatedAt ? { activatedAt: event.activatedAt } : {}),
      ...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
    };

    if (event.status === 'ACTIVATED' && (order.status === OrderStatus.PROVISIONING || order.status === OrderStatus.QR_READY)) {
      const qrPayload = event.qrPayload ?? order.qrPayload;
      if (!qrPayload) throw new BadRequestException('Activation event is missing activation details');
      await this.completeProviderActivation(order, { qrPayload, ...(event.subscriptionId ? { subscriptionId: event.subscriptionId } : {}), ...(event.iccid ? { iccid: event.iccid } : {}), ...(event.activatedAt ? { activatedAt: event.activatedAt } : {}), label: event.eventType });
      return { accepted: true, eventType: event.eventType };
    }

    await this.inventory.applyLifecycle(order.id, lifecycle);
    const assigned = await this.inventory.inventoryForOrder(order.id);
    if (assigned) order.assignment = { inventoryId: assigned.id, iccid: assigned.iccid, ...(assigned.msisdn ? { msisdn: assigned.msisdn } : {}), ...(event.subscriptionId ? { providerSubscriptionId: event.subscriptionId } : {}), verificationStatus: event.status === 'ACTIVATED' ? 'VERIFIED' : 'PENDING', ...(event.status === 'ACTIVATED' ? { verifiedAt: new Date().toISOString() } : {}), providerLastSeenAt: new Date().toISOString() };
    if (event.subscriptionId) order.providerSubscriptionId = event.subscriptionId;
    if (event.status) order.providerStatus = event.status;
    if (this.prisma.enabled && (event.status === 'SUSPENDED' || event.status === 'TERMINATED')) {
      await this.prisma.transatelLifecycleOperation.updateMany({
        where: { orderId: order.id, action: event.status === 'SUSPENDED' ? 'SUSPEND' : 'TERMINATE', state: 'ACCEPTED' },
        data: { state: 'CONFIRMED' },
      });
    }
    await this.persistence.save(order);
    return { accepted: true, eventType: event.eventType };
  }
  async retry(id: string) {
    const order = this.get(id);
    if (order.status !== OrderStatus.PROVISIONING_FAILED) throw new BadRequestException('Order is not retryable');
    if (this.prisma.enabled) {
      const operation = await this.prisma.provisioningOperation.findUnique({ where: { orderId: id }, select: { state: true, providerOrderId: true, providerSubscriptionId: true } });
      if (operation && (operation.providerOrderId || operation.providerSubscriptionId || !['CREATED', 'REJECTED'].includes(operation.state))) {
        throw new BadRequestException('The provider may already have accepted this order. Reconcile its live status from Provisioning recovery instead of retrying.');
      }
      if (operation?.state === 'REJECTED') {
        throw new BadRequestException('Transatel rejected this request. Correct the plan, inventory, or provider configuration before creating a replacement order; this order cannot be safely resubmitted.');
      }
    }
    return this.approveProvisioning(order);
  }
  /**
   * Re-delivers the activation QR email for an order whose customer never
   * received the original notification. When an owner id is provided the
   * caller can only resend for their own order. Reuses the same delivery
   * pipeline as the original QR_READY notification (password-protected PDF).
   */
  async resendQr(id: string, ownerId?: string) { const order = this.get(id, ownerId ?? undefined); if (![OrderStatus.QR_READY, OrderStatus.COMPLETED].includes(order.status)) throw new BadRequestException('QR can only be resent for a ready or completed order'); if (!order.qrPayload) throw new BadRequestException('Order has no activation QR to resend'); await this.safeNotify(order, 'QR_READY'); this.logger.log(`QR re-sent for order ${order.orderNumber} (${order.id})`); return this.redact(order); }
  /**
   * Builds the same password-protected QR PDF emailed at QR_READY so an
   * authenticated owner can download it in-account when they did not receive
   * the email. The MSISDN is the PDF password, matching the email flow.
   */
  async activationQr(id: string, ownerId?: string) { const order = this.get(id, ownerId ?? undefined); if (![OrderStatus.QR_READY, OrderStatus.COMPLETED].includes(order.status)) throw new BadRequestException('QR is only available for a ready or completed order'); if (!order.qrPayload) throw new BadRequestException('Order has no activation QR'); const inventory = await this.inventory.inventoryForOrder(order.id); const msisdn = inventory?.msisdn ?? order.traveler?.mobile ?? order.topUpMobile; if (!msisdn) throw new BadRequestException('eSIM number is required to open the QR document'); const bytes = await this.qrPdf.build({ qrPayload: order.qrPayload, orderNumber: order.orderNumber, password: msisdn }); return { filename: `${order.orderNumber}-esim.pdf`, contentType: 'application/pdf', bytes }; }
  /**
   * Reconciliation sweep for QR_READY orders whose activation window has
   * elapsed. Instead of failing immediately it re-queries the provider details
   * endpoint a bounded number of times, so a dropped/lost ACTIVATED webhook is
   * recovered when the provider now reports activation details; otherwise the
   * order is failed and released after ACTIVATION_REFETCH_ATTEMPTS.
   */
  async reconcileStaleActivationOrders() {
    const now = Date.now();
    const recovered: string[] = [];
    const failed: string[] = [];
    const capabilities = this.connectivity.descriptor().capabilities;
    for (const order of this.orders.values()) {
      if (order.status !== OrderStatus.QR_READY || !order.qrDeliveredAt || !order.plan.validityDays) continue;
      const expiry = new Date(new Date(order.qrDeliveredAt).getTime() + order.plan.validityDays * 86_400_000).getTime();
      if (now <= expiry) continue;
      const attempt = await this.nextActivationRefetchAttempt(order);
      if (attempt <= this.maxActivationRefetches && capabilities.esimDetails) {
        try {
          const details = await this.connectivity.getEsimDetails(await this.providerRefFor(order));
          const qrPayload = (details as { qrPayload?: string }).qrPayload;
          if (qrPayload) {
            await this.completeProviderActivation(order, { qrPayload, ...(order.providerSubscriptionId ? { subscriptionId: order.providerSubscriptionId } : {}), label: 'activation re-fetch' });
            await this.clearActivationRefetchAttempts(order);
            recovered.push(order.id);
            this.logger.log(`Order ${order.orderNumber} (${order.id}) recovered after activation re-fetch attempt ${attempt}`);
          } else {
            this.logger.debug(`Order ${order.orderNumber} (${order.id}) not active at provider yet (re-fetch attempt ${attempt}/${this.maxActivationRefetches})`);
          }
          continue;
        } catch (error) {
          this.metrics?.recordFailure('reconciliation', 'activation-refetch');
          this.logger.warn(`Activation re-fetch failed for order ${order.id} (attempt ${attempt}/${this.maxActivationRefetches}): ${error instanceof Error ? error.message : 'unknown'}`);
          continue;
        }
      }
      this.transition(order, OrderStatus.PROVISIONING_FAILED, 'Activation window expired without an ACTIVATED event');
      await this.persistence.save(order);
      await this.inventory.release(order.id);
      await this.alertProvisioningFailure(order);
      failed.push(order.id);
      await this.clearActivationRefetchAttempts(order);
      this.logger.warn(`Order ${order.orderNumber} (${order.id}) QR_READY activation window expired without ACTIVATED after ${attempt - 1} re-fetch attempt(s); marked PROVISIONING_FAILED`);
    }
    return { recovered, failed };
  }
  /**
   * Periodic sweep that re-drives orders left in APPROVED/PROVISIONING without
   * a QR payload. Jobs are idempotent (processProvisioning skips orders that
   * already have a QR), and the shared job id keeps BullMQ from piling up
   * duplicate work. Throttled per order so a persistently failing job is
   * re-attempted periodically instead of hammering the queue every cycle.
   */
  async recoverStuckProvisioningOrders() {
    const now = Date.now();
    const recovered: string[] = [];
    const failed: string[] = [];
    const minAgeMs = Number(process.env.PROVISIONING_RECOVERY_MINUTES ?? 2) * 60_000;
    const minGapMs = Number(process.env.PROVISIONING_RECOVERY_RETRY_MINUTES ?? 10) * 60_000;
    for (const order of this.orders.values()) {
      if (![OrderStatus.APPROVED, OrderStatus.PROVISIONING].includes(order.status)) continue;
      if (order.qrPayload) continue;
      const entered = [...order.timeline].reverse().find((event) => event.to === order.status)?.at;
      const enteredAt = entered ? new Date(entered).getTime() : order.createdAt ? new Date(order.createdAt).getTime() : 0;
      if (!enteredAt || now - enteredAt < minAgeMs) continue;
      const lastRecovery = order.lastProvisioningRecoveryAt ? new Date(order.lastProvisioningRecoveryAt).getTime() : 0;
      if (now - lastRecovery < minGapMs) continue;
      try {
        await this.queues.add(QUEUES.provisioning, 'provision-order', { orderId: order.id }, `provision-${order.id}`);
        await this.markProvisioningRecovery(order, now);
        recovered.push(order.id);
        this.logger.log(`Recovery sweep re-queued provisioning for order ${order.orderNumber} (${order.id})`);
      } catch (error) {
        await this.markProvisioningRecovery(order, now);
        failed.push(order.id);
        this.metrics?.recordFailure('reconciliation', 'provisioning-recovery');
        this.logger.warn(`Recovery sweep could not re-queue provisioning for order ${order.id}: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    }
    if (recovered.length) this.logger.log(`Recovery sweep re-queued ${recovered.length} stuck order(s)`);
    return { recovered, failed };
  }
  private async nextActivationRefetchAttempt(order: DemoOrder) {
    if (!this.prisma.enabled) { order.activationRefetchAttempts = (order.activationRefetchAttempts ?? 0) + 1; return order.activationRefetchAttempts; }
    const updated = await this.prisma.order.update({ where: { id: order.id }, data: { activationRefetchAttempts: { increment: 1 } }, select: { activationRefetchAttempts: true } });
    order.activationRefetchAttempts = updated.activationRefetchAttempts;
    return updated.activationRefetchAttempts;
  }
  private async clearActivationRefetchAttempts(order: DemoOrder) {
    order.activationRefetchAttempts = 0;
    if (this.prisma.enabled) await this.prisma.order.update({ where: { id: order.id }, data: { activationRefetchAttempts: 0 } });
  }
  private async markProvisioningRecovery(order: DemoOrder, at: number) {
    const value = new Date(at).toISOString(); order.lastProvisioningRecoveryAt = value;
    if (this.prisma.enabled) await this.prisma.order.update({ where: { id: order.id }, data: { lastProvisioningRecoveryAt: new Date(at) } });
  }
  /**
   * Resolves the reference handed to the provider's details endpoint: the ICCID
   * from the reserved inventory when available, else the provider subscription
   * id, else the order id (which Transatel can resolve back to an inventory).
   */
  private async providerRefFor(order: DemoOrder): Promise<string> {
    if (this.prisma.enabled) {
      try {
        const inventory = await this.inventory.inventoryForOrder(order.id);
        if (inventory?.iccid) return inventory.iccid;
      } catch { /* fall through to the subscription/reference id */ }
    }
    return order.providerSubscriptionId ?? order.id;
  }
  /**
   * Completes an order once the provider has delivered its activation details
   * and QR payload. Shared by the ACTIVATED webhook handler and the QR_READY
   * recovery sweep so a recovered order follows the exact webhook path.
   */
  private async completeProviderActivation(order: DemoOrder, input: { qrPayload: string; subscriptionId?: string; iccid?: string; activatedAt?: string; label?: string }) {
    const wasReady = order.status === OrderStatus.QR_READY;
    order.qrPayload = input.qrPayload;
    if (input.subscriptionId) order.providerSubscriptionId = input.subscriptionId;
    order.providerStatus = 'ACTIVATED';
    order.activatedAt = input.activatedAt ?? new Date().toISOString();
    const provider = this.connectivity.descriptor().provider;
    const lifecycle = { provider, status: 'ACTIVATED' as const, ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}), ...(input.iccid ? { iccid: input.iccid } : {}), ...(order.activatedAt ? { activatedAt: order.activatedAt } : {}) };
    await this.activateOrder(order, input.qrPayload, provider, input.subscriptionId);
    if (provider === 'TRANSATEL' && input.subscriptionId) {
      const target = await this.inventory.inventoryForOrder(order.id);
      if (!target?.iccid) throw new Error('Assigned eSIM could not be resolved for provider verification');
      if (input.iccid && input.iccid !== target.iccid) await this.inventory.applyLifecycle(order.id, lifecycle);
      const usage = await this.connectivity.getUsage(target.iccid);
      if (!usage.subscriptions?.some((item) => item.providerSubscriptionId === input.subscriptionId)) throw new Error('Provider subscription is not present on the assigned eSIM');
    }
    await this.inventory.applyLifecycle(order.id, lifecycle);
    const assigned = await this.inventory.inventoryForOrder(order.id);
    if (assigned) order.assignment = { inventoryId: assigned.id, iccid: assigned.iccid, ...(assigned.msisdn ? { msisdn: assigned.msisdn } : {}), ...(input.subscriptionId ? { providerSubscriptionId: input.subscriptionId } : {}), verificationStatus: 'VERIFIED', verifiedAt: new Date().toISOString(), providerLastSeenAt: new Date().toISOString() };
    this.transition(order, OrderStatus.COMPLETED, `Provider ${input.label ? `${input.label} ` : ''}delivered activation`);
    await this.persistence.save(order);
    if (!wasReady) await this.safeNotify(order, 'QR_READY');
  }
  private async activateOrder(order: DemoOrder, qrPayload: string, provider: string, subscriptionId?: string) {
    const customerId = await this.inventory.customerIdForOrder(order.id);
    const providerInfo = { provider, ...(subscriptionId ? { providerSubscriptionId: subscriptionId } : {}) };
    const target = await this.provisioningTarget(order);
    if (target) { await this.inventory.assignTopup(order.id, customerId, target.inventory.iccid, qrPayload, providerInfo); return; }
    await this.inventory.assign(order.id, customerId, qrPayload, providerInfo);
  }
  private async provisioningTarget(order: DemoOrder) {
    const targetEsimId = (order.pricingSnapshot as { targetEsimId?: string }).targetEsimId;
    if (!targetEsimId || !this.prisma.enabled) return null;
    const row = await this.prisma.esimInventory.findUnique({ where: { id: targetEsimId }, include: { customerEsims: { take: 1, orderBy: { assignedAt: 'desc' }, include: { order: { include: { traveler: true } } } } } });
    if (!row) throw new NotFoundException('Target eSIM is no longer available');
    const traveler = row.customerEsims[0]?.order.traveler;
    return { inventory: { id: row.id, eid: row.eid, iccid: row.iccid }, ...(traveler ? { traveler: { firstName: traveler.firstName, surname: traveler.surname, email: traveler.email, mobile: traveler.mobile, city: traveler.city, countryOfResidence: traveler.countryOfResidence } } : {}) };
  }
  private markAutoApproved(order: DemoOrder) { this.transition(order, OrderStatus.APPROVED, 'Auto-approved after payment'); this.transition(order, OrderStatus.PROVISIONING); }
  private async enqueueProvisioning(order: DemoOrder, jobId: string) {
    try {
      await this.queues.add(QUEUES.provisioning, 'provision-order', { orderId: order.id }, jobId);
    } catch (error) {
      // The durable order state is recovered by boot/reconciliation. Never
      // propagate this after a payment has been confirmed.
      this.logger.error(`Provisioning queue unavailable for ${order.id}: ${error instanceof Error ? error.message : 'unknown'}`);
      return;
    }
    if (!this.queues.enabled) await this.processLocally(order.id);
  }
  private async approveProvisioning(order: DemoOrder) { this.transition(order, OrderStatus.PROVISIONING, 'Manual retry'); await this.persistence.save(order); await this.queues.add(QUEUES.provisioning, 'provision-order', { orderId: order.id }, `retry-${order.id}-${Date.now()}`); if (!this.queues.enabled) return this.processLocally(order.id); return this.redact(order); }
  private async processLocally(orderId:string){let failure:unknown;for(let attempt=1;attempt<=3;attempt++){try{return await this.processProvisioning(orderId,attempt,attempt===3)}catch(error){failure=error}}throw failure}
  private transition(order: DemoOrder, to: OrderStatus, reason?: string) { assertTransition(order.status, to); const from = order.status; order.status = to; order.timeline.push({ from, to, at: new Date().toISOString(), ...(reason ? { reason } : {}) }); }
  private notifyEmailFor(order: DemoOrder) { return order.traveler?.email ?? (order.pricingSnapshot as { topUpEmail?: string }).topUpEmail; }
  private classifyProvisioningFailure(error: unknown) {
    if (error instanceof ConflictException && /inventory|available/i.test(error.message)) return provisioningFailure('INVENTORY_UNAVAILABLE');
    if (error instanceof ApiException) {
      switch (error.code) {
        case ApiErrorCode.INVENTORY_UNAVAILABLE: return provisioningFailure('INVENTORY_UNAVAILABLE');
        case ApiErrorCode.PLAN_NOT_AVAILABLE:
        case ApiErrorCode.PLAN_UNAVAILABLE:
        case ApiErrorCode.PRODUCT_UNAVAILABLE: return provisioningFailure('PLAN_UNAVAILABLE');
        case ApiErrorCode.CONNECTIVITY_UNAVAILABLE:
        case ApiErrorCode.PROVISIONING_FAILED: return provisioningFailure('PROVIDER_UNAVAILABLE');
        default: return provisioningFailure('UNKNOWN');
      }
    }
    return provisioningFailure('UNKNOWN');
  }
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
    const { ownerId: _ownerId, providerSubscriptionId: _providerSubscriptionId, providerStatus: _providerStatus, qrPayload: _qrPayload, assignment: rawAssignment, ...safe } = order;
    const documents = safe.documents.map(({ privateAssetId: _privateAssetId, ...document }) => document);
    const payment = safe.payment ? (({ correlationId: _correlationId, providerTransactionId: _providerTransactionId, ...rest }) => rest)(safe.payment) : undefined;
    const timeline = safe.timeline.map((event) => ({ ...event, ...(event.reason ? { reason: event.reason.replace(/\s+\(?(requested by|approved by|assigned by)\s+user_[A-Za-z0-9_]+\)?\.?$/i, '').trim() || undefined } : {}) }));
    const pricingSnapshot = { ...(safe.pricingSnapshot as Record<string, unknown>) };
    delete pricingSnapshot.topUpEmail;
    delete pricingSnapshot.topUpIdentity;
    const assignment = rawAssignment ? { verificationStatus: rawAssignment.verificationStatus, verifiedAt: rawAssignment.verifiedAt, providerLastSeenAt: rawAssignment.providerLastSeenAt } : undefined;
    const purchaseContext = safe.purchaseType === 'TOPUP' ? 'TOPUP' : typeof pricingSnapshot.targetEsimId === 'string' ? 'NEW_DESTINATION' : 'FIRST_PURCHASE';
    return { ...safe, purchaseContext, pricingSnapshot, documents, ...(payment ? { payment } : {}), ...(assignment ? { assignment } : {}), timeline } as unknown as DemoOrder;
  }
}
