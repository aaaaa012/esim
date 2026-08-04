import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@visa-compass/shared';
import { AuthGuard, type AuthenticatedRequest, requireRole } from '../../common/auth.guard.js';
import { AccountGuard,AccountTypes } from '../../common/auth.guard.js';
import { UserRoleName } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Webhook } from 'svix';
import { PrismaService } from '../../infrastructure/prisma.service.js';
import { QueueService } from '../../jobs/queue.service.js';
import { QUEUES } from '../../jobs/queues.js';
import { ClerkSyncService } from '../identity/clerk-sync.service.js';

@Controller('webhooks')
export class WebhooksController {
  private readonly accepted = new Set<string>();
  constructor(private readonly prisma: PrismaService, private readonly queues: QueueService, private readonly clerkSync: ClerkSyncService) {}

  @Post('clerk')
  @HttpCode(202)
  async clerk(@Body() body: unknown, @Headers() headers: Record<string, string>) {
    if (!process.env.CLERK_WEBHOOK_SECRET) {
      if (process.env.NODE_ENV === 'production') throw new BadRequestException('Clerk webhook is not configured');
      return { accepted: true, simulated: true };
    }
    const event = new Webhook(process.env.CLERK_WEBHOOK_SECRET).verify(JSON.stringify(body), {
      'svix-id': headers['svix-id'] ?? '',
      'svix-timestamp': headers['svix-timestamp'] ?? '',
      'svix-signature': headers['svix-signature'] ?? '',
    }) as { type: string; data: { id: string } };
    const result = await this.clerkSync.sync(event as never);
    return { accepted: true, eventType: event.type, userId: event.data.id, ...result };
  }

  @Post('payments/:provider')
  @HttpCode(202)
  async payment(@Param('provider') provider: string, @Body() body: { eventId?: string }, @Headers('x-visa-signature') signature?: string) {
    const eventId = body.eventId;
    if (!eventId) throw new BadRequestException('eventId is required');
    if (this.accepted.has(`${provider}:${eventId}`) || await this.webhookExists(provider, eventId)) return { accepted: true, duplicate: true };
    if (process.env.NODE_ENV !== 'production' && signature) this.verifyLocalSignature(JSON.stringify(body), signature);
    this.accepted.add(`${provider}:${eventId}`);
    await this.persistWebhook(provider, eventId, body, Boolean(signature));
    await this.queues.add(QUEUES.payments, 'payment-callback', { provider, eventId, payload: body }, `${provider}-${eventId}`);
    return { accepted: true, queued: true };
  }

  @Post('connectivity/:provider')
  @HttpCode(202)
  async connectivity(@Param('provider') provider: string, @Body() body: { eventId?: string }, @Headers('x-visa-signature') signature?:string) {
    if (!body.eventId) throw new BadRequestException('eventId is required');
    if(process.env.NODE_ENV==='production'&&!signature)throw new BadRequestException('Connectivity webhook signature is required');
    if(signature)this.verifyConnectivitySignature(JSON.stringify(body),signature);
    const key = `${provider}:${body.eventId}`;
    if (this.accepted.has(key) || await this.webhookExists(provider, body.eventId)) return { accepted: true, duplicate: true };
    this.accepted.add(key);
    await this.persistWebhook(provider, body.eventId, body, true);
    await this.queues.add(QUEUES.providerCallbacks, 'connectivity-callback', { provider, eventId: body.eventId, payload: body }, key);
    return { accepted: true, queued: true };
  }

  private async persistWebhook(source: string, eventId: string, payload: object, signatureValid: boolean) {
    if (!this.prisma.enabled) return;
    await this.prisma.webhookEvent.upsert({ where: { source_eventId: { source, eventId } }, update: {}, create: { source, eventId, payload, signatureValid } });
  }

  private async webhookExists(source: string, eventId: string) { if (!this.prisma.enabled) return false; return Boolean(await this.prisma.webhookEvent.findUnique({ where: { source_eventId: { source, eventId } }, select: { id: true } })); }

  private verifyLocalSignature(payload: string, signature: string) {
    const expected = createHmac('sha256', process.env.PAYMENT_SIMULATOR_SECRET ?? 'local-development-only-change-me').update(payload).digest('hex');
    const a = Buffer.from(expected); const b = Buffer.from(signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new BadRequestException('Invalid webhook signature');
  }
  private verifyConnectivitySignature(payload:string,signature:string){const secret=process.env.CONNECTIVITY_WEBHOOK_SECRET??(process.env.NODE_ENV!=='production'?'local-connectivity-webhook-secret':'');if(!secret)throw new BadRequestException('Connectivity webhook is not configured');const expected=createHmac('sha256',secret).update(payload).digest('hex');const a=Buffer.from(expected);const b=Buffer.from(signature);if(a.length!==b.length||!timingSafeEqual(a,b))throw new BadRequestException('Invalid connectivity webhook signature')}
}

@Controller('operations/integration-events')
@UseGuards(AuthGuard,AccountGuard)
@AccountTypes(UserRoleName.OPERATIONS,UserRoleName.SUPER_ADMIN)
export class OperationsIntegrationEventsController {
  constructor(private readonly prisma:PrismaService){}
  @Get() async list(@Req() request:AuthenticatedRequest){requireRole(request,[UserRole.OPERATIONS,UserRole.SUPER_ADMIN]);if(!this.prisma.enabled)return [];return this.prisma.webhookEvent.findMany({where:{NOT:{source:{startsWith:'idempotency:'}}},select:{id:true,source:true,eventId:true,signatureValid:true,processedAt:true,errorMessage:true,createdAt:true},orderBy:{createdAt:'desc'},take:200})}
}
