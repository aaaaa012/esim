import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@visa-compass/shared';
import { UserRoleName } from '@prisma/client';
import { AccountGuard, AccountTypes, AuthGuard, type AuthenticatedRequest, requireRole } from '../../common/auth.guard.js';
import { InventoryService } from './inventory.service.js';

@Controller('operations/inventory')
@UseGuards(AuthGuard, AccountGuard)
@AccountTypes(UserRoleName.OPERATIONS, UserRoleName.SUPER_ADMIN)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}
  @Get() overview(@Req() req: AuthenticatedRequest) { requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]); return this.inventory.overview(); }
  @Get('profiles')
  profiles(@Req() req: AuthenticatedRequest, @Query('status') status?: string, @Query('q') q?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.inventory.profiles({
      ...(status ? { status: status as never } : {}),
      ...(q ? { q } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
      ...(offset ? { offset: Number(offset) } : {}),
    });
  }
  @Post('import')
  import(@Body() body: { iccids: string[]; eids?: (string | null)[]; msisdns?: (string | null)[]; source?: string }, @Req() req: AuthenticatedRequest) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    if (!Array.isArray(body.iccids) || !body.iccids.length)
      throw new BadRequestException('iccids array is required');
    return this.inventory.importBatch(body.iccids, body.eids, body.source, body.msisdns, req.user!.id);
  }
  @Post('import-csv')
  importCsv(@Body() body: { csv?: string; content?: string; fileName?: string; source?: string }, @Req() req: AuthenticatedRequest) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    const content = typeof body.content === "string" && body.content.trim()
      ? body.content
      : typeof body.csv === "string" && body.csv.trim()
        ? body.csv
        : "";
    if (!content) throw new BadRequestException('csv/xlsx content is required');
    return this.inventory.importBatchTabular(content, body.fileName, body.source, req.user!.id);
  }
  @Post('batches/:id/approve')
  approve(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    requireRole(req, [UserRole.SUPER_ADMIN]);
    return this.inventory.approveBatch(id, req.user!.id);
  }
  @Post('batches/:id/reject')
  reject(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: AuthenticatedRequest) {
    requireRole(req, [UserRole.SUPER_ADMIN]);
    return this.inventory.rejectBatch(id, req.user!.id, body.reason);
  }
  @Post('profiles/:id/reconcile')
  reconcileProfile(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.inventory.reconcileProviderProfile(id);
  }
  @Post('profiles/:id/restore-availability')
  restoreProfileAvailability(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    requireRole(req, [UserRole.SUPER_ADMIN]);
    return this.inventory.restoreQuarantinedProfile(id, req.user!.id);
  }
}
