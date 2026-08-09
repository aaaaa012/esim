import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { UserRoleName } from '@prisma/client';
import { AccountGuard, AccountTypes, AuthGuard, type AuthenticatedRequest } from '../../common/auth.guard.js';
import { CustomerEsimsService } from './customer-esims.service.js';

@Controller('customer/esims')
@UseGuards(AuthGuard, AccountGuard)
@AccountTypes(UserRoleName.CUSTOMER)
export class CustomerEsimsController {
  constructor(private readonly esims: CustomerEsimsService) {}
  @Get() list(@Req() request: AuthenticatedRequest) { return this.esims.list(request.user!.id); }
  @Get(':id') get(@Param('id') id: string, @Req() request: AuthenticatedRequest) { return this.esims.get(request.user!.id, id); }
  @Post(':id/usage/refresh') refresh(@Param('id') id: string, @Req() request: AuthenticatedRequest) { return this.esims.refresh(request.user!.id, id); }
}
