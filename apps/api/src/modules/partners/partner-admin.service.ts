import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  OrderStatus,
  PartnerCredentialStatus,
  PartnerIntegrationType,
  PartnerLedgerEntryType,
  PartnerPriceListStatus,
  PartnerRefundStatus,
  PartnerSettlementMethod,
  PartnerStatus,
  Prisma,
} from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CryptoService } from "../../infrastructure/crypto.service.js";
import { PrismaService } from "../../infrastructure/prisma.service.js";

export const PARTNER_SCOPES = [
  "catalog:read",
  "checkout:write",
  "orders:read",
  "orders:write",
  "documents:write",
  "refunds:write",
  "usage:read",
  "esims:read",
] as const;

@Injectable()
export class PartnerAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async list() {
    const partners = await this.prisma.partner.findMany({
      include: {
        account: true,
        credentials: { orderBy: { createdAt: "desc" } },
        webhooks: true,
        _count: { select: { orders: true, quotes: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return partners.map((partner) => this.sanitizePartner(partner));
  }

  async detail(id: string) {
    const partner = await this.prisma.partner.findUnique({
      where: { id },
      include: {
        account: true,
        credentials: { orderBy: { createdAt: "desc" } },
        webhooks: {
          select: {
            id: true,
            url: true,
            eventTypes: true,
            active: true,
            createdAt: true,
            updatedAt: true,
            _count: { select: { deliveries: true } },
          },
          orderBy: { createdAt: "desc" },
        },
        _count: {
          select: {
            orders: true,
            customers: true,
            refundRequests: true,
            credentials: true,
          },
        },
      },
    });
    if (!partner) throw new NotFoundException("Partner not found");
    return this.sanitizePartner(partner);
  }

  async create(
    input: {
      code: string;
      name: string;
      settlementMethods?: PartnerSettlementMethod[] | undefined;
      rateLimitPerMinute?: number | undefined;
      redirectAllowlist?: string[] | undefined;
      balancePaisa?: number | undefined;
      creditLimitPaisa?: number | undefined;
      integrationType?: PartnerIntegrationType | undefined;
    },
    actorClerkId: string,
  ) {
    const code = input.code.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(code))
      throw new BadRequestException(
        "Partner code must be 3-32 URL-safe characters",
      );
    const settlementMethods = [PartnerSettlementMethod.PARTNER_ACCOUNT];
    const redirectAllowlist: string[] = [];
    const partner = await this.prisma.$transaction(async (tx) => {
      const created = await tx.partner.create({
        data: {
          code,
          name: input.name.trim(),
          status: PartnerStatus.PENDING,
          integrationType: input.integrationType ?? PartnerIntegrationType.API,
          allowedSettlementMethods: settlementMethods,
          rateLimitPerMinute: input.rateLimitPerMinute ?? 120,
          redirectAllowlist,
          account: {
            create: {
              balancePaisa: input.balancePaisa ?? 0,
              creditLimitPaisa: 0,
            },
          },
        },
      });
      await this.audit(tx, actorClerkId, "Partner", created.id, "CREATED", {
        code,
        settlementMethods,
      });
      return created;
    });
    return partner;
  }

  async update(
    id: string,
    input: {
      name?: string | undefined;
      status?: PartnerStatus | undefined;
      settlementMethods?: PartnerSettlementMethod[] | undefined;
      rateLimitPerMinute?: number | undefined;
      redirectAllowlist?: string[] | undefined;
      integrationType?: PartnerIntegrationType | undefined;
    },
    actorClerkId: string,
  ) {
    const previous = await this.requirePartner(id);
    const redirectAllowlist = input.redirectAllowlist?.map((url) =>
      this.validateRedirectUrl(url),
    );
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.partner.update({
        where: { id },
        data: {
          ...(input.name ? { name: input.name.trim() } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.integrationType ? { integrationType: input.integrationType } : {}),
          allowedSettlementMethods: [PartnerSettlementMethod.PARTNER_ACCOUNT],
          ...(input.rateLimitPerMinute !== undefined
            ? { rateLimitPerMinute: input.rateLimitPerMinute }
            : {}),
          ...(redirectAllowlist ? { redirectAllowlist: [] } : {}),
        },
      });
      await this.audit(tx, actorClerkId, "Partner", id, "UPDATED", {
        previousStatus: previous.status,
        status: row.status,
      });
      return row;
    });
    return updated;
  }

  async issueCredential(
    partnerId: string,
    input: { name: string; scopes: string[]; expiresAt?: string | undefined },
    actorClerkId: string,
  ) {
    await this.requirePartner(partnerId);
    const invalid = input.scopes.filter(
      (scope) =>
        !PARTNER_SCOPES.includes(scope as (typeof PARTNER_SCOPES)[number]),
    );
    if (invalid.length)
      throw new BadRequestException(`Unknown scopes: ${invalid.join(", ")}`);
    const prefix = `vc_partner_${randomBytes(8).toString("hex")}`;
    const secret = randomBytes(32).toString("base64url");
    const credential = await this.prisma.$transaction(async (tx) => {
      const created = await tx.partnerCredential.create({
        data: {
          partnerId,
          name: input.name.trim(),
          keyPrefix: prefix,
          secretHash: createHash("sha256").update(secret).digest("hex"),
          scopes: [...new Set(input.scopes)],
          ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}),
        },
      });
      await this.audit(
        tx,
        actorClerkId,
        "PartnerCredential",
        created.id,
        "CREATED",
        {
          partnerId,
          keyPrefix: prefix,
          scopes: input.scopes,
        },
      );
      return created;
    });
    return { ...credential, apiKey: `${prefix}.${secret}` };
  }

  async revokeCredential(
    partnerId: string,
    credentialId: string,
    actorClerkId: string,
  ) {
    const credential = await this.prisma.partnerCredential.findFirst({
      where: { id: credentialId, partnerId },
    });
    if (!credential)
      throw new NotFoundException("Partner credential not found");
    const updated = await this.prisma.partnerCredential.update({
      where: { id: credentialId },
      data: { status: PartnerCredentialStatus.REVOKED, revokedAt: new Date() },
    });
    await this.audit(
      this.prisma,
      actorClerkId,
      "PartnerCredential",
      credentialId,
      "REVOKED",
      {
        partnerId,
        keyPrefix: credential.keyPrefix,
      },
    );
    return updated;
  }

  async createPriceList(
    partnerId: string,
    input: {
      name: string;
      status?: PartnerPriceListStatus | undefined;
      effectiveFrom: string;
      effectiveTo?: string | undefined;
      items: Array<{
        planId: string;
        wholesaleAmountPaisa: number;
        retailAmountPaisa: number;
      }>;
    },
    actorClerkId: string,
  ) {
    await this.requirePartner(partnerId);
    if (!input.items.length)
      throw new BadRequestException("At least one price item is required");
    if (
      input.items.some(
        (item) => item.wholesaleAmountPaisa < 0 || item.retailAmountPaisa < 0,
      )
    )
      throw new BadRequestException(
        "Prices must be non-negative integer paisa",
      );
    return this.prisma.$transaction(async (tx) => {
      const aggregate = await tx.partnerPriceList.aggregate({
        where: { partnerId },
        _max: { version: true },
      });
      if (input.status === PartnerPriceListStatus.ACTIVE)
        await tx.partnerPriceList.updateMany({
          where: { partnerId, status: PartnerPriceListStatus.ACTIVE },
          data: { status: PartnerPriceListStatus.ARCHIVED },
        });
      const list = await tx.partnerPriceList.create({
        data: {
          partnerId,
          name: input.name.trim(),
          version: (aggregate._max.version ?? 0) + 1,
          status: input.status ?? PartnerPriceListStatus.DRAFT,
          effectiveFrom: new Date(input.effectiveFrom),
          ...(input.effectiveTo
            ? { effectiveTo: new Date(input.effectiveTo) }
            : {}),
          items: { create: input.items },
        },
        include: { items: true },
      });
      await this.audit(
        tx,
        actorClerkId,
        "PartnerPriceList",
        list.id,
        "CREATED",
        {
          partnerId,
          version: list.version,
          status: list.status,
        },
      );
      return list;
    });
  }

  priceLists(partnerId: string) {
    return this.prisma.partnerPriceList.findMany({
      where: { partnerId },
      include: { items: { include: { plan: true } } },
      orderBy: { version: "desc" },
    });
  }

  async adjustAccount(
    partnerId: string,
    input: {
      amountPaisa: number;
      creditLimitPaisa?: number | undefined;
      reference: string;
      reason: string;
    },
    actorClerkId: string,
  ) {
    if (!Number.isInteger(input.amountPaisa) || !input.amountPaisa)
      throw new BadRequestException(
        "A non-zero integer paisa adjustment is required",
      );
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.partnerAccount.upsert({
        where: { partnerId },
        update: {},
        create: { partnerId },
      });
      const balance = account.balancePaisa + input.amountPaisa;
      if (balance < 0)
        throw new BadRequestException(
          "Adjustment would make the prepaid partner balance negative",
        );
      const updated = await tx.partnerAccount.update({
        where: { id: account.id },
        data: {
          balancePaisa: balance,
          creditLimitPaisa: 0,
          reservedPaisa: 0,
          version: { increment: 1 },
        },
      });
      const ledger = await tx.partnerLedgerEntry.create({
        data: {
          partnerId,
          type:
            input.amountPaisa > 0
              ? PartnerLedgerEntryType.CREDIT
              : PartnerLedgerEntryType.ADJUSTMENT,
          amountPaisa: Math.abs(input.amountPaisa),
          balanceAfterPaisa: balance,
          reference: input.reference,
          metadata: {
            reason: input.reason,
            source: input.amountPaisa > 0 ? "OFFLINE_SETTLEMENT" : "ADMIN_ADJUSTMENT",
          },
        },
      });
      await this.audit(
        tx,
        actorClerkId,
        "PartnerAccount",
        account.id,
        "ADJUSTED",
        {
          amountPaisa: input.amountPaisa,
          reference: input.reference,
        },
      );
      return { account: updated, ledgerEntry: ledger };
    });
  }

  ledger(partnerId: string, input: { from?: string; to?: string; type?: PartnerLedgerEntryType; q?: string; limit?: number } = {}) {
    return this.prisma.partnerLedgerEntry.findMany({
      where: {
        partnerId,
        ...(input.from || input.to ? { createdAt: { ...(input.from ? { gte: new Date(input.from) } : {}), ...(input.to ? { lte: new Date(input.to) } : {}) } } : {}),
        ...(input.type ? { type: input.type } : {}),
        ...(input.q ? { OR: [
          { reference: { contains: input.q, mode: "insensitive" } },
          { order: { is: { OR: [
            { orderNumber: { contains: input.q, mode: "insensitive" } },
            { externalOrderId: { contains: input.q, mode: "insensitive" } },
          ] } } },
        ] } : {}),
      },
      include: { order: { select: { id: true, orderNumber: true, externalOrderId: true } } },
      orderBy: { createdAt: "desc" },
      take: Math.min(1000, Math.max(1, input.limit ?? 500)),
    });
  }

  async orders(partnerId: string, input: { from?: string; to?: string; status?: OrderStatus; q?: string; limit?: number } = {}) {
    await this.requirePartner(partnerId);
    return this.prisma.order.findMany({
      where: {
        partnerId,
        ...(input.from || input.to ? { createdAt: { ...(input.from ? { gte: new Date(input.from) } : {}), ...(input.to ? { lte: new Date(input.to) } : {}) } } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.q ? { OR: [
          { orderNumber: { contains: input.q, mode: "insensitive" } },
          { externalOrderId: { contains: input.q, mode: "insensitive" } },
        ] } : {}),
      },
      include: { plan: { include: { country: true } }, traveler: { select: { firstName: true, surname: true, email: true } } },
      orderBy: { createdAt: "desc" },
      take: Math.min(1000, Math.max(1, input.limit ?? 500)),
    });
  }

  async summary(partnerId: string, from?: string, to?: string) {
    await this.requirePartner(partnerId);
    const createdAt = from || to ? { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } : undefined;
    const [account, orders, ledger] = await Promise.all([
      this.prisma.partnerAccount.findUnique({ where: { partnerId } }),
      this.prisma.order.findMany({ where: { partnerId, ...(createdAt ? { createdAt } : {}) }, select: { status: true, totalAmount: true, channel: true } }),
      this.prisma.partnerLedgerEntry.findMany({ where: { partnerId, ...(createdAt ? { createdAt } : {}) }, select: { type: true, amountPaisa: true } }),
    ]);
    const byStatus = orders.reduce<Record<string, number>>((result, order) => ({ ...result, [order.status]: (result[order.status] ?? 0) + 1 }), {});
    const byChannel = orders.reduce<Record<string, number>>((result, order) => ({ ...result, [order.channel]: (result[order.channel] ?? 0) + 1 }), {});
    const totalOrderValuePaisa = orders.reduce((sum, order) => sum + Math.round(Number(order.totalAmount) * 100), 0);
    const sum = (types: PartnerLedgerEntryType[]) => ledger.filter((entry) => types.includes(entry.type)).reduce((total, entry) => total + entry.amountPaisa, 0);
    return {
      currency: "NPR",
      currentBalancePaisa: account?.balancePaisa ?? 0,
      ordersCreated: orders.length,
      ordersByStatus: byStatus,
      ordersByChannel: byChannel,
      fulfilledOrders: (byStatus.QR_READY ?? 0) + (byStatus.COMPLETED ?? 0),
      failedOrders: byStatus.PROVISIONING_FAILED ?? 0,
      totalOrderValuePaisa,
      averageOrderValuePaisa: orders.length ? Math.round(totalOrderValuePaisa / orders.length) : 0,
      totalCreditedPaisa: sum([PartnerLedgerEntryType.CREDIT]),
      totalDebitedPaisa: sum([PartnerLedgerEntryType.DEBIT]),
      totalRefundedPaisa: sum([PartnerLedgerEntryType.REFUND]),
      totalAdjustedPaisa: sum([PartnerLedgerEntryType.ADJUSTMENT]),
      from: from ?? null,
      to: to ?? null,
    };
  }

  async createWebhook(
    partnerId: string,
    input: { url: string; eventTypes: string[] },
    actorClerkId: string,
  ) {
    await this.requirePartner(partnerId);
    const url = this.validateWebhookUrl(input.url);
    const secret = randomBytes(32).toString("base64url");
    const endpoint = await this.prisma.partnerWebhookEndpoint.create({
      data: {
        partnerId,
        url,
        eventTypes: [...new Set(input.eventTypes)],
        secretEncrypted: this.crypto.encrypt(secret),
      },
    });
    await this.audit(
      this.prisma,
      actorClerkId,
      "PartnerWebhookEndpoint",
      endpoint.id,
      "CREATED",
      {
        partnerId,
        url,
      },
    );
    return { ...endpoint, secretEncrypted: undefined, signingSecret: secret };
  }

  webhooks(partnerId: string) {
    return this.prisma.partnerWebhookEndpoint.findMany({
      where: { partnerId },
      select: {
        id: true,
        url: true,
        eventTypes: true,
        active: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async updateWebhook(
    partnerId: string,
    webhookId: string,
    active: boolean,
    actorClerkId: string,
  ) {
    const endpoint = await this.prisma.partnerWebhookEndpoint.findFirst({
      where: { id: webhookId, partnerId },
    });
    if (!endpoint) throw new NotFoundException("Partner webhook not found");
    const updated = await this.prisma.partnerWebhookEndpoint.update({
      where: { id: webhookId },
      data: { active },
      select: {
        id: true,
        url: true,
        eventTypes: true,
        active: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    await this.audit(
      this.prisma,
      actorClerkId,
      "PartnerWebhookEndpoint",
      webhookId,
      active ? "ENABLED" : "DISABLED",
      { partnerId, previousActive: endpoint.active, active },
    );
    return updated;
  }

  deliveries(partnerId: string) {
    return this.prisma.partnerWebhookDelivery.findMany({
      where: { event: { partnerId } },
      include: { event: true, endpoint: { select: { id: true, url: true } } },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
  }

  async assertReplayOwnership(
    partnerId: string,
    deliveryId: string,
    actorClerkId: string,
  ) {
    const delivery = await this.prisma.partnerWebhookDelivery.findFirst({
      where: { id: deliveryId, event: { partnerId } },
      select: { id: true, status: true },
    });
    if (!delivery) throw new NotFoundException("Partner webhook delivery not found");
    await this.audit(
      this.prisma,
      actorClerkId,
      "PartnerWebhookDelivery",
      deliveryId,
      "REPLAY_REQUESTED",
      { partnerId, previousStatus: delivery.status },
    );
  }

  refunds(partnerId?: string) {
    return this.prisma.partnerRefundRequest.findMany({
      where: partnerId ? { partnerId } : {},
      include: { partner: true, order: true },
      orderBy: { createdAt: "desc" },
    });
  }

  async decideRefund(
    id: string,
    status: PartnerRefundStatus,
    reason: string,
    actorClerkId: string,
  ) {
    if (
      status !== PartnerRefundStatus.APPROVED &&
      status !== PartnerRefundStatus.REJECTED
    )
      throw new BadRequestException(
        "Refund decision must be APPROVED or REJECTED",
      );
    const actor = await this.actor(actorClerkId);
    const refund = await this.prisma.partnerRefundRequest.findUnique({
      where: { id },
      include: { order: true },
    });
    if (!refund) throw new NotFoundException("Refund request not found");
    if (refund.status !== PartnerRefundStatus.REQUESTED)
      throw new BadRequestException("Refund request is already decided");
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.partnerRefundRequest.update({
        where: { id },
        data: { status, decidedById: actor.id, decidedAt: new Date() },
      });
      if (
        status === PartnerRefundStatus.APPROVED &&
        refund.order.partnerSettlementMethod ===
          PartnerSettlementMethod.PARTNER_ACCOUNT
      ) {
        const debit = await tx.partnerLedgerEntry.findFirst({
          where: {
            partnerId: refund.partnerId,
            orderId: refund.orderId,
            type: PartnerLedgerEntryType.DEBIT,
          },
        });
        const account = await tx.partnerAccount.findUnique({
          where: { partnerId: refund.partnerId },
        });
        if (debit && account) {
          const balanceAfterPaisa = account.balancePaisa + refund.amountPaisa;
          await tx.partnerAccount.update({
            where: { id: account.id },
            data: {
              balancePaisa: balanceAfterPaisa,
              version: { increment: 1 },
            },
          });
          await tx.partnerLedgerEntry.create({
            data: {
              partnerId: refund.partnerId,
              orderId: refund.orderId,
              type: PartnerLedgerEntryType.REFUND,
              amountPaisa: refund.amountPaisa,
              balanceAfterPaisa,
              reference: `refund:${refund.orderId}:approved`,
              metadata: { refundRequestId: refund.id },
            },
          });
        }
        await tx.order.update({
          where: { id: refund.orderId },
          data: { status: OrderStatus.REFUNDED, version: { increment: 1 } },
        });
        await tx.orderEvent.create({
          data: {
            orderId: refund.orderId,
            fromStatus: refund.order.status,
            toStatus: OrderStatus.REFUNDED,
            reason: "Partner refund approved",
          },
        });
        const endpoints = await tx.partnerWebhookEndpoint.findMany({ where: { partnerId: refund.partnerId, active: true } });
        const eligible = endpoints.filter((endpoint) => { const types = Array.isArray(endpoint.eventTypes) ? endpoint.eventTypes.filter((value): value is string => typeof value === "string") : []; return types.includes("*") || types.includes("order.refunded"); });
        await tx.partnerEvent.create({ data: { partnerId: refund.partnerId, orderId: refund.orderId, type: "order.refunded", resourceId: refund.orderId, correlationId: randomUUID(), payload: { orderId: refund.orderId, externalOrderId: refund.order.externalOrderId, status: OrderStatus.REFUNDED, fulfillmentStatus: "NOT_READY", refundRequestId: refund.id }, deliveries: { create: eligible.map((endpoint) => ({ endpointId: endpoint.id })) } } });
      }
      await this.audit(
        tx,
        actorClerkId,
        "PartnerRefundRequest",
        id,
        "DECIDED",
        { status, reason },
      );
      return updated;
    });
  }

  private requirePartner(id: string) {
    return this.prisma.partner.findUnique({ where: { id } }).then((partner) => {
      if (!partner) throw new NotFoundException("Partner not found");
      return partner;
    });
  }

  private sanitizePartner<T extends { credentials?: Array<Record<string, unknown>> }>(
    partner: T,
  ) {
    return {
      ...partner,
      ...(partner.credentials
        ? {
            credentials: partner.credentials.map(
              ({ secretHash: _secretHash, ...credential }) => credential,
            ),
          }
        : {}),
    };
  }

  private actor(clerkId: string) {
    return this.prisma.user.findUnique({ where: { clerkId } }).then((actor) => {
      if (!actor) throw new NotFoundException("Actor account not found");
      return actor;
    });
  }

  private validateSettlementMethods(methods: PartnerSettlementMethod[]) {
    if (!methods.length)
      throw new BadRequestException("A settlement method is required");
  }

  private validateRedirectUrl(value: string) {
    const url = new URL(value);
    if (
      url.protocol !== "https:" &&
      !(process.env.NODE_ENV !== "production" && url.hostname === "localhost")
    )
      throw new BadRequestException("Redirect URLs must use HTTPS");
    return url.toString();
  }

  private validateWebhookUrl(value: string) {
    const url = new URL(value);
    if (
      url.protocol !== "https:" &&
      !(process.env.NODE_ENV !== "production" && url.hostname === "localhost")
    )
      throw new BadRequestException("Webhook URLs must use HTTPS");
    const host = url.hostname.toLowerCase();
    const ip = host.split(".").map(Number);
    const literalPrivate =
      host === "localhost" ||
      host === "metadata.google.internal" ||
      host === "0.0.0.0" ||
      host === "::" ||
      host === "::1" ||
      (ip.length === 4 &&
        ((ip[0] ?? 0) === 0 ||
          (ip[0] ?? 0) === 10 ||
          (ip[0] ?? 0) === 127 ||
          ((ip[0] ?? 0) === 169 && (ip[1] ?? 0) === 254) ||
          ((ip[0] ?? 0) === 172 && (ip[1] ?? 0) >= 16 && (ip[1] ?? 0) <= 31) ||
          ((ip[0] ?? 0) === 192 && (ip[1] ?? 0) === 168)));
    if (literalPrivate)
      throw new BadRequestException("Webhook URL host is not allowed");
    return url.toString();
  }

  private async audit(
    tx: Prisma.TransactionClient | PrismaService,
    actorClerkId: string,
    entity: string,
    entityId: string,
    action: string,
    value: Prisma.InputJsonValue,
  ) {
    const actor = await tx.user.findUnique({
      where: { clerkId: actorClerkId },
    });
    await tx.auditLog.create({
      data: {
        module: "PARTNERS",
        entity,
        entityId,
        action,
        ...(actor ? { performedById: actor.id } : {}),
        newValue: value,
      },
    });
  }
}
