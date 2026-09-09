import type { PaymentInitiation } from "../payments/payment-gateway.js";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
} from "@visa-compass/shared";
import type { AuthenticatedUser } from "../../common/auth.guard.js";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { CryptoService } from "../../infrastructure/crypto.service.js";
import { OrdersService, type DemoOrder } from "./orders.service.js";
import { GuestOrderAccessService } from "./guest-order-access.service.js";
import { NotificationService } from "../notification/notification.service.js";
import { PaymentsService } from "../payments/payments.service.js";
import { resolveRechargeOwner } from "./recharge-ownership.js";

export type RechargeInput = {
  planId: string;
  termsAccepted: boolean;
  privacyAccepted: boolean;
  compatibilityAccepted?: boolean | undefined;
  checkoutAttemptKey: string;
  lookupToken?: string | undefined;
  targetEsimId?: string | undefined;
};
export function rechargeView(order: DemoOrder) {
  // Allowlist: never return ownership, traveler, documents, QR, or raw provider responses.
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    purchaseType: "TOPUP" as const,
    status: order.status,
    version: order.version,
    plan: order.plan,
    totalAmountNpr: order.totalAmountNpr,
    createdAt: order.createdAt,
    documents: [],
    timeline: order.timeline.map(({ from, to, at }) => ({ from, to, at })),
    payment: order.payment
      ? {
          provider: order.payment.provider,
          reference: order.payment.reference,
          status: order.payment.status,
          expiresAt: order.payment.expiresAt,
        }
      : undefined,
    paymentState: order.payment?.status ?? "NOT_STARTED",
    rechargeState: order.status,
    refundStatus: order.refundStatus,
    nextAction:
      order.status === OrderStatus.REFUNDED ||
      order.status === OrderStatus.CANCELLED
        ? "CLOSED"
        : order.status === OrderStatus.REFUND_PENDING
          ? "WAIT"
          : order.status === OrderStatus.PAYMENT_REVIEW_REQUIRED
            ? "OPERATIONS_REVIEW"
            : order.status === OrderStatus.PROVISIONING_FAILED
              ? "OPERATIONS_REVIEW"
              : order.status === OrderStatus.PAYMENT_FAILED ||
                  order.status === OrderStatus.DRAFT
                ? "PAY"
                : order.status === OrderStatus.COMPLETED
                  ? "COMPLETE"
                  : "WAIT",
  };
}

function paymentView(
  payment: Pick<PaymentInitiation, "reference"> & Partial<PaymentInitiation>,
) {
  return {
    reference: payment.reference,
    redirectUrl: payment.redirectUrl,
    expiresAt: payment.expiresAt,
    ...(payment.qrDataUrl ? { qrDataUrl: payment.qrDataUrl } : {}),
    ...(payment.qrPayload ? { qrPayload: payment.qrPayload } : {}),
    ...(payment.websocketUrl ? { websocketUrl: payment.websocketUrl } : {}),
    ...(payment.banks
      ? {
          banks: payment.banks.map(
            ({ bankName, bankCode, bankIcon, packageName, intentScheme }) => ({
              bankName,
              bankCode,
              bankIcon,
              packageName,
              intentScheme,
            }),
          ),
        }
      : {}),
  };
}

@Injectable()
export class RechargesService {
  private readonly logger = new Logger(RechargesService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly access: GuestOrderAccessService,
    private readonly notifications: NotificationService,
    private readonly payments: PaymentsService,
    private readonly crypto: CryptoService,
  ) {}

  async target(inventoryId: string) {
    const originals = await this.prisma.order.findMany({
      where: {
        orderType: "INITIAL_PURCHASE",
        customerEsim: { is: { inventoryId } },
      },
      include: {
        customer: { include: { user: true } },
        traveler: true,
        customerEsim: { include: { inventory: true } },
      },
    });
    const original = resolveRechargeOwner(originals);
    const inventory = original.customerEsim!.inventory;
    if (
      !["QR_READY", "COMPLETED"].includes(original.status) ||
      !inventory.msisdn ||
      !original.traveler?.email ||
      original.customer.status === "BLOCKED"
    )
      throw new ConflictException(
        "This eSIM is not eligible for recharge; contact support",
      );
    return {
      inventoryId,
      originalOrderId: original.id,
      customerId: original.customerId,
      ownerId: original.customer.user?.clerkId ?? original.customerId,
      email: original.traveler.email,
      mobile: inventory.msisdn,
    };
  }

  async eligibleTargets(user: AuthenticatedUser) {
    if (user.accountType !== "CUSTOMER" || user.mustChangePassword)
      throw new ForbiddenException("A customer account is required");
    if (!this.prisma.enabled)
      throw new BadRequestException("Recharge requires database persistence");
    // Only the owner of an initial purchase can automatically reuse its eSIM.
    // Paying for somebody else's recharge does not establish ownership.
    const originals = await this.prisma.order.findMany({
      where: {
        orderType: "INITIAL_PURCHASE",
        status: { in: ["QR_READY", "COMPLETED"] },
        documentReviewStatus: { in: ["VERIFIED", "MANUALLY_APPROVED"] },
        customer: { user: { clerkId: user.id }, status: { not: "BLOCKED" } },
        customerEsim: { isNot: null },
      },
      select: {
        customerEsim: {
          select: {
            inventoryId: true,
            inventory: { select: { iccid: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    const candidates = new Map(
      originals.flatMap((order) =>
        order.customerEsim
          ? [[order.customerEsim.inventoryId, order.customerEsim] as const]
          : [],
      ),
    );
    const targets = await Promise.all(
      [...candidates.values()].map(async (candidate) => {
        try {
          const target = await this.target(candidate.inventoryId);
          if (target.ownerId !== user.id) return null;
          return {
            id: target.inventoryId,
            label: `Travel eSIM · ${candidate.inventory.iccid.slice(-4)}`,
          };
        } catch (error) {
          if (
            error instanceof ConflictException ||
            error instanceof NotFoundException
          )
            return null;
          throw error;
        }
      }),
    );
    return { targets: targets.filter((target) => target !== null) };
  }

  async targetFromLookup(token: string) {
    const claims = this.access.rechargeLookupClaims(token);
    const target = await this.target(claims.inventoryId);
    if (
      target.originalOrderId !== claims.originalOrderId ||
      target.customerId !== claims.customerId ||
      target.mobile !== claims.mobile ||
      createHash("sha256")
        .update(target.email.trim().toLowerCase())
        .digest("hex") !== claims.recipientHash
    )
      throw new ForbiddenException(
        "The recharge link is no longer valid. Request a new link",
      );
    return target;
  }

  async create(
    input: RechargeInput,
    user?: AuthenticatedUser,
    context?: {
      ipAddress?: string | undefined;
      userAgent?: string | undefined;
    },
  ) {
    if (user?.mustChangePassword)
      throw new ForbiddenException("Update your password before continuing");
    if (!this.prisma.enabled)
      throw new BadRequestException("Recharge requires database persistence");
    if (
      !input.termsAccepted ||
      !input.privacyAccepted ||
      !/^[a-zA-Z0-9_-]{20,100}$/.test(input.checkoutAttemptKey ?? "")
    )
      throw new BadRequestException(
        "Consent and a valid checkout attempt are required",
      );
    if (Boolean(input.lookupToken) === Boolean(input.targetEsimId))
      throw new BadRequestException("Select one recharge authorization method");
    const target = input.lookupToken
      ? await this.targetFromLookup(input.lookupToken)
      : await this.target(input.targetEsimId!);
    if (!input.lookupToken && (!user || target.ownerId !== user.id))
      throw new NotFoundException("eSIM not found");
    // A verified email link authorizes one recharge checkout. Deriving the
    // attempt key from the bearer token makes retries idempotent while stopping
    // the same forwarded link from creating a second order with a new client key.
    const checkoutAttemptKey = input.lookupToken
      ? createHash("sha256").update(`recharge:${input.lookupToken}`).digest("hex")
      : input.checkoutAttemptKey;
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          planId: input.planId,
          target: target.inventoryId,
          customer: target.customerId,
          purchaser: user?.localUserId ?? null,
          terms: input.termsAccepted,
          privacy: input.privacyAccepted,
        }),
      )
      .digest("hex");
    let stored = await this.prisma.order.findUnique({
      where: { checkoutAttemptKey },
    });
    if (!stored) {
      try {
        const orderId = randomUUID();
        const recoveryToken = randomBytes(32).toString("base64url");
        const recoveryUrl = `${process.env.CUSTOMER_WEB_URL ?? "http://localhost:3000"}/esim/checkout?order=${orderId}&recharge=1#resume=${recoveryToken}`;
        const recovery = {
          recipient: target.email,
          recipientHash: createHash("sha256")
            .update(target.email.trim().toLowerCase())
            .digest("hex"),
          tokenHash: createHash("sha256").update(recoveryToken).digest("hex"),
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
          recoveryUrlEncrypted: this.crypto.encrypt(recoveryUrl),
        };
        const created = await this.orders.create(
          target.ownerId,
          input.planId,
          true,
          {
            ...(context?.ipAddress ? { ipAddress: context.ipAddress } : {}),
            ...(context?.userAgent ? { userAgent: context.userAgent } : {}),
            mobile: target.mobile,
            email: target.email,
            termsAccepted: true,
            privacyAccepted: true,
            recharge: {
              orderId,
              recovery,
              customerId: target.customerId,
              inventoryId: target.inventoryId,
              purchasedByUserId: user?.localUserId,
              checkoutAttemptKey,
              checkoutRequestHash: hash,
            },
          },
        );
        stored = await this.prisma.order.findUniqueOrThrow({
          where: { id: created.id },
        });
      } catch (error) {
        if ((error as { code?: string }).code !== "P2002") throw error;
        stored = await this.prisma.order.findUnique({
          where: { checkoutAttemptKey },
        });
        if (!stored) throw error;
      }
    } else this.logger.log(`Recharge checkout replay: ${stored.id}`);
    if (stored.checkoutRequestHash !== hash)
      throw new ConflictException(
        "This checkout attempt was already used for a different purchase",
      );
    await this.ensureRecovery(stored.id, target.email);
    await this.orders.refreshOne(stored.id, true);
    return {
      order: rechargeView(this.orders.get(stored.id)),
      token: this.access.createSessionToken(stored.id),
      recovery: await this.access.issue(stored.id, "DISPLAY"),
    };
  }

  async authorize(id: string, user?: AuthenticatedUser, token?: string) {
    await this.orders.refreshOne(id, true);
    const order = this.orders.get(id);
    if (order.purchaseType !== "TOPUP")
      throw new NotFoundException("Recharge not found");
    if (user?.mustChangePassword)
      throw new ForbiddenException("Update your password before continuing");
    if (
      user &&
      (order.ownerId === user.id ||
        order.purchasedByUserId === user.localUserId ||
        user.accountType === "OPERATIONS" ||
        user.accountType === "SUPER_ADMIN")
    )
      return order;
    try {
      this.access.assertSessionToken(id, token ?? "");
    } catch {
      this.logger.warn(`Recharge access denied: ${id}`);
      throw new NotFoundException("Recharge not found");
    }
    return order;
  }

  async recover(id: string, token: string) {
    await this.orders.refreshOne(id, true);
    if (this.orders.get(id).purchaseType !== "TOPUP")
      throw new NotFoundException("Recharge not found");
    const result = await this.access.recover(id, token);
    return { ...result, order: rechargeView(this.orders.get(id)) };
  }

  async ensureRecovery(id: string, email?: string, rotate = false) {
    const row = await this.prisma.order.findUniqueOrThrow({
      where: { id },
      include: { customerEsim: true },
    });
    const inventoryId =
      row.targetInventoryId ??
      row.customerEsim?.inventoryId ??
      (row.pricingSnapshot as { targetEsimId?: string })?.targetEsimId;
    if (!inventoryId)
      throw new ConflictException("Recharge target needs operations review");
    const target = await this.target(inventoryId);
    if (row.targetInventoryId && row.customerId !== target.customerId) {
      this.logger.error(`Recharge beneficiary mismatch: ${id}`);
      throw new ConflictException("Recharge ownership needs operations review");
    }
    const recipient = email ?? target.email;
    const dedupeKey = `recharge-recovery:${id}`;
    const rawToken = randomBytes(32).toString("base64url");
    const recoveryUrl = `${process.env.CUSTOMER_WEB_URL ?? "http://localhost:3000"}/esim/checkout?order=${encodeURIComponent(id)}&recharge=1#resume=${rawToken}`;
    const notification = await this.prisma.$transaction(async (tx) => {
      // Serialize issuance so link rotation and notification payload stay consistent.
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${id}::uuid FOR UPDATE`;
      const previous = await tx.notification.findUnique({
        where: { dedupeKey },
      });
      if (previous && !rotate) return previous;
      if (rotate)
        await tx.guestOrderAccessToken.updateMany({
          where: { orderId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      await tx.guestOrderAccessToken.create({
        data: {
          orderId: id,
          purpose: "EMAIL",
          tokenHash: createHash("sha256").update(rawToken).digest("hex"),
          recipientHash: createHash("sha256")
            .update(recipient.trim().toLowerCase())
            .digest("hex"),
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
        },
      });
      const data = {
        recipient,
        orderNumber: row.orderNumber,
        recoveryUrlEncrypted: this.crypto.encrypt(recoveryUrl),
        status: "QUEUED",
        nextAttemptAt: new Date(),
        attemptCount: 0,
        sentAt: null,
        errorMessage: null,
      };
      return tx.notification.upsert({
        where: { dedupeKey },
        update: data,
        create: {
          id: randomUUID(),
          orderId: id,
          channel: "EMAIL",
          template: "RECHARGE_RECOVERY",
          dedupeKey,
          ...data,
        },
      });
    });
    if (!["SENT", "SIMULATED"].includes(notification.status)) {
      try {
        await this.notifications.retry(
          notification.id,
          recipient,
          row.orderNumber,
        );
      } catch (error) {
        await this.notifications.markFailure(notification.id, error, false);
        this.logger.warn(`Recharge tracking delivery pending: ${id}`);
      }
    }
  }

  async requestRecovery(orderNumber: string, email: string) {
    const generic = {
      message:
        "If these details match a recharge, a tracking link will be sent to its recovery email.",
    };
    const row = await this.prisma.order.findFirst({
      where: { orderNumber, orderType: "TOPUP" },
      include: { customerEsim: true },
    });
    if (!row) return generic;
    try {
      const target = await this.target(
        row.targetInventoryId ??
          row.customerEsim?.inventoryId ??
          (row.pricingSnapshot as { targetEsimId?: string })?.targetEsimId ??
          "",
      );
      const digest = (value: string) =>
        createHash("sha256").update(value.trim().toLowerCase()).digest();
      if (timingSafeEqual(digest(target.email), digest(email)))
        await this.ensureRecovery(row.id, target.email, true);
    } catch {
      this.logger.warn(
        `Recharge recovery request could not be completed: ${row.id}`,
      );
    }
    return generic;
  }

  async pay(
    id: string,
    provider: PaymentProvider,
    user?: AuthenticatedUser,
    token?: string,
  ) {
    const order = await this.authorize(id, user, token);
    await this.ensureRecovery(id);
    if (order.payment?.status === PaymentStatus.PENDING) {
      await this.payments.verify(id, order.ownerId, order.payment.reference);
      await this.orders.refreshOne(id, true);
      const latest = this.orders.get(id);
      if (latest.payment?.status === PaymentStatus.PENDING) {
        const payment = latest.payment;
        if (
          payment.provider === provider &&
          payment.expiresAt &&
          new Date(payment.expiresAt) > new Date()
        ) {
          const initiation = await this.prisma.paymentInitiation.findUnique({
            where: { orderId: id },
          });
          const stored = initiation?.result as PaymentInitiation | null;
          if (
            initiation?.status === "COMPLETED" &&
            stored?.reference === payment.reference
          )
            return paymentView(stored);
          if (provider === PaymentProvider.FONEPAY || !payment.redirectUrl)
            throw new ConflictException(
              "Payment details need verification; do not pay again",
            );
          return {
            reference: payment.reference,
            redirectUrl: payment.redirectUrl,
            expiresAt: payment.expiresAt,
          };
        }
        throw new ConflictException(
          "Payment confirmation is pending. Do not pay again",
        );
      }
    }
    const current = this.orders.get(id);
    if (
      ![OrderStatus.DRAFT, OrderStatus.PAYMENT_FAILED].includes(current.status)
    )
      throw new ConflictException(
        "This recharge cannot collect another payment",
      );
    return paymentView(
      await this.payments.initiate(id, current.ownerId, provider),
    );
  }

  async purchases(user: AuthenticatedUser) {
    const rows = await this.prisma.order.findMany({
      where: {
        OR: [
          { purchasedByUserId: user.localUserId },
          { customer: { user: { clerkId: user.id } } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        customer: { include: { user: true } },
        targetInventory: { select: { iccid: true } },
      },
    });
    return Promise.all(
      rows.map(async (row) => {
        await this.orders.refreshOne(row.id, true);
        const order = this.orders.get(row.id);
        return row.orderType === "TOPUP"
          ? {
              ...rechargeView(order),
              rechargeFor:
                row.customer.user?.clerkId === user.id
                  ? ("OWN" as const)
                  : ("OTHER" as const),
              targetSuffix: row.targetInventory?.iccid.slice(-4),
            }
          : this.orders.view(row.id, user.id);
      }),
    );
  }
}
