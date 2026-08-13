import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, Req, NotFoundException, UseGuards } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createOrderSchema, documentRequestSchema, initiatePaymentSchema, travelerSchema } from '@visa-compass/shared';
import { GuestLookupRateLimitGuard } from '../../common/guest-lookup.rate-limit.guard.js';
import { PassportVerificationRateLimitGuard } from '../../common/passport-verification.rate-limit.guard.js';
import { clientIp } from '../../common/client-ip.js';
import { PaymentsService } from '../payments/payments.service.js';
import { OrdersService } from './orders.service.js';

const guestTokenTtlMs = 24 * 60 * 60_000;
const tokenFor = (orderId: string) => {
  const secret = process.env.GUEST_ORDER_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') throw new Error('GUEST_ORDER_SECRET is required in production');
  const payload = Buffer.from(JSON.stringify({ orderId, expiresAt: Date.now() + guestTokenTtlMs })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret ?? 'local-guest-checkout-secret').update(payload).digest('base64url')}`;
};
const lookupTokenFor = (mobile: string) => {
  const secret = process.env.GUEST_ORDER_SECRET ?? 'local-guest-checkout-secret';
  const payload = Buffer.from(JSON.stringify({ mobile, expiresAt: Date.now() + 15 * 60_000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
};
const mobileFromLookupToken = (token: string) => {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw new ForbiddenException('Invalid or expired top-up lookup');
  const expected = Buffer.from(createHmac('sha256', process.env.GUEST_ORDER_SECRET ?? 'local-guest-checkout-secret').update(payload).digest('base64url'));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new ForbiddenException('Invalid or expired top-up lookup');
  const value = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { mobile?: string; expiresAt?: number };
  if (!value.mobile || !value.expiresAt || value.expiresAt < Date.now()) throw new ForbiddenException('Invalid or expired top-up lookup');
  return value.mobile;
};

// Login-free ("guest") checkout. Orders are created with no owner and every
// mutation is gated by an HMAC token bound to the order id, so the browser can
// drive the whole purchase without signing in.
@Controller('guest/orders')
export class GuestOrdersController {
  constructor(private readonly orders: OrdersService, private readonly payments: PaymentsService) {}

  @Post() async create(@Body() body: unknown, @Req() req: { ip?: string; socket?: { remoteAddress?: string }; headers?: { 'user-agent'?: string } }) {
    const parsed = createOrderSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    const input = parsed.data as { planId: string; compatibilityAccepted: boolean; targetEsimId?: string } & Partial<{ mobile: string }>;
    const candidate = body as { mobile?: unknown; email?: unknown; lookupToken?: unknown };
    if (candidate.mobile !== undefined && typeof candidate.mobile !== 'string') throw new BadRequestException('mobile must be a string');
    if (candidate.email !== undefined && typeof candidate.email !== 'string') throw new BadRequestException('email must be a string');
    const ipAddress = clientIp(req);
    const userAgent = req.headers?.['user-agent'];
    const verifiedMobile = candidate.lookupToken !== undefined ? mobileFromLookupToken(String(candidate.lookupToken)) : undefined;
    if (candidate.mobile !== undefined && !verifiedMobile) throw new ForbiddenException('A valid top-up lookup is required');
    const order = await this.orders.create(null, input.planId, input.compatibilityAccepted, {
      ...(verifiedMobile ? { mobile: verifiedMobile } : {}),
      ...(candidate.email !== undefined ? { email: candidate.email as string } : {}),
      ...(ipAddress ? { ipAddress } : {}),
      ...(userAgent ? { userAgent } : {}),
    });
    return { order, token: tokenFor(order.id) };
  }

  @Get(':id') get(@Param('id') id: string, @Query('token') token: string) { this.assert(id, token); return this.orders.view(id); }

  @Patch(':id/traveler') traveler(@Param('id') id: string, @Body() body: Record<string, unknown>) { this.assert(id, typeof body.token === 'string' ? body.token : ''); const { token: _token, ...traveler } = body; return this.orders.setTraveler(id, null, travelerSchema.parse(traveler)); }

  @Post(':id/documents') document(@Param('id') id: string, @Body() body: { token: string; type: unknown; fileName: string; contentType?: string }) { this.assert(id, body.token); return this.orders.addDocument(id, null, documentRequestSchema.parse({ type: body.type, fileName: body.fileName, ...(body.contentType ? { contentType: body.contentType } : {}) })); }

  @Post(':id/documents/:documentId/confirm') confirmDocument(@Param('id') id: string, @Param('documentId') documentId: string, @Body('token') token: string) { this.assert(id, token); return this.orders.confirmDocument(id, documentId, null); }

  @Post(':id/verify-passport')
  @UseGuards(PassportVerificationRateLimitGuard)
  verifyPassport(@Param('id') id: string, @Body() body: { token: string }) { this.assert(id, body.token); return this.orders.verifyPassport(id, null); }

  @Post(':id/payment') payment(@Param('id') id: string, @Body() body: { token: string; provider: unknown }) { this.assert(id, body.token); const input = initiatePaymentSchema.parse({ provider: body.provider }); return this.payments.initiate(id, null, input.provider); }

  @Post(':id/payment/verify') verify(@Param('id') id: string, @Body() body: { token: string; reference: string }) { this.assert(id, body.token); return this.payments.verify(id, null, body.reference); }

  @Post(':id/payment/simulate') simulate(@Param('id') id: string, @Body() body: { token: string; reference: string; scenario?: 'SUCCESS' | 'CANCELLED' | 'PENDING' | 'WRONG_AMOUNT' | 'REFUNDED' | 'TIMEOUT' }) { this.assert(id, body.token); return this.payments.simulate(id, null, body.reference, body.scenario); }

  @Post(':id/payment/abandon') abandon(@Param('id') id: string, @Body() body: { token: string; reason?: string }) { this.assert(id, body.token); return this.orders.resolvePaymentFailure(id, null, body.reason ?? 'Payment abandoned by guest'); }

  @Post(':id/cancel') cancel(@Param('id') id: string, @Body() body: { token: string; reason?: string }) { this.assert(id, body.token); return this.orders.cancel(id, null, body.reason ?? 'Cancelled by guest'); }

  @Post('topup-lookup')
  @UseGuards(GuestLookupRateLimitGuard)
  async topUpLookup(@Body() body: { mobile: string }) { if (!body.mobile?.trim()) throw new BadRequestException('mobile is required'); const result = await this.orders.topUpLookup(body.mobile); return { ...result, ...(result.found ? { lookupToken: lookupTokenFor(body.mobile.trim()) } : {}) }; }

  private assert(id: string, token: string) {
    if (!this.orders.get(id)) throw new NotFoundException('Order not found');
    if (!token) throw new ForbiddenException('Guest token is required');
    const [payload, signature] = token.split('.');
    if (!payload || !signature) throw new ForbiddenException('Invalid or expired guest token');
    const expected = Buffer.from(createHmac('sha256', process.env.GUEST_ORDER_SECRET ?? 'local-guest-checkout-secret').update(payload).digest('base64url'));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new ForbiddenException('Invalid or expired guest token');
    let claims: { orderId?: string; expiresAt?: number };
    try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { orderId?: string; expiresAt?: number }; }
    catch { throw new ForbiddenException('Invalid or expired guest token'); }
    if (claims.orderId !== id || !claims.expiresAt || claims.expiresAt <= Date.now()) throw new ForbiddenException('Invalid or expired guest token');
  }
}
