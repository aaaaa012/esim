import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
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
  @Post('import')
  import(@Body() body: { iccids: string[]; eids?: (string | null)[]; source?: string }) {
    if (!Array.isArray(body.iccids) || !body.iccids.length)
      throw new BadRequestException('iccids array is required');
    return this.inventory.importBatch(body.iccids, body.eids, body.source);
  }
  @Post('import-csv')
  importCsv(@Body() body: { csv: string; source?: string }) {
    if (typeof body.csv !== 'string' || !body.csv.trim())
      throw new BadRequestException('csv content is required');
    return this.inventory.importBatchCsv(body.csv, body.source);
  }
}
