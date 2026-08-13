import { Body, Controller, Get, Param, Post, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { UserRole } from '@visa-compass/shared';
import { UserRoleName } from '@prisma/client';
import { AuthGuard, type AuthenticatedRequest, requireRole } from '../../common/auth.guard.js';
import { OrdersService } from '../orders/orders.service.js';
import { NotificationService } from './notification.service.js';

@Controller()
@UseGuards(AuthGuard)
export class NotificationController {
  constructor(private readonly notifications:NotificationService,private readonly orders:OrdersService){}
  @Get('customer/orders/:id/notifications') customer(@Param('id') id:string,@Req() request:AuthenticatedRequest){if(request.user!.accountType!==UserRoleName.CUSTOMER)requireRole(request,[UserRole.CUSTOMER]);this.orders.get(id,request.user!.id);return this.notifications.list([id])}
  @Get('customer/notifications') customerAll(@Req() request:AuthenticatedRequest){if(request.user!.accountType!==UserRoleName.CUSTOMER)requireRole(request,[UserRole.CUSTOMER]);return this.notifications.list(this.orders.list(request.user!.id).map(order=>order.id))}
  @Get('operations/notifications') operations(@Req() request:AuthenticatedRequest){requireRole(request,[UserRole.OPERATIONS,UserRole.SUPER_ADMIN]);return this.notifications.list()}
  @Get('operations/notifications/health') health(@Req() request:AuthenticatedRequest){requireRole(request,[UserRole.OPERATIONS,UserRole.SUPER_ADMIN]);return this.notifications.health()}
  @Post('operations/notifications/test') test(@Body() body:{orderId?:string;channel?:'EMAIL'|'WHATSAPP'},@Req() request:AuthenticatedRequest){requireRole(request,[UserRole.SUPER_ADMIN]);if(!body.orderId)throw new BadRequestException('orderId is required');const order=this.orders.get(body.orderId);if(!order.traveler)throw new BadRequestException('Traveler contact details are unavailable');const channel=body.channel??'EMAIL';return this.notifications.enqueue({orderId:order.id,channel,template:'ORDER_STATUS',recipient:channel==='EMAIL'?order.traveler.email:order.traveler.mobile,orderNumber:order.orderNumber})}
  @Post('operations/notifications/:id/retry') async retry(@Param('id') id:string,@Req() request:AuthenticatedRequest){requireRole(request,[UserRole.OPERATIONS,UserRole.SUPER_ADMIN]);const notification=await this.notifications.get(id);if(!notification.orderId)throw new BadRequestException('Notification has no order');const order=this.orders.get(notification.orderId);const snapshot=order.pricingSnapshot as {topUpEmail?:string};const recipient=notification.channel==='EMAIL'?(order.traveler?.email??snapshot.topUpEmail):(order.traveler?.mobile??order.topUpMobile);if(!recipient)throw new BadRequestException('Customer contact details are unavailable');return this.notifications.retry(id,recipient,order.orderNumber)}
}
