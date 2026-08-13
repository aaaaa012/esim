import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ManualRefundReason, ManualRefundStatus, UserRoleName } from '@prisma/client';
import { AccountGuard, AccountTypes, AuthGuard, type AuthenticatedRequest } from '../../common/auth.guard.js';
import { ManualRefundsService } from './manual-refunds.service.js';

@Controller('operations/manual-refunds')
@UseGuards(AuthGuard, AccountGuard)
@AccountTypes(UserRoleName.OPERATIONS, UserRoleName.SUPER_ADMIN)
export class ManualRefundsController {
  constructor(private readonly refunds: ManualRefundsService) {}

  @Get()
  list(@Query('status') status?: ManualRefundStatus, @Query('orderId') orderId?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.refunds.list({ ...(status ? { status } : {}), ...(orderId ? { orderId } : {}), limit: Number(limit) || 50, offset: Number(offset) || 0 });
  }

  @Post('orders/:orderId')
  request(@Param('orderId') orderId: string, @Body() body: { reason: ManualRefundReason; explanation: string }, @Req() req: AuthenticatedRequest) {
    return this.refunds.request(orderId, req.user!.localUserId, body);
  }

  @Post(':id/approve') @AccountTypes(UserRoleName.SUPER_ADMIN)
  approve(@Param('id') id: string, @Body() body: { note?: string }, @Req() req: AuthenticatedRequest) { return this.refunds.approve(id, req.user!.localUserId, body.note); }

  @Post(':id/reject') @AccountTypes(UserRoleName.SUPER_ADMIN)
  reject(@Param('id') id: string, @Body() body: { note: string }, @Req() req: AuthenticatedRequest) { return this.refunds.reject(id, req.user!.localUserId, body.note); }

  @Post(':id/complete') @AccountTypes(UserRoleName.SUPER_ADMIN)
  complete(@Param('id') id: string, @Body() body: { providerReference: string; amount: number; completedAt: string; note?: string }, @Req() req: AuthenticatedRequest) { return this.refunds.complete(id, req.user!.localUserId, body); }
}
