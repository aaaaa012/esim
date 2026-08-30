import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Req,
  NotFoundException,
  UseGuards,
} from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createOrderSchema,
  documentRequestSchema,
  initiatePaymentSchema,
  travelerSchema,
} from "@visa-compass/shared";
import { GuestLookupRateLimitGuard } from "../../common/guest-lookup.rate-limit.guard.js";
import { PassportVerificationRateLimitGuard } from "../../common/passport-verification.rate-limit.guard.js";
import { clientIp } from "../../common/client-ip.js";
import { PaymentsService } from "../payments/payments.service.js";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { OrdersService } from "./orders.service.js";

const guestTokenTtlMs = 24 * 60 * 60_000;
const tokenFor = (orderId: string) => {
  const secret = process.env.GUEST_ORDER_SECRET;
  if (!secret && process.env.NODE_ENV === "production")
    throw new Error("GUEST_ORDER_SECRET is required in production");
  const payload = Buffer.from(
    JSON.stringify({ orderId, expiresAt: Date.now() + guestTokenTtlMs }),
  ).toString("base64url");
  return `${payload}.${createHmac(
    "sha256",
    secret ?? "local-guest-checkout-secret",
  )
    .update(payload)
    .digest("base64url")}`;
};
const lookupTokenFor = (mobile: string) => {
  const secret =
    process.env.GUEST_ORDER_SECRET ?? "local-guest-checkout-secret";
  const payload = Buffer.from(
    JSON.stringify({ mobile, expiresAt: Date.now() + 15 * 60_000 }),
  ).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
};
const mobileFromLookupToken = (token: string) => {
  const [payload, signature] = token.split(".");
  if (!payload || !signature)
    throw new ForbiddenException("Invalid or expired top-up lookup");
  const expected = Buffer.from(
    createHmac(
      "sha256",
      process.env.GUEST_ORDER_SECRET ?? "local-guest-checkout-secret",
    )
      .update(payload)
      .digest("base64url"),
  );
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new ForbiddenException("Invalid or expired top-up lookup");
  const value = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
    mobile?: string;
    expiresAt?: number;
  };
  if (!value.mobile || !value.expiresAt || value.expiresAt < Date.now())
    throw new ForbiddenException("Invalid or expired top-up lookup");
  return value.mobile;
};

// Login-free ("guest") checkout. Orders are created with no owner and every
// mutation is gated by an HMAC token bound to the order id, so the browser can
// drive the whole purchase without signing in.
@Controller("guest/orders")
export class GuestOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post() async create(
    @Body() body: unknown,
    @Req()
    req: {
      ip?: string;
      socket?: { remoteAddress?: string };
      headers?: { "user-agent"?: string };
    },
  ) {
    const parsed = createOrderSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    const input = parsed.data as {
      planId: string;
      compatibilityAccepted: boolean;
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
        ? mobileFromLookupToken(String(candidate.lookupToken))
        : undefined;
    if (candidate.mobile !== undefined && !verifiedMobile)
      throw new ForbiddenException("A valid top-up lookup is required");
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
      },
    );
    return { order, token: tokenFor(order.id) };
  }

  @Get(":id") get(
    @Param("id") id: string,
    @Headers("x-guest-order-token") token: string,
  ) {
    this.assert(id, token);
    return this.orders.guestView(id);
  }

  @Patch(":id/traveler") traveler(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
    @Headers("x-guest-order-token") token: string,
  ) {
    this.assert(id, token);
    return this.orders.setTraveler(id, null, travelerSchema.parse(body));
  }

  @Post(":id/documents") document(
    @Param("id") id: string,
    @Body()
    body: {
      type: unknown;
      fileName: string;
      contentType?: string;
    },
    @Headers("x-guest-order-token") token: string,
  ) {
    this.assert(id, token);
    return this.orders.addDocument(
      id,
      null,
      documentRequestSchema.parse({
        type: body.type,
        fileName: body.fileName,
        ...(body.contentType ? { contentType: body.contentType } : {}),
      }),
    );
  }

  @Post(":id/documents/:documentId/confirm") confirmDocument(
    @Param("id") id: string,
    @Param("documentId") documentId: string,
    @Headers("x-guest-order-token") token: string,
  ) {
    this.assert(id, token);
    return this.orders.confirmDocument(id, documentId, null);
  }

  @Post(":id/verify-passport")
  @UseGuards(PassportVerificationRateLimitGuard)
  verifyPassport(
    @Param("id") id: string,
    @Headers("x-guest-order-token") token: string,
  ) {
    this.assert(id, token);
    return this.orders.verifyPassport(id, null);
  }

  @Post(":id/payment") payment(
    @Param("id") id: string,
    @Body() body: { provider: unknown },
    @Headers("x-guest-order-token") token: string,
  ) {
    this.assert(id, token);
    const input = initiatePaymentSchema.parse({ provider: body.provider });
    return this.payments.initiate(id, null, input.provider);
  }

  @Post(":id/payment/verify") verify(
    @Param("id") id: string,
    @Body() body: { reference: string },
    @Headers("x-guest-order-token") token: string,
  ) {
    this.assert(id, token);
    return this.payments.verify(id, null, body.reference);
  }

  @Post(":id/payment/simulate") simulate(
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
    this.assert(id, token);
    return this.payments.simulate(id, null, body.reference, body.scenario);
  }

  @Post(":id/payment/abandon") abandon(
    @Param("id") id: string,
    @Body() body: { reason?: string },
    @Headers("x-guest-order-token") token: string,
  ) {
    this.assert(id, token);
    return this.orders.resolvePaymentFailure(
      id,
      null,
      body.reason ?? "Payment abandoned by guest",
    );
  }

  @Post(":id/cancel") cancel(
    @Param("id") id: string,
    @Body() body: { reason?: string },
    @Headers("x-guest-order-token") token: string,
  ) {
    this.assert(id, token);
    return this.orders.cancel(id, null, body.reason ?? "Cancelled by guest");
  }

  @Post("topup-lookup")
  @UseGuards(GuestLookupRateLimitGuard)
  async topUpLookup(@Body() body: { mobile: string }) {
    const startedAt = Date.now();
    try {
      if (!body.mobile?.trim())
        throw new BadRequestException("mobile is required");
      const result = await this.orders.topUpLookup(body.mobile);
      await this.recordTopUpEvent("customer-topup-lookup", 200, startedAt, {
        found: result.found,
        topUpAvailable:
          "topUpAvailable" in result && Boolean(result.topUpAvailable),
      }, { mobile: "[REDACTED]" });
      return {
        ...result,
        ...(result.found
          ? { lookupToken: lookupTokenFor(body.mobile.trim()) }
          : {}),
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

  @Post("topup-eligibility")
  @UseGuards(GuestLookupRateLimitGuard)
  async topUpEligibility(
    @Body() body: { mobile?: string; lookupToken?: string; planId?: string },
  ) {
    const startedAt = Date.now();
    try {
      if (!body.planId?.trim())
        throw new BadRequestException("planId is required");
      const mobile = mobileFromLookupToken(body.lookupToken ?? "");
      if (body.mobile && body.mobile !== mobile)
        throw new ForbiddenException(
          "Top-up lookup does not match this mobile number",
        );
      const result = await this.orders.checkTopUpEligibility(mobile, body.planId);
      await this.recordTopUpEvent("customer-topup-eligibility", 200, startedAt, {
        planId: body.planId,
        allowed: result.allowed,
        ...(result.errorKey ? { errorKey: result.errorKey } : {}),
        ...(result.errorMessage
          ? { reason: result.errorMessage.slice(0, 300) }
          : {}),
      }, {
        mobile: "[REDACTED]",
        lookupToken: "[REDACTED]",
        planId: body.planId,
      });
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
    return typeof error === "object" && error && "getStatus" in error &&
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

  private assert(id: string, token: string) {
    if (!this.orders.get(id)) throw new NotFoundException("Order not found");
    if (!token) throw new ForbiddenException("Guest token is required");
    const [payload, signature] = token.split(".");
    if (!payload || !signature)
      throw new ForbiddenException("Invalid or expired guest token");
    const expected = Buffer.from(
      createHmac(
        "sha256",
        process.env.GUEST_ORDER_SECRET ?? "local-guest-checkout-secret",
      )
        .update(payload)
        .digest("base64url"),
    );
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw new ForbiddenException("Invalid or expired guest token");
    let claims: { orderId?: string; expiresAt?: number };
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
        orderId?: string;
        expiresAt?: number;
      };
    } catch {
      throw new ForbiddenException("Invalid or expired guest token");
    }
    if (
      claims.orderId !== id ||
      !claims.expiresAt ||
      claims.expiresAt <= Date.now()
    )
      throw new ForbiddenException("Invalid or expired guest token");
  }
}
