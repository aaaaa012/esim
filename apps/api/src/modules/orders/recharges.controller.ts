import {
  Body,
  Controller,
  ExecutionContext,
  Get,
  Headers,
  Injectable,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { initiatePaymentSchema } from "@visa-compass/shared";
import {
  AuthGuard,
  type AuthenticatedRequest,
} from "../../common/auth.guard.js";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { ClerkSyncService } from "../identity/clerk-sync.service.js";
import { GuestLookupRateLimitGuard } from "../../common/guest-lookup.rate-limit.guard.js";
import { RechargesService, rechargeView } from "./recharges.service.js";
import { PaymentsService } from "../payments/payments.service.js";

@Injectable()
export class OptionalRechargeAuthGuard extends AuthGuard {
  constructor(prisma: PrismaService, clerk: ClerkSyncService) {
    super(prisma, clerk);
  }
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.headers.authorization) return true;
    return super.canActivate(context);
  }
}
const createSchema = z.object({
  planId: z.string().min(1),
  termsAccepted: z.literal(true),
  privacyAccepted: z.literal(true),
  compatibilityAccepted: z.boolean().optional(),
  checkoutAttemptKey: z.string().regex(/^[a-zA-Z0-9_-]{20,100}$/),
  lookupToken: z.string().min(1).optional(),
  targetEsimId: z.string().uuid().optional(),
});

@Controller("recharges")
@UseGuards(OptionalRechargeAuthGuard)
export class RechargesController {
  constructor(
    private readonly recharges: RechargesService,
    private readonly payments: PaymentsService,
  ) {}
  @Post()
  create(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest & { ip?: string },
  ) {
    return this.recharges.create(createSchema.parse(body), req.user, {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }
  @Get("purchases")
  @UseGuards(AuthGuard)
  purchases(@Req() req: AuthenticatedRequest) {
    return this.recharges.purchases(req.user!);
  }
  @Get("targets")
  @UseGuards(AuthGuard)
  targets(@Req() req: AuthenticatedRequest) {
    return this.recharges.eligibleTargets(req.user!);
  }
  @Post("recovery-link")
  @UseGuards(GuestLookupRateLimitGuard)
  requestRecovery(@Body() body: unknown) {
    const input = z
      .object({
        orderNumber: z.string().trim().min(1).max(100),
        email: z.string().trim().email().max(254),
      })
      .parse(body);
    return this.recharges.requestRecovery(input.orderNumber, input.email);
  }
  @Post(":id/recover")
  @UseGuards(GuestLookupRateLimitGuard)
  recover(@Param("id") id: string, @Body() body: unknown) {
    return this.recharges.recover(
      id,
      z.object({ token: z.string().min(1).max(1000) }).parse(body).token,
    );
  }
  @Get(":id")
  async get(
    @Param("id") id: string,
    @Req() req: AuthenticatedRequest,
    @Headers("x-guest-order-token") token: string,
  ) {
    return rechargeView(await this.recharges.authorize(id, req.user, token));
  }
  @Post(":id/payment/initiate")
  initiate(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Headers("x-guest-order-token") token: string,
  ) {
    return this.recharges.pay(
      id,
      initiatePaymentSchema.parse(body).provider,
      req.user,
      token,
    );
  }
  @Post(":id/payment/verify")
  async verify(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Headers("x-guest-order-token") token: string,
  ) {
    const order = await this.recharges.authorize(id, req.user, token);
    const { reference } = z
      .object({ reference: z.string().min(1).max(500) })
      .parse(body);
    await this.payments.verify(id, order.ownerId, reference);
    return rechargeView(await this.recharges.authorize(id, req.user, token));
  }
  @Post(":id/payment/simulate")
  async simulate(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Headers("x-guest-order-token") token: string,
  ) {
    const order = await this.recharges.authorize(id, req.user, token);
    const input = z
      .object({
        reference: z.string(),
        scenario: z
          .enum([
            "SUCCESS",
            "CANCELLED",
            "PENDING",
            "WRONG_AMOUNT",
            "REFUNDED",
            "TIMEOUT",
          ])
          .optional(),
      })
      .parse(body);
    await this.payments.simulate(
      id,
      order.ownerId,
      input.reference,
      input.scenario,
    );
    return rechargeView(await this.recharges.authorize(id, req.user, token));
  }
}
