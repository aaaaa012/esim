import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@visa-compass/shared';
import { UserRoleName } from '@prisma/client';
import { AccountGuard,AccountTypes,AuthGuard, type AuthenticatedRequest, requireRole } from '../../common/auth.guard.js';
import { InventoryService } from './inventory.service.js';

@Controller('operations/inventory')
@UseGuards(AuthGuard,AccountGuard)
@AccountTypes(UserRoleName.OPERATIONS,UserRoleName.SUPER_ADMIN)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}
  @Get() overview(@Req() req: AuthenticatedRequest) { requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]); return this.inventory.overview(); }
}
