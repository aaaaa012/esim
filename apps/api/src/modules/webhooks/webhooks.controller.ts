import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Post, Query, RawBodyRequest, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@visa-compass/shared';
import { AuthGuard, type AuthenticatedRequest, requireRole } from '../../common/auth.guard.js';
import { AccountGuard,AccountTypes } from '../../common/auth.guard.js';
import { UserRoleName } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { Webhook } from 'svix';
import { PrismaService } from '../../infrastructure/prisma.service.js';
import { QueueService } from '../../jobs/queue.service.js';
import { QUEUES } from '../../jobs/queues.js';
import { ClerkSyncService } from '../identity/clerk-sync.service.js';
import { paymentSimulatorSecret } from '../../common/payment-simulator-secret.js';

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
    if (typeof eventId !== 'string' || eventId.length < 8 || eventId.length > 256) throw new BadRequestException('eventId is invalid');
    this.verifyPaymentSignature(JSON.stringify(body), signature);
    if (this.accepted.has(`${provider}:${eventId}`) || await this.webhookExists(provider, eventId)) return { accepted: true, duplicate: true };
    this.remember(`${provider}:${eventId}`);
    await this.persistWebhook(provider, eventId, body, true);
    await this.queues.add(QUEUES.payments, 'payment-callback', { provider, eventId, payload: body }, `${provider}-${eventId}`);
    return { accepted: true, queued: true };
  }

  @Post('connectivity/:provider')
  @HttpCode(202)
  async connectivity(@Param('provider') provider: string, @Body() body: { eventId?: string; header?: { eventId?: string } }, @Headers() headers: Record<string, string>, @Req() request: RawBodyRequest<Request>) {
    const source = provider.toLowerCase();
    if (source !== 'transatel') throw new BadRequestException(`Unsupported connectivity provider: ${provider}`);
    const eventId = body.eventId ?? body.header?.eventId;
    if (!eventId) throw new BadRequestException('eventId is required');
    if (typeof eventId !== 'string' || eventId.length < 8 || eventId.length > 256) throw new BadRequestException('eventId is invalid');
    const signature = headers['x-tsl-signature-256'] ?? headers['x-visa-signature'];
    if (signature) {
      if (!request.rawBody) throw new BadRequestException('Raw webhook body is unavailable');
      this.verifyTransatelSignature(request.rawBody, signature);
    }
    else if (process.env.NODE_ENV === 'production') throw new BadRequestException('Transatel webhook signature is required');
    const key = `${source}:${eventId}`;
    const existing = await this.webhookState(source, eventId);
    if (existing?.deadLetteredAt) return { accepted: true, duplicate: true, deadLettered: true };
    if (existing?.processedAt) return { accepted: true, duplicate: true };
    if (!existing) await this.persistWebhook(source, eventId, body, Boolean(signature));
    // Re-enqueue persisted-but-unprocessed duplicates. This closes the failure
    // window where the database insert succeeds but Redis is temporarily down.
    await this.queues.add(QUEUES.providerCallbacks, 'connectivity-callback', { provider: source, eventId }, key);
    this.remember(key);
    return { accepted: true, queued: true };
  }

  /** Bounded in-memory dedup set used when persistence is disabled. */
  private remember(key: string) {
    this.accepted.add(key);
    if (this.accepted.size > 20_000) this.accepted.clear();
  }

  private async persistWebhook(source: string, eventId: string, payload: object, signatureValid: boolean) {
    if (!this.prisma.enabled) return;
    await this.prisma.webhookEvent.upsert({ where: { source_eventId: { source, eventId } }, update: {}, create: { source, eventId, payload, signatureValid } });
  }

  private async webhookExists(source: string, eventId: string) { if (!this.prisma.enabled) return false; return Boolean(await this.prisma.webhookEvent.findUnique({ where: { source_eventId: { source, eventId } }, select: { id: true } })); }
  private async webhookState(source: string, eventId: string) { if (!this.prisma.enabled) return null; return this.prisma.webhookEvent.findUnique({ where: { source_eventId: { source, eventId } }, select: { processedAt: true, deadLetteredAt: true } }); }

  private verifyPaymentSignature(payload: string, signature?: string) {
    if (!signature) throw new BadRequestException('Payment webhook signature is required');
    const secret = process.env.PAYMENT_WEBHOOK_SECRET ?? (process.env.NODE_ENV === 'production' ? undefined : paymentSimulatorSecret());
    if (!secret) throw new BadRequestException('Payment webhook is not configured');
    const raw = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
    const expected = createHmac('sha256', secret).update(payload).digest('hex');
    const a = Buffer.from(expected); const b = Buffer.from(raw);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new BadRequestException('Invalid payment webhook signature');
  }
  private verifyTransatelSignature(payload:Buffer,signature:string){const secret=process.env.TRANSATEL_WEBHOOK_SECRET;if(!secret)throw new BadRequestException('Transatel webhook is not configured');const expected=`sha256=${createHmac('sha256',secret).update(payload).digest('hex')}`;const a=Buffer.from(expected);const b=Buffer.from(signature);if(a.length!==b.length||!timingSafeEqual(a,b))throw new BadRequestException('Invalid Transatel webhook signature')}
}

@Controller('operations/integration-events')
@UseGuards(AuthGuard,AccountGuard)
@AccountTypes(UserRoleName.OPERATIONS,UserRoleName.SUPER_ADMIN)
export class OperationsIntegrationEventsController {
  constructor(private readonly prisma:PrismaService){}
  @Get() async list(@Req() request:AuthenticatedRequest){requireRole(request,[UserRole.OPERATIONS,UserRole.SUPER_ADMIN]);if(!this.prisma.enabled)return [];return this.prisma.webhookEvent.findMany({where:{NOT:{source:{startsWith:'idempotency:'}}},select:{id:true,source:true,eventId:true,signatureValid:true,processedAt:true,processingStartedAt:true,attemptCount:true,nextAttemptAt:true,deadLetteredAt:true,errorMessage:true,createdAt:true},orderBy:{createdAt:'desc'},take:200})}
}

@Controller('operations/integration-logs')
@UseGuards(AuthGuard,AccountGuard)
@AccountTypes(UserRoleName.OPERATIONS,UserRoleName.SUPER_ADMIN)
export class OperationsIntegrationLogsController {
  constructor(private readonly prisma:PrismaService){}
  @Get() async list(@Req() request:AuthenticatedRequest, @Query('operation') operation?:string){requireRole(request,[UserRole.OPERATIONS,UserRole.SUPER_ADMIN]);if(!this.prisma.enabled)return [];return this.prisma.integrationLog.findMany({where:operation?{operation}:{},select:{id:true,operation:true,method:true,endpoint:true,status:true,durationMs:true,errorCode:true,errorMessage:true,createdAt:true},orderBy:{createdAt:'desc'},take:200})}
}

@Controller('operations/provisioning-operations')
@UseGuards(AuthGuard,AccountGuard)
@AccountTypes(UserRoleName.OPERATIONS,UserRoleName.SUPER_ADMIN)
export class OperationsProvisioningOperationsController {
  constructor(private readonly prisma:PrismaService){}
  @Get() async list(@Req() request:AuthenticatedRequest,@Query('state') state?:string){requireRole(request,[UserRole.OPERATIONS,UserRole.SUPER_ADMIN]);if(!this.prisma.enabled)return [];const allowed=['CREATED','SUBMITTING','ACCEPTED','WAITING_FOR_QR','QR_READY','ACTIVATED','RECONCILE_REQUIRED','REJECTED','MANUAL_REVIEW','CANCELLED'];const selected=state&&allowed.includes(state)?state as never:undefined;return this.prisma.provisioningOperation.findMany({where:selected?{state:selected}:{},select:{id:true,orderId:true,provider:true,state:true,idempotencyKey:true,iccid:true,providerProductId:true,providerOrderId:true,providerSubscriptionId:true,attemptCount:true,lastErrorCategory:true,lastErrorMessage:true,submittedAt:true,acceptedAt:true,nextReconcileAt:true,reconcileDeadlineAt:true,completedAt:true,createdAt:true,updatedAt:true},orderBy:{updatedAt:'desc'},take:200})}
}
