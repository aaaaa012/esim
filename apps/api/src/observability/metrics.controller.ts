import { Controller, Get, Header, UseGuards } from "@nestjs/common";
import { UserRoleName } from "@prisma/client";
import { AccountGuard, AccountTypes, AuthGuard } from "../common/auth.guard.js";
import { MetricsService } from "./metrics.service.js";

@Controller("metrics")
@UseGuards(AuthGuard, AccountGuard)
@AccountTypes(UserRoleName.OPERATIONS, UserRoleName.SUPER_ADMIN)
export class MetricsController {
  constructor(private readonly service: MetricsService) {}
  @Get()
  @Header("content-type", "text/plain; version=0.0.4; charset=utf-8")
  scrape() {
    return this.service.render();
  }
}
