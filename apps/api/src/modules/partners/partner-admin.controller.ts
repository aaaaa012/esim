import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  OrderStatus,
  PartnerPriceListStatus,
  PartnerIntegrationType,
  PartnerLedgerEntryType,
  PartnerRefundStatus,
  PartnerSettlementMethod,
  PartnerStatus,
  UserRoleName,
} from "@prisma/client";
import { z } from "zod";
import {
  AccountGuard,
  AccountTypes,
  AuthGuard,
  type AuthenticatedRequest,
} from "../../common/auth.guard.js";
import {
  PARTNER_SCOPES,
  PartnerAdminService,
} from "./partner-admin.service.js";
import { PartnerService } from "./partner.service.js";
import { PartnerWebhookProcessor } from "../../jobs/partner-webhook.processor.js";

const partnerSchema = z.object({
  code: z.string().min(3).max(32),
  name: z.string().min(2).max(120),
  settlementMethods: z.array(z.enum(PartnerSettlementMethod)).optional(),
  rateLimitPerMinute: z.number().int().min(1).max(10_000).optional(),
  redirectAllowlist: z.array(z.string().url()).max(20).optional(),
  balancePaisa: z.number().int().min(0).optional(),
  creditLimitPaisa: z.literal(0).optional(),
  integrationType: z.enum(PartnerIntegrationType).optional(),
});
const updateSchema = partnerSchema
  .omit({ code: true, balancePaisa: true, creditLimitPaisa: true })
  .partial()
  .extend({
    status: z.enum(PartnerStatus).optional(),
  });
const credentialSchema = z.object({
  name: z.string().min(2).max(80),
  scopes: z.array(z.enum(PARTNER_SCOPES)).min(1),
  expiresAt: z.string().datetime().optional(),
});
const priceListSchema = z.object({
  name: z.string().min(2).max(120),
  status: z.enum(PartnerPriceListStatus).optional(),
  effectiveFrom: z.string().datetime(),
  effectiveTo: z.string().datetime().optional(),
  items: z
    .array(
      z.object({
        planId: z.string().uuid(),
        wholesaleAmountPaisa: z.number().int().min(0),
        retailAmountPaisa: z.number().int().min(0),
      }),
    )
    .min(1),
});

@Controller("admin/partners")
@UseGuards(AuthGuard, AccountGuard)
@AccountTypes(UserRoleName.SUPER_ADMIN)
export class PartnerAdminController {
  constructor(
    private readonly partners: PartnerAdminService,
    private readonly partnerService: PartnerService,
    private readonly partnerWebhooks: PartnerWebhookProcessor,
  ) {}

  @Get()
  list() {
    return this.partners.list();
  }

  @Post()
  create(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.partners.create(partnerSchema.parse(body), request.user!.id);
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.partners.update(id, updateSchema.parse(body), request.user!.id);
  }

  @Post(":id/hosted-checkout-sessions")
  async hostedCheckoutSession(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = z
      .object({
        planId: z.string().uuid(),
        externalOrderId: z.string().trim().min(1).max(120),
        externalCustomerId: z.string().trim().min(1).max(120),
        topUpMobile: z.string().trim().min(1).max(20).optional(),
      })
      .parse(body);
    return this.partnerService.createHostedCheckoutSession(id, input);
  }

  @Post(":id/credentials")
  issueCredential(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.partners.issueCredential(
      id,
      credentialSchema.parse(body),
      request.user!.id,
    );
  }

  @Delete(":id/credentials/:credentialId")
  revokeCredential(
    @Param("id") id: string,
    @Param("credentialId") credentialId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.partners.revokeCredential(id, credentialId, request.user!.id);
  }

  @Get(":id/price-lists")
  priceLists(@Param("id") id: string) {
    return this.partners.priceLists(id);
  }

  @Post(":id/price-lists")
  createPriceList(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.partners.createPriceList(
      id,
      priceListSchema.parse(body),
      request.user!.id,
    );
  }

  @Get(":id/ledger")
  ledger(@Param("id") id: string, @Query("from") from?: string, @Query("to") to?: string, @Query("type") type?: PartnerLedgerEntryType, @Query("q") q?: string, @Query("limit") limit?: string) {
    return this.partners.ledger(id, { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(type ? { type } : {}), ...(q ? { q } : {}), ...(limit ? { limit: Number(limit) } : {}) });
  }

  @Get(":id/orders")
  orders(@Param("id") id: string, @Query("from") from?: string, @Query("to") to?: string, @Query("status") status?: OrderStatus, @Query("q") q?: string, @Query("limit") limit?: string) {
    return this.partners.orders(id, { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(status ? { status } : {}), ...(q ? { q } : {}), ...(limit ? { limit: Number(limit) } : {}) });
  }

  @Get(":id/summary")
  summary(@Param("id") id: string, @Query("from") from?: string, @Query("to") to?: string) {
    return this.partners.summary(id, from, to);
  }

  @Post(":id/ledger-adjustments")
  adjust(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = z
      .object({
        amountPaisa: z
          .number()
          .int()
          .refine((value) => value !== 0),
        creditLimitPaisa: z.number().int().min(0).optional(),
        reference: z.string().min(4).max(120),
        reason: z.string().min(4).max(500),
      })
      .parse(body);
    return this.partners.adjustAccount(id, input, request.user!.id);
  }

  @Get(":id/webhooks")
  webhooks(@Param("id") id: string) {
    return this.partners.webhooks(id);
  }

  @Post(":id/webhooks")
  createWebhook(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = z
      .object({
        url: z.string().url(),
        eventTypes: z.array(z.string().min(3)).min(1),
      })
      .parse(body);
    return this.partners.createWebhook(id, input, request.user!.id);
  }

  @Get(":id/webhook-deliveries")
  deliveries(@Param("id") id: string) {
    return this.partners.deliveries(id);
  }

  @Post(":id/webhook-deliveries/:deliveryId/replay")
  async replay(@Param("deliveryId") deliveryId: string) {
    return this.partnerWebhooks.replay(deliveryId);
  }

  @Get(":id/refunds")
  refunds(@Param("id") id: string) {
    return this.partners.refunds(id);
  }

  @Patch("refunds/:refundId")
  decideRefund(
    @Param("refundId") id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = z.object({ status: z.enum(PartnerRefundStatus) }).parse(body);
    return this.partners.decideRefund(id, input.status, request.user!.id);
  }
}
