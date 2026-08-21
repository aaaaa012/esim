import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { PaymentDisputeStatus, UserRoleName } from "@prisma/client";
import {
  AccountGuard,
  AccountTypes,
  AuthGuard,
  type AuthenticatedRequest,
} from "../../common/auth.guard.js";
import { PaymentDisputesService } from "./payment-disputes.service.js";

@Controller("operations/payment-disputes")
@UseGuards(AuthGuard, AccountGuard)
@AccountTypes(UserRoleName.OPERATIONS, UserRoleName.SUPER_ADMIN)
export class PaymentDisputesController {
  constructor(private readonly disputes: PaymentDisputesService) {}

  @Get()
  list(@Query("status") status?: PaymentDisputeStatus) {
    return this.disputes.list(status);
  }

  @Post(":id/status")
  @AccountTypes(UserRoleName.SUPER_ADMIN)
  update(
    @Param("id") id: string,
    @Body() body: { status: PaymentDisputeStatus; note: string },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.disputes.updateStatus(
      id,
      request.user!.localUserId,
      body.status,
      body.note,
    );
  }
}
