import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { PlanStatus, UserRoleName, UserStatus } from "@prisma/client";
import {
  AccountGuard,
  AccountTypes,
  AuthGuard,
  type AuthenticatedRequest,
} from "../../common/auth.guard.js";
import { AdminService } from "./admin.service.js";

@Controller("admin")
@UseGuards(AuthGuard, AccountGuard)
@AccountTypes(UserRoleName.SUPER_ADMIN)
export class AdminController {
  constructor(private readonly admin: AdminService) {}
  @Get("plans") plans() {
    return this.admin.plans();
  }
  @Post("plans/import-csv")
  importPlansCsv(@Body() body: { csv?: string; content?: string; fileName?: string }, @Req() req: AuthenticatedRequest) {
    const content = typeof body.content === "string" && body.content.trim()
      ? body.content
      : typeof body.csv === "string" && body.csv.trim()
        ? body.csv
        : "";
    if (!content) throw new BadRequestException("csv/xlsx content is required");
    return this.admin.importPlansFromTabular(content, body.fileName, req.user!.id);
  }
  @Post("plans/:id/approve")
  approvePlan(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    return this.admin.approvePlan(id, req.user!.id);
  }
  @Post("plans/:id/reject")
  rejectPlan(@Param("id") id: string, @Body() body: { reason?: string }, @Req() req: AuthenticatedRequest) {
    return this.admin.rejectPlan(id, req.user!.id, body.reason);
  }
  @Patch("plans/:id") updatePlan(
    @Param("id") id: string,
    @Body()
    body: { sellingPriceNpr?: number; popular?: boolean; status?: PlanStatus },
  ) {
    return this.admin.updatePlan(id, body);
  }
  @Get("integrations") integrations() {
    return this.admin.integrations();
  }
  @Post("integrations/:id/test") test(@Param("id") id: string) {
    return this.admin.testIntegration(id);
  }
  @Post("integrations/transatel/sync-catalog")
  syncCatalog() {
    return this.admin.syncTransatelCatalog();
  }
  @Post("integrations/transatel/ensure-webhook")
  ensureWebhook() {
    return this.admin.ensureTransatelWebhook();
  }
  @Post("integrations/transatel/eligibility")
  eligibility(@Body() body: { planId: string; msisdn: string }) {
    return this.admin.transatelEligibility(body.planId, body.msisdn);
  }
  @Get("users") users() {
    return this.admin.users();
  }
  @Patch("users/:id/account-type") accountType(
    @Param("id") id: string,
    @Body() body: { accountType: UserRoleName },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.admin.changeAccountType(id, body.accountType, req.user!.id);
  }
  @Patch("users/:id/status") status(
    @Param("id") id: string,
    @Body() body: { status: UserStatus },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.admin.changeStatus(id, body.status, req.user!.id);
  }
  @Get("staff-invitations") invitations() {
    return this.admin.invitations();
  }
  @Post("staff-invitations") invite(
    @Body() body: { email: string; accountType: UserRoleName },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.admin.invite(body.email, body.accountType, req.user!.id);
  }
  @Post("staff-invitations/:id/resend") resend(
    @Param("id") id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.admin.resendInvitation(id, req.user!.id);
  }
  @Delete("staff-invitations/:id") revoke(
    @Param("id") id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.admin.revokeInvitation(id, req.user!.id);
  }
}
