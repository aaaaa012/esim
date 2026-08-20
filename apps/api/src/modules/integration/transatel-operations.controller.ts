import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@visa-compass/shared';
import { UserRoleName } from '@prisma/client';
import { AccountGuard, AccountTypes, AuthGuard, type AuthenticatedRequest, requireRole } from '../../common/auth.guard.js';
import { TransatelOperationsService } from './transatel-operations.service.js';

type LifecycleBody = { reason?: string; idempotencyKey?: string };

@Controller('operations/transatel')
@UseGuards(AuthGuard, AccountGuard)
@AccountTypes(UserRoleName.OPERATIONS, UserRoleName.SUPER_ADMIN)
export class TransatelOperationsController {
  constructor(private readonly transatel: TransatelOperationsService) {}

  @Get()
  dashboard(@Req() request: AuthenticatedRequest, @Query('scope') scope?: 'subscribers' | 'inventory' | 'failures' | 'actions', @Query('q') q?: string) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.transatel.dashboard({ ...(scope ? { scope } : {}), ...(q ? { q } : {}) });
  }

  @Get('diagnostics')
  diagnostics(@Req() request: AuthenticatedRequest) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.transatel.diagnostics();
  }

  @Post('orders/:id/reconcile')
  reconcile(@Param('id') orderId: string, @Req() request: AuthenticatedRequest) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.transatel.reconcile(orderId, request.user!.localUserId);
  }

  @Post('orders/:id/suspend')
  suspend(@Param('id') orderId: string, @Body() body: LifecycleBody, @Req() request: AuthenticatedRequest) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.transatel.suspend({ orderId, reason: body.reason ?? '', idempotencyKey: body.idempotencyKey ?? '', actorId: request.user!.localUserId });
  }

  @Post('orders/:id/terminate')
  terminate(@Param('id') orderId: string, @Body() body: LifecycleBody, @Req() request: AuthenticatedRequest) {
    requireRole(request, [UserRole.SUPER_ADMIN]);
    return this.transatel.terminate({ orderId, reason: body.reason ?? '', idempotencyKey: body.idempotencyKey ?? '', actorId: request.user!.localUserId });
  }
}
