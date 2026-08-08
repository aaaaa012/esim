import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  CustomerSource,
  DocumentStatus,
  DocumentType,
  OrderStatus,
  PaymentProvider,
  PartnerLedgerEntryType,
  PartnerQuoteStatus,
  PartnerSettlementMethod,
  PartnerStatus,
  Prisma,
} from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  DocumentType as SharedDocumentType,
  type TravelerInput,
} from "@visa-compass/shared";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { CryptoService } from "../../infrastructure/crypto.service.js";
import { CloudinaryStorageService } from "../../infrastructure/cloudinary-storage.service.js";
import { ConnectivityService } from "../integration/connectivity.service.js";
import { NotificationService } from "../notification/notification.service.js";
import { PartnerWebhookProcessor } from "../../jobs/partner-webhook.processor.js";
import { OrdersService } from "../orders/orders.service.js";

type CreateOrderInput = {
  quoteId: string;
  externalOrderId: string;
  externalCustomerId: string;
  compatibilityAccepted: true;
  metadata?: Record<string, string> | undefined;
};

type CompleteOrderInput = {
  externalOrderId: string;
  externalCustomerId: string;
  planId: string;
  settlement:
    | { method: "PARTNER_ACCOUNT" }
    | {
        method: "HOSTED_PAYMENT";
        provider: PaymentProvider;
        redirectUrl: string;
      };
  traveler: TravelerInput;
  documents: Array<{ type: DocumentType; uploadId: string }>;
  consent: {
    compatibilityAccepted: true;
    termsAccepted: true;
    privacyAccepted: true;
    acceptedAt: string;
  };
  metadata?: Record<string, string> | undefined;
};

type UploadSessionInput = {
  externalOrderId: string;
  documents: Array<{
    type: DocumentType;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }>;
};

const PARTNER_ORDER_INCLUDE = {
  plan: { include: { country: true } },
  traveler: true,
  documents: true,
  payments: { orderBy: { createdAt: "desc" as const }, take: 1 },
  events: { orderBy: { createdAt: "asc" as const } },
  partnerQuote: true,
  partnerRefundRequests: { orderBy: { createdAt: "desc" as const }, take: 1 },
} satisfies Prisma.OrderInclude;

type PartnerOrderRow = Prisma.OrderGetPayload<{
  include: typeof PARTNER_ORDER_INCLUDE;
}>;

@Injectable()
export class PartnerService {
  private readonly logger = new Logger(PartnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly storage: CloudinaryStorageService,
    private readonly connectivity: ConnectivityService,
    private readonly notifications: NotificationService,
    private readonly partnerWebhooks: PartnerWebhookProcessor,
    private readonly applicationOrders: OrdersService,
  ) {}

  async capabilities(partnerId: string) {
    const partner = await this.partner(partnerId);
    return {
      apiVersion: "v1",
      currency: "NPR",
      settlementMethods: partner.allowedSettlementMethods,
      payments: ["KHALTI", "ESEWA"],
      notifications: ["EMAIL", "WHATSAPP"],
      connectivity: {
        ...this.connectivity.descriptor(),
        health: await this.connectivity.health(),
      },
      idempotencyRequiredForMutations: true,
      outboundWebhooks: true,
    };
  }

  async plans(partnerId: string, country?: string) {
    await this.partner(partnerId);
    const rows = await this.prisma.plan.findMany({
      where: {
        status: "ACTIVE",
        country: {
          active: true,
          ...(country ? { isoCode: country.toUpperCase() } : {}),
        },
      },
      include: { country: true },
      orderBy: [{ country: { name: "asc" } }, { sellingPrice: "asc" }],
    });
    return rows.map((plan) => {
      const publicAmountPaisa = Math.round(Number(plan.sellingPrice) * 100);
      return {
        id: plan.id,
        countryCode: plan.country.isoCode,
        countryName: plan.country.name,
        name: plan.name,
        dataAllowance: plan.dataAllowance,
        validityDays: plan.validityDays,
        coverage: plan.coverage,
        destination: {
          countryCode: plan.country.isoCode,
          countryName: plan.country.name,
        },
        price: { amountPaisa: publicAmountPaisa, currency: "NPR" },
        requiredDocuments: this.requiredDocuments(plan.country.isoCode),
        availability: "AVAILABLE",
        compatibilityDisclaimer:
          "The traveler must confirm that the destination device supports eSIM before purchase.",
        refundSummary:
          "Refund eligibility depends on payment, review, provisioning, and activation status.",
        updatedAt: plan.updatedAt,
        currency: "NPR",
        wholesaleAmountPaisa: publicAmountPaisa,
        retailAmountPaisa: publicAmountPaisa,
        priceListId: null,
        priceListVersion: null,
      };
    });
  }

  async createUploadSessions(partnerId: string, input: UploadSessionInput) {
    await this.partner(partnerId);
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    return this.prisma.$transaction(async (tx) => {
      const items = [];
      for (const document of input.documents) {
        const id = randomUUID();
        const signed = this.storage.createPartnerDocumentUpload(
          id,
          document.type as unknown as SharedDocumentType,
        );
        const intent = await tx.partnerDocumentUploadIntent.create({
          data: {
            id,
            partnerId,
            externalOrderId: input.externalOrderId,
            type: document.type,
            fileName: document.fileName,
            contentType: document.contentType,
            declaredSizeBytes: document.sizeBytes,
            privateAssetId: signed.assetId,
            expiresAt,
          },
        });
        items.push({
          uploadId: intent.id,
          type: intent.type,
          fileName: intent.fileName,
          expiresAt: intent.expiresAt,
          upload: signed.upload,
        });
      }
      return { externalOrderId: input.externalOrderId, documents: items };
    });
  }

  async createCompleteOrder(
    partnerId: string,
    input: CompleteOrderInput,
    requestContext: { ipAddress: string; userAgent: string },
  ) {
    const partner = await this.partner(partnerId);
    const settlementMethod = input.settlement.method as PartnerSettlementMethod;
    if (!this.stringArray(partner.allowedSettlementMethods).includes(settlementMethod))
      throw new BadRequestException({
        code: "SETTLEMENT_METHOD_UNAVAILABLE",
        message: "Settlement method is not enabled for partner",
      });
    if (input.settlement.method === "HOSTED_PAYMENT")
      this.assertRedirectAllowed(
        partner.redirectAllowlist,
        input.settlement.redirectUrl,
      );
    const plan = await this.prisma.plan.findFirst({
      where: { id: input.planId, status: "ACTIVE", country: { active: true } },
      include: { country: true },
    });
    if (!plan)
      throw new BadRequestException({
        code: "PLAN_UNAVAILABLE",
        message: "Plan is unavailable",
      });
    const required = this.requiredDocuments(plan.country.isoCode);
    const suppliedTypes = new Set(input.documents.map((item) => item.type));
    const missing = required.filter((type) => !suppliedTypes.has(type));
    if (missing.length)
      throw new BadRequestException({
        code: "DOCUMENT_REQUIRED",
        message: `Required documents missing: ${missing.join(", ")}`,
      });
    const uploadIds = input.documents.map((item) => item.uploadId);
    const intents = await this.prisma.partnerDocumentUploadIntent.findMany({
      where: {
        id: { in: uploadIds },
        partnerId,
        externalOrderId: input.externalOrderId,
        consumedAt: null,
      },
    });
    if (intents.length !== uploadIds.length)
      throw new BadRequestException({
        code: "UPLOAD_NOT_VERIFIED",
        message: "One or more document uploads are unavailable",
      });
    const now = new Date();
    if (intents.some((intent) => intent.expiresAt <= now))
      throw new BadRequestException({
        code: "UPLOAD_EXPIRED",
        message: "One or more document uploads have expired",
      });
    for (const requested of input.documents) {
      const intent = intents.find((item) => item.id === requested.uploadId);
      if (!intent || intent.type !== requested.type)
        throw new BadRequestException({
          code: "UPLOAD_NOT_VERIFIED",
          message: "Document upload type does not match",
        });
      const verified = await this.storage.verifyDocument(intent.privateAssetId);
      if (
        verified.bytes !== intent.declaredSizeBytes ||
        !this.formatMatchesContentType(verified.format, intent.contentType)
      )
        throw new BadRequestException({
          code: "UPLOAD_NOT_VERIFIED",
          message: "Uploaded document does not match its declaration",
        });
    }
    const amountPaisa = Math.round(Number(plan.sellingPrice) * 100);
    const orderId = randomUUID();
    const hostedPayment =
      input.settlement.method === "HOSTED_PAYMENT"
        ? {
            token: randomBytes(32).toString("base64url"),
            expiresAt: new Date(Date.now() + 30 * 60_000),
          }
        : null;
    await this.prisma.$transaction(async (tx) => {
      const duplicate = await tx.order.findFirst({
        where: { partnerId, externalOrderId: input.externalOrderId },
      });
      if (duplicate)
        throw new ConflictException("External order ID already exists");
      const consumable = await tx.partnerDocumentUploadIntent.updateMany({
        where: {
          id: { in: uploadIds },
          partnerId,
          externalOrderId: input.externalOrderId,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date(), consumedOrderId: orderId },
      });
      if (consumable.count !== uploadIds.length)
        throw new ConflictException("Document upload was already consumed");
      const partnerCustomer = await this.ensurePartnerCustomer(
        tx,
        partner.code,
        partnerId,
        input.externalCustomerId,
      );
      const status =
        settlementMethod === PartnerSettlementMethod.PARTNER_ACCOUNT
          ? OrderStatus.REVIEW_PENDING
          : OrderStatus.PAYMENT_PENDING;
      const pricingSnapshot = {
        pricingSource: "PUBLIC_CATALOGUE",
        planId: plan.id,
        name: plan.name,
        countryCode: plan.country.isoCode,
        dataAllowance: plan.dataAllowance,
        validityDays: plan.validityDays,
        amountPaisa,
        currency: "NPR",
        capturedAt: new Date().toISOString(),
      };
      await tx.order.create({
        data: {
          id: orderId,
          orderNumber: `VC-${new Date().getUTCFullYear()}-${orderId.slice(0, 8).toUpperCase()}`,
          customerId: partnerCustomer.customerId,
          partnerId,
          partnerCustomerId: partnerCustomer.id,
          externalOrderId: input.externalOrderId,
          partnerSettlementMethod: settlementMethod,
          partnerPaymentProvider:
            input.settlement.method === "HOSTED_PAYMENT"
              ? input.settlement.provider
              : null,
          partnerMetadata: input.metadata ?? Prisma.JsonNull,
          planId: plan.id,
          status,
          subtotal: amountPaisa / 100,
          totalAmount: amountPaisa / 100,
          pricingSnapshot,
          compatibilityAcceptedAt: new Date(input.consent.acceptedAt),
          traveler: { create: this.travelerData(input.traveler) },
          documents: {
            create: intents.map((intent) => ({
              type: intent.type,
              fileName: intent.fileName,
              privateAssetId: intent.privateAssetId,
            })),
          },
          events: { create: { fromStatus: null, toStatus: status } },
        },
      });
      await tx.customerConsent.createMany({
        data: ["COMPATIBILITY", "TERMS", "PRIVACY"].map((type) => ({
          customerId: partnerCustomer.customerId,
          type,
          version: "1.0",
          ipAddress: requestContext.ipAddress,
          userAgent: requestContext.userAgent.slice(0, 500),
          acceptedAt: new Date(input.consent.acceptedAt),
        })),
      });
      if (settlementMethod === PartnerSettlementMethod.PARTNER_ACCOUNT)
        await this.debitAccount(tx, partnerId, orderId, amountPaisa, input.externalOrderId);
      if (hostedPayment && input.settlement.method === "HOSTED_PAYMENT")
        await tx.partnerHostedCheckoutSession.create({
          data: {
            partnerId,
            orderId,
            tokenHash: createHash("sha256").update(hostedPayment.token).digest("hex"),
            redirectUrl: input.settlement.redirectUrl,
            expiresAt: hostedPayment.expiresAt,
          },
        });
      await this.createEvent(tx, partnerId, orderId, "order.created", orderId, {
        orderId,
        externalOrderId: input.externalOrderId,
        status,
        amountPaisa,
        currency: "NPR",
      });
    });
    const handoff = await Promise.allSettled([
      this.applicationOrders.refreshFromPersistence(orderId),
      this.partnerWebhooks.enqueuePending(),
    ]);
    for (const result of handoff)
      if (result.status === "rejected")
        this.logger.error(
          result.reason instanceof Error
            ? result.reason.message
            : "Partner order post-commit handoff failed",
        );
    const order = await this.order(partnerId, orderId);
    if (input.settlement.method !== "HOSTED_PAYMENT" || !hostedPayment)
      return order;
    return {
      ...order,
      nextAction: {
        type: "HOSTED_PAYMENT",
        provider: input.settlement.provider,
        checkoutUrl: `${process.env.CUSTOMER_WEB_URL ?? "http://localhost:3000"}/partner-checkout/${hostedPayment.token}`,
        expiresAt: hostedPayment.expiresAt,
      },
    };
  }

  async createQuote(
    partnerId: string,
    planId: string,
    settlementMethod: PartnerSettlementMethod,
  ) {
    const partner = await this.partner(partnerId);
    const allowed = this.stringArray(partner.allowedSettlementMethods);
    if (!allowed.includes(settlementMethod))
      throw new BadRequestException(
        "Settlement method is not enabled for partner",
      );
    const plan = (await this.plans(partnerId)).find(
      (item) => item.id === planId,
    );
    if (!plan) throw new BadRequestException("Invalid or inactive plan");
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    return this.prisma.partnerQuote.create({
      data: {
        partnerId,
        planId,
        settlementMethod,
        wholesaleAmountPaisa: plan.wholesaleAmountPaisa,
        retailAmountPaisa: plan.retailAmountPaisa,
        currency: "NPR",
        expiresAt,
        pricingSnapshot: {
          planId,
          name: plan.name,
          countryCode: plan.countryCode,
          dataAllowance: plan.dataAllowance,
          validityDays: plan.validityDays,
          wholesaleAmountPaisa: plan.wholesaleAmountPaisa,
          retailAmountPaisa: plan.retailAmountPaisa,
          priceListVersion: null,
          pricingSource: "PUBLIC_CATALOGUE",
          currency: "NPR",
        },
      },
      select: {
        id: true,
        planId: true,
        settlementMethod: true,
        wholesaleAmountPaisa: true,
        retailAmountPaisa: true,
        currency: true,
        expiresAt: true,
      },
    });
  }

  async createOrder(partnerId: string, input: CreateOrderInput) {
    const result = await this.prisma.$transaction(async (tx) => {
      const quote = await tx.partnerQuote.findFirst({
        where: { id: input.quoteId, partnerId },
        include: { plan: true, partner: true },
      });
      if (!quote) throw new NotFoundException("Quote not found");
      if (
        quote.status !== PartnerQuoteStatus.ACTIVE ||
        quote.expiresAt <= new Date()
      )
        throw new BadRequestException("Quote is expired or unavailable");
      if (quote.plan.status !== "ACTIVE")
        throw new BadRequestException("Quoted plan is no longer active");
      const duplicate = await tx.order.findFirst({
        where: { partnerId, externalOrderId: input.externalOrderId },
      });
      if (duplicate)
        throw new ConflictException("External order ID already exists");
      const partnerCustomer = await this.ensurePartnerCustomer(
        tx,
        quote.partner.code,
        partnerId,
        input.externalCustomerId,
      );
      const amountPaisa =
        quote.settlementMethod === PartnerSettlementMethod.PARTNER_ACCOUNT
          ? quote.wholesaleAmountPaisa
          : quote.retailAmountPaisa;
      if (quote.settlementMethod === PartnerSettlementMethod.PARTNER_ACCOUNT)
        await this.reserveAccount(
          tx,
          partnerId,
          quote.wholesaleAmountPaisa,
          input.externalOrderId,
        );
      const id = randomUUID();
      const order = await tx.order.create({
        data: {
          id,
          orderNumber: `VC-${new Date().getUTCFullYear()}-${id.slice(0, 8).toUpperCase()}`,
          customerId: partnerCustomer.customerId,
          partnerId,
          partnerCustomerId: partnerCustomer.id,
          externalOrderId: input.externalOrderId,
          partnerQuoteId: quote.id,
          partnerSettlementMethod: quote.settlementMethod,
          partnerMetadata: input.metadata ?? Prisma.JsonNull,
          planId: quote.planId,
          status: OrderStatus.DRAFT,
          subtotal: amountPaisa / 100,
          totalAmount: amountPaisa / 100,
          pricingSnapshot: quote.pricingSnapshot as Prisma.InputJsonValue,
          compatibilityAcceptedAt: new Date(),
          events: { create: { fromStatus: null, toStatus: OrderStatus.DRAFT } },
        },
      });
      await tx.partnerQuote.update({
        where: { id: quote.id },
        data: { status: PartnerQuoteStatus.CONSUMED, consumedAt: new Date() },
      });
      await this.createEvent(
        tx,
        partnerId,
        order.id,
        "order.created",
        order.id,
        {
          orderId: order.id,
          externalOrderId: input.externalOrderId,
          status: order.status,
        },
      );
      return order;
    });
    await this.partnerWebhooks.enqueuePending();
    return this.order(partnerId, result.id);
  }

  async listOrders(
    partnerId: string,
    input: {
      cursor?: string | undefined;
      status?: OrderStatus | undefined;
      externalOrderId?: string | undefined;
      limit?: number | undefined;
    },
  ) {
    const limit = Math.min(100, Math.max(1, input.limit ?? 25));
    const rows = await this.prisma.order.findMany({
      where: {
        partnerId,
        ...(input.status ? { status: input.status } : {}),
        ...(input.externalOrderId
          ? { externalOrderId: input.externalOrderId }
          : {}),
      },
      include: PARTNER_ORDER_INCLUDE,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    const more = rows.length > limit;
    const items = rows.slice(0, limit);
    return {
      items: items.map((order) => this.normalizeOrder(order)),
      nextCursor: more ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async account(partnerId: string) {
    await this.partner(partnerId);
    const account = await this.prisma.partnerAccount.upsert({
      where: { partnerId },
      update: {},
      create: { partnerId },
    });
    const [debits, credits] = await Promise.all([
      this.prisma.partnerLedgerEntry.aggregate({
        where: {
          partnerId,
          type: { in: [PartnerLedgerEntryType.DEBIT, PartnerLedgerEntryType.CAPTURE] },
        },
        _sum: { amountPaisa: true },
      }),
      this.prisma.partnerLedgerEntry.aggregate({
        where: {
          partnerId,
          type: { in: [PartnerLedgerEntryType.CREDIT, PartnerLedgerEntryType.REFUND] },
        },
        _sum: { amountPaisa: true },
      }),
    ]);
    return {
      currency: "NPR",
      balancePaisa: account.balancePaisa,
      outstandingPaisa: Math.max(0, -account.balancePaisa),
      reservedPaisa: account.reservedPaisa,
      totalDebitsPaisa: debits._sum.amountPaisa ?? 0,
      totalCreditsPaisa: credits._sum.amountPaisa ?? 0,
      updatedAt: account.updatedAt,
    };
  }

  async ledger(
    partnerId: string,
    input: {
      cursor?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      externalOrderId?: string | undefined;
      limit?: number | undefined;
    },
  ) {
    await this.partner(partnerId);
    const limit = Math.min(100, Math.max(1, input.limit ?? 25));
    const rows = await this.prisma.partnerLedgerEntry.findMany({
      where: {
        partnerId,
        ...(input.from || input.to
          ? {
              createdAt: {
                ...(input.from ? { gte: new Date(input.from) } : {}),
                ...(input.to ? { lte: new Date(input.to) } : {}),
              },
            }
          : {}),
        ...(input.externalOrderId
          ? { order: { externalOrderId: input.externalOrderId } }
          : {}),
      },
      include: {
        order: { select: { id: true, externalOrderId: true, orderNumber: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    const more = rows.length > limit;
    const items = rows.slice(0, limit);
    return {
      items: items.map((entry) => ({
        id: entry.id,
        type: entry.type,
        amountPaisa: entry.amountPaisa,
        balanceAfterPaisa: entry.balanceAfterPaisa,
        currency: "NPR",
        reference: entry.reference,
        order: entry.order,
        createdAt: entry.createdAt,
      })),
      nextCursor: more ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async order(partnerId: string, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, partnerId },
      include: PARTNER_ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException("Order not found");
    return this.normalizeOrder(order);
  }

  async orderByExternalId(partnerId: string, externalOrderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { partnerId, externalOrderId },
      select: { id: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    return this.order(partnerId, order.id);
  }

  async setTraveler(
    partnerId: string,
    orderId: string,
    traveler: TravelerInput,
  ) {
    const order = await this.mutableOrder(partnerId, orderId, [
      OrderStatus.DRAFT,
    ]);
    const data = {
      title: traveler.title,
      firstName: traveler.firstName,
      middleName: traveler.middleName ?? null,
      surname: traveler.surname,
      dateOfBirthEncrypted: this.crypto.encrypt(traveler.dateOfBirth),
      nationality: traveler.nationality,
      city: traveler.city,
      countryOfResidence: traveler.countryOfResidence,
      employerOrBusinessName: traveler.employerOrBusinessName ?? null,
      email: traveler.email,
      mobile: traveler.mobile,
      passportNumberEncrypted: this.crypto.encrypt(traveler.passportNumber),
      passportNumberHash: this.crypto.blindIndex(traveler.passportNumber),
      passportExpiryEncrypted: this.crypto.encrypt(traveler.passportExpiryDate),
      pointOfSaleCode: traveler.pointOfSaleCode ?? null,
    };
    await this.prisma.traveler.upsert({
      where: { orderId },
      update: data,
      create: { orderId, ...data },
    });
    await this.bump(order.id, order.version);
    return this.order(partnerId, orderId);
  }

  async addDocument(
    partnerId: string,
    orderId: string,
    input: { type: DocumentType; fileName: string },
  ) {
    const order = await this.mutableOrder(partnerId, orderId, [
      OrderStatus.DRAFT,
      OrderStatus.AWAITING_CUSTOMER,
    ]);
    const signed = this.storage.createDocumentUpload(
      orderId,
      input.type as unknown as SharedDocumentType,
    );
    const document = await this.prisma.travelerDocument.upsert({
      where: { orderId_type: { orderId, type: input.type } },
      update: {
        fileName: input.fileName,
        privateAssetId: signed.assetId,
        status: DocumentStatus.PENDING,
        reviewedAt: null,
        reviewedById: null,
      },
      create: {
        orderId,
        type: input.type,
        fileName: input.fileName,
        privateAssetId: signed.assetId,
      },
    });
    await this.bump(order.id, order.version);
    return {
      id: document.id,
      type: document.type,
      status: document.status,
      upload: signed.upload,
    };
  }

  async confirmDocument(
    partnerId: string,
    orderId: string,
    documentId: string,
  ) {
    const document = await this.prisma.travelerDocument.findFirst({
      where: { id: documentId, orderId, order: { partnerId } },
    });
    if (!document) throw new NotFoundException("Document not found");
    await this.storage.verifyDocument(document.privateAssetId);
    return {
      id: document.id,
      type: document.type,
      status: document.status,
      uploadVerified: true,
    };
  }

  async hostedSession(partnerId: string, orderId: string, redirectUrl: string) {
    const order = await this.mutableOrder(partnerId, orderId, [
      OrderStatus.DRAFT,
      OrderStatus.PAYMENT_PENDING,
    ]);
    const partner = await this.partner(partnerId);
    this.assertRedirectAllowed(partner.redirectAllowlist, redirectUrl);
    const token = randomBytes(32).toString("base64url");
    const session = await this.prisma.partnerHostedCheckoutSession.create({
      data: {
        partnerId,
        orderId,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        redirectUrl,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      },
    });
    return {
      sessionId: session.id,
      checkoutUrl: `${process.env.CUSTOMER_WEB_URL ?? "http://localhost:3000"}/partner-checkout/${token}`,
      expiresAt: session.expiresAt,
    };
  }

  async hostedCheckout(token: string) {
    const session = await this.hostedCheckoutSession(token);
    const order = await this.prisma.order.findUnique({
      where: { id: session.orderId },
      include: {
        plan: { include: { country: true } },
        traveler: true,
        documents: {
          select: { id: true, type: true, status: true, fileName: true },
        },
        partner: { select: { name: true } },
      },
    });
    if (!order) throw new NotFoundException("Hosted checkout not found");
    return {
      sessionId: session.id,
      expiresAt: session.expiresAt,
      partnerName: order.partner?.name,
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        amountPaisa: Math.round(Number(order.totalAmount) * 100),
        currency: order.currency,
        plan: {
          id: order.plan.id,
          name: order.plan.name,
          country: order.plan.country.name,
          dataAllowance: order.plan.dataAllowance,
          validityDays: order.plan.validityDays,
        },
        travelerComplete: Boolean(order.traveler),
        documents: order.documents,
        requiredDocuments: [DocumentType.PASSPORT, DocumentType.TICKET],
      },
    };
  }

  async setHostedTraveler(token: string, traveler: TravelerInput) {
    const session = await this.hostedCheckoutSession(token);
    return this.setTraveler(session.partnerId, session.orderId, traveler);
  }

  async addHostedDocument(
    token: string,
    input: { type: DocumentType; fileName: string },
  ) {
    const session = await this.hostedCheckoutSession(token);
    return this.addDocument(session.partnerId, session.orderId, input);
  }

  async confirmHostedDocument(token: string, documentId: string) {
    const session = await this.hostedCheckoutSession(token);
    return this.confirmDocument(session.partnerId, session.orderId, documentId);
  }

  async completeHostedCheckout(
    token: string,
    consent: { ipAddress: string; userAgent: string },
  ) {
    const session = await this.hostedCheckoutSession(token);
    const order = await this.prisma.order.findUnique({
      where: { id: session.orderId },
      include: { traveler: true, documents: true },
    });
    if (!order?.traveler)
      throw new BadRequestException("Traveler details are required");
    const documentTypes = new Set(
      order.documents.map((document) => document.type),
    );
    if (
      !documentTypes.has(DocumentType.PASSPORT) ||
      !documentTypes.has(DocumentType.TICKET)
    )
      throw new BadRequestException(
        "Passport and ticket documents are required",
      );
    const nextStatus =
      PartnerSettlementMethod.HOSTED_PAYMENT === order.partnerSettlementMethod
        ? OrderStatus.PAYMENT_PENDING
        : OrderStatus.REVIEW_PENDING;
    const result = await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.partnerHostedCheckoutSession.updateMany({
        where: {
          id: session.id,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });
      if (consumed.count !== 1)
        throw new ConflictException("Hosted checkout was already completed");
      const updated = await tx.order.updateMany({
        where: {
          id: order.id,
          version: order.version,
          status: OrderStatus.DRAFT,
        },
        data: { status: nextStatus, version: { increment: 1 } },
      });
      if (updated.count !== 1)
        throw new ConflictException("Order was changed; reload and retry");
      await tx.customerConsent.create({
        data: {
          customerId: order.customerId,
          type: "PARTNER_HOSTED_CHECKOUT",
          version: "1.0",
          ipAddress: consent.ipAddress,
          userAgent: consent.userAgent.slice(0, 500),
        },
      });
      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          fromStatus: order.status,
          toStatus: nextStatus,
        },
      });
      await this.createEvent(
        tx,
        session.partnerId,
        order.id,
        "checkout.completed",
        order.id,
        {
          orderId: order.id,
          externalOrderId: order.externalOrderId,
          status: nextStatus,
        },
      );
      return {
        redirectUrl: session.redirectUrl,
        orderId: order.id,
        status: nextStatus,
      };
    });
    await this.partnerWebhooks.enqueuePending();
    return result;
  }

  async cancel(partnerId: string, orderId: string, reason: string) {
    const order = await this.mutableOrder(partnerId, orderId, [
      OrderStatus.DRAFT,
      OrderStatus.PAYMENT_PENDING,
      OrderStatus.AWAITING_CUSTOMER,
      OrderStatus.REVIEW_PENDING,
    ]);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.updateMany({
        where: { id: order.id, version: order.version },
        data: { status: OrderStatus.CANCELLED, version: { increment: 1 } },
      });
      if (updated.count !== 1)
        throw new ConflictException(
          "Order was changed by another request; reload and retry",
        );
      await tx.orderEvent.create({
        data: {
          orderId,
          fromStatus: order.status,
          toStatus: OrderStatus.CANCELLED,
          reason,
        },
      });
      if (
        order.partnerSettlementMethod ===
        PartnerSettlementMethod.PARTNER_ACCOUNT
      ) {
        if (order.partnerQuote)
          await this.releaseReservation(
            tx,
            partnerId,
            orderId,
            order.partnerQuote.wholesaleAmountPaisa,
          );
        else
          await this.refundDirectDebit(
            tx,
            partnerId,
            orderId,
            Math.round(Number(order.totalAmount) * 100),
            "cancellation",
          );
      }
      await this.createEvent(
        tx,
        partnerId,
        orderId,
        "order.cancelled",
        orderId,
        {
          orderId,
          externalOrderId: order.externalOrderId,
          status: OrderStatus.CANCELLED,
          reason,
        },
      );
    });
    await this.partnerWebhooks.enqueuePending();
    return this.order(partnerId, orderId);
  }

  async requestRefund(partnerId: string, orderId: string, reason: string) {
    const order = await this.mutableOrder(partnerId, orderId, [
      OrderStatus.PAYMENT_CONFIRMED,
      OrderStatus.REVIEW_PENDING,
      OrderStatus.APPROVED,
      OrderStatus.PROVISIONING_FAILED,
      OrderStatus.COMPLETED,
    ]);
    const amountPaisa = Math.round(Number(order.totalAmount) * 100);
    const request = await this.prisma.$transaction(async (tx) => {
      const refund = await tx.partnerRefundRequest.create({
        data: { partnerId, orderId, amountPaisa, reason },
      });
      await tx.order.updateMany({
        where: { id: orderId, version: order.version },
        data: { status: OrderStatus.REFUND_PENDING, version: { increment: 1 } },
      });
      await tx.orderEvent.create({
        data: {
          orderId,
          fromStatus: order.status,
          toStatus: OrderStatus.REFUND_PENDING,
          reason,
        },
      });
      await this.createEvent(
        tx,
        partnerId,
        orderId,
        "refund.requested",
        refund.id,
        {
          refundRequestId: refund.id,
          orderId,
          amountPaisa,
          currency: "NPR",
          status: refund.status,
        },
      );
      return refund;
    });
    await this.partnerWebhooks.enqueuePending();
    return request;
  }

  async events(partnerId: string, orderId: string) {
    await this.order(partnerId, orderId);
    return this.prisma.partnerEvent.findMany({
      where: { partnerId, orderId },
      select: {
        id: true,
        type: true,
        version: true,
        resourceId: true,
        correlationId: true,
        payload: true,
        occurredAt: true,
      },
      orderBy: { occurredAt: "asc" },
    });
  }

  async usage(partnerId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, partnerId },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (order.status !== OrderStatus.COMPLETED)
      throw new BadRequestException("Usage is available after provisioning");
    return this.connectivity.getUsage(orderId);
  }

  async notify(
    partnerId: string,
    orderId: string,
    input: {
      channel: "EMAIL" | "WHATSAPP";
      template: "ORDER_STATUS" | "QR_READY" | "DOCUMENT_REUPLOAD";
    },
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, partnerId },
      include: { traveler: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (!order.traveler)
      throw new BadRequestException("Traveler contact details are required");
    return this.notifications.enqueue({
      orderId,
      channel: input.channel,
      template: input.template,
      recipient:
        input.channel === "EMAIL"
          ? order.traveler.email
          : order.traveler.mobile,
      orderNumber: order.orderNumber,
    });
  }

  private normalizeOrder(order: PartnerOrderRow) {
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      externalOrderId: order.externalOrderId,
      status: order.status,
      settlementMethod: order.partnerSettlementMethod,
      paymentProvider: order.partnerPaymentProvider,
      metadata: order.partnerMetadata,
      currency: order.currency,
      totalAmountPaisa: Math.round(Number(order.totalAmount) * 100),
      pricingSnapshot: order.pricingSnapshot,
      plan: {
        id: order.plan.id,
        countryCode: order.plan.country.isoCode,
        name: order.plan.name,
        dataAllowance: order.plan.dataAllowance,
        validityDays: order.plan.validityDays,
      },
      travelerComplete: Boolean(order.traveler),
      documents: order.documents.map((document) => ({
        id: document.id,
        type: document.type,
        status: document.status,
      })),
      payment: order.payments[0]
        ? {
            provider: order.payments[0].provider,
            status: order.payments[0].status,
          }
        : null,
      refund: order.partnerRefundRequests[0] ?? null,
      timeline: order.events.map((event) => ({
        from: event.fromStatus,
        to: event.toStatus,
        reason: event.reason,
        at: event.createdAt,
      })),
      esimDetailsAvailable: order.status === OrderStatus.COMPLETED,
      version: order.version,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }

  private async partner(id: string) {
    const partner = await this.prisma.partner.findUnique({ where: { id } });
    if (
      !partner ||
      (partner.status !== PartnerStatus.ACTIVE &&
        partner.status !== PartnerStatus.SUSPENDED)
    )
      throw new NotFoundException("Partner not found");
    return partner;
  }

  private async hostedCheckoutSession(token: string) {
    if (!/^[A-Za-z0-9_-]{32,100}$/.test(token))
      throw new NotFoundException("Hosted checkout not found");
    const session = await this.prisma.partnerHostedCheckoutSession.findUnique({
      where: { tokenHash: createHash("sha256").update(token).digest("hex") },
    });
    if (!session || session.consumedAt || session.expiresAt <= new Date())
      throw new NotFoundException("Hosted checkout not found");
    return session;
  }

  private async mutableOrder(
    partnerId: string,
    id: string,
    statuses: OrderStatus[],
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id, partnerId },
      include: { partnerQuote: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (!statuses.includes(order.status))
      throw new BadRequestException(
        "Order cannot be changed in its current state",
      );
    return order;
  }

  private async bump(id: string, version: number) {
    const result = await this.prisma.order.updateMany({
      where: { id, version },
      data: { version: { increment: 1 } },
    });
    if (result.count !== 1)
      throw new ConflictException(
        "Order was changed by another request; reload and retry",
      );
  }

  private async ensurePartnerCustomer(
    tx: Prisma.TransactionClient,
    partnerCode: string,
    partnerId: string,
    externalCustomerId: string,
  ) {
    const existing = await tx.partnerCustomer.findUnique({
      where: {
        partnerId_externalCustomerId: { partnerId, externalCustomerId },
      },
    });
    if (existing) return existing;
    const suffix = createHash("sha256")
      .update(`${partnerId}:${externalCustomerId}`)
      .digest("hex")
      .slice(0, 18);
    const customer = await tx.customer.create({
      data: {
        customerCode: `VP-${partnerCode.toUpperCase().slice(0, 8)}-${suffix.toUpperCase()}`,
        source: CustomerSource.PARTNER,
        email: `${suffix}@partner.visacompass.invalid`,
      },
    });
    return tx.partnerCustomer.create({
      data: { partnerId, externalCustomerId, customerId: customer.id },
    });
  }

  private async reserveAccount(
    tx: Prisma.TransactionClient,
    partnerId: string,
    amountPaisa: number,
    externalOrderId: string,
  ) {
    const account = await tx.partnerAccount.upsert({
      where: { partnerId },
      update: {},
      create: { partnerId },
    });
    const available =
      account.balancePaisa + account.creditLimitPaisa - account.reservedPaisa;
    if (available < amountPaisa)
      throw new BadRequestException("Partner credit is insufficient");
    const updated = await tx.partnerAccount.updateMany({
      where: { id: account.id, version: account.version },
      data: {
        reservedPaisa: { increment: amountPaisa },
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1)
      throw new ConflictException("Partner balance changed; retry");
    await tx.partnerLedgerEntry.create({
      data: {
        partnerId,
        type: PartnerLedgerEntryType.RESERVATION,
        amountPaisa,
        balanceAfterPaisa: account.balancePaisa,
        reference: `reserve:${partnerId}:${externalOrderId}`,
      },
    });
  }

  private async debitAccount(
    tx: Prisma.TransactionClient,
    partnerId: string,
    orderId: string,
    amountPaisa: number,
    externalOrderId: string,
  ) {
    const account = await tx.partnerAccount.upsert({
      where: { partnerId },
      update: {},
      create: { partnerId },
    });
    const balanceAfterPaisa = account.balancePaisa - amountPaisa;
    const updated = await tx.partnerAccount.updateMany({
      where: { id: account.id, version: account.version },
      data: {
        balancePaisa: balanceAfterPaisa,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1)
      throw new ConflictException("Partner balance changed; retry");
    await tx.partnerLedgerEntry.create({
      data: {
        partnerId,
        orderId,
        type: PartnerLedgerEntryType.DEBIT,
        amountPaisa,
        balanceAfterPaisa,
        reference: `debit:${partnerId}:${externalOrderId}`,
        metadata: { settlement: "PARTNER_ACCOUNT" },
      },
    });
  }

  private travelerData(traveler: TravelerInput) {
    return {
      title: traveler.title,
      firstName: traveler.firstName,
      middleName: traveler.middleName ?? null,
      surname: traveler.surname,
      dateOfBirthEncrypted: this.crypto.encrypt(traveler.dateOfBirth),
      nationality: traveler.nationality,
      city: traveler.city,
      countryOfResidence: traveler.countryOfResidence,
      employerOrBusinessName: traveler.employerOrBusinessName ?? null,
      email: traveler.email,
      mobile: traveler.mobile,
      passportNumberEncrypted: this.crypto.encrypt(traveler.passportNumber),
      passportNumberHash: this.crypto.blindIndex(traveler.passportNumber),
      passportExpiryEncrypted: this.crypto.encrypt(traveler.passportExpiryDate),
      pointOfSaleCode: traveler.pointOfSaleCode ?? null,
    };
  }

  private requiredDocuments(countryCode: string): DocumentType[] {
    const visaCountries = new Set(
      (process.env.VISA_REQUIRED_COUNTRIES ?? "")
        .split(",")
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean),
    );
    return [
      DocumentType.PASSPORT,
      DocumentType.TICKET,
      ...(visaCountries.has(countryCode.toUpperCase()) ? [DocumentType.VISA] : []),
    ];
  }

  private formatMatchesContentType(format: string, contentType: string) {
    const normalized = format.toLowerCase();
    return (
      (contentType === "application/pdf" && normalized === "pdf") ||
      (contentType === "image/png" && normalized === "png") ||
      (contentType === "image/jpeg" && ["jpg", "jpeg"].includes(normalized))
    );
  }

  private assertRedirectAllowed(
    allowlist: Prisma.JsonValue,
    redirectUrl: string,
  ) {
    const target = new URL(redirectUrl);
    const allowed = this.stringArray(allowlist);
    if (
      !allowed.some((entry) => {
        const permitted = new URL(entry);
        return (
          target.origin === permitted.origin &&
          target.pathname.startsWith(permitted.pathname)
        );
      })
    )
      throw new BadRequestException("Redirect URL is not allowlisted");
  }

  private async releaseReservation(
    tx: Prisma.TransactionClient,
    partnerId: string,
    orderId: string,
    amountPaisa: number,
  ) {
    const account = await tx.partnerAccount.findUnique({
      where: { partnerId },
    });
    if (!account) return;
    await tx.partnerAccount.update({
      where: { id: account.id },
      data: {
        reservedPaisa: {
          decrement: Math.min(account.reservedPaisa, amountPaisa),
        },
        version: { increment: 1 },
      },
    });
    await tx.partnerLedgerEntry.create({
      data: {
        partnerId,
        orderId,
        type: PartnerLedgerEntryType.RELEASE,
        amountPaisa,
        balanceAfterPaisa: account.balancePaisa,
        reference: `release:${orderId}`,
      },
    });
  }

  private async refundDirectDebit(
    tx: Prisma.TransactionClient,
    partnerId: string,
    orderId: string,
    amountPaisa: number,
    reason: string,
  ) {
    const reference = `refund:${orderId}:${reason}`;
    const existing = await tx.partnerLedgerEntry.findUnique({
      where: { reference },
    });
    if (existing) return;
    const debit = await tx.partnerLedgerEntry.findFirst({
      where: { partnerId, orderId, type: PartnerLedgerEntryType.DEBIT },
    });
    if (!debit) return;
    const account = await tx.partnerAccount.findUnique({ where: { partnerId } });
    if (!account) return;
    const balanceAfterPaisa = account.balancePaisa + amountPaisa;
    const updated = await tx.partnerAccount.updateMany({
      where: { id: account.id, version: account.version },
      data: { balancePaisa: balanceAfterPaisa, version: { increment: 1 } },
    });
    if (updated.count !== 1)
      throw new ConflictException("Partner balance changed; retry");
    await tx.partnerLedgerEntry.create({
      data: {
        partnerId,
        orderId,
        type: PartnerLedgerEntryType.REFUND,
        amountPaisa,
        balanceAfterPaisa,
        reference,
        metadata: { reason },
      },
    });
  }

  private async createEvent(
    tx: Prisma.TransactionClient,
    partnerId: string,
    orderId: string,
    type: string,
    resourceId: string,
    payload: Prisma.InputJsonValue,
  ) {
    const endpoints = await tx.partnerWebhookEndpoint.findMany({
      where: { partnerId, active: true },
    });
    const eligible = endpoints.filter((endpoint) => {
      const types = this.stringArray(endpoint.eventTypes);
      return types.includes("*") || types.includes(type);
    });
    return tx.partnerEvent.create({
      data: {
        partnerId,
        orderId,
        type,
        resourceId,
        correlationId: randomUUID(),
        payload,
        deliveries: {
          create: eligible.map((endpoint) => ({ endpointId: endpoint.id })),
        },
      },
    });
  }

  private stringArray(value: Prisma.JsonValue) {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  }
}
