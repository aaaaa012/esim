import { RechargesService, rechargeView } from "./recharges.service.js";
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Logger,
  Param,
  Patch,
  Post,
  Req,
  NotFoundException,
  UseGuards,
} from "@nestjs/common";
import {
  createOrderSchema,
  documentRequestSchema,
  initiatePaymentSchema,
  travelerSchema,
} from "@visa-compass/shared";
import { GuestLookupRateLimitGuard } from "../../common/guest-lookup.rate-limit.guard.js";
import { normalizeMsisdn } from "../../common/msisdn.util.js";
import { PassportVerificationRateLimitGuard } from "../../common/passport-verification.rate-limit.guard.js";
import { clientIp } from "../../common/client-ip.js";
import { PaymentsService } from "../payments/payments.service.js";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { OrdersService } from "./orders.service.js";
import { GuestOrderAccessService } from "./guest-order-access.service.js";
import { NotificationService } from "../notification/notification.service.js";

// Login-free ("guest") checkout. Orders are created with no owner and every
// mutation is gated by an HMAC token bound to the order id, so the browser can
// drive the whole purchase without signing in.
@Controller("guest/orders")
export class GuestOrdersController {
  private readonly logger = new Logger(GuestOrdersController.name);

  constructor(
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
    private readonly prisma: PrismaService,
    private readonly access: GuestOrderAccessService,
    private readonly notifications: NotificationService,
    private readonly recharges: RechargesService,
  ) {}

  @Post() async create(
    @Body() body: unknown,
    @Req()
    req: {
      ip?: string;
      socket?: { remoteAddress?: string };
      headers?: { "user-agent"?: string; "x-idempotency-key"?: string };
    },
  ) {
    const parsed = createOrderSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    const input = parsed.data as {
      planId: string;
      compatibilityAccepted: boolean;
      termsAccepted: boolean;
      privacyAccepted: boolean;
      targetEsimId?: string;
    } & Partial<{ mobile: string }>;
    const candidate = body as {
      mobile?: unknown;
      email?: unknown;
      lookupToken?: unknown;
    };
    if (candidate.mobile !== undefined && typeof candidate.mobile !== "string")
      throw new BadRequestException("mobile must be a string");
    if (candidate.email !== undefined && typeof candidate.email !== "string")
      throw new BadRequestException("email must be a string");
    const ipAddress = clientIp(req);
    const userAgent = req.headers?.["user-agent"];
    const verifiedMobile =
      candidate.lookupToken !== undefined
        ? this.access.mobileFromLookupToken(String(candidate.lookupToken))
        : undefined;
    if (candidate.mobile !== undefined && !verifiedMobile)
      throw new ForbiddenException("A valid top-up lookup is required");
    if (verifiedMobile)
      return this.recharges.create({
        planId: input.planId,
        termsAccepted: input.termsAccepted,
        privacyAccepted: input.privacyAccepted,
        lookupToken: String(candidate.lookupToken),
        checkoutAttemptKey: String(
          (body as { checkoutAttemptKey?: string }).checkoutAttemptKey ??
            req.headers?.["x-idempotency-key"] ??
            "",
        ),
      });
    const order = await this.orders.create(
      null,
      input.planId,
      input.compatibilityAccepted,
      {
        ...(verifiedMobile ? { mobile: verifiedMobile } : {}),
        ...(candidate.email !== undefined
          ? { email: candidate.email as string }
          : {}),
        ...(ipAddress ? { ipAddress } : {}),
        ...(userAgent ? { userAgent } : {}),
        termsAccepted: input.termsAccepted,
        privacyAccepted: input.privacyAccepted,
      },
    );
    const recovery = await this.access.issue(order.id, "DISPLAY");
    return {
      order,
      token: this.access.createSessionToken(order.id),
      recovery,
    };
  }

  @Post(":id/recover")
  async recover(@Param("id") id: string, @Body() body: { token?: unknown }) {
    await this.orders.refreshOne(id, true);
    if (!this.orders.get(id)) throw new NotFoundException("Order not found");
    if (this.orders.get(id).purchaseType === "TOPUP")
      return this.recharges.recover(
        id,
        typeof body.token === "string" ? body.token : "",
      );
    const recovered = await this.access.recover(
      id,
      typeof body.token === "string" ? body.token : "",
    );
    const ownerId = await this.guestOwner(id);
    return {
      order: ownerId
        ? await this.orders.view(id, ownerId)
        : await this.orders.guestView(id),
      ...recovered,
    };
  }

  @Get(":id") async get(
    @Param("id") id: string,
    @Headers("x-guest-order-token") token: string,
  ) {
    await this.orders.refreshOne(id, true);
    if (this.orders.get(id).purchaseType === "TOPUP")
      return rechargeView(await this.recharges.authorize(id, undefined, token));
    const ownerId = await this.assert(id, token);
    return ownerId ? this.orders.view(id, ownerId) : this.orders.guestView(id);
  }

  @Patch(":id/traveler") async traveler(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
    @Headers("x-guest-order-token") token: string,
  ) {
    const ownerId = await this.assert(id, token);
    const traveler = travelerSchema.parse(body);
    const order = await this.orders.setTraveler(id, ownerId, traveler);
    try {
      const recovery = await this.access.issue(id, "EMAIL", traveler.email);
      if (recovery)
        await this.notifications.enqueue({
          orderId: id,
          channel: "EMAIL",
          template: "GUEST_ORDER_RECOVERY",
          recipient: traveler.email,
          orderNumber: order.orderNumber,
          recoveryUrl: this.recoveryUrl(id, recovery.token),
        });
    } catch (error) {
      this.logger.warn(
        `Guest recovery email could not be queued for ${id}: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
    return order;
  }

  @Post(":id/documents") async document(
    @Param("id") id: string,
    @Body()
    body: {
      type: unknown;
      fileName: string;
      contentType?: string;
    },
    @Headers("x-guest-order-token") token: string,
  ) {
    const ownerId = await this.assert(id, token);
    return this.orders.addDocument(
      id,
      ownerId,
      documentRequestSchema.parse({
        type: body.type,
        fileName: body.fileName,
        ...(body.contentType ? { contentType: body.contentType } : {}),
      }),
    );
  }

  @Post(":id/documents/:documentId/confirm") async confirmDocument(
    @Param("id") id: string,
    @Param("documentId") documentId: string,
    @Headers("x-guest-order-token") token: string,
  ) {
    const ownerId = await this.assert(id, token);
    return this.orders.confirmDocument(id, documentId, ownerId);
  }

  @Post(":id/verify-passport")
  @UseGuards(PassportVerificationRateLimitGuard)
  async verifyPassport(
    @Param("id") id: string,
    @Headers("x-guest-order-token") token: string,
  ) {
    const ownerId = await this.assert(id, token);
    return this.orders.verifyPassport(id, ownerId);
  }

  @Post(":id/payment") async payment(
    @Param("id") id: string,
    @Body() body: { provider: unknown },
    @Headers("x-guest-order-token") token: string,
  ) {
    const ownerId = await this.assert(id, token);
    const input = initiatePaymentSchema.parse({ provider: body.provider });
    return this.payments.initiate(id, ownerId, input.provider);
  }

  @Post(":id/payment/verify") async verify(
    @Param("id") id: string,
    @Body() body: { reference: string },
    @Headers("x-guest-order-token") token: string,
  ) {
    const ownerId = await this.assert(id, token);
    return this.payments.verify(id, ownerId, body.reference);
  }

  @Post(":id/payment/simulate") async simulate(
    @Param("id") id: string,
    @Body()
    body: {
      reference: string;
      scenario?:
        | "SUCCESS"
        | "CANCELLED"
        | "PENDING"
        | "WRONG_AMOUNT"
        | "REFUNDED"
        | "TIMEOUT";
    },
    @Headers("x-guest-order-token") token: string,
  ) {
    const ownerId = await this.assert(id, token);
    return this.payments.simulate(id, ownerId, body.reference, body.scenario);
  }

  @Post(":id/payment/abandon") async abandon(
    @Param("id") id: string,
    @Body() body: { reason?: string },
    @Headers("x-guest-order-token") token: string,
  ) {
    const ownerId = await this.assert(id, token);
    return this.orders.resolvePaymentFailure(
      id,
      ownerId,
      body.reason ?? "Payment abandoned by guest",
    );
  }

  @Post(":id/cancel") async cancel(
    @Param("id") id: string,
    @Body() body: { reason?: string },
    @Headers("x-guest-order-token") token: string,
  ) {
    const ownerId = await this.assert(id, token);
    return this.orders.cancel(id, ownerId, body.reason ?? "Cancelled by guest");
  }

  @Post("topup-lookup")
  @UseGuards(GuestLookupRateLimitGuard)
  async topUpLookup(@Body() body: { mobile: string }) {
    const startedAt = Date.now();
    try {
      const normalizedMobile = normalizeMsisdn(body.mobile ?? "");
      if (
        !/^[+0-9][0-9\s()./-]*$/.test((body.mobile ?? "").trim()) ||
        !/^[0-9]{6,15}$/.test(normalizedMobile)
      )
        throw new BadRequestException(
          "Enter a valid eSIM mobile number (MSISDN) with 6 to 15 digits",
        );
      const subscriber = await this.orders.resolveSubscriber(body.mobile);
      if (subscriber) {
        if (!subscriber.inventory)
          return {
            verificationRequested: true,
            message:
              "If this eSIM is eligible, a recharge link will be sent to its original purchase email.",
          };
        const target = await this.recharges.target(subscriber.inventory.id);
        const lookupToken = this.access.createLookupToken(
          target.mobile,
          target,
        );
        try {
          await this.notifications.enqueue({
            orderId: subscriber.orderId,
            channel: "EMAIL",
            template: "TOPUP_LOOKUP",
            recipient: target.email,
            orderNumber: "eSIM recharge",
            recoveryUrl: this.topUpLookupUrl(lookupToken),
          });
        } catch (error) {
          this.logger.error(
            `Recharge verification email could not be queued for order ${subscriber.orderId}: ${error instanceof Error ? error.message : "unknown"}`,
          );
        }
      }
      await this.recordTopUpEvent(
        "customer-topup-lookup",
        200,
        startedAt,
        {
          verificationRequested: true,
        },
        { mobile: "[REDACTED]" },
      );
      return {
        verificationRequested: true,
        message:
          "If this MSISDN belongs to an eligible Visa Compass eSIM, a secure recharge link has been sent to the original purchase email.",
      };
    } catch (error) {
      await this.recordTopUpEvent(
        "customer-topup-lookup",
        this.statusFor(error),
        startedAt,
        { found: false },
        { mobile: "[REDACTED]" },
        error,
      );
      throw error;
    }
  }

  @Post("topup-lookup/verify")
  @UseGuards(GuestLookupRateLimitGuard)
  async verifyTopUpLookup(@Body() body: { lookupToken?: string }) {
    const { mobile } = await this.recharges.targetFromLookup(
      body.lookupToken ?? "",
    );
    const result = await this.orders.topUpLookup(mobile);
    if (!result.found)
      throw new ForbiddenException("This recharge link is invalid or expired");
    return { ...result, lookupToken: body.lookupToken };
  }

  @Post("topup-eligibility")
  @UseGuards(GuestLookupRateLimitGuard)
  async topUpEligibility(
    @Body() body: { mobile?: string; lookupToken?: string; planId?: string },
  ) {
    const startedAt = Date.now();
    try {
      if (!body.planId?.trim())
        throw new BadRequestException("planId is required");
      const { mobile } = await this.recharges.targetFromLookup(
        body.lookupToken ?? "",
      );
      if (body.mobile && body.mobile !== mobile)
        throw new ForbiddenException(
          "Top-up lookup does not match this eSIM MSISDN",
        );
      const result = await this.orders.checkTopUpEligibility(
        mobile,
        body.planId,
      );
      await this.recordTopUpEvent(
        "customer-topup-eligibility",
        200,
        startedAt,
        {
          planId: body.planId,
          allowed: result.allowed,
          ...(result.errorKey ? { errorKey: result.errorKey } : {}),
          ...(result.errorMessage
            ? { reason: result.errorMessage.slice(0, 300) }
            : {}),
        },
        {
          mobile: "[REDACTED]",
          lookupToken: "[REDACTED]",
          planId: body.planId,
        },
      );
      return result;
    } catch (error) {
      await this.recordTopUpEvent(
        "customer-topup-eligibility",
        this.statusFor(error),
        startedAt,
        body.planId
          ? { planId: body.planId, allowed: false }
          : { allowed: false },
        {
          mobile: "[REDACTED]",
          lookupToken: "[REDACTED]",
          ...(body.planId ? { planId: body.planId } : {}),
        },
        error,
      );
      throw error;
    }
  }

  private statusFor(error: unknown) {
    return typeof error === "object" &&
      error &&
      "getStatus" in error &&
      typeof (error as { getStatus?: unknown }).getStatus === "function"
      ? (error as { getStatus(): number }).getStatus()
      : 500;
  }

  /** Persist safe customer top-up milestones without phone numbers or tokens. */
  private async recordTopUpEvent(
    operation: "customer-topup-lookup" | "customer-topup-eligibility",
    status: number,
    startedAt: number,
    responseBody: Record<string, unknown>,
    requestBody: Record<string, unknown>,
    error?: unknown,
  ) {
    if (!this.prisma.enabled) return;
    const message =
      error instanceof Error ? error.message.slice(0, 500) : undefined;
    try {
      await this.prisma.integrationLog.create({
        data: {
          operation,
          method: "POST",
          endpoint:
            operation === "customer-topup-lookup"
              ? "/guest/orders/topup-lookup"
              : "/guest/orders/topup-eligibility",
          status,
          durationMs: Date.now() - startedAt,
          requestBody: { source: "customer-web", ...requestBody },
          responseBody: responseBody as never,
          ...(message ? { errorMessage: message } : {}),
        },
      });
    } catch {
      // Diagnostics must never interrupt a customer recharge journey.
    }
  }

  private async assert(id: string, token: string) {
    this.access.assertSessionToken(id, token);
    return this.guestOwner(id);
  }

  private async guestOwner(id: string) {
    await this.orders.refreshOne(id, true);
    const order = this.orders.get(id);
    if (!order) throw new NotFoundException("Order not found");
    if (order.purchaseType === "TOPUP")
      throw new ForbiddenException(
        "Use the recharge tracking endpoint for this order",
      );
    if (order.ownerId && !order.ownerId.startsWith("guest-"))
      throw new ForbiddenException("Guest access has been revoked");
    return order.ownerId;
  }

  private recoveryUrl(orderId: string, token: string) {
    const base = (
      process.env.CUSTOMER_WEB_URL ?? "http://localhost:3000"
    ).replace(/\/$/, "");
    return `${base}/esim/checkout?order=${encodeURIComponent(orderId)}#resume=${encodeURIComponent(token)}`;
  }

  private topUpLookupUrl(token: string) {
    const base = (
      process.env.CUSTOMER_WEB_URL ?? "http://localhost:3000"
    ).replace(/\/$/, "");
    // Keep the bearer token in the URL fragment. Fragments are not sent in
    // HTTP requests, access logs, or referrer headers.
    return `${base}/recharge#topup=${encodeURIComponent(token)}`;
  }
}
