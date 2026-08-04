import { Body, Controller, Get, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { UserRole, createOrderSchema, documentRequestSchema, travelerSchema } from '@visa-compass/shared';
import { UserRoleName } from '@prisma/client';
import { AccountGuard, AccountTypes, AuthGuard, type AuthenticatedRequest, requireRole } from '../../common/auth.guard.js';
import { OrdersService } from './orders.service.js';

@Controller('customer/orders')
@UseGuards(AuthGuard,AccountGuard)
@AccountTypes(UserRoleName.CUSTOMER)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}
  @Get() list(@Req() req: AuthenticatedRequest) { return this.orders.list(req.user!.id); }
  @Get(':id') get(@Param('id') id: string, @Req() req: AuthenticatedRequest) { return this.orders.view(id, req.user!.id); }
  @Get(':id/qr') qr(@Param('id') id: string, @Req() req: AuthenticatedRequest) { return this.orders.qr(id, req.user!.id); }
  @Post() create(@Body() body: unknown, @Req() req: AuthenticatedRequest) { const input = createOrderSchema.parse(body); const ipAddress = (req as { ip?: string }).ip; const userAgent = req.headers['user-agent']; return this.orders.create(req.user!.id, input.planId, input.compatibilityAccepted, { ...(ipAddress ? { ipAddress } : {}), ...(userAgent ? { userAgent } : {}) }); }
  @Patch(':id/traveler') traveler(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) { return this.orders.setTraveler(id, req.user!.id, travelerSchema.parse(body)); }
  @Post(':id/documents') document(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) { const input = documentRequestSchema.parse(body); return this.orders.addDocument(id, req.user!.id, input); }
  @Post(':id/documents/:documentId/confirm') confirmDocument(@Param('id') id: string, @Param('documentId') documentId: string, @Req() req: AuthenticatedRequest) { return this.orders.confirmDocument(id, documentId, req.user!.id); }
}

@Controller('operations')
@UseGuards(AuthGuard,AccountGuard)
@AccountTypes(UserRoleName.OPERATIONS,UserRoleName.SUPER_ADMIN)
export class OperationsController {
  constructor(private readonly orders: OrdersService) {}
  @Get('dashboard') dashboard(@Req() req: AuthenticatedRequest) { requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]); const all = this.orders.list(); const today = new Date().toISOString().slice(0, 10); const transatelConfigured = ['TRANSATEL_BASE_URL','TRANSATEL_CLIENT_ID','TRANSATEL_CLIENT_SECRET','TRANSATEL_MVNO_REF'].every((key) => Boolean(process.env[key])); return { counts: { reviewPending: all.filter((o) => o.status === 'REVIEW_PENDING').length, awaitingCustomer: all.filter((o) => o.status === 'AWAITING_CUSTOMER').length, provisioningFailed: all.filter((o) => o.status === 'PROVISIONING_FAILED').length, completedToday: all.filter((o) => o.status === 'COMPLETED' && o.timeline.some((event) => event.to === 'COMPLETED' && event.at.startsWith(today))).length }, integrations: [{ name: 'Transatel', status: transatelConfigured ? 'UP' : 'CONFIG_REQUIRED' }, { name: 'Khalti', status: process.env.KHALTI_SECRET_KEY ? 'UP' : 'CONFIG_REQUIRED' }, { name: 'eSewa', status: process.env.ESEWA_SECRET_KEY ? 'UP' : 'CONFIG_REQUIRED' }], recentOrders: all.slice().sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0, 8) }; }
  @Get('customers') customers(@Req() req: AuthenticatedRequest) { requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]); const grouped = new Map<string, ReturnType<OrdersService['list']>>(); for (const order of this.orders.list()) grouped.set(order.ownerId, [...(grouped.get(order.ownerId) ?? []), order]); return [...grouped.entries()].map(([ownerId, orders]) => ({ ownerId, name: orders.find((o) => o.traveler)?.traveler ? `${orders.find((o) => o.traveler)!.traveler!.firstName} ${orders.find((o) => o.traveler)!.traveler!.surname}` : 'Customer profile pending', email: orders.find((o) => o.traveler)?.traveler?.email ?? '—', orders: orders.length, completedEsims: orders.filter((o) => o.status === 'COMPLETED').length, lastOrderAt: orders.map((o) => o.createdAt).sort().at(-1) })); }
  @Get('audit') audit(@Req() req: AuthenticatedRequest) { requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]); return this.orders.audit(); }
  @Get('orders') list(@Req() req: AuthenticatedRequest) { requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]); return this.orders.list(); }
  @Get('orders/:id') get(@Param('id') id: string, @Req() req: AuthenticatedRequest) { requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]); return this.orders.view(id); }
  @Get('orders/:id/documents/:documentId/preview') preview(@Param('id') id: string, @Param('documentId') documentId: string, @Req() req: AuthenticatedRequest) { requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]); return this.orders.documentPreview(id, documentId); }
  @Get('orders/:id/documents/:documentId/content') async content(@Param('id') id: string, @Param('documentId') documentId: string, @Req() req: AuthenticatedRequest, @Res() response: Response) { requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]); const content = await this.orders.documentContent(id, documentId); response.setHeader('content-type', content.contentType); response.setHeader('content-disposition', `inline; filename="${content.fileName.replace(/["\r\n]/g, '_')}"`); response.setHeader('cache-control', 'no-store, private'); response.send(content.bytes); }
  @Post('orders/:id/approve') approve(@Param('id') id: string, @Req() req: AuthenticatedRequest) { requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]); return this.orders.approve(id, req.user!.id); }
  @Post('orders/:id/request-reupload') reupload(@Param('id') id: string, @Body() body: { reason: string }, @Req() req: AuthenticatedRequest) { requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]); return this.orders.requestReupload(id, body.reason); }
  @Post('orders/:id/documents/:documentId/approve') approveDocument(@Param('id') id: string, @Param('documentId') documentId: string, @Req() req: AuthenticatedRequest) { requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]); return this.orders.reviewDocument(id, documentId, req.user!.id, 'APPROVE'); }
  @Post('orders/:id/documents/:documentId/request-reupload') reuploadDocument(@Param('id') id: string, @Param('documentId') documentId: string, @Body() body: { reason?: string }, @Req() req: AuthenticatedRequest) { requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]); return this.orders.reviewDocument(id, documentId, req.user!.id, 'REUPLOAD', body.reason); }
  @Post('orders/:id/retry') retry(@Param('id') id: string, @Req() req: AuthenticatedRequest) { requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]); return this.orders.retry(id); }
}
