import {
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { UserRoleName } from "@prisma/client";
import type { Response } from "express";
import {
  AccountGuard,
  AccountTypes,
  AuthGuard,
  type AuthenticatedRequest,
} from "../../common/auth.guard.js";
import { CustomerEsimsService } from "./customer-esims.service.js";

@Controller("customer/esims")
@UseGuards(AuthGuard, AccountGuard)
@AccountTypes(UserRoleName.CUSTOMER)
export class CustomerEsimsController {
  constructor(private readonly esims: CustomerEsimsService) {}
  @Get() list(@Req() request: AuthenticatedRequest) {
    return this.esims.list(request.user!.id);
  }
  @Get(":id") get(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.esims.get(request.user!.id, id);
  }
  @Get(":id/activation-qr") async activationQr(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ) {
    const { filename, contentType, bytes } = await this.esims.activationQr(
      request.user!.id,
      id,
    );
    response.setHeader("content-type", contentType);
    response.setHeader(
      "content-disposition",
      `inline; filename="${filename.replace(/["\r\n]/g, "_")}"`,
    );
    response.setHeader("cache-control", "no-store, private");
    response.setHeader("x-content-type-options", "nosniff");
    response.send(bytes);
  }
  @Post(":id/usage/refresh") refresh(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.esims.refresh(request.user!.id, id);
  }
}
