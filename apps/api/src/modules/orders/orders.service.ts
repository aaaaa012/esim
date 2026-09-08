import type { RechargeRecoveryOutbox } from "./recharge-ownership.js";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  DocumentStatus,
  DocumentType,
  ApiErrorCode,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  provisioningFailure,
  type ProvisioningFailure,
  type TravelerInput,
} from "@visa-compass/shared";
import {
  CatalogService,
  type CatalogPlan,
} from "../catalog/catalog.controller.js";
import { assertTransition } from "./order-machine.js";
import { ConnectivityService } from "../integration/connectivity.service.js";
import type { ProviderWebhookEvent } from "../integration/connectivity-provider.js";
import { S3StorageService } from "../../infrastructure/s3-storage.service.js";
import { ApiException } from "../../common/api-error.js";
import { OrdersPersistenceService } from "./orders-persistence.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { QueueService } from "../../jobs/queue.service.js";
import { QUEUES } from "../../jobs/queues.js";
import {
  ocrJobOptions,
  orderPassportOcrJobId,
} from "../../jobs/ocr-recovery.config.js";
import { NotificationService } from "../notification/notification.service.js";
import { QrPdfService } from "../notification/qr-pdf.service.js";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { MetricsService } from "../../observability/metrics.service.js";
import { normalizeMsisdn, msisdnVariants } from "../../common/msisdn.util.js";
import type { PassportVerificationResult } from "./passport-verification.service.js";
import { ProductionResilienceService } from "../../jobs/production-resilience.service.js";

type Timeline = {
  from: OrderStatus | null;
  to: OrderStatus;
  at: string;
  reason?: string;
};
export type DemoOrder = {
  id: string;
  ownerId: string | null;
  refundStatus?: string | undefined;
  beneficiaryCustomerId?: string | undefined;
  purchasedByUserId?: string | undefined;
  targetInventoryId?: string | undefined;
  checkoutAttemptKey?: string | undefined;
  checkoutRequestHash?: string | undefined;
  orderNumber: string;
  status: OrderStatus;
  version: number;
  plan: CatalogPlan;
  totalAmountNpr: number;
  pricingSnapshot: object;
  compatibilityAcceptedAt: string;
  traveler?: TravelerInput;
  documents: {
    id: string;
    type: DocumentType;
    fileName: string;
    privateAssetId: string;
    status: DocumentStatus;
    uploadVerified?: boolean;
  }[];
  payment?: {
    provider: PaymentProvider;
    reference: string;
    status: PaymentStatus;
    correlationId?: string;
    expiresAt?: string;
    returnUrl?: string;
    redirectUrl?: string;
    providerTransactionId?: string;
    verificationAttempts?: number;
  };
  timeline: Timeline[];
  qrPayload?: string;
  createdAt: string;
  providerSubscriptionId?: string;
  providerStatus?: string;
  qrDeliveredAt?: string;
  activatedAt?: string;
  usage?: { usedMb: number; totalMb: number; lastCheckedAt?: string };
  activationRefetchAttempts?: number;
  lastProvisioningRecoveryAt?: string;
  purchaseType?: "INITIAL_PURCHASE" | "TOPUP";
  topUpMobile?: string;
  passportVerification?: PassportVerificationResult;
  documentReviewPolicy?: "AUTO_OCR" | "MANUAL_REVIEW" | "NO_REVIEW";
  documentReviewStatus?:
    | "NOT_STARTED"
    | "OCR_PENDING"
    | "OCR_BACKGROUND"
    | "VERIFIED"
    | "MANUAL_REVIEW"
    | "REUPLOAD_REQUIRED"
    | "MANUALLY_APPROVED"
    | "SKIPPED";
  documentReviewStartedAt?: string;
  documentCheckoutReleaseAt?: string;
  assignment?: {
    inventoryId: string;
    iccid: string;
    msisdn?: string;
    providerSubscriptionId?: string;
    verificationStatus?: string;
    verifiedAt?: string;
    providerLastSeenAt?: string;
  };
  partner?: { id: string; code: string; name: string };
  externalOrderId?: string;
  provisioningFailure?: ProvisioningFailure;
  operationalDisposition?:
    | "RETRY_AUTOMATIC"
    | "RECONCILE_PROVIDER"
    | "MANUAL_ACTION"
    | "REFUND_ELIGIBLE"
    | "TERMINAL_REJECTION";
};

@Injectable()
export class OrdersService implements OnModuleInit {
  private readonly orders = new Map<string, DemoOrder>();
  private readonly logger = new Logger(OrdersService.name);
  private readonly confirmLocks = new Map<string, Promise<unknown>>();
  private readonly maxActivationRefetches = (() => {
    const parsed = Number(process.env.ACTIVATION_REFETCH_ATTEMPTS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
  })();
  private readonly maxProvisioningProfileSwaps = (() => {
    const configured = Number(process.env.MAX_PROVISIONING_PROFILE_SWAPS ?? 2);
    return Number.isFinite(configured) ? Math.max(0, configured) : 2;
  })();
  constructor(
    private readonly connectivity: ConnectivityService,
    private readonly storage: S3StorageService,
    private readonly persistence: OrdersPersistenceService,
    private readonly inventory: InventoryService,
    private readonly queues: QueueService,
    private readonly notifications: NotificationService,
    private readonly catalog: CatalogService,
    private readonly prisma: PrismaService,
    private readonly qrPdf: QrPdfService,
    private readonly metrics?: MetricsService,
    private readonly resilience?: ProductionResilienceService,
  ) {}
  async refreshFromPersistence(orderId?: string) {
    for (const order of await this.persistence.load())
      if (!orderId || order.id === orderId) this.orders.set(order.id, order);
  }
  async refreshOne(orderId: string, force = false) {
    if (!force && this.orders.has(orderId)) return;
    for (const order of await this.persistence.load(orderId))
      if (order.id === orderId) this.orders.set(order.id, order);
  }
  async onModuleInit() {
    for (const order of await this.persistence.load(undefined, true))
      this.orders.set(order.id, order);
    this.logger.log(
      `Hydrated ${this.orders.size} active/recent persisted order(s) for recovery`,
    );
    for (const order of this.orders.values()) {
      if (
        ![OrderStatus.APPROVED, OrderStatus.PROVISIONING].includes(order.status)
      )
        continue;
      const recovery =
        order.status === OrderStatus.APPROVED
          ? this.approveToProvisioning(order.id, "Recovered accepted order")
          : this.queues.add(
              QUEUES.provisioning,
              "provision-order",
              { orderId: order.id },
              `provision-${order.id}`,
            );
      void recovery.catch((error) =>
        this.logger.error(
          `Could not recover order ${order.id} at boot: ${error instanceof Error ? error.message : "unknown"}`,
        ),
      );
    }
  }
  list(ownerId?: string) {
    return [...this.orders.values()]
      .filter((o) => !ownerId || o.ownerId === ownerId)
      .map((order) => (ownerId ? this.redact(order) : this.expand(order)));
  }
  audit() {
    return this.persistence.audit();
  }
  get(id: string, ownerId?: string) {
    const order = this.orders.get(id);
    if (!order || (ownerId && order.ownerId !== ownerId))
      throw new NotFoundException("Order not found");
    return order;
  }
  async view(id: string, ownerId?: string) {
    // OCR workers update persistent orders directly. Refresh before serving a
    // checkout view so a completed verification cannot remain hidden behind
    // this process's in-memory order cache.
    await this.refreshOne(id, true);
    return ownerId
      ? this.redact(this.get(id, ownerId))
      : this.expand(this.get(id));
  }
  async operationsView(id: string) {
    const order = this.expand(this.get(id));
    if (!this.prisma.enabled) return order;
    const identity = await this.prisma.order.findUnique({
      where: { id },
      select: {
        channel: true,
        partnerCustomer: {
          select: {
            id: true,
            externalCustomerId: true,
            partner: { select: { id: true, code: true, name: true } },
          },
        },
        purchasedBy: { select: { id: true, email: true } },
        targetInventoryId: true,
        notifications: {
          where: { template: "QR_READY" },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: { status: true, sentAt: true, createdAt: true },
        },
        customer: {
          select: {
            id: true,
            customerCode: true,
            email: true,
            phone: true,
            source: true,
            status: true,
            createdAt: true,
            user: {
              select: {
                id: true,
                email: true,
                status: true,
                accountType: true,
                createdAt: true,
              },
            },
          },
        },
      },
    });
    if (!identity) return order;
    return {
      ...order,
      channel: identity.channel,
      purchasedBy: identity.purchasedBy,
      targetInventoryId: identity.targetInventoryId,
      customer: {
        id: identity.customer.id,
        customerCode: identity.customer.customerCode,
        email: identity.customer.email,
        phone: identity.customer.phone,
        source: identity.customer.source,
        status: identity.customer.status,
        createdAt: identity.customer.createdAt.toISOString(),
      },
      loginAccount: identity.customer.user
        ? {
            ...identity.customer.user,
            createdAt: identity.customer.user.createdAt.toISOString(),
          }
        : null,
      partnerCustomer: identity.partnerCustomer ?? null,
      qrDelivery: {
        lastSuccessfulAt:
          identity.notifications
            .find((item) => item.status === "SENT")
            ?.sentAt?.toISOString() ?? null,
        pending: identity.notifications.some((item) =>
          ["QUEUED", "SENDING"].includes(item.status),
        ),
      },
    };
  }
  async guestView(id: string) {
    await this.refreshOne(id, true);
    return this.redact(this.get(id));
  }
  async customerProfile(ownerId: string) {
    if (!this.prisma.enabled) {
      const orders = this.list(ownerId);
      return {
        ownerId,
        orders: orders.map((order) => ({
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          plan: order.plan,
          createdAt: order.createdAt,
          totalAmountNpr: order.totalAmountNpr,
          usage: order.usage,
        })),
      };
    }
    const customer = await this.prisma.customer.findFirst({
      where: { OR: this.customerMatch(ownerId) },
      include: {
        user: true,
        partnerIdentity: {
          include: {
            partner: { select: { id: true, code: true, name: true } },
          },
        },
      },
    });
    if (!customer) throw new NotFoundException("Customer not found");
    const orders = await this.prisma.order.findMany({
      where: { customerId: customer.id },
      include: {
        plan: { include: { country: true } },
        traveler: true,
        customerEsim: { include: { inventory: true, subscriptions: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    const latestTraveler = orders.find((order) => order.traveler)?.traveler;
    const profileUpdates = await this.prisma.auditLog.findMany({
      where: {
        entity: "Customer",
        entityId: customer.id,
        action: { in: ["EMAIL_CORRECTED"] },
      },
      include: { performedBy: { select: { email: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const displayEmail =
      customer.source === "PARTNER" &&
      customer.email.endsWith("@partner.visacompass.invalid") &&
      latestTraveler?.email
        ? latestTraveler.email
        : customer.email;
    return {
      ownerId: customer.user?.clerkId ?? customer.id,
      identity: {
        customer: {
          id: customer.id,
          customerCode: customer.customerCode,
          email: displayEmail,
          phone: customer.phone,
          source: customer.source,
          status: customer.status,
          createdAt: customer.createdAt.toISOString(),
        },
        loginAccount: customer.user
          ? {
              id: customer.user.id,
              email: customer.user.email,
              status: customer.user.status,
              accountType: customer.user.accountType,
              createdAt: customer.user.createdAt.toISOString(),
            }
          : null,
        partnerCustomer: customer.partnerIdentity
          ? {
              id: customer.partnerIdentity.id,
              externalCustomerId: customer.partnerIdentity.externalCustomerId,
              partner: customer.partnerIdentity.partner,
            }
          : null,
      },
      customerCode: customer.customerCode,
      email: displayEmail,
      name: latestTraveler?.firstName,
      profileUpdates: profileUpdates.map((update) => ({
        id: update.id,
        action: update.action,
        previousValue: update.previousValue,
        newValue: update.newValue,
        performedBy: update.performedBy?.email ?? "System",
        createdAt: update.createdAt.toISOString(),
      })),
      orders: orders.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        purchaseType: order.orderType,
        channel: order.channel,
        topUpMobile:
          order.orderType === "TOPUP"
            ? ((order.pricingSnapshot as { topUpMobile?: string } | null)
                ?.topUpMobile ??
              order.customerEsim?.inventory.msisdn ??
              null)
            : null,
        plan: {
          id: order.plan.id,
          name: order.plan.name,
          dataAllowance: order.plan.dataAllowance,
          validityDays: order.plan.validityDays,
          countryCode: order.plan.country.isoCode,
          countryName: order.plan.country.name,
        },
        createdAt: order.createdAt.toISOString(),
        totalAmountNpr: Number(order.totalAmount),
        traveler: order.traveler
          ? {
              firstName: order.traveler.firstName,
              surname: order.traveler.surname,
              mobile: order.traveler.mobile,
              email: order.traveler.email,
            }
          : undefined,
        ...(order.customerEsim
          ? {
              esim: {
                id: order.customerEsim.inventory.id,
                iccid: order.customerEsim.inventory.iccid,
                status: order.customerEsim.inventory.status,
                providerStatus:
                  order.providerStatus ??
                  order.customerEsim.inventory.providerStatus,
                ...(order.customerEsim.inventory.activatedAt
                  ? {
                      activatedAt:
                        order.customerEsim.inventory.activatedAt.toISOString(),
                    }
                  : {}),
                ...(order.customerEsim.inventory.expiresAt
                  ? {
                      expiresAt:
                        order.customerEsim.inventory.expiresAt.toISOString(),
                    }
                  : {}),
                usage: (() => {
                  const latest = [...order.customerEsim.subscriptions].sort(
                    (a, b) =>
                      (b.usageLastCheckedAt?.getTime() ?? 0) -
                      (a.usageLastCheckedAt?.getTime() ?? 0),
                  )[0];
                  if (!latest || latest.usageLastCheckedAt === null)
                    return undefined;
                  return {
                    usedMb: latest.usedMb,
                    totalMb: latest.totalMb,
                    remainingMb: Math.max(0, latest.totalMb - latest.usedMb),
                    lastCheckedAt: latest.usageLastCheckedAt.toISOString(),
                  };
                })(),
                purchaseType: order.orderType,
                providerSubscriptionId:
                  order.customerEsim.subscriptions[0]?.providerSubscriptionId ??
                  null,
              },
            }
          : {}),
      })),
    };
  }
  async create(
    ownerId: string | null,
    planId: string,
    compatibilityAccepted: boolean,
    meta?: {
      ipAddress?: string;
      userAgent?: string;
      mobile?: string;
      email?: string;
      targetEsimId?: string;
      recharge?: {
        orderId?: string;
        recovery?: RechargeRecoveryOutbox;
        customerId: string;
        inventoryId: string;
        purchasedByUserId?: string | undefined;
        checkoutAttemptKey?: string | undefined;
        checkoutRequestHash?: string;
      };
      termsAccepted?: boolean;
      privacyAccepted?: boolean;
    },
  ) {
    if (!compatibilityAccepted)
      throw new BadRequestException("Compatibility declaration is required");
    if (!meta?.termsAccepted || !meta?.privacyAccepted)
      throw new BadRequestException("Terms and privacy consent are required");
    const plan = await this.catalog.findActive(planId);
    if (!plan) throw new BadRequestException("Invalid or inactive plan");
    const id = meta?.recharge?.orderId ?? randomUUID();
    const now = new Date().toISOString();
    const target =
      meta?.targetEsimId && ownerId
        ? await this.targetEsim(ownerId, meta.targetEsimId)
        : null;
    const mobileTarget =
      !target && meta?.mobile ? await this.targetForMobile(meta.mobile) : null;
    const selectedTarget = meta?.recharge
      ? { inventoryId: meta.recharge.inventoryId }
      : (target ?? mobileTarget);
    const purchaseType = selectedTarget
      ? ("TOPUP" as const)
      : ("INITIAL_PURCHASE" as const);
    // Existing eSIMs may buy packages for any destination. Transatel decides
    // whether the specific provider product can be subscribed to by that
    // eSIM's MSISDN; do not infer eligibility from the original plan country.
    if (meta?.mobile) {
      const eligibility = await this.checkTopUpEligibility(meta.mobile, planId);
      if (!eligibility.allowed)
        throw new BadRequestException(
          eligibility.errorMessage ??
            "This eSIM cannot subscribe to the selected plan.",
        );
    }
    if (meta?.mobile && purchaseType !== "TOPUP")
      throw new BadRequestException(
        "This number is not linked to an active Visa Compass eSIM.",
      );
    if (purchaseType === "INITIAL_PURCHASE")
      await this.assertInventoryAvailableForNewOrder();
    const topUpEmail =
      purchaseType === "TOPUP"
        ? meta?.recharge
          ? meta.email
          : meta?.mobile
            ? await this.priorOrderEmail(meta.mobile)
            : ownerId
              ? await this.customerEmail(ownerId)
              : undefined
        : undefined;
    const reusableTraveler =
      target && purchaseType === "INITIAL_PURCHASE"
        ? target.traveler
        : undefined;
    const order: DemoOrder = {
      id,
      ownerId,
      ...(meta?.recharge
        ? {
            beneficiaryCustomerId: meta.recharge.customerId,
            targetInventoryId: meta.recharge.inventoryId,
            purchasedByUserId: meta.recharge.purchasedByUserId,
            checkoutAttemptKey: meta.recharge.checkoutAttemptKey,
            checkoutRequestHash: meta.recharge.checkoutRequestHash,
          }
        : {}),
      orderNumber: `VC-${new Date().getUTCFullYear()}-${id.slice(0, 8).toUpperCase()}`,
      status: OrderStatus.DRAFT,
      version: 0,
      plan,
      totalAmountNpr: plan.sellingPriceNpr,
      pricingSnapshot: {
        planId,
        name: plan.name,
        amount: plan.sellingPriceNpr,
        currency: "NPR",
        ...(selectedTarget ? { targetEsimId: selectedTarget.inventoryId } : {}),
        ...(meta?.mobile ? { topUpMobile: meta.mobile } : {}),
        ...(topUpEmail ? { topUpEmail } : {}),
      },
      compatibilityAcceptedAt: now,
      ...(reusableTraveler ? { traveler: reusableTraveler } : {}),
      documents: [],
      timeline: [{ from: null, to: OrderStatus.DRAFT, at: now }],
      createdAt: now,
      purchaseType,
      ...(meta?.mobile ? { topUpMobile: meta.mobile } : {}),
    };
    this.orders.set(id, order);
    try {
      await this.persistence.save(order, meta?.recharge?.recovery);
    } catch (error) {
      this.orders.delete(id);
      throw error;
    }
    const consentContext = [
      ["E_SIM_COMPATIBILITY", "1.0"],
      ["TERMS_OF_SERVICE", "1.0"],
      ["PRIVACY_POLICY", "1.0"],
    ] as const;
    await Promise.all(
      consentContext.map(([type, version]) =>
        this.persistence.recordConsent(
          id,
          ownerId ?? "guest",
          type,
          version,
          meta.ipAddress ?? "unknown",
          meta.userAgent ?? "unknown",
        ),
      ),
    ).catch((error) =>
      this.logger.warn(
        `Consent recording failed for order ${id}: ${error instanceof Error ? error.message : "unknown"}`,
      ),
    );
    return this.redact(order);
  }

  async assertInventoryAvailableForNewOrder() {
    await this.inventory.assertAvailableForNewOrder();
  }

  async claimGuestOrder(
    orderId: string,
    ownerId: string,
    performedById?: string,
  ) {
    await this.refreshOne(orderId, this.prisma.enabled);
    const memoryOrder = this.orders.get(orderId);
    if (memoryOrder?.purchaseType === "TOPUP")
      throw new BadRequestException(
        "Recharge ownership cannot be claimed or transferred",
      );
    if (!memoryOrder) throw new NotFoundException("Order not found");
    if (!this.prisma.enabled) {
      if (memoryOrder.ownerId && memoryOrder.ownerId !== ownerId)
        throw new ApiException({
          code: "ORDER_ALREADY_CLAIMED",
          message: "This guest order belongs to another account",
          status: 409,
        });
      memoryOrder.ownerId = ownerId;
      return this.redact(memoryOrder);
    }
    const target = await this.prisma.customer.findFirst({
      where: { OR: this.customerMatch(ownerId) },
      select: { id: true },
    });
    if (!target) throw new NotFoundException("Customer account not found");
    const source = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        customerId: true,
        customer: { select: { user: { select: { clerkId: true } } } },
      },
    });
    if (!source) throw new NotFoundException("Order not found");
    if (source.customerId !== target.id) {
      if (!source.customer.user?.clerkId.startsWith("guest-"))
        throw new ApiException({
          code: "ORDER_ALREADY_CLAIMED",
          message: "This guest order belongs to another account",
          status: 409,
        });
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.order.updateMany({
          where: { id: orderId, customerId: source.customerId },
          data: { customerId: target.id },
        });
        if (claimed.count !== 1)
          throw new ApiException({
            code: "ORDER_ALREADY_CLAIMED",
            message: "This guest order was claimed by another account",
            status: 409,
          });
        await tx.customerEsim.updateMany({
          where: { orderId, customerId: source.customerId },
          data: { customerId: target.id },
        });
        const originalAssignment = await tx.customerEsim.findUnique({
          where: { orderId },
          select: { inventoryId: true },
        });
        if (originalAssignment) {
          const recharges = await tx.order.findMany({
            where: {
              orderType: "TOPUP",
              customerId: source.customerId,
              OR: [
                { targetInventoryId: originalAssignment.inventoryId },
                {
                  customerEsim: {
                    is: { inventoryId: originalAssignment.inventoryId },
                  },
                },
              ],
            },
            select: { id: true },
          });
          const ids = recharges.map((item) => item.id);
          await tx.order.updateMany({
            where: { id: { in: ids } },
            data: { customerId: target.id, version: { increment: 1 } },
          });
          await tx.customerEsim.updateMany({
            where: { orderId: { in: ids } },
            data: { customerId: target.id },
          });
        }
        await tx.customerConsent.updateMany({
          where: { customerId: source.customerId },
          data: { customerId: target.id },
        });
        await tx.auditLog.create({
          data: {
            module: "ORDERS",
            entity: "Order",
            entityId: orderId,
            action: "GUEST_ORDER_CLAIMED",
            ...(performedById ? { performedById } : {}),
            previousValue: { ownership: "GUEST" },
            newValue: { ownership: "CUSTOMER_ACCOUNT" },
          },
        });
      });
    }
    memoryOrder.ownerId = ownerId;
    await this.refreshOne(orderId, true);
    return this.view(orderId, ownerId);
  }
  /**
   * Builds the Prisma `OR` filter for looking up a customer by either its
   * internal UUID id or the Clerk identity id. Clerk ids are not UUIDs, so the
   * `id` clause is only included when the value can legally cast to the UUID
   * column, otherwise PostgreSQL rejects the query with a cast error.
   */
  private customerMatch(ownerId: string) {
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return [
      { user: { clerkId: ownerId } },
      ...(uuid.test(ownerId) ? [{ id: ownerId }] : []),
    ];
  }
  private async priorOrderEmail(mobile: string): Promise<string | undefined> {
    return (await this.resolveSubscriber(mobile))?.traveler.email;
  }
  private async customerEmail(ownerId: string): Promise<string | undefined> {
    if (!this.prisma.enabled)
      return [...this.orders.values()].find(
        (order) => order.ownerId === ownerId && order.traveler,
      )?.traveler?.email;
    const customer = await this.prisma.customer.findFirst({
      where: { OR: this.customerMatch(ownerId) },
      select: { email: true },
    });
    return customer?.email ?? undefined;
  }
  private async targetEsim(ownerId: string, inventoryId: string) {
    if (!this.prisma.enabled)
      throw new BadRequestException(
        "Target eSIM selection requires database persistence",
      );
    const customer = await this.prisma.customer.findFirst({
      where: { OR: this.customerMatch(ownerId) },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException("eSIM not found");
    const rows = await this.prisma.customerEsim.findMany({
      where: { customerId: customer.id, inventoryId },
      select: {
        inventoryId: true,
        orderId: true,
        assignedAt: true,
        order: {
          select: {
            plan: { select: { country: { select: { isoCode: true } } } },
          },
        },
      },
      orderBy: { assignedAt: "desc" },
    });
    if (!rows.length) throw new NotFoundException("eSIM not found");
    const traveler = rows
      .map((row) => this.orders.get(row.orderId)?.traveler)
      .find(Boolean);
    return {
      inventoryId,
      countryCodes: [
        ...new Set(rows.map((row) => row.order.plan.country.isoCode)),
      ],
      ...(traveler ? { traveler } : {}),
    };
  }
  private async targetForMobile(mobile: string) {
    const prior = await this.priorCompletedOrderFor(mobile);
    return prior?.inventory
      ? {
          inventoryId: prior.inventory.id,
          countryCodes: [prior.planCountryCode],
        }
      : null;
  }
  private topUpLookupWhere(mobile: string, allowReadyToInstall = false) {
    const variants = [...msisdnVariants(mobile)];
    return {
      status: allowReadyToInstall
        ? { in: ["QR_READY" as const, "COMPLETED" as const] }
        : ("COMPLETED" as const),
      orderType: "INITIAL_PURCHASE" as const,
      customerEsim: {
        is: {
          inventory: {
            is: { msisdn: { in: variants } },
          },
        },
      },
    };
  }
  private matchesTopUpLookup(
    target: string,
    values: Array<string | null | undefined>,
  ) {
    return values.some((value) => value && normalizeMsisdn(value) === target);
  }
  private async hasCompletedOrderForOwner(ownerId: string) {
    const anyCompleted = [...this.orders.values()].some(
      (order) =>
        order.ownerId === ownerId && order.status === OrderStatus.COMPLETED,
    );
    if (anyCompleted) return true;
    if (!this.prisma.enabled) return false;
    const customer = await this.prisma.customer.findFirst({
      where: { OR: this.customerMatch(ownerId) },
      select: { id: true },
    });
    if (!customer) return false;
    return Boolean(
      await this.prisma.order.findFirst({
        where: { customerId: customer.id, status: "COMPLETED" },
        select: { id: true },
      }),
    );
  }
  async usageFor(orderId: string) {
    const order = this.get(orderId);
    if (this.prisma.enabled) {
      return this.inventory.refreshUsage(orderId);
    }
    if (order.usage) return order.usage;
    throw new NotFoundException("Usage is available after provisioning");
  }
  async setTraveler(
    id: string,
    ownerId: string | null,
    traveler: TravelerInput,
  ) {
    await this.refreshOne(id, true);
    const order = this.get(id, ownerId ?? undefined);
    if (order.status !== OrderStatus.DRAFT)
      throw new BadRequestException("Submitted order is immutable");
    order.traveler = traveler;
    await this.persistence.save(order);
    return this.redact(order);
  }
  async addDocument(
    id: string,
    ownerId: string | null,
    input: { type: DocumentType; fileName: string; contentType?: string },
  ) {
    await this.refreshOne(id, true);
    const order = this.get(id, ownerId ?? undefined);
    const replacement = order.documentReviewStatus === "REUPLOAD_REQUIRED";
    const replacesExistingEvidence = order.documents.some(
      (document) => document.type === input.type,
    );
    if (
      ![OrderStatus.DRAFT, OrderStatus.AWAITING_CUSTOMER].includes(
        order.status,
      ) &&
      !replacement
    )
      throw new BadRequestException("Documents cannot be changed now");
    const signed = await this.storage.createDocumentUpload(
      id,
      input.type,
      input.contentType ?? "application/pdf",
    );
    const document = {
      id: randomUUID(),
      type: input.type,
      fileName: input.fileName,
      privateAssetId: signed.assetId,
      status: DocumentStatus.PENDING,
    };
    order.documents = order.documents
      .filter((d) => d.type !== input.type)
      .concat(document);
    if (
      replacement ||
      replacesExistingEvidence ||
      ["VERIFIED", "MANUALLY_APPROVED", "SKIPPED"].includes(
        order.documentReviewStatus ?? "",
      )
    ) {
      order.documentReviewStatus = "NOT_STARTED";
      delete order.documentReviewStartedAt;
      delete order.documentCheckoutReleaseAt;
      delete order.passportVerification;
    }
    await this.persistence.save(order);
    return { ...document, upload: signed.upload };
  }
  async confirmDocument(
    id: string,
    documentId: string,
    ownerId: string | null,
  ) {
    await this.refreshOne(id, true);
    const order = this.get(id, ownerId ?? undefined);
    const document = order.documents.find((item) => item.id === documentId);
    if (!document) throw new NotFoundException("Document not found");
    if (document.uploadVerified)
      return {
        id: document.id,
        type: document.type,
        status: document.status,
        uploadVerified: true,
      };
    await this.storage.verifyDocument(document.privateAssetId);
    document.uploadVerified = true;
    const reviewResubmission = [
      OrderStatus.REVIEW_PENDING,
      OrderStatus.AWAITING_CUSTOMER,
      OrderStatus.PAYMENT_CONFIRMED,
      OrderStatus.APPROVED,
      OrderStatus.PROVISIONING,
      OrderStatus.QR_READY,
      OrderStatus.ACTIVATION_ATTENTION,
      OrderStatus.COMPLETED,
    ].includes(order.status);
    let queueReplacementOcr = false;
    if (reviewResubmission && order.documentReviewStatus === "NOT_STARTED") {
      order.documentReviewStartedAt = new Date().toISOString();
      if (order.documentReviewPolicy === "NO_REVIEW") {
        order.documentReviewStatus = "SKIPPED";
      } else if (
        order.documentReviewPolicy === "AUTO_OCR" &&
        document.type === DocumentType.PASSPORT
      ) {
        order.documentReviewStatus = "OCR_PENDING";
        queueReplacementOcr = true;
      } else {
        order.documentReviewStatus = "MANUAL_REVIEW";
      }
    }
    if (
      order.status === OrderStatus.AWAITING_CUSTOMER &&
      !order.documents.some(
        (item) => item.status === DocumentStatus.REUPLOAD_REQUIRED,
      )
    )
      this.transition(
        order,
        OrderStatus.REVIEW_PENDING,
        "Customer supplied requested document",
      );
    await this.persistence.save(order);
    if (queueReplacementOcr) {
      try {
        await this.queues.add(
          QUEUES.documents,
          "verify-order-passport",
          {
            orderId: order.id,
            documentId: document.id,
            privateAssetId: document.privateAssetId,
          },
          orderPassportOcrJobId(order.id, document.id, document.privateAssetId),
          ocrJobOptions(),
        );
      } catch (error) {
        // Keep the durable request pending. The independent workflow
        // reconciler retries queue delivery during the OCR grace window and
        // moves it to manual review only after that window expires.
        order.documentReviewStatus = "OCR_PENDING";
        await this.persistence.save(order);
        this.logger.warn(
          `Replacement OCR handoff failed for ${order.id}: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }
    await this.ensureDocumentReviewAttention(order);
    const allRequiredDocumentsConfirmed = [
      DocumentType.PASSPORT,
      DocumentType.TICKET,
    ].every((type) =>
      order.documents.some((item) => item.type === type && item.uploadVerified),
    );
    if (
      allRequiredDocumentsConfirmed &&
      order.documentReviewStatus === "NOT_STARTED"
    )
      await this.verifyPassport(id, ownerId);
    return {
      id: document.id,
      type: document.type,
      status: document.status,
      uploadVerified: true,
    };
  }
  async documentPreview(id: string, documentId: string) {
    const order = this.get(id);
    const document = order.documents.find((item) => item.id === documentId);
    if (!document) throw new NotFoundException("Document not found");
    return {
      url: await this.storage.signedReadUrl(document.privateAssetId),
      fileName: document.fileName,
      contentType: document.fileName.toLowerCase().endsWith(".pdf")
        ? "application/pdf"
        : "image",
      expiresInSeconds: 300,
    };
  }
  async documentContent(id: string, documentId: string) {
    const order = this.get(id);
    const document = order.documents.find((item) => item.id === documentId);
    if (!document) throw new NotFoundException("Document not found");
    return {
      ...(await this.storage.downloadDocument(document.privateAssetId)),
      fileName: document.fileName,
    };
  }
  async verifyPassport(id: string, ownerId: string | null) {
    await this.refreshOne(id, true);
    const order = this.get(id, ownerId ?? undefined);
    if (order.purchaseType === "TOPUP")
      throw new BadRequestException(
        "Passport verification is not required for top-ups",
      );
    const passport = order.documents.find(
      (document) =>
        document.type === DocumentType.PASSPORT && document.uploadVerified,
    );
    if (!passport || !order.traveler)
      throw new BadRequestException(
        "Confirmed passport and traveller details are required",
      );
    const persistedPassportVerdict = order.passportVerification?.status;
    if (
      persistedPassportVerdict === "VERIFIED" ||
      persistedPassportVerdict === "SKIPPED"
    ) {
      const terminalReviewStatus = persistedPassportVerdict;
      if (order.documentReviewStatus !== terminalReviewStatus) {
        order.documentReviewStatus = terminalReviewStatus;
        await this.persistence.save(order);
      }
      return this.redact(order);
    }
    if (
      ["VERIFIED", "MANUALLY_APPROVED", "SKIPPED"].includes(
        order.documentReviewStatus ?? "",
      )
    )
      return this.redact(order);
    const missingRequiredDocuments = [
      DocumentType.PASSPORT,
      DocumentType.TICKET,
    ].filter(
      (type) =>
        !order.documents.some(
          (document) => document.type === type && document.uploadVerified,
        ),
    );
    if (missingRequiredDocuments.length)
      throw new BadRequestException(
        `Confirm all required documents before verification: ${missingRequiredDocuments.join(", ")}`,
      );
    const config = this.prisma.enabled
      ? await this.prisma.platformConfiguration.upsert({
          where: { id: "platform" },
          update: {},
          create: { id: "platform" },
        })
      : { documentReviewPolicy: "AUTO_OCR" as const, ocrCheckoutWaitMs: 8000 };
    const now = new Date();
    order.documentReviewPolicy = config.documentReviewPolicy;
    order.documentReviewStartedAt ??= now.toISOString();
    if (config.documentReviewPolicy === "NO_REVIEW") {
      order.documentReviewStatus = "SKIPPED";
      order.passportVerification = {
        status: "SKIPPED",
        matchedFields: [],
        checkedAt: now.toISOString(),
        method: "policy",
        detail:
          "Document verification was skipped by the configured review policy",
      };
      await this.persistence.save(order);
      return this.redact(order);
    }
    if (config.documentReviewPolicy === "MANUAL_REVIEW") {
      order.documentReviewStatus = "MANUAL_REVIEW";
      order.passportVerification = {
        status: "NOT_READY",
        matchedFields: [],
        checkedAt: now.toISOString(),
        method: "ocr-error",
        detail: "Documents require manual approval before payment can continue",
      };
      await this.persistence.save(order);
      return this.redact(order);
    }
    // A later customer recheck is a recovery signal. Legacy OCR_BACKGROUND
    // orders are moved back to the strictly blocking OCR_PENDING state.
    const reviewStartedAt = Date.parse(order.documentReviewStartedAt ?? "");
    const recoveryDelayMs = Math.max(config.ocrCheckoutWaitMs * 4, 30_000);
    const requeueBackgroundVerification =
      order.documentReviewStatus === "OCR_BACKGROUND" ||
      (order.documentReviewStatus === "OCR_PENDING" &&
        Number.isFinite(reviewStartedAt) &&
        now.getTime() - reviewStartedAt >= recoveryDelayMs);
    if (
      !["OCR_PENDING", "OCR_BACKGROUND"].includes(
        order.documentReviewStatus ?? "",
      ) ||
      requeueBackgroundVerification
    ) {
      order.documentReviewStatus = "OCR_PENDING";
      if (requeueBackgroundVerification) {
        order.documentReviewStartedAt = now.toISOString();
        delete order.documentCheckoutReleaseAt;
      }
      await this.persistence.save(order);
      try {
        await this.queues.add(
          QUEUES.documents,
          "verify-order-passport",
          {
            orderId: order.id,
            documentId: passport.id,
            privateAssetId: passport.privateAssetId,
          },
          orderPassportOcrJobId(order.id, passport.id, passport.privateAssetId),
          ocrJobOptions(),
        );
      } catch (error) {
        // Queue transport may recover before the OCR grace window expires.
        // The workflow reconciler owns the eventual manual-review fallback.
        order.documentReviewStatus = "OCR_PENDING";
        order.passportVerification = {
          status: "NOT_READY",
          matchedFields: [],
          checkedAt: now.toISOString(),
          method: "ocr-error",
          detail: `OCR queue is temporarily unavailable; retrying during the recovery window (${error instanceof Error ? error.message : "unknown error"})`,
        };
        await this.persistence.save(order);
      }
    }
    return this.redact(order);
  }
  async beginPayment(
    id: string,
    ownerId: string | null,
    provider: PaymentProvider,
    initiation: {
      reference: string;
      correlationId?: string;
      expiresAt?: string;
      returnUrl: string;
      redirectUrl?: string;
    },
  ) {
    await this.refreshOne(id, true);
    const order = this.get(id, ownerId ?? undefined);
    if (
      order.payment?.status === PaymentStatus.PENDING &&
      order.payment.reference === initiation.reference
    )
      return this.redact(order);
    if (
      order.payment?.status === PaymentStatus.PENDING &&
      order.payment.expiresAt &&
      new Date(order.payment.expiresAt).getTime() > Date.now()
    )
      throw new ConflictException("Another payment session is already active");
    if (order.purchaseType !== "TOPUP") {
      const required = order.documents.filter((d) =>
        [DocumentType.PASSPORT, DocumentType.TICKET].includes(d.type),
      );
      if (!order.traveler || required.length !== 2)
        throw new BadRequestException(
          "Traveler, passport, and ticket are required",
        );
      await Promise.all(
        required.map((document) =>
          this.storage.verifyDocument(document.privateAssetId),
        ),
      );
      required.forEach((document) => {
        document.uploadVerified = true;
      });
      const review = order.documentReviewStatus;
      if (review === "REUPLOAD_REQUIRED")
        throw new ApiException({
          code: "PASSPORT_VERIFICATION_REQUIRED",
          message: "Upload a clearer passport before payment",
        });
      if (!["VERIFIED", "MANUALLY_APPROVED", "SKIPPED"].includes(review ?? ""))
        throw new ApiException({
          code: "PASSPORT_VERIFICATION_REQUIRED",
          message:
            review === "OCR_PENDING" || review === "OCR_BACKGROUND"
              ? "Passport verification must complete before payment"
              : "Passport verification is required before payment",
        });
    }
    if (order.status !== OrderStatus.PAYMENT_PENDING)
      this.transition(order, OrderStatus.PAYMENT_PENDING);
    order.payment = {
      provider,
      reference: initiation.reference,
      status: PaymentStatus.PENDING,
      ...(initiation.correlationId
        ? { correlationId: initiation.correlationId }
        : {}),
      ...(initiation.expiresAt ? { expiresAt: initiation.expiresAt } : {}),
      returnUrl: initiation.returnUrl,
      ...(initiation.redirectUrl
        ? { redirectUrl: initiation.redirectUrl }
        : {}),
    };
    await this.persistence.save(order);
    return this.redact(order);
  }
  async confirmPayment(id: string, reference: string, transactionId?: string) {
    if (this.prisma.enabled)
      return this.confirmPaymentPersisted(id, reference, transactionId);
    return this.runExclusive(id, () =>
      this.confirmPaymentUnlocked(id, reference, transactionId),
    );
  }

  private async confirmPaymentPersisted(
    id: string,
    reference: string,
    transactionId?: string,
  ) {
    const claim = await this.persistence.confirmPaymentAtomically(
      id,
      reference,
      transactionId,
    );
    await this.refreshOne(id, true);
    const order = this.get(id);
    if (order.payment?.reference !== reference)
      throw new BadRequestException("Payment reference mismatch");
    if (claim.requiresReview) {
      await this.resilience?.attention({
        dedupeKey: `late-payment:${id}:${reference}`,
        category: "PAYMENT_REFUND_REVIEW",
        entityType: "Order",
        entityId: id,
        orderId: id,
        severity: "CRITICAL",
        summary: `Payment arrived after ${order.orderNumber} could no longer advance`,
        detail:
          "Gateway payment evidence was preserved, but provisioning was not started because the local order was cancelled, failed, refunded, or otherwise ineligible",
        localState: order.status,
        externalState: PaymentStatus.COMPLETED,
        lastSuccessfulStep: "PAYMENT_CONFIRMED_EXTERNALLY",
        failureCategory: "LATE_PAYMENT_ON_INELIGIBLE_ORDER",
        availableActions: ["RECHECK_PAYMENT", "REVIEW_MANUAL_REFUND"],
      });
      return this.redact(order);
    }
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
        if (
          ![
            OrderStatus.PROVISIONING,
            OrderStatus.QR_READY,
            OrderStatus.COMPLETED,
          ].includes(current.status)
        )
          throw error;
      }
    }
    const current = this.get(id);
    if (current.status === OrderStatus.PROVISIONING)
      await this.enqueueProvisioning(current, `provision-${current.id}`);
    await this.ensureDocumentReviewAttention(current);
    await this.safeResolveAttention(
      `payment-review:${id}`,
      "Payment confirmed by the gateway",
    );
    return this.redact(current);
  }

  /**
   * Guards payment confirmation per order id. Browser verification, the
   * callback path and the background reconcile can all reach confirmation at
   * once. This lock is only the non-persistent development fallback;
   * production uses confirmPaymentAtomically() and optimistic order versions.
   */
  private async confirmPaymentUnlocked(
    id: string,
    reference: string,
    transactionId?: string,
  ) {
    const order = this.get(id);
    if (order.payment?.reference !== reference)
      throw new BadRequestException("Payment reference mismatch");
    if (order.payment.status === PaymentStatus.COMPLETED)
      return this.redact(order);
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
    await this.ensureDocumentReviewAttention(confirmed);
    return this.redact(confirmed);
  }

  private async ensureDocumentReviewAttention(order: DemoOrder) {
    if (order.documentReviewStatus !== "MANUAL_REVIEW") return;
    await this.resilience?.attention({
      dedupeKey: `document-review:${order.id}`,
      category: "DOCUMENT_MANUAL_REVIEW",
      entityType: "Order",
      entityId: order.id,
      orderId: order.id,
      summary: "Documents require manual review",
      localState: order.status,
      failureCategory: "DOCUMENT_REVIEW_POLICY",
      lastSuccessfulStep: "PAYMENT_OR_SETTLEMENT_CONFIRMED",
      availableActions: [],
    });
  }
  async resolvePaymentFailure(
    id: string,
    ownerId: string | null,
    reason: string,
    paymentStatus: PaymentStatus = PaymentStatus.FAILED,
  ) {
    const order = this.get(id, ownerId ?? undefined);
    if (
      order.status === OrderStatus.CANCELLED ||
      order.status === OrderStatus.REFUNDED
    )
      return this.redact(order);
    if (
      ![OrderStatus.PAYMENT_PENDING, OrderStatus.PAYMENT_FAILED].includes(
        order.status,
      )
    )
      return this.redact(order);
    if (order.payment && order.payment.status !== PaymentStatus.COMPLETED)
      order.payment.status = paymentStatus;
    if (order.status !== OrderStatus.PAYMENT_FAILED)
      this.transition(order, OrderStatus.PAYMENT_FAILED, reason);
    await this.persistence.save(order);
    return this.redact(order);
  }
  async requirePaymentReview(id: string, reason: string) {
    await this.refreshOne(id, true);
    const order = this.get(id);
    if (order.status === OrderStatus.PAYMENT_REVIEW_REQUIRED)
      return this.redact(order);
    if (order.status !== OrderStatus.PAYMENT_PENDING) return this.redact(order);
    if (order.payment) order.payment.status = PaymentStatus.REVIEW_REQUIRED;
    order.operationalDisposition = "MANUAL_ACTION";
    this.transition(order, OrderStatus.PAYMENT_REVIEW_REQUIRED, reason);
    await this.persistence.save(order);
    return this.redact(order);
  }

  /** Serializes async tasks that share a key (e.g. per-order confirmation). */
  private runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = (this.confirmLocks.get(key) ??
      Promise.resolve()) as Promise<unknown>;
    const run = previous.catch(() => undefined).then(task);
    this.confirmLocks.set(key, run);
    void run.finally(() => {
      if (this.confirmLocks.get(key) === run) this.confirmLocks.delete(key);
    });
    return run;
  }
  async cancel(id: string, ownerId: string | null, reason: string) {
    await this.refreshOne(id, true);
    const order = this.get(id, ownerId ?? undefined);
    if (
      ![
        OrderStatus.DRAFT,
        OrderStatus.PAYMENT_PENDING,
        OrderStatus.PAYMENT_FAILED,
      ].includes(order.status)
    )
      throw new BadRequestException(
        `Order in ${order.status} cannot be cancelled`,
      );
    if (order.payment && order.payment.status === PaymentStatus.PENDING)
      order.payment.status = PaymentStatus.CANCELLED;
    this.transition(order, OrderStatus.CANCELLED, reason);
    await this.persistence.save(order);
    return this.redact(order);
  }
  async expireStalePayments() {
    const now = Date.now();
    let expired = 0;
    for (const order of this.orders.values()) {
      if (
        order.status !== OrderStatus.PAYMENT_PENDING ||
        !order.payment?.expiresAt
      )
        continue;
      if (new Date(order.payment.expiresAt).getTime() > now) continue;
      if (order.payment.status === PaymentStatus.PENDING)
        order.payment.status = PaymentStatus.REVIEW_REQUIRED;
      this.transition(
        order,
        OrderStatus.PAYMENT_REVIEW_REQUIRED,
        "Payment window elapsed; gateway confirmation is required",
      );
      order.operationalDisposition = "MANUAL_ACTION";
      await this.persistence.save(order);
      await this.resilience?.attention({
        dedupeKey: `payment-review:${order.id}`,
        category: "PAYMENT_UNCERTAIN",
        entityType: "Order",
        entityId: order.id,
        orderId: order.id,
        summary: `Payment needs confirmation for ${order.orderNumber}`,
        detail: "Payment window elapsed without a definitive gateway result",
        localState: OrderStatus.PAYMENT_REVIEW_REQUIRED,
        lastSuccessfulStep: "PAYMENT_INITIATED",
        failureCategory: "PAYMENT_WINDOW_ELAPSED",
        availableActions: ["RECHECK_PAYMENT"],
      });
      expired += 1;
    }
    return { expired };
  }
  async topUpLookup(mobile: string, options?: { includeIdentity?: boolean }) {
    const target = normalizeMsisdn(mobile);
    if (!target)
      throw new BadRequestException("A valid eSIM MSISDN is required");
    const includeIdentity = Boolean(options?.includeIdentity);
    const fromOrders = [...this.orders.values()].find(
      (order) =>
        order.status === OrderStatus.COMPLETED &&
        normalizeMsisdn(order.assignment?.msisdn ?? "") === target,
    );
    if (fromOrders)
      return {
        found: true,
        mobile,
        ...this.topUpSubscriber(fromOrders, includeIdentity),
      };
    if (this.prisma.enabled) {
      const dbOrder = await this.prisma.order.findFirst({
        where: this.topUpLookupWhere(mobile),
        include: {
          plan: { include: { country: true } },
          customerEsim: { include: { inventory: true, subscriptions: true } },
          traveler: true,
        },
        orderBy: { createdAt: "desc" },
      });
      if (
        dbOrder?.traveler &&
        this.matchesTopUpLookup(target, [
          dbOrder.customerEsim?.inventory?.msisdn,
        ])
      ) {
        return {
          found: true,
          mobile,
          ...this.dbTopUpSubscriber(dbOrder, includeIdentity),
        };
      }
    }
    return { found: false, mobile };
  }
  private topUpSubscriber(order: DemoOrder, includeIdentity: boolean) {
    const subscriber: Record<string, unknown> = {
      currentPlan: {
        id: order.plan.id,
        name: order.plan.name,
        dataAllowance: order.plan.dataAllowance,
        validityDays: order.plan.validityDays,
        countryCode: order.plan.countryCode,
        countryName: order.plan.countryName,
      },
      countryCode: order.plan.countryCode,
      countryName: order.plan.countryName,
      ...(order.usage ? { usage: order.usage } : {}),
      hasActiveEsim: Boolean(order.qrPayload),
      ...(includeIdentity && order.traveler
        ? {
            identity: {
              firstName: order.traveler.firstName,
              surname: order.traveler.surname,
              email: order.traveler.email,
              countryOfResidence: order.traveler.countryOfResidence,
            },
          }
        : {}),
    };
    return {
      subscriber,
      topUpAvailable: Boolean(order.qrPayload && order.assignment?.msisdn),
    };
  }
  private dbTopUpSubscriber(
    dbOrder: {
      plan: {
        id: string;
        name: string;
        dataAllowance: string;
        validityDays: number;
        country: { isoCode: string; name: string };
      };
      customerEsim?: {
        inventory: {
          iccid: string;
          msisdn: string | null;
          status: string;
          activatedAt: Date | null;
          expiresAt: Date | null;
        } | null;
        subscriptions: {
          usedMb: number;
          totalMb: number;
          usageLastCheckedAt: Date | null;
          status: string;
          expiresAt: Date | null;
        }[];
      } | null;
      traveler: {
        firstName: string;
        surname: string;
        email: string;
        countryOfResidence: string;
        mobile: string;
      } | null;
    },
    includeIdentity: boolean,
  ) {
    const traveler = dbOrder.traveler;
    if (!traveler)
      return {
        subscriber: {
          countryCode: dbOrder.plan.country.isoCode,
          countryName: dbOrder.plan.country.name,
        },
        topUpAvailable: false,
      };
    const latest = [...(dbOrder.customerEsim?.subscriptions ?? [])].sort(
      (a, b) =>
        (b.usageLastCheckedAt?.getTime() ?? 0) -
        (a.usageLastCheckedAt?.getTime() ?? 0),
    )[0];
    const activeSubscriptions = (
      dbOrder.customerEsim?.subscriptions ?? []
    ).filter(
      (subscription) =>
        subscription.status !== "EXPIRED" &&
        subscription.status !== "TERMINATED",
    );
    const expiresAt = (() => {
      const dates = activeSubscriptions
        .map((subscription) => subscription.expiresAt?.getTime())
        .filter(
          (value): value is number => value !== undefined && value !== null,
        );
      if (dates.length) return new Date(Math.min(...dates)).toISOString();
      return dbOrder.customerEsim?.inventory?.expiresAt
        ? dbOrder.customerEsim.inventory.expiresAt.toISOString()
        : undefined;
    })();
    const subscriber: Record<string, unknown> = {
      currentPlan: {
        id: dbOrder.plan.id,
        name: dbOrder.plan.name,
        dataAllowance: dbOrder.plan.dataAllowance,
        validityDays: dbOrder.plan.validityDays,
        countryCode: dbOrder.plan.country.isoCode,
        countryName: dbOrder.plan.country.name,
      },
      countryCode: dbOrder.plan.country.isoCode,
      countryName: dbOrder.plan.country.name,
      ...(expiresAt ? { expiresAt } : {}),
      ...(latest?.usageLastCheckedAt
        ? {
            usage: {
              usedMb: latest.usedMb,
              totalMb: latest.totalMb,
              lastCheckedAt: latest.usageLastCheckedAt.toISOString(),
            },
          }
        : {}),
      hasActiveEsim: Boolean(dbOrder.customerEsim?.inventory),
      ...(includeIdentity
        ? {
            identity: {
              firstName: traveler.firstName,
              surname: traveler.surname,
              email: traveler.email,
              countryOfResidence: traveler.countryOfResidence,
            },
          }
        : {}),
    };
    return {
      subscriber,
      topUpAvailable: Boolean(dbOrder.customerEsim?.inventory?.msisdn),
    };
  }
  /**
   * Resolves an eSIM's original purchase and provisioning identity. Recharge
   * eligibility can also inspect paid, ready-to-install eSIMs; ordinary lookup
   * keeps its existing completed-order requirement.
   */
  private async priorCompletedOrderFor(
    mobile: string,
    allowReadyToInstall = false,
  ) {
    const target = normalizeMsisdn(mobile);
    if (!target) return null;
    if (!this.prisma.enabled) {
      const prior = [...this.orders.values()].find(
        (order) =>
          (order.status === OrderStatus.COMPLETED ||
            (allowReadyToInstall && order.status === OrderStatus.QR_READY)) &&
          order.traveler &&
          normalizeMsisdn(order.assignment?.msisdn ?? "") === target,
      );
      if (!prior?.traveler) return null;
      return {
        orderId: prior.id,
        customerId: undefined,
        planCountryCode: prior.plan.countryCode,
        traveler: {
          firstName: prior.traveler.firstName,
          surname: prior.traveler.surname,
          email: prior.traveler.email,
          mobile: prior.traveler.mobile,
          city: prior.traveler.city,
          countryOfResidence: prior.traveler.countryOfResidence,
        },
        inventory: null,
      };
    }
    const prior = await this.prisma.order.findFirst({
      where: this.topUpLookupWhere(mobile, allowReadyToInstall),
      include: {
        plan: { include: { country: true } },
        customerEsim: { include: { inventory: true } },
        traveler: true,
      },
      orderBy: { createdAt: "desc" },
    });
    if (
      !prior?.traveler ||
      !this.matchesTopUpLookup(target, [prior.customerEsim?.inventory?.msisdn])
    )
      return null;
    return {
      orderId: prior.id,
      customerId: prior.customerId,
      planCountryCode: prior.plan.country.isoCode,
      traveler: {
        firstName: prior.traveler.firstName,
        surname: prior.traveler.surname,
        email: prior.traveler.email,
        mobile: prior.traveler.mobile,
        city: prior.traveler.city,
        countryOfResidence: prior.traveler.countryOfResidence,
      },
      inventory: prior.customerEsim?.inventory
        ? {
            id: prior.customerEsim.inventory.id,
            eid: prior.customerEsim.inventory.eid,
            iccid: prior.customerEsim.inventory.iccid,
            msisdn: prior.customerEsim.inventory.msisdn,
          }
        : null,
    };
  }
  async resolveSubscriber(mobile: string, allowReadyToInstall = false) {
    const target = normalizeMsisdn(mobile);
    if (!target) return null;
    if (!this.prisma.enabled) {
      const prior = [...this.orders.values()].find(
        (order) =>
          (order.status === OrderStatus.COMPLETED ||
            (allowReadyToInstall && order.status === OrderStatus.QR_READY)) &&
          order.traveler &&
          normalizeMsisdn(order.assignment?.msisdn ?? "") === target,
      );
      if (!prior?.traveler) return null;
      return {
        orderId: prior.id,
        customerId: undefined,
        planCountryCode: prior.plan.countryCode,
        traveler: {
          firstName: prior.traveler.firstName,
          surname: prior.traveler.surname,
          email: prior.traveler.email,
          mobile: prior.traveler.mobile,
          city: prior.traveler.city,
          countryOfResidence: prior.traveler.countryOfResidence,
        },
        inventory: null,
      };
    }
    return this.priorCompletedOrderFor(mobile, allowReadyToInstall);
  }

  /**
   * Validates a recharge against the provider before money is collected.
   * The supplied identifier must match the eSIM MSISDN. Transatel receives the
   * same stored MSISDN after the local ownership and lifecycle checks pass.
   */
  async checkTopUpEligibility(mobile: string, planId: string) {
    const target = await this.resolveSubscriber(mobile, true);
    const msisdn = target?.inventory?.msisdn;
    if (!target?.inventory || !msisdn)
      return {
        allowed: false,
        errorKey: "ESIM_NOT_AVAILABLE",
        errorMessage: "We could not find an active eSIM for this MSISDN.",
      };
    const provider = await this.connectivity.checkEligibility(planId, msisdn);
    return provider;
  }
  async requestReupload(id: string, reason: string) {
    await this.refreshOne(id, true);
    const order = this.get(id);
    if (!reason.trim())
      throw new BadRequestException("Re-upload reason is required");
    order.documentReviewStatus = "REUPLOAD_REQUIRED";
    order.documents.forEach((d) => {
      if ([DocumentType.PASSPORT, DocumentType.TICKET].includes(d.type))
        d.status = DocumentStatus.REUPLOAD_REQUIRED;
    });
    if (order.partner && order.status === OrderStatus.REVIEW_PENDING)
      this.transition(
        order,
        OrderStatus.AWAITING_CUSTOMER,
        "Operations requested required document replacements",
      );
    order.timeline.push({
      from: order.status,
      to: order.status,
      at: new Date().toISOString(),
      reason: `Documents requested again: ${reason.trim()}`,
    });
    await this.persistence.save(order);
    if (order.partner) {
      const verification =
        await this.prisma.partnerDocumentVerification.findFirst({
          where: { consumedOrderId: id, partnerId: order.partner.id },
          select: { id: true },
        });
      if (verification)
        await this.prisma.$transaction([
          this.prisma.partnerDocumentVerification.update({
            where: { id: verification.id },
            data: {
              status: "REUPLOAD_REQUIRED",
              failureCode: "DOCUMENT_REUPLOAD_REQUIRED",
            },
          }),
          this.prisma.partnerDocumentUploadIntent.updateMany({
            where: {
              verificationId: verification.id,
              type: { in: [DocumentType.PASSPORT, DocumentType.TICKET] },
            },
            data: {
              verificationStatus: "REUPLOAD_REQUIRED",
              verificationCode: "DOCUMENT_REUPLOAD_REQUIRED",
            },
          }),
        ]);
    }
    if (order.partner)
      await this.emitPartnerDocumentEvent(
        order,
        "document.verification.reupload_required",
        "DOCUMENT_REUPLOAD_REQUIRED",
      );
    await this.safeNotify(order, "DOCUMENT_REUPLOAD", reason.trim());
    return order;
  }
  async reviewDocument(
    id: string,
    documentId: string,
    actorId: string,
    decision: "APPROVE" | "REUPLOAD",
    reason?: string,
  ) {
    await this.refreshOne(id, true);
    const order = this.get(id);
    const document = order.documents.find((item) => item.id === documentId);
    if (!document) throw new NotFoundException("Document not found");
    let recordDecision = true;
    if (decision === "APPROVE") {
      const alreadyApproved = document.status === DocumentStatus.APPROVED;
      recordDecision = !alreadyApproved;
      document.status = DocumentStatus.APPROVED;
      const requiredTypes = [DocumentType.PASSPORT, DocumentType.TICKET];
      const allRequiredApproved = requiredTypes.every((type) =>
        order.documents.some(
          (item) =>
            item.type === type && item.status === DocumentStatus.APPROVED,
        ),
      );
      if (allRequiredApproved) order.documentReviewStatus = "MANUALLY_APPROVED";
      if (!alreadyApproved)
        order.timeline.push({
          from: order.status,
          to: order.status,
          at: new Date().toISOString(),
          reason: `${document.type} received final manual approval from ${actorId}`,
        });
      else if (!allRequiredApproved) return this.redact(order);
    } else {
      if (document.type === DocumentType.VISA)
        throw new BadRequestException(
          "Visa is optional and cannot block fulfillment or require replacement",
        );
      if (document.status === DocumentStatus.APPROVED)
        throw new BadRequestException(
          "A final manual approval cannot be replaced by a re-upload request",
        );
      if (!reason?.trim())
        throw new BadRequestException("Re-upload reason is required");
      document.status = DocumentStatus.REUPLOAD_REQUIRED;
      order.documentReviewStatus = "REUPLOAD_REQUIRED";
      if (order.partner && order.status === OrderStatus.REVIEW_PENDING)
        this.transition(
          order,
          OrderStatus.AWAITING_CUSTOMER,
          "Operations requested a required document replacement",
        );
      order.timeline.push({
        from: order.status,
        to: order.status,
        at: new Date().toISOString(),
        reason: `${document.type}: ${reason.trim()} (requested by ${actorId})`,
      });
    }
    await this.persistence.save(order);
    if (order.partner) {
      const verification =
        await this.prisma.partnerDocumentVerification.findFirst({
          where: { consumedOrderId: order.id, partnerId: order.partner.id },
          select: { id: true },
        });
      if (verification) {
        if (decision === "REUPLOAD")
          await this.prisma.$transaction([
            this.prisma.partnerDocumentVerification.update({
              where: { id: verification.id },
              data: {
                status: "REUPLOAD_REQUIRED",
                failureCode: "DOCUMENT_REUPLOAD_REQUIRED",
              },
            }),
            this.prisma.partnerDocumentUploadIntent.updateMany({
              where: { verificationId: verification.id, type: document.type },
              data: {
                verificationStatus: "REUPLOAD_REQUIRED",
                verificationCode: "DOCUMENT_REUPLOAD_REQUIRED",
              },
            }),
          ]);
        else if (order.documentReviewStatus === "MANUALLY_APPROVED")
          await this.prisma.partnerDocumentVerification.update({
            where: { id: verification.id },
            data: { status: "MANUALLY_APPROVED", failureCode: null },
          });
      }
    }
    if (order.partner && decision === "REUPLOAD")
      await this.emitPartnerDocumentEvent(
        order,
        "document.verification.reupload_required",
        "DOCUMENT_REUPLOAD_REQUIRED",
        document.type,
      );
    if (recordDecision)
      await this.persistence.recordReview(
        order.id,
        documentId,
        actorId,
        decision,
        reason,
      );
    if (decision === "REUPLOAD")
      await this.safeNotify(order, "DOCUMENT_REUPLOAD", reason!.trim());
    if (order.documentReviewStatus === "MANUALLY_APPROVED")
      await this.safeResolveAttention(
        `document-review:${order.id}`,
        "All required documents manually approved",
        actorId,
      );
    else if (decision === "REUPLOAD")
      await this.resilience?.attention({
        dedupeKey: `document-review:${order.id}`,
        category: "DOCUMENT_REUPLOAD",
        entityType: "Order",
        entityId: order.id,
        orderId: order.id,
        summary: "Customer document replacement requested",
        detail: reason!.trim(),
        localState: order.status,
        failureCategory: "MANUAL_REVIEW_REJECTED",
        lastSuccessfulStep: "FULFILLMENT_CONTINUES",
        availableActions: [],
      });
    return this.redact(order);
  }

  async rejectPartnerDocuments(id: string, actorId: string, reason: string) {
    await this.refreshOne(id, true);
    const order = this.get(id);
    if (!order.partner)
      throw new BadRequestException(
        "Terminal document rejection is available only for partner orders",
      );
    if (
      ![OrderStatus.REVIEW_PENDING, OrderStatus.AWAITING_CUSTOMER].includes(
        order.status,
      )
    )
      throw new ConflictException(
        "Only an uncharged pending partner order can be rejected",
      );
    if (!reason.trim())
      throw new BadRequestException("Document rejection reason is required");
    if (reason.trim().length > 1000)
      throw new BadRequestException(
        "Document rejection reason must be 1000 characters or fewer",
      );
    const from = order.status;
    order.documents.forEach((document) => {
      if ([DocumentType.PASSPORT, DocumentType.TICKET].includes(document.type))
        document.status = DocumentStatus.REJECTED;
    });
    order.operationalDisposition = "TERMINAL_REJECTION";
    order.timeline.push({
      from,
      to: OrderStatus.CANCELLED,
      at: new Date().toISOString(),
      reason: `Documents terminally rejected: ${reason.trim()}`,
    });
    order.status = OrderStatus.CANCELLED;
    await this.persistence.save(order);
    const verification =
      await this.prisma.partnerDocumentVerification.findFirst({
        where: { consumedOrderId: id, partnerId: order.partner.id },
        select: { id: true },
      });
    if (verification)
      await this.prisma.$transaction([
        this.prisma.partnerDocumentVerification.update({
          where: { id: verification.id },
          data: { status: "INVALID", failureCode: "DOCUMENTS_REJECTED" },
        }),
        this.prisma.partnerDocumentUploadIntent.updateMany({
          where: {
            verificationId: verification.id,
            type: { in: [DocumentType.PASSPORT, DocumentType.TICKET] },
          },
          data: {
            verificationStatus: "REJECTED",
            verificationCode: "DOCUMENTS_REJECTED",
          },
        }),
      ]);
    await this.emitPartnerDocumentEvent(
      order,
      "document.verification.rejected",
      "DOCUMENTS_REJECTED",
    );
    await this.safeResolveAttention(
      `document-review:${id}`,
      "Partner documents terminally rejected",
      actorId,
    );
    return this.redact(order);
  }
  async approve(id: string, actorId: string) {
    await this.refreshOne(id, true);
    const order = this.get(id);
    if (
      order.partner &&
      order.externalOrderId &&
      !order.payment &&
      order.status === OrderStatus.REVIEW_PENDING
    )
      throw new ConflictException(
        "Verified direct partner orders must be finalized by the partner before provisioning",
      );
    const required = order.documents.filter((document) =>
      [DocumentType.PASSPORT, DocumentType.TICKET].includes(document.type),
    );
    if (
      required.length !== 2 ||
      required.some((document) => document.status !== DocumentStatus.APPROVED)
    )
      throw new BadRequestException(
        "Passport and ticket must be individually approved first",
      );
    const profile = await this.inventory.reserve(order.id);
    this.transition(
      order,
      OrderStatus.APPROVED,
      `Approved by ${actorId}; inventory ${profile.iccid} reserved`,
    );
    this.transition(order, OrderStatus.PROVISIONING);
    await this.persistence.save(order);
    let queued = true;
    try {
      await this.queues.add(
        QUEUES.provisioning,
        "provision-order",
        { orderId: order.id },
        `provision-${order.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Provisioning queue unavailable for ${order.id}: ${error instanceof Error ? error.message : "unknown"}`,
      );
      if (process.env.NODE_ENV === "production") throw error;
      queued = false;
    }
    if (
      (!queued || !this.queues.enabled) &&
      process.env.NODE_ENV !== "production"
    )
      await this.processLocally(order.id);
    return this.redact(order);
  }
  async approveToProvisioning(orderId: string, note: string) {
    await this.refreshOne(orderId, true);
    const order = this.get(orderId);
    if (order.status !== OrderStatus.APPROVED)
      throw new BadRequestException(
        `Order in ${order.status} cannot be auto-approved`,
      );
    if (order.purchaseType === "TOPUP") {
      const target = await this.provisioningTarget(order);
      this.transition(
        order,
        OrderStatus.PROVISIONING,
        target?.inventory
          ? `${note}; top-up on existing eSIM ${target.inventory.iccid}`
          : note,
      );
    } else {
      const profile = await this.inventory.reserve(order.id);
      this.transition(
        order,
        OrderStatus.PROVISIONING,
        `${note}; inventory ${profile.iccid} reserved`,
      );
    }
    await this.persistence.save(order);
    await this.ensureDocumentReviewAttention(order);
    let queued = true;
    try {
      await this.queues.add(
        QUEUES.provisioning,
        "provision-order",
        { orderId: order.id },
        `provision-${order.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Provisioning queue unavailable for ${order.id}: ${error instanceof Error ? error.message : "unknown"}`,
      );
      if (process.env.NODE_ENV === "production") throw error;
      queued = false;
    }
    if (
      (!queued || !this.queues.enabled) &&
      process.env.NODE_ENV !== "production"
    )
      await this.processLocally(order.id);
    return this.redact(order);
  }
  async advanceApprovedIfNeeded(orderId: string) {
    await this.refreshOne(orderId, true);
    const order = this.get(orderId);
    if (order.status !== OrderStatus.APPROVED) return this.redact(order);
    return this.approveToProvisioning(
      orderId,
      "Recovered durable fulfillment handoff",
    );
  }
  async processProvisioning(
    id: string,
    attempt: number,
    finalAttempt: boolean,
  ) {
    await this.refreshOne(id, true);
    const order = this.get(id);
    if (
      order.status === OrderStatus.PROVISIONING &&
      order.qrPayload &&
      order.providerSubscriptionId
    ) {
      this.logger.warn(
        `Order ${id} already has provider activation details; recovering the local QR-ready state without another provisioning request`,
      );
      return this.recoverProvisioningQrReady(id, {
        qrPayload: order.qrPayload,
        providerSubscriptionId: order.providerSubscriptionId,
        ...(order.assignment?.iccid ? { iccid: order.assignment.iccid } : {}),
        reason: "Recovered persisted provider result during provisioning retry",
      });
    }
    if (order.status !== OrderStatus.PROVISIONING || order.qrPayload) {
      this.logger.debug(
        `Order ${id} is not eligible for provisioning; skipping`,
      );
      return;
    }
    const target = await this.provisioningTarget(order);
    const reuseExisting = Boolean(target);
    let profile: { id: string; eid: string; iccid: string } | undefined;
    let request:
      | {
          orderId: string;
          planId: string;
          eid: string;
          purchaseType: "INITIAL_PURCHASE" | "TOPUP";
          traveler: {
            firstName: string;
            surname: string;
            email: string;
            mobile: string;
            city: string;
            countryOfResidence: string;
          };
        }
      | undefined;
    try {
      profile =
        target?.inventory ?? (await this.inventory.profileForOrder(order.id));
      const identity =
        order.purchaseType === "TOPUP"
          ? (target?.traveler ?? {
              email:
                (order.pricingSnapshot as { topUpEmail?: string }).topUpEmail ??
                "",
              mobile: order.topUpMobile ?? "",
              firstName: "Existing",
              surname: "Customer",
              city: "",
              countryOfResidence: "NP",
            })
          : {
              firstName: order.traveler!.firstName,
              surname: order.traveler!.surname,
              email: order.traveler!.email,
              mobile: order.traveler!.mobile,
              city: order.traveler!.city,
              countryOfResidence: order.traveler!.countryOfResidence,
            };
      request = {
        orderId: order.id,
        planId: order.plan.id,
        eid: profile.eid,
        purchaseType: order.purchaseType ?? "INITIAL_PURCHASE",
        traveler: identity,
      };
      const result = await this.connectivity.provision(request);
      await this.persistence.provisioningAttempt(order.id, attempt, request, {
        response: result,
      });
      if (!result.providerSubscriptionId)
        throw new Error(
          "Connectivity provider did not return a subscription id",
        );
      delete order.provisioningFailure;
      delete order.operationalDisposition;
      order.providerSubscriptionId = result.providerSubscriptionId;
      const isTopUp = order.purchaseType === "TOPUP";
      order.providerStatus = isTopUp ? "SUBSCRIBED" : "PRELOADED";
      if (result.status === "DELAYED" || (!isTopUp && !result.qrPayload)) {
        await this.persistence.save(order);
        await this.safeResolveAttention(
          `provisioning-failure:${order.id}`,
          "Provider accepted the provisioning request",
        );
        this.logger.log(
          `Transatel accepted order ${order.id} as ${result.providerSubscriptionId}; waiting for activation details`,
        );
        return this.redact(order);
      }
      if (result.qrPayload) order.qrPayload = result.qrPayload;
      if (!reuseExisting) order.qrDeliveredAt = new Date().toISOString();
      const providerInfo = {
        provider: this.connectivity.descriptor().provider,
        providerSubscriptionId: result.providerSubscriptionId,
      };
      if (reuseExisting)
        await this.inventory.assignTopup(
          order.id,
          await this.inventory.customerIdForOrder(order.id),
          profile.iccid,
          result.qrPayload,
          providerInfo,
        );
      else
        await this.inventory.assign(
          order.id,
          await this.inventory.customerIdForOrder(order.id),
          result.qrPayload!,
          providerInfo,
        );
      const assigned = await this.inventory.inventoryForOrder(order.id);
      if (assigned)
        order.assignment = {
          inventoryId: assigned.id,
          iccid: assigned.iccid,
          ...(assigned.msisdn ? { msisdn: assigned.msisdn } : {}),
          providerSubscriptionId: result.providerSubscriptionId,
          verificationStatus: "PENDING",
        };
      this.transition(
        order,
        isTopUp ? OrderStatus.COMPLETED : OrderStatus.QR_READY,
        isTopUp
          ? `Top-up subscribed on attempt ${attempt}; package added to existing eSIM`
          : `Provisioned on attempt ${attempt}; activation QR delivered`,
      );
      try {
        await this.persistence.save(order);
      } catch (error) {
        if (!this.isOptimisticOrderConflict(error)) throw error;
        if (isTopUp) {
          await this.refreshOne(order.id, true);
          const fresh = this.get(order.id);
          if (fresh.status === OrderStatus.PROVISIONING) {
            fresh.providerSubscriptionId = result.providerSubscriptionId;
            fresh.providerStatus = "SUBSCRIBED";
            this.transition(
              fresh,
              OrderStatus.COMPLETED,
              "Recovered subscribed top-up after concurrent order update",
            );
            await this.persistence.save(fresh);
          }
          if (assigned)
            await this.queueTopUpUsageRefresh(assigned.id, order.id);
          return this.redact(fresh);
        }
        this.logger.warn(
          `Order ${order.id} changed after provider success; reloading and recovering its QR-ready state`,
        );
        return await this.recoverProvisioningQrReady(order.id, {
          qrPayload: result.qrPayload!,
          providerSubscriptionId: result.providerSubscriptionId,
          iccid: profile.iccid,
          reason: "Recovered provider result after concurrent order update",
        });
      }
      await this.safeResolveAttention(
        `provisioning-failure:${order.id}`,
        "Provider accepted the provisioning request",
      );
      if (isTopUp && assigned)
        await this.queueTopUpUsageRefresh(assigned.id, order.id);
      if (!reuseExisting) await this.safeNotify(order, "QR_READY");
      return this.redact(order);
    } catch (error) {
      const errorCode =
        error instanceof ApiException
          ? `${error.code} (HTTP ${error.getStatus()})${error.internalDetail !== undefined ? `: ${typeof error.internalDetail === "string" ? error.internalDetail : JSON.stringify(error.internalDetail)}` : ""}`.slice(
              0,
              2000,
            )
          : error instanceof Error
            ? `${error.name}: ${error.message}`.slice(0, 2000)
            : "UNKNOWN";
      if (request)
        await this.persistence.provisioningAttempt(order.id, attempt, request, {
          errorCode,
        });
      if (
        order.qrPayload &&
        order.providerSubscriptionId &&
        this.isOptimisticOrderConflict(error)
      ) {
        this.logger.warn(
          `Order ${order.id} remains recoverable after a concurrent QR-ready update; retrying will finalize local state without resubmitting`,
        );
        throw error;
      }
      const ambiguousOutcome =
        error instanceof ApiException &&
        String(error.internalDetail ?? "").includes(
          "refusing to submit a duplicate command",
        );
      if (ambiguousOutcome) {
        this.logger.warn(
          `Order ${order.id} has an ambiguous Transatel submission; leaving it in PROVISIONING for reconciliation`,
        );
        throw error;
      }
      const permanentRejection =
        error instanceof ApiException &&
        String(error.internalDetail ?? "").startsWith("PERMANENT_");
      const classifiedFailure = this.classifyProvisioningFailure(error);
      if (
        permanentRejection &&
        !target &&
        this.prisma.enabled &&
        this.maxProvisioningProfileSwaps > 0
      ) {
        const operation = await this.prisma.provisioningOperation.findUnique({
          where: { orderId: order.id },
          select: { profileSwapCount: true },
        });
        if (
          operation &&
          operation.profileSwapCount < this.maxProvisioningProfileSwaps
        ) {
          try {
            const replacement =
              await this.inventory.replacePermanentlyRejectedProfile(
                order.id,
                `Provider permanently rejected provisioning: ${errorCode}`,
              );
            delete order.providerStatus;
            delete order.providerSubscriptionId;
            delete order.provisioningFailure;
            delete order.operationalDisposition;
            order.timeline.push({
              from: OrderStatus.PROVISIONING,
              to: OrderStatus.PROVISIONING,
              at: new Date().toISOString(),
              reason: `Provider rejected ${replacement.previousIccid}; reserved safe replacement ${replacement.replacement.iccid} (${replacement.generation}/${this.maxProvisioningProfileSwaps})`,
            });
            await this.persistence.save(order);
            try {
              await this.queues.add(
                QUEUES.provisioning,
                "provision-order",
                { orderId: order.id },
                `provision-${order.id}-profile-${replacement.generation}`,
              );
            } catch (queueError) {
              await this.resilience?.attention({
                dedupeKey: `provisioning-replacement-handoff:${order.id}`,
                category: "PROVISIONING_ATTENTION",
                entityType: "Order",
                entityId: order.id,
                orderId: order.id,
                summary: `Replacement eSIM is waiting for provisioning for ${order.orderNumber}`,
                detail:
                  queueError instanceof Error
                    ? queueError.message
                    : "Queue handoff failed",
                localState: OrderStatus.PROVISIONING,
                lastSuccessfulStep: "SAFE_REPLACEMENT_RESERVED",
                failureCategory: "QUEUE_HANDOFF_FAILED",
                availableActions: ["RETRY_PROVISIONING"],
              });
            }
            this.logger.warn(
              `Provisioning failover ${order.id}: ${replacement.previousIccid} -> ${replacement.replacement.iccid}`,
            );
            return this.redact(order);
          } catch (replacementError) {
            this.logger.warn(
              `Could not safely replace rejected inventory for ${order.id}: ${replacementError instanceof Error ? replacementError.message : "unknown"}`,
            );
          }
        }
      }
      const inventoryShortage =
        classifiedFailure.code === "INVENTORY_UNAVAILABLE";
      if (inventoryShortage) {
        order.provisioningFailure = classifiedFailure;
        order.operationalDisposition = "RETRY_AUTOMATIC";
        await this.persistence.save(order);
        await this.resilience?.attention({
          dedupeKey: `provisioning-failure:${order.id}`,
          category: "INVENTORY_SHORTAGE",
          entityType: "Order",
          entityId: order.id,
          orderId: order.id,
          summary: `Safe inventory is unavailable for ${order.orderNumber}`,
          detail: errorCode,
          localState: OrderStatus.PROVISIONING,
          lastSuccessfulStep: "PAYMENT_CONFIRMED",
          failureCategory: "INVENTORY_UNAVAILABLE",
          nextRetryAt: new Date(
            Date.now() +
              Number(process.env.PROVISIONING_RECOVERY_RETRY_MINUTES ?? 10) *
                60_000,
          ),
          availableActions: ["RECHECK_INVENTORY"],
        });
        this.logger.warn(
          `Order ${order.id} is waiting for safe inventory; provisioning remains recoverable`,
        );
        throw error;
      }
      if (finalAttempt || permanentRejection) {
        this.metrics?.recordFailure("provisioning", "exhausted");
        if (permanentRejection) order.providerStatus = "REJECTED";
        order.provisioningFailure = classifiedFailure;
        order.operationalDisposition = permanentRejection
          ? "TERMINAL_REJECTION"
          : "MANUAL_ACTION";
        this.transition(
          order,
          OrderStatus.PROVISIONING_FAILED,
          permanentRejection
            ? "Transatel permanently rejected the provisioning request"
            : "Provisioning retries exhausted",
        );
        // release() itself refuses profiles with a provider subscription, so it
        // is safe for every terminal failure, not only explicit rejections.
        await this.inventory.release(order.id);
        await this.persistence.save(order);
        await this.alertProvisioningFailure(order);
        await this.resilience?.attention({
          dedupeKey: `provisioning-failure:${order.id}`,
          category: "PROVISIONING_ATTENTION",
          entityType: "Order",
          entityId: order.id,
          orderId: order.id,
          summary: `Provisioning needs attention for ${order.orderNumber}`,
          detail: errorCode,
          localState: OrderStatus.PROVISIONING_FAILED,
          lastSuccessfulStep: "PAYMENT_CONFIRMED",
          failureCategory: order.provisioningFailure?.code ?? "UNKNOWN",
          availableActions: permanentRejection ? [] : ["RETRY_PROVISIONING"],
        });
      }
      throw error;
    }
  }

  private async queueTopUpUsageRefresh(inventoryId: string, orderId: string) {
    try {
      await this.queues.add(
        QUEUES.reconciliation,
        "reconcile-usage",
        { id: inventoryId, kind: "esim-usage" },
        `topup-usage-${orderId}`,
        { attempts: 5, backoff: { type: "exponential", delay: 15_000 } },
      );
    } catch (error) {
      this.logger.warn(
        `Could not queue immediate usage refresh for top-up ${orderId}: ${error instanceof Error ? error.message : "unknown"}`,
      );
      await this.resilience?.attention({
        dedupeKey: `topup-usage-refresh:${orderId}`,
        category: "SUBSCRIPTION_ASSIGNMENT_CONFLICT",
        entityType: "Order",
        entityId: orderId,
        orderId,
        severity: "WARNING",
        summary: "Immediate top-up balance refresh could not be queued",
        detail:
          "The regular usage reconciliation cycle will retry this package automatically.",
        lastSuccessfulStep: "TOPUP_SUBSCRIBED",
        failureCategory: "USAGE_REFRESH_QUEUE_UNAVAILABLE",
        availableActions: ["RECHECK_ORDER_PROVIDER"],
      });
    }
  }
  /**
   * Finishes the local side of a provisioning operation that already succeeded
   * at the provider. This path deliberately never calls provision(), making it
   * safe for automatic and manual reconciliation after an uncertain DB commit.
   */
  async recoverProvisioningQrReady(
    id: string,
    input: {
      qrPayload: string;
      providerSubscriptionId: string;
      iccid?: string;
      reason?: string;
    },
  ) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await this.refreshOne(id, true);
      const order = this.get(id);
      if ([OrderStatus.QR_READY, OrderStatus.COMPLETED].includes(order.status))
        return this.redact(order);
      if (order.status !== OrderStatus.PROVISIONING)
        throw new BadRequestException(
          `Order in ${order.status} cannot be recovered to QR ready`,
        );

      const target = await this.provisioningTarget(order);
      const customerId = await this.inventory.customerIdForOrder(order.id);
      const providerInfo = {
        provider: this.connectivity.descriptor().provider,
        providerSubscriptionId: input.providerSubscriptionId,
      };
      if (target) {
        await this.inventory.assignTopup(
          order.id,
          customerId,
          input.iccid ?? target.inventory.iccid,
          input.qrPayload,
          providerInfo,
        );
      } else {
        await this.inventory.assign(
          order.id,
          customerId,
          input.qrPayload,
          providerInfo,
        );
      }

      order.qrPayload = input.qrPayload;
      if (!target) order.qrDeliveredAt = new Date().toISOString();
      order.providerSubscriptionId = input.providerSubscriptionId;
      order.providerStatus = "PRELOADED";
      delete order.provisioningFailure;
      delete order.operationalDisposition;
      const assigned = await this.inventory.inventoryForOrder(order.id);
      if (assigned)
        order.assignment = {
          inventoryId: assigned.id,
          iccid: assigned.iccid,
          ...(assigned.msisdn ? { msisdn: assigned.msisdn } : {}),
          providerSubscriptionId: input.providerSubscriptionId,
          verificationStatus: "PENDING",
        };
      this.transition(
        order,
        OrderStatus.QR_READY,
        input.reason ??
          (target
            ? "Recovered provider result; package added to existing eSIM"
            : "Recovered provider QR after local persistence failure"),
      );
      try {
        await this.persistence.save(order);
      } catch (error) {
        if (this.isOptimisticOrderConflict(error) && attempt < maxAttempts) {
          this.logger.warn(
            `QR-ready recovery for ${order.id} raced with another update; retrying from fresh state (${attempt}/${maxAttempts})`,
          );
          continue;
        }
        throw error;
      }
      await this.safeResolveAttention(
        `provisioning-failure:${order.id}`,
        "Provider QR was recovered successfully",
      );
      if (!target) await this.safeNotify(order, "QR_READY");
      return this.redact(order);
    }
    throw new ConflictException(
      "Order recovery exhausted its concurrency retries",
    );
  }

  private isOptimisticOrderConflict(error: unknown) {
    return (
      error instanceof ConflictException &&
      error.message.includes("Order was changed by another request")
    );
  }
  async markProvisioningManualReview(id: string, reason: string) {
    const order = this.get(id);
    if (order.status !== OrderStatus.PROVISIONING) return;
    this.transition(order, OrderStatus.PROVISIONING_FAILED, reason);
    order.provisioningFailure = this.classifyProvisioningFailure(
      new ApiException({
        code: ApiErrorCode.PROVISIONING_FAILED,
        message: reason,
        status: 502,
        details: reason,
      }),
    );
    order.operationalDisposition = "RECONCILE_PROVIDER";
    await this.persistence.save(order);
    await this.alertProvisioningFailure(order);
  }
  async applyProviderEvent(event: ProviderWebhookEvent) {
    if (!event.orderId)
      throw new BadRequestException(
        "Provider event did not include an order id",
      );
    await this.refreshOne(event.orderId, true);
    const order = this.get(event.orderId);
    if (!order)
      throw new NotFoundException(`No active order found for ${event.orderId}`);
    const provider = this.connectivity.descriptor().provider;
    const assignedBeforeEvent = await this.inventory.inventoryForOrder(
      order.id,
    );
    const identityConflict =
      (event.iccid &&
        assignedBeforeEvent?.iccid &&
        event.iccid !== assignedBeforeEvent.iccid) ||
      (event.subscriptionId &&
        order.providerSubscriptionId &&
        event.subscriptionId !== order.providerSubscriptionId);
    if (identityConflict) {
      await this.resilience?.attention({
        dedupeKey: `provider-callback-identity:${order.id}:${event.eventType}:${event.status ?? "UNKNOWN"}`,
        category: "PROVIDER_CALLBACK_IDENTITY_CONFLICT",
        entityType: "Order",
        entityId: order.id,
        orderId: order.id,
        severity: "CRITICAL",
        summary: `Transatel callback identity does not match ${order.orderNumber}`,
        detail:
          "The callback ICCID or subscription belongs to different provider evidence; no lifecycle mutation was applied",
        localState: order.status,
        externalState: event.status ?? event.eventType,
        lastSuccessfulStep: "CALLBACK_RECEIVED",
        failureCategory: "PROVIDER_IDENTITY_CONFLICT",
        availableActions: ["RECONCILE_ORDER_PROVISIONING"],
      });
      throw new BadRequestException(
        "Provider callback identity does not match the assigned eSIM",
      );
    }

    const currentProviderState = order.providerStatus?.toUpperCase();
    const incomingProviderState = event.status?.toUpperCase();
    const currentIsTerminal = ["TERMINATED", "EXPIRED"].includes(
      currentProviderState ?? "",
    );
    const incomingWouldRegress =
      (currentProviderState === "ACTIVATED" &&
        incomingProviderState === "PRELOADED") ||
      (currentIsTerminal &&
        Boolean(incomingProviderState) &&
        incomingProviderState !== currentProviderState);
    if (incomingWouldRegress) {
      if (currentIsTerminal) {
        await this.resilience?.attention({
          dedupeKey: `provider-callback-ordering:${order.id}:${event.eventType}:${incomingProviderState}`,
          category: "PROVIDER_CALLBACK_ORDERING_CONFLICT",
          entityType: "Order",
          entityId: order.id,
          orderId: order.id,
          severity: "HIGH",
          summary: `An older Transatel callback conflicted with ${order.orderNumber}`,
          detail:
            "The callback was retained for audit but ignored because it would replace a terminal provider state",
          ...(currentProviderState ? { localState: currentProviderState } : {}),
          ...(incomingProviderState
            ? { externalState: incomingProviderState }
            : {}),
          lastSuccessfulStep: "CALLBACK_ORDER_VALIDATED",
          failureCategory: "OUT_OF_ORDER_CALLBACK",
          availableActions: ["RECHECK_ORDER_PROVIDER"],
        });
      }
      return {
        accepted: true,
        eventType: event.eventType,
        ignored: true,
        reason: "OUT_OF_ORDER_PROVIDER_STATE",
      };
    }
    if (this.prisma.enabled && event.orderId) {
      const state =
        event.status === "ACTIVATED"
          ? "ACTIVATED"
          : event.status === "PRELOADED"
            ? "WAITING_FOR_QR"
            : undefined;
      if (state)
        await this.prisma.provisioningOperation.updateMany({
          where: {
            orderId: event.orderId,
            ...(event.status === "PRELOADED"
              ? { state: { notIn: ["QR_READY", "ACTIVATED"] } }
              : {}),
          },
          data: {
            state,
            ...(event.subscriptionId
              ? { providerSubscriptionId: event.subscriptionId }
              : {}),
            ...(state === "ACTIVATED"
              ? { completedAt: new Date(), nextReconcileAt: null }
              : { nextReconcileAt: new Date(Date.now() + 60_000) }),
            version: { increment: 1 },
          },
        });
    }
    const lifecycle = {
      provider,
      ...(event.iccid ? { iccid: event.iccid } : {}),
      ...(event.msisdn ? { msisdn: event.msisdn } : {}),
      ...(event.status ? { status: event.status } : {}),
      ...(event.subscriptionId ? { subscriptionId: event.subscriptionId } : {}),
      ...(event.activatedAt ? { activatedAt: event.activatedAt } : {}),
      ...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
    };

    if (
      event.status === "ACTIVATED" &&
      (order.status === OrderStatus.PROVISIONING ||
        order.status === OrderStatus.QR_READY)
    ) {
      const qrPayload = event.qrPayload ?? order.qrPayload;
      if (!qrPayload)
        throw new BadRequestException(
          "Activation event is missing activation details",
        );
      await this.completeProviderActivation(order, {
        qrPayload,
        ...(event.subscriptionId
          ? { subscriptionId: event.subscriptionId }
          : {}),
        ...(event.iccid ? { iccid: event.iccid } : {}),
        ...(event.activatedAt ? { activatedAt: event.activatedAt } : {}),
        label: event.eventType,
      });
      return { accepted: true, eventType: event.eventType };
    }

    await this.inventory.applyLifecycle(order.id, lifecycle);
    const assigned = await this.inventory.inventoryForOrder(order.id);
    if (assigned)
      order.assignment = {
        inventoryId: assigned.id,
        iccid: assigned.iccid,
        ...(assigned.msisdn ? { msisdn: assigned.msisdn } : {}),
        ...(event.subscriptionId
          ? { providerSubscriptionId: event.subscriptionId }
          : {}),
        verificationStatus:
          event.status === "ACTIVATED" ? "VERIFIED" : "PENDING",
        ...(event.status === "ACTIVATED"
          ? { verifiedAt: new Date().toISOString() }
          : {}),
        providerLastSeenAt: new Date().toISOString(),
      };
    if (event.subscriptionId)
      order.providerSubscriptionId = event.subscriptionId;
    if (event.status) order.providerStatus = event.status;
    if (
      this.prisma.enabled &&
      (event.status === "SUSPENDED" || event.status === "TERMINATED")
    ) {
      const expected = await this.prisma.transatelLifecycleOperation.updateMany(
        {
          where: {
            orderId: order.id,
            action: event.status === "SUSPENDED" ? "SUSPEND" : "TERMINATE",
            state: { in: ["ACCEPTED", "CONFIRMED"] },
          },
          data: { state: "CONFIRMED" },
        },
      );
      if (expected.count === 0) {
        await this.resilience?.attention({
          dedupeKey: `unexpected-provider-lifecycle:${order.id}:${event.status}`,
          category: "UNEXPECTED_PROVIDER_LIFECYCLE",
          entityType: "Order",
          entityId: order.id,
          orderId: order.id,
          severity: "CRITICAL",
          summary: `Transatel unexpectedly reported ${event.status.toLowerCase()} for ${order.orderNumber}`,
          detail:
            "No matching approved lifecycle operation exists; service and refund impact require review",
          localState: order.status,
          externalState: event.status,
          lastSuccessfulStep: "ESIM_FULFILLED",
          failureCategory: "UNEXPECTED_PROVIDER_STATE",
          availableActions: ["RECHECK_ORDER_PROVIDER"],
        });
      }
    }
    await this.persistence.save(order);
    return { accepted: true, eventType: event.eventType };
  }
  async retry(id: string) {
    await this.refreshOne(id, true);
    const order = this.get(id);
    if (order.status !== OrderStatus.PROVISIONING_FAILED)
      throw new BadRequestException("Order is not retryable");
    if (this.prisma.enabled) {
      const operation = await this.prisma.provisioningOperation.findUnique({
        where: { orderId: id },
        select: {
          state: true,
          providerOrderId: true,
          providerSubscriptionId: true,
        },
      });
      if (
        operation &&
        (operation.providerOrderId ||
          operation.providerSubscriptionId ||
          !["CREATED", "REJECTED"].includes(operation.state))
      ) {
        throw new BadRequestException(
          "The provider may already have accepted this order. Reconcile its live status from Provisioning recovery instead of retrying.",
        );
      }
      if (operation?.state === "REJECTED") {
        throw new BadRequestException(
          "Transatel rejected this request. Correct the plan, inventory, or provider configuration before creating a replacement order; this order cannot be safely resubmitted.",
        );
      }
    }
    return this.approveProvisioning(order);
  }
  /**
   * Re-delivers the activation QR email for an order whose customer never
   * received the original notification. When an owner id is provided the
   * caller can only resend for their own order. Reuses the same delivery
   * pipeline as the original QR_READY notification (unencrypted QR image).
   */
  async resendQr(id: string, ownerId?: string) {
    await this.refreshOne(id, true);
    const order = this.get(id, ownerId ?? undefined);
    if (order.purchaseType === "TOPUP")
      throw new BadRequestException(
        "This top-up uses the eSIM already installed on the customer's phone; there is no new installation QR to resend",
      );
    if (
      ![
        OrderStatus.QR_READY,
        OrderStatus.COMPLETED,
        OrderStatus.ACTIVATION_ATTENTION,
      ].includes(order.status)
    )
      throw new BadRequestException(
        "QR can only be resent for a ready or completed order",
      );
    if (!order.qrPayload)
      throw new BadRequestException("Order has no activation QR to resend");
    const inventory = await this.inventory.inventoryForOrder(order.id);
    if (!inventory)
      throw new BadRequestException(
        "Order has no assigned eSIM for this installation QR",
      );
    const recipient = this.notifyEmailFor(order);
    if (!recipient)
      throw new BadRequestException(
        "Customer email is required to resend the installation QR",
      );
    if (this.prisma.enabled) {
      const recent = await this.prisma.notification.findFirst({
        where: {
          orderId: order.id,
          template: "QR_READY",
          status: { in: ["QUEUED", "SENDING"] },
          createdAt: { gte: new Date(Date.now() - 60_000) },
        },
        select: { id: true },
      });
      if (recent) return ownerId ? this.redact(order) : this.expand(order);
    }
    await this.notifications.enqueue({
      orderId: order.id,
      channel: "EMAIL",
      template: "QR_READY",
      recipient,
      orderNumber: order.orderNumber,
    });
    order.timeline.push({
      from: order.status,
      to: order.status,
      at: new Date().toISOString(),
      reason: "Installation QR resend queued",
    });
    await this.persistence.save(order);
    this.logger.log(
      `QR resend queued for order ${order.orderNumber} (${order.id})`,
    );
    return ownerId ? this.redact(order) : this.expand(order);
  }
  /**
   * Builds an unencrypted QR PDF so an authenticated owner can download the
   * same activation QR in-account when they did not receive the email.
   */
  async activationQr(id: string, ownerId?: string) {
    const order = this.get(id, ownerId ?? undefined);
    if (
      ![
        OrderStatus.QR_READY,
        OrderStatus.COMPLETED,
        OrderStatus.ACTIVATION_ATTENTION,
      ].includes(order.status)
    )
      throw new BadRequestException(
        "QR is only available for a ready or completed order",
      );
    if (!order.qrPayload)
      throw new BadRequestException("Order has no activation QR");
    const bytes = await this.qrPdf.build({
      qrPayload: order.qrPayload,
      orderNumber: order.orderNumber,
    });
    return {
      filename: `${order.orderNumber}-esim.pdf`,
      contentType: "application/pdf",
      bytes,
    };
  }
  /** QR_READY is successful fulfilment, not an activation deadline. */
  async reconcileStaleActivationOrders() {
    const now = Date.now();
    const recovered: string[] = [];
    const failed: string[] = [];
    const capabilities = this.connectivity.descriptor().capabilities;
    for (const order of this.orders.values()) {
      if (order.status !== OrderStatus.QR_READY || !capabilities.esimDetails)
        continue;
      const last = order.lastProvisioningRecoveryAt
        ? new Date(order.lastProvisioningRecoveryAt).getTime()
        : 0;
      if (now - last < 24 * 60 * 60_000) continue;
      await this.markProvisioningRecovery(order, now);
      try {
        const providerRef = await this.providerRefFor(order);
        const details = await this.connectivity.getEsimDetails(providerRef);
        const subscriptionActive =
          this.connectivity.descriptor().provider === "TRANSATEL"
            ? (
                await this.connectivity.getUsage(providerRef)
              ).subscriptions?.some(
                (subscription) =>
                  (!order.providerSubscriptionId ||
                    subscription.providerSubscriptionId ===
                      order.providerSubscriptionId) &&
                  subscription.status.toUpperCase() === "ACTIVE",
              ) === true
            : ["ACTIVE", "ACTIVATED"].includes(details.status.toUpperCase());
        if (subscriptionActive) {
          await this.completeProviderActivation(order, {
            qrPayload:
              (details as { qrPayload?: string }).qrPayload ?? order.qrPayload!,
            ...(order.providerSubscriptionId
              ? { subscriptionId: order.providerSubscriptionId }
              : {}),
            label: "activation re-fetch",
          });
          recovered.push(order.id);
        } else {
          this.logger.debug(
            `Order ${order.orderNumber} awaits customer installation; keeping QR_READY`,
          );
        }
      } catch (error) {
        this.metrics?.recordFailure("reconciliation", "activation-refetch");
        failed.push(order.id);
        this.logger.warn(
          `Activation observation failed for order ${order.id}; local state was preserved: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
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
    const minAgeMs =
      Number(process.env.PROVISIONING_RECOVERY_MINUTES ?? 2) * 60_000;
    const minGapMs =
      Number(process.env.PROVISIONING_RECOVERY_RETRY_MINUTES ?? 10) * 60_000;
    for (const order of this.orders.values()) {
      if (
        ![OrderStatus.APPROVED, OrderStatus.PROVISIONING].includes(order.status)
      )
        continue;
      if (order.qrPayload) continue;
      const entered = [...order.timeline]
        .reverse()
        .find((event) => event.to === order.status)?.at;
      const enteredAt = entered
        ? new Date(entered).getTime()
        : order.createdAt
          ? new Date(order.createdAt).getTime()
          : 0;
      if (!enteredAt || now - enteredAt < minAgeMs) continue;
      const lastRecovery = order.lastProvisioningRecoveryAt
        ? new Date(order.lastProvisioningRecoveryAt).getTime()
        : 0;
      if (now - lastRecovery < minGapMs) continue;
      try {
        await this.queues.add(
          QUEUES.provisioning,
          "provision-order",
          { orderId: order.id },
          `provision-${order.id}`,
        );
        await this.markProvisioningRecovery(order, now);
        recovered.push(order.id);
        this.logger.log(
          `Recovery sweep re-queued provisioning for order ${order.orderNumber} (${order.id})`,
        );
      } catch (error) {
        await this.markProvisioningRecovery(order, now);
        failed.push(order.id);
        this.metrics?.recordFailure("reconciliation", "provisioning-recovery");
        this.logger.warn(
          `Recovery sweep could not re-queue provisioning for order ${order.id}: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }
    if (recovered.length)
      this.logger.log(
        `Recovery sweep re-queued ${recovered.length} stuck order(s)`,
      );
    return { recovered, failed };
  }
  async recoverApprovedOrders() {
    if (!this.prisma.enabled) return { recovered: [], failed: [] };
    const rows = await this.prisma.order.findMany({
      where: {
        status: "APPROVED",
        updatedAt: { lte: new Date(Date.now() - 30_000) },
      },
      select: { id: true },
      take: 100,
      orderBy: { updatedAt: "asc" },
    });
    const recovered: string[] = [];
    const failed: string[] = [];
    for (const row of rows) {
      try {
        await this.refreshOne(row.id, true);
        await this.approveToProvisioning(
          row.id,
          "Recovered accepted order during reconciliation",
        );
        recovered.push(row.id);
      } catch (error) {
        failed.push(row.id);
        this.logger.warn(
          `Approved order recovery failed for ${row.id}: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }
    return { recovered, failed };
  }
  private async nextActivationRefetchAttempt(order: DemoOrder) {
    if (!this.prisma.enabled) {
      order.activationRefetchAttempts =
        (order.activationRefetchAttempts ?? 0) + 1;
      return order.activationRefetchAttempts;
    }
    const updated = await this.prisma.order.update({
      where: { id: order.id },
      data: { activationRefetchAttempts: { increment: 1 } },
      select: { activationRefetchAttempts: true },
    });
    order.activationRefetchAttempts = updated.activationRefetchAttempts;
    return updated.activationRefetchAttempts;
  }
  private async clearActivationRefetchAttempts(order: DemoOrder) {
    order.activationRefetchAttempts = 0;
    if (this.prisma.enabled)
      await this.prisma.order.update({
        where: { id: order.id },
        data: { activationRefetchAttempts: 0 },
      });
  }
  private async markProvisioningRecovery(order: DemoOrder, at: number) {
    const value = new Date(at).toISOString();
    order.lastProvisioningRecoveryAt = value;
    if (this.prisma.enabled)
      await this.prisma.order.update({
        where: { id: order.id },
        data: { lastProvisioningRecoveryAt: new Date(at) },
      });
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
      } catch {
        /* fall through to the subscription/reference id */
      }
    }
    return order.providerSubscriptionId ?? order.id;
  }
  /**
   * Completes an order once the provider has delivered its activation details
   * and QR payload. Shared by the ACTIVATED webhook handler and the QR_READY
   * recovery sweep so a recovered order follows the exact webhook path.
   */
  private async completeProviderActivation(
    order: DemoOrder,
    input: {
      qrPayload: string;
      subscriptionId?: string;
      iccid?: string;
      activatedAt?: string;
      label?: string;
    },
  ) {
    const wasReady = order.status === OrderStatus.QR_READY;
    order.qrPayload = input.qrPayload;
    if (input.subscriptionId)
      order.providerSubscriptionId = input.subscriptionId;
    order.providerStatus = "ACTIVATED";
    order.activatedAt = input.activatedAt ?? new Date().toISOString();
    const provider = this.connectivity.descriptor().provider;
    const lifecycle = {
      provider,
      status: "ACTIVATED" as const,
      ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}),
      ...(input.iccid ? { iccid: input.iccid } : {}),
      ...(order.activatedAt ? { activatedAt: order.activatedAt } : {}),
    };
    if (provider === "TRANSATEL" && input.subscriptionId) {
      const topupTarget = await this.provisioningTarget(order);
      const target =
        topupTarget?.inventory ??
        (await this.inventory.inventoryForOrder(order.id));
      if (!target?.iccid)
        throw new Error(
          "Assigned eSIM could not be resolved for provider verification",
        );
      if (input.iccid && input.iccid !== target.iccid) {
        await this.resilience?.attention({
          dedupeKey: `provider-activation-conflict:${order.id}:${input.subscriptionId}`,
          category: "PROVISIONING_IDENTITY_CONFLICT",
          entityType: "Order",
          entityId: order.id,
          orderId: order.id,
          severity: "CRITICAL",
          summary: `Transatel activation identity does not match ${order.orderNumber}`,
          detail: `Expected ICCID ${target.iccid}; provider reported ${input.iccid}`,
          localState: order.status,
          externalState: "ACTIVATED",
          lastSuccessfulStep: "PROVIDER_SUBMISSION",
          failureCategory: "PROVIDER_ICCID_MISMATCH",
          availableActions: ["RECONCILE_ORDER_PROVISIONING"],
        });
        throw new ConflictException(
          "Provider activation belongs to a different eSIM",
        );
      }
      const usage = await this.connectivity.getUsage(target.iccid);
      if (
        !usage.subscriptions?.some(
          (item) => item.providerSubscriptionId === input.subscriptionId,
        )
      ) {
        await this.resilience?.attention({
          dedupeKey: `provider-activation-conflict:${order.id}:${input.subscriptionId}`,
          category: "PROVISIONING_IDENTITY_CONFLICT",
          entityType: "Order",
          entityId: order.id,
          orderId: order.id,
          severity: "CRITICAL",
          summary: `Transatel subscription does not belong to ${order.orderNumber}`,
          detail:
            "The activated subscription was not present on the assigned ICCID",
          localState: order.status,
          externalState: "ACTIVATED",
          lastSuccessfulStep: "PROVIDER_SUBMISSION",
          failureCategory: "PROVIDER_SUBSCRIPTION_MISMATCH",
          availableActions: ["RECONCILE_ORDER_PROVISIONING"],
        });
        throw new Error(
          "Provider subscription is not present on the assigned eSIM",
        );
      }
    }
    await this.activateOrder(
      order,
      input.qrPayload,
      provider,
      input.subscriptionId,
    );
    await this.inventory.applyLifecycle(order.id, lifecycle);
    const assigned = await this.inventory.inventoryForOrder(order.id);
    if (assigned)
      order.assignment = {
        inventoryId: assigned.id,
        iccid: assigned.iccid,
        ...(assigned.msisdn ? { msisdn: assigned.msisdn } : {}),
        ...(input.subscriptionId
          ? { providerSubscriptionId: input.subscriptionId }
          : {}),
        verificationStatus: "VERIFIED",
        verifiedAt: new Date().toISOString(),
        providerLastSeenAt: new Date().toISOString(),
      };
    this.transition(
      order,
      OrderStatus.COMPLETED,
      `Provider ${input.label ? `${input.label} ` : ""}delivered activation`,
    );
    delete order.provisioningFailure;
    delete order.operationalDisposition;
    await this.persistence.save(order);
    await this.safeResolveAttention(
      `provisioning-failure:${order.id}`,
      "Provider activation was confirmed",
    );
    await this.safeResolveAttention(
      `activation-attention:${order.id}`,
      "Provider activation was confirmed",
    );
    if (!wasReady && order.purchaseType !== "TOPUP")
      await this.safeNotify(order, "QR_READY");
  }
  private async activateOrder(
    order: DemoOrder,
    qrPayload: string,
    provider: string,
    subscriptionId?: string,
  ) {
    const customerId = await this.inventory.customerIdForOrder(order.id);
    const providerInfo = {
      provider,
      ...(subscriptionId ? { providerSubscriptionId: subscriptionId } : {}),
    };
    const target = await this.provisioningTarget(order);
    if (target) {
      await this.inventory.assignTopup(
        order.id,
        customerId,
        target.inventory.iccid,
        qrPayload,
        providerInfo,
      );
      return;
    }
    await this.inventory.assign(order.id, customerId, qrPayload, providerInfo);
  }
  private async provisioningTarget(order: DemoOrder) {
    const targetEsimId =
      order.targetInventoryId ??
      (order.pricingSnapshot as { targetEsimId?: string }).targetEsimId;
    if (!targetEsimId || !this.prisma.enabled) return null;
    const row = await this.prisma.esimInventory.findUnique({
      where: { id: targetEsimId },
      include: {
        customerEsims: {
          where: { order: { orderType: "INITIAL_PURCHASE" } },
          take: 1,
          orderBy: { assignedAt: "desc" },
          include: { order: { include: { traveler: true } } },
        },
      },
    });
    if (!row) throw new NotFoundException("Target eSIM is no longer available");
    const traveler = row.customerEsims[0]?.order.traveler;
    return {
      inventory: { id: row.id, eid: row.eid, iccid: row.iccid },
      ...(traveler
        ? {
            traveler: {
              firstName: traveler.firstName,
              surname: traveler.surname,
              email: traveler.email,
              mobile: traveler.mobile,
              city: traveler.city,
              countryOfResidence: traveler.countryOfResidence,
            },
          }
        : {}),
    };
  }
  private markAutoApproved(order: DemoOrder) {
    this.transition(order, OrderStatus.APPROVED, "Auto-approved after payment");
    this.transition(order, OrderStatus.PROVISIONING);
  }
  private async enqueueProvisioning(order: DemoOrder, jobId: string) {
    try {
      await this.queues.add(
        QUEUES.provisioning,
        "provision-order",
        { orderId: order.id },
        jobId,
      );
    } catch (error) {
      // The durable order state is recovered by boot/reconciliation. Never
      // propagate this after a payment has been confirmed.
      this.logger.error(
        `Provisioning queue unavailable for ${order.id}: ${error instanceof Error ? error.message : "unknown"}`,
      );
      return;
    }
    if (!this.queues.enabled) await this.processLocally(order.id);
  }
  private async approveProvisioning(order: DemoOrder) {
    this.transition(order, OrderStatus.PROVISIONING, "Manual retry");
    await this.persistence.save(order);
    await this.queues.add(
      QUEUES.provisioning,
      "provision-order",
      { orderId: order.id },
      `retry-${order.id}-${Date.now()}`,
    );
    if (!this.queues.enabled) return this.processLocally(order.id);
    return this.redact(order);
  }
  private async processLocally(orderId: string) {
    let failure: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.processProvisioning(orderId, attempt, attempt === 3);
      } catch (error) {
        failure = error;
      }
    }
    throw failure;
  }
  private transition(order: DemoOrder, to: OrderStatus, reason?: string) {
    assertTransition(order.status, to);
    const from = order.status;
    order.status = to;
    order.timeline.push({
      from,
      to,
      at: new Date().toISOString(),
      ...(reason ? { reason } : {}),
    });
  }
  private notifyEmailFor(order: DemoOrder) {
    return (
      order.traveler?.email ??
      (order.pricingSnapshot as { topUpEmail?: string }).topUpEmail
    );
  }
  private classifyProvisioningFailure(error: unknown) {
    if (
      error instanceof ConflictException &&
      /inventory|available/i.test(error.message)
    )
      return provisioningFailure("INVENTORY_UNAVAILABLE");
    if (error instanceof ApiException) {
      switch (error.code) {
        case ApiErrorCode.INVENTORY_UNAVAILABLE:
          return provisioningFailure("INVENTORY_UNAVAILABLE");
        case ApiErrorCode.PLAN_NOT_AVAILABLE:
        case ApiErrorCode.PLAN_UNAVAILABLE:
        case ApiErrorCode.PRODUCT_UNAVAILABLE:
          return provisioningFailure("PLAN_UNAVAILABLE");
        case ApiErrorCode.CONNECTIVITY_UNAVAILABLE:
        case ApiErrorCode.PROVISIONING_FAILED:
          return provisioningFailure("PROVIDER_UNAVAILABLE");
        default:
          return provisioningFailure("UNKNOWN");
      }
    }
    return provisioningFailure("UNKNOWN");
  }
  private async safeNotify(
    order: DemoOrder,
    template: "QR_READY" | "DOCUMENT_REUPLOAD",
    reason?: string,
  ) {
    const recipient = this.notifyEmailFor(order);
    if (!recipient) return;
    try {
      await this.notifications.enqueue({
        orderId: order.id,
        channel: "EMAIL",
        template,
        recipient,
        orderNumber: order.orderNumber,
        ...(reason ? { reason } : {}),
      });
    } catch (error) {
      this.logger.error(
        `Notification enqueue failed for order ${order.id}: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }
  /**
   * Alerts operators (OPS_ALERT_EMAIL) when a provisioning run fails after its
   * retries are exhausted. The alert is best-effort and never blocks the order
   * failure path.
   */
  private async alertProvisioningFailure(order: DemoOrder) {
    const recipient = process.env.OPS_ALERT_EMAIL;
    if (!recipient) {
      this.logger.error(
        `PROVISIONING_FAILED for order ${order.orderNumber} (${order.id}). Configure OPS_ALERT_EMAIL to receive an alert.`,
      );
      return;
    }
    try {
      await this.notifications.enqueue({
        orderId: order.id,
        channel: "EMAIL",
        template: "OPS_ALERT",
        recipient,
        orderNumber: order.orderNumber,
        reason: `PROVISIONING_FAILED: provisioning retries exhausted for order ${order.orderNumber}`,
      });
      this.logger.error(
        `Ops alert queued for PROVISIONING_FAILED order ${order.orderNumber}`,
      );
    } catch (error) {
      this.logger.error(
        `Ops alert enqueue failed for order ${order.id}: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }
  private async safeResolveAttention(
    dedupeKey: string,
    resolution: string,
    actorId: string | null = null,
  ) {
    try {
      const internalActor = actorId
        ? await this.prisma.user.findUnique({
            where: { clerkId: actorId },
            select: { id: true },
          })
        : null;
      await this.resilience?.resolve(
        dedupeKey,
        internalActor?.id ?? null,
        resolution,
      );
    } catch (error) {
      this.logger.warn(
        `Attention resolution ${dedupeKey} failed with actor attribution; retrying without attribution: ${error instanceof Error ? error.message : "unknown"}`,
      );
      try {
        await this.resilience?.resolve(dedupeKey, null, resolution);
      } catch (retryError) {
        this.logger.error(
          `Attention resolution ${dedupeKey} remains deferred after retry: ${retryError instanceof Error ? retryError.message : "unknown"}`,
        );
      }
    }
  }
  private async emitPartnerDocumentEvent(
    order: DemoOrder,
    type: string,
    failureCode: string,
    documentType?: DocumentType,
  ) {
    if (!order.partner) return;
    const verification =
      await this.prisma.partnerDocumentVerification.findFirst({
        where: { consumedOrderId: order.id, partnerId: order.partner.id },
        select: { id: true },
      });
    if (!verification) return;
    const endpoints = await this.prisma.partnerWebhookEndpoint.findMany({
      where: { partnerId: order.partner.id, active: true },
    });
    const eligible = endpoints.filter((endpoint) => {
      const types = Array.isArray(endpoint.eventTypes)
        ? endpoint.eventTypes.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      return types.includes("*") || types.includes(type);
    });
    await this.prisma.partnerEvent.create({
      data: {
        partnerId: order.partner.id,
        orderId: order.id,
        type,
        resourceId: verification.id,
        correlationId: randomUUID(),
        payload: {
          orderId: order.id,
          externalOrderId: order.externalOrderId ?? null,
          verificationId: verification.id,
          status:
            failureCode === "DOCUMENTS_REJECTED"
              ? "INVALID"
              : "REUPLOAD_REQUIRED",
          failureCode,
          ...(documentType ? { documentType } : {}),
        },
        deliveries: {
          create: eligible.map((endpoint) => ({ endpointId: endpoint.id })),
        },
      },
    });
  }
  private expand(order: DemoOrder) {
    const { qrPayload: _qrPayload, ...safe } = order;
    return safe;
  }
  private redact(order: DemoOrder) {
    const {
      ownerId: _ownerId,
      beneficiaryCustomerId: _beneficiaryCustomerId,
      purchasedByUserId: _purchasedByUserId,
      targetInventoryId: _targetInventoryId,
      checkoutAttemptKey: _checkoutAttemptKey,
      checkoutRequestHash: _checkoutRequestHash,
      providerSubscriptionId: _providerSubscriptionId,
      providerStatus: _providerStatus,
      qrPayload: _qrPayload,
      assignment: rawAssignment,
      ...safe
    } = order;
    const documents = safe.documents.map(
      ({ privateAssetId: _privateAssetId, ...document }) => document,
    );
    const payment = safe.payment
      ? (({
          correlationId: _correlationId,
          providerTransactionId: _providerTransactionId,
          ...rest
        }) => rest)(safe.payment)
      : undefined;
    const timeline = safe.timeline.map((event) => ({
      ...event,
      ...(event.reason
        ? {
            reason:
              event.reason
                .replace(
                  /\s+\(?(requested by|approved by|assigned by)\s+user_[A-Za-z0-9_]+\)?\.?$/i,
                  "",
                )
                .trim() || undefined,
          }
        : {}),
    }));
    const pricingSnapshot = {
      ...(safe.pricingSnapshot as Record<string, unknown>),
    };
    delete pricingSnapshot.topUpEmail;
    delete pricingSnapshot.topUpIdentity;
    const assignment = rawAssignment
      ? {
          verificationStatus: rawAssignment.verificationStatus,
          verifiedAt: rawAssignment.verifiedAt,
          providerLastSeenAt: rawAssignment.providerLastSeenAt,
        }
      : undefined;
    const purchaseContext =
      safe.purchaseType === "TOPUP"
        ? "TOPUP"
        : typeof pricingSnapshot.targetEsimId === "string"
          ? "NEW_DESTINATION"
          : "FIRST_PURCHASE";
    return {
      ...safe,
      purchaseContext,
      pricingSnapshot,
      documents,
      ...(payment ? { payment } : {}),
      ...(assignment ? { assignment } : {}),
      timeline,
    } as unknown as DemoOrder;
  }
}
