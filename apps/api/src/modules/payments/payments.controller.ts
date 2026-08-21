import { Body, Controller, Param, Post, Req, UseGuards } from "@nestjs/common";
import { initiatePaymentSchema } from "@visa-compass/shared";
import { UserRoleName } from "@prisma/client";
import {
  AccountGuard,
  AccountTypes,
  AuthGuard,
  type AuthenticatedRequest,
} from "../../common/auth.guard.js";
import { PaymentsService } from "./payments.service.js";

@Controller("customer/orders/:orderId/payment")
@UseGuards(AuthGuard, AccountGuard)
@AccountTypes(UserRoleName.CUSTOMER)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}
  @Post() initiate(
    @Param("orderId") orderId: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    const input = initiatePaymentSchema.parse(body);
    return this.payments.initiate(orderId, req.user!.id, input.provider);
  }
  @Post("simulate-complete") simulate(
    @Param("orderId") orderId: string,
    @Body()
    body: {
      reference: string;
      scenario?:
        | "SUCCESS"
        | "CANCELLED"
        | "PENDING"
        | "WRONG_AMOUNT"
        | "REFUNDED"
        | "TIMEOUT";
    },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.payments.simulate(
      orderId,
      req.user!.id,
      body.reference,
      body.scenario,
    );
  }
  @Post("verify") verify(
    @Param("orderId") orderId: string,
    @Body() body: { reference: string },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.payments.verify(orderId, req.user!.id, body.reference);
  }
}
