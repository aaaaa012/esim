import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { DocumentType, PaymentProvider, documentRequestSchema, travelerSchema } from '@visa-compass/shared';
import { z } from 'zod';
import { CatalogService } from '../catalog/catalog.controller.js';
import { ConnectivityService } from '../integration/connectivity.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { NotificationService } from '../notification/notification.service.js';
import { PartnerAuthGuard, type PartnerRequest } from './partner-auth.guard.js';

const quoteSchema = z.object({ planId: z.string().uuid() });
const createSchema = z.object({ planId: z.string().uuid(), externalCustomerId: z.string().min(1).max(120), compatibilityAccepted: z.literal(true) });
const notificationSchema = z.object({ channel: z.enum(['EMAIL','WHATSAPP']), template: z.enum(['ORDER_STATUS','QR_READY','DOCUMENT_REUPLOAD']) });
const paymentSchema = z.object({ provider: z.enum(PaymentProvider) });

@Controller('partners')
@UseGuards(PartnerAuthGuard)
export class PartnersController {
  constructor(private readonly orders: OrdersService, private readonly payments: PaymentsService, private readonly connectivity: ConnectivityService, private readonly notifications:NotificationService,private readonly catalog:CatalogService) {}

  @Get('capabilities') async capabilities() { return { apiVersion: 'v1', payments: [PaymentProvider.KHALTI, PaymentProvider.ESEWA], notifications: ['EMAIL','WHATSAPP'], connectivity: { ...this.connectivity.descriptor(), health: await this.connectivity.health() }, idempotencyRequiredForMutations: true }; }

  @Get('plans') plans() { return this.catalog.plans(); }

  @Post('quotes') async quote(@Body() body: unknown) {
    const { planId } = quoteSchema.parse(body);
    const plan = await this.catalog.findActive(planId);
    if (!plan) throw new BadRequestException('Invalid plan');
    return { quoteId: `quote_${plan.id}`, planId: plan.id, amount: plan.sellingPriceNpr, currency: 'NPR', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
  }

  @Post('orders') async create(@Body() body: unknown, @Req() request: PartnerRequest) {
    const input = createSchema.parse(body);
    return this.orders.create(`partner:${request.partner!.id}:${input.externalCustomerId}`, input.planId, input.compatibilityAccepted);
  }

  @Get('orders/:id') status(@Param('id') id: string, @Req() request: PartnerRequest) {
    return this.partnerOrder(id, request);
  }

  @Post('orders/:id/traveler') traveler(@Param('id') id: string, @Body() body: unknown, @Req() request: PartnerRequest) { const order = this.partnerOrder(id, request); return this.orders.setTraveler(id, order.ownerId!, travelerSchema.parse(body)); }

  @Post('orders/:id/documents') document(@Param('id') id: string, @Body() body: unknown, @Req() request: PartnerRequest) { const order = this.partnerOrder(id, request); return this.orders.addDocument(id, order.ownerId!, documentRequestSchema.parse(body)); }

  @Post('orders/:id/documents/:documentId/confirm') confirmDocument(@Param('id') id: string, @Param('documentId') documentId: string, @Req() request: PartnerRequest) { const order = this.partnerOrder(id, request); return this.orders.confirmDocument(id, documentId, order.ownerId!); }

  @Post('orders/:id/payments') payment(@Param('id') id: string, @Body() body: unknown, @Req() request: PartnerRequest) { const order = this.partnerOrder(id, request); const { provider } = paymentSchema.parse(body); return this.payments.initiate(id, order.ownerId!, provider); }

  @Get('orders/:id/connectivity') async connectivityStatus(@Param('id') id: string, @Req() request: PartnerRequest) { const order = this.partnerOrder(id, request); return { orderId: id, orderStatus: order.status, ...this.connectivity.descriptor(), health: await this.connectivity.health(), detailsAvailable: order.status === 'COMPLETED' }; }

  @Get('orders/:id/usage') async usage(@Param('id') id: string, @Req() request: PartnerRequest) { const order = this.partnerOrder(id, request); if (order.status !== 'COMPLETED') throw new BadRequestException('Usage is available after provisioning'); return this.orders.usageFor(id); }

  @Post('orders/:id/notifications') async notify(@Param('id') id: string, @Body() body: unknown, @Req() request: PartnerRequest) { const order = this.partnerOrder(id, request); const input = notificationSchema.parse(body); if (!order.traveler) throw new BadRequestException('Traveler contact details are required'); return this.notifications.enqueue({orderId:id,channel:input.channel,template:input.template,recipient:input.channel === 'EMAIL' ? order.traveler.email : order.traveler.mobile,orderNumber:order.orderNumber}); }

  private partnerOrder(id: string, request: PartnerRequest) { const order = this.orders.get(id); if (!order.ownerId || !order.ownerId.startsWith(`partner:${request.partner!.id}:`)) throw new NotFoundException('Order not found'); return order; }
}
