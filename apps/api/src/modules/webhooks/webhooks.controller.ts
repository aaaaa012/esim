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
import { ReconciliationService } from '../../jobs/reconciliation.service.js';
import { QUEUES } from '../../jobs/queues.js';
import { ClerkSyncService } from '../identity/clerk-sync.service.js';
import { paymentSimulatorSecret } from '../../common/payment-simulator-secret.js';

@Controller('webhooks')
export class WebhooksController {
  private readonly accepted = new Set<string>();
  constructor(private readonly prisma: PrismaService, private readonly queues: QueueService, private readonly clerkSync: ClerkSyncService) {}

  @Post('clerk')
  @HttpCode(202)
  async clerk(@Body() body: unknown, @Headers() headers: Record<string, string>, @Req() request: { rawBody?: Buffer }) {
    if (!process.env.CLERK_WEBHOOK_SECRET) {
      if (process.env.NODE_ENV === 'production') throw new BadRequestException('Clerk webhook is not configured');
      return { accepted: true, simulated: true };
    }
    const event = new Webhook(process.env.CLERK_WEBHOOK_SECRET).verify(this.rawPayload(body, request.rawBody), {
      'svix-id': headers['svix-id'] ?? '',
      'svix-timestamp': headers['svix-timestamp'] ?? '',
      'svix-signature': headers['svix-signature'] ?? '',
    }) as { type: string; data: { id?: string } };
    // Clerk delivers organization/session events to the same endpoint. They
    // are validly signed but not identity synchronization work.
    if (!event.type.startsWith('user.')) return { accepted: true, eventType: event.type, ignored: true };
    const result = await this.clerkSync.sync(event as never);
    return { accepted: true, eventType: event.type, userId: event.data.id, ...result };
  }

  @Post('payments/:provider')
  @HttpCode(202)
  async payment(@Param('provider') provider: string, @Body() body: { eventId?: string; orderId?: string; reference?: string; pidx?: string }, @Req() request: { rawBody?: Buffer }, @Headers('x-visa-signature') signature?: string) {
    const eventId = body.eventId;
    if (!eventId) throw new BadRequestException('eventId is required');
    if (typeof eventId !== 'string' || eventId.length < 8 || eventId.length > 256) throw new BadRequestException('eventId is invalid');
    this.verifyPaymentSignature(this.rawPayload(body, request.rawBody), signature);
    const key = `${provider}:${eventId}`;
    const existing = await this.webhookState(provider, eventId);
    if (existing?.deadLetteredAt) return { accepted: true, duplicate: true, deadLettered: true };
    if (existing?.processedAt) return { accepted: true, duplicate: true };
    const reference = body.reference ?? body.pidx;
    let orderId = body.orderId;
    if (!orderId && reference && this.prisma.enabled) {
      orderId = (await this.prisma.payment.findUnique({ where: { paymentReference: reference }, select: { orderId: true } }))?.orderId;
    }
    const payload = { ...body, ...(reference ? { reference } : {}), ...(orderId ? { orderId } : {}) };
    // Re-enqueue persisted-but-unprocessed duplicates. This closes the failure
    // window where the database insert succeeds but Redis is temporarily down,
    // so a Khalti retry can never be silently dropped.
    if (!existing) await this.persistWebhook(provider, eventId, payload, true);
    await this.queues.add(QUEUES.payments, 'payment-callback', { provider, eventId, payload }, key);
    this.remember(key);
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

  private rawPayload(body: unknown, rawBody?: Buffer): string {
    if (rawBody) return rawBody.toString('utf8');
    if (process.env.NODE_ENV === 'production') throw new BadRequestException('Webhook raw body is unavailable');
    return JSON.stringify(body);
  }

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
  constructor(private readonly prisma:PrismaService,private readonly queues:QueueService){}
  @Get() async list(@Req() request:AuthenticatedRequest){requireRole(request,[UserRole.OPERATIONS,UserRole.SUPER_ADMIN]);if(!this.prisma.enabled)return [];return this.prisma.webhookEvent.findMany({where:{NOT:{source:{startsWith:'idempotency:'}}},select:{id:true,source:true,eventId:true,signatureValid:true,processedAt:true,processingStartedAt:true,attemptCount:true,nextAttemptAt:true,deadLetteredAt:true,errorMessage:true,createdAt:true},orderBy:{createdAt:'desc'},take:200})}
  @Post(':id/replay') async replay(@Param('id') id:string,@Req() request:AuthenticatedRequest){
    requireRole(request,[UserRole.OPERATIONS,UserRole.SUPER_ADMIN]);
    if(!this.prisma.enabled)throw new BadRequestException('Webhook replay requires database persistence');
    const event=await this.prisma.webhookEvent.findUnique({where:{id},select:{id:true,source:true,eventId:true,payload:true}});
    if(!event)throw new BadRequestException('Webhook event not found');
    const source=event.source.toLowerCase();
    const queue=source==='transatel'?QUEUES.providerCallbacks:source==='khalti'?QUEUES.payments:null;
    if(!queue)throw new BadRequestException(`Webhook replay is not supported for ${event.source}`);
    await this.prisma.webhookEvent.update({where:{id},data:{processedAt:null,processingStartedAt:null,deadLetteredAt:null,errorMessage:null,nextAttemptAt:new Date()}});
    await this.queues.add(queue,source==='transatel'?'connectivity-callback':'payment-callback',{provider:source,eventId:event.eventId,payload:event.payload as Record<string,unknown>},`replay-${source}-${event.eventId}-${Date.now()}`);
    return {id,eventId:event.eventId,source,status:'QUEUED'};
  }
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
  constructor(private readonly prisma:PrismaService,private readonly reconciliation:ReconciliationService){}
  @Get() async list(@Req() request:AuthenticatedRequest,@Query('state') state?:string){requireRole(request,[UserRole.OPERATIONS,UserRole.SUPER_ADMIN]);if(!this.prisma.enabled)return [];const allowed=['CREATED','SUBMITTING','ACCEPTED','WAITING_FOR_QR','QR_READY','ACTIVATED','RECONCILE_REQUIRED','REJECTED','MANUAL_REVIEW','CANCELLED'];const selected=state&&allowed.includes(state)?state as never:undefined;return this.prisma.provisioningOperation.findMany({where:selected?{state:selected}:{},select:{id:true,orderId:true,provider:true,state:true,idempotencyKey:true,iccid:true,providerProductId:true,providerOrderId:true,providerSubscriptionId:true,attemptCount:true,lastErrorCategory:true,lastErrorMessage:true,submittedAt:true,acceptedAt:true,nextReconcileAt:true,reconcileDeadlineAt:true,completedAt:true,createdAt:true,updatedAt:true,order:{select:{orderNumber:true,status:true,orderType:true}}},orderBy:{updatedAt:'desc'},take:200})}
  @Post(':id/reconcile') async reconcile(@Param('id') id:string,@Req() request:AuthenticatedRequest){requireRole(request,[UserRole.OPERATIONS,UserRole.SUPER_ADMIN]);return this.reconciliation.reconcileProvisioningOperationNow(id)}
}

type LogGroup = 'all' | 'provider' | 'incoming' | 'orders' | 'staff';
type LogEntry = {
  group: LogGroup;
  id: string;
  identifier?: string;
  title: string;
  detail: string;
  status?: number;
  statusLabel?: string;
  createdAt: string;
  durationMs?: number | null;
  error?: string | null;
  requestBody?: unknown;
  responseBody?: unknown;
};

@Controller('operations/logs')
@UseGuards(AuthGuard,AccountGuard)
@AccountTypes(UserRoleName.OPERATIONS,UserRoleName.SUPER_ADMIN)
export class OperationsLogsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Req() request:AuthenticatedRequest, @Query('group') group?:string, @Query('q') q?:string, @Query('page') page?:string, @Query('pageSize') pageSize?:string):Promise<{total:number;page:number;pageSize:number;items:LogEntry[]}> {
    requireRole(request,[UserRole.OPERATIONS,UserRole.SUPER_ADMIN]);
    if(!this.prisma.enabled)return {total:0,page:1,pageSize:25,items:[]};
    const selected:LogGroup = group==='provider'||group==='incoming'||group==='orders'||group==='staff' ? group : 'all';
    const rawPage = Number.parseInt(page ?? '1',10);
    const pageNum = Number.isFinite(rawPage)&&rawPage>=1 ? rawPage : 1;
    const rawSize = Number.parseInt(pageSize ?? '25',10);
    const size = Number.isFinite(rawSize)&&rawSize>=1 ? Math.min(rawSize,50) : 25;
    const offset = (pageNum-1)*size;
    const fetchCount = offset+size;
    const [provider,incoming,orders,staff] = await Promise.all([
      selected==='provider'||selected==='all' ? this.providerLogs(fetchCount) : [],
      selected==='incoming'||selected==='all' ? this.incomingLogs(fetchCount) : [],
      selected==='orders'||selected==='all' ? this.orderLogs(fetchCount) : [],
      selected==='staff'||selected==='all' ? this.staffLogs(fetchCount) : [],
    ]);
    const groups = { provider, incoming, orders, staff };
    const counts = await Promise.all([
      selected==='provider'||selected==='all' ? this.prisma.integrationLog.count() : Promise.resolve(0),
      selected==='incoming'||selected==='all' ? this.prisma.webhookEvent.count() : Promise.resolve(0),
      selected==='orders'||selected==='all' ? Promise.all([this.prisma.provisioningAttempt.count(),this.prisma.provisioningOperation.count()]).then(([a,b])=>a+b) : Promise.resolve(0),
      selected==='staff'||selected==='all' ? this.prisma.auditLog.count() : Promise.resolve(0),
    ]);
    const exactTotal = counts[0]+counts[1]+counts[2]+counts[3];
    let items = [...groups.provider,...groups.incoming,...groups.orders,...groups.staff].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    let windowTotal:number|undefined;
    const needle = q?.trim().toLowerCase();
    if(needle){
      items = items.filter((it)=>[it.title,it.detail,it.statusLabel,it.identifier,String(it.status??''),it.error].filter(Boolean).some((s)=>String(s).toLowerCase().includes(needle)));
      windowTotal = items.length;
    }
    return { total: windowTotal ?? exactTotal, page: pageNum, pageSize: size, items: items.slice(offset,offset+size) };
  }

  private async providerLogs(take:number):Promise<LogEntry[]>{
    const rows = await this.prisma.integrationLog.findMany({orderBy:{createdAt:'desc'},take});
    return rows.map((row)=>({
      group:'provider' as const, id:row.id, identifier: this.integrationIdentifier(row.operation,row.endpoint), title: row.operation,
      detail: `${row.method} ${row.endpoint}`,
      status: row.status, statusLabel: row.status>=200&&row.status<400?'SUCCESS':'FAILED',
      createdAt: row.createdAt.toISOString(), durationMs: row.durationMs,
      error: row.errorMessage ?? row.errorCode ?? null,
      requestBody: row.requestBody ?? undefined, responseBody: row.responseBody ?? undefined,
    }));
  }
  private integrationIdentifier(operation:string,endpoint:string):string {
    const op = operation.toLowerCase();
    const ep = endpoint.toLowerCase();
    if(op.startsWith('khalti')||ep.includes('khalti')) return 'Khalti';
    if(op.startsWith('cloudinary')||ep.includes('cloudinary')) return 'Cloudinary';
    return 'Transatel';
  }

  private async incomingLogs(take:number):Promise<LogEntry[]>{
    const rows = await this.prisma.webhookEvent.findMany({orderBy:{createdAt:'desc'},take});
    const providerNames:Record<string,string>={transatel:'Transatel',khalti:'Khalti',clerk:'Clerk'};
    return rows.map((row)=>({
      group:'incoming' as const, id:row.id, identifier: providerNames[row.source.toLowerCase()] ?? row.source.toUpperCase(), title: this.humaneSource(row.source),
      detail: row.eventId,
      statusLabel: row.deadLetteredAt?'FAILED':row.processedAt?'PROCESSED':'QUEUED',
      createdAt: row.createdAt.toISOString(),
      error: row.errorMessage ?? null,
      responseBody: row.payload as unknown,
    }));
  }

  private async orderLogs(take:number):Promise<LogEntry[]>{
    const [attempts, operations] = await Promise.all([
      this.prisma.provisioningAttempt.findMany({orderBy:{createdAt:'desc'},take}),
      this.prisma.provisioningOperation.findMany({orderBy:{updatedAt:'desc'},take,select:{id:true,state:true,iccid:true,requestSnapshot:true,responseSnapshot:true,lastErrorMessage:true,lastErrorCategory:true,attemptCount:true,createdAt:true,order:{select:{orderNumber:true}}}}),
    ]);
    const attemptRows:LogEntry[] = attempts.map((row)=>({
      group:'orders' as const, id:`attempt-${row.id}`, title:'Activation attempt',
      detail:`attempt #${row.attempt} · ${row.provider} · order ${row.orderId}`,
      statusLabel: row.status, createdAt: row.createdAt.toISOString(),
      error: row.errorCode ?? null, requestBody: row.requestSnapshot as unknown, responseBody: row.responseSnapshot ?? undefined,
    }));
    const opRows:LogEntry[] = operations.map((row)=>({
      group:'orders' as const, id:`op-${row.id}`, title:'eSIM activation',
      detail: row.order?.orderNumber ? `order ${row.order.orderNumber}` : `order ${row.id}`,
      statusLabel: row.state, createdAt: row.createdAt.toISOString(),
      error: row.lastErrorCategory ? `${row.lastErrorCategory}: ${row.lastErrorMessage??''}`.slice(0,2000) : null,
      requestBody: row.requestSnapshot as unknown, responseBody: row.responseSnapshot ?? undefined,
    }));
    return [...attemptRows,...opRows].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }

  private async staffLogs(take:number):Promise<LogEntry[]>{
    const rows = await this.prisma.auditLog.findMany({orderBy:{createdAt:'desc'},take,include:{performedBy:{select:{email:true}}}});
    return rows.map((row)=>({
      group:'staff' as const, id:row.id, title: row.action,
      detail: `${row.module} · ${row.entity} · ${row.entityId}` + (row.performedBy?.email?` · by ${row.performedBy.email}`:''),
      createdAt: row.createdAt.toISOString(),
      requestBody: row.previousValue ?? undefined, responseBody: row.newValue ?? undefined,
    }));
  }

  private humaneSource(source:string):string {
    const map:Record<string,string>={transatel:'Network provider',khalti:'Payment gateway',clerk:'Accounts'};
    return map[source.toLowerCase()]??source;
  }
}
