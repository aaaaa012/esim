import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  DocumentReviewPolicy,
  PlanStatus,
  UserRoleName,
  UserStatus,
} from "@prisma/client";
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
  @Get("document-review-policy")
  documentReviewPolicy() {
    return this.admin.documentReviewPolicy();
  }
  @Patch("document-review-policy")
  updateDocumentReviewPolicy(
    @Body() body: { policy: DocumentReviewPolicy; ocrCheckoutWaitMs?: number },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.admin.updateDocumentReviewPolicy(body, req.user!.id);
  }
  @Get("plans")
  @AccountTypes(UserRoleName.OPERATIONS, UserRoleName.SUPER_ADMIN)
  plans() {
    return this.admin.plans();
  }
  @Get("plans/page")
  @AccountTypes(UserRoleName.OPERATIONS, UserRoleName.SUPER_ADMIN)
  planPage(
    @Query("q") q?: string,
    @Query("status") status?: PlanStatus,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.admin.planPage({
      ...(q ? { q } : {}),
      ...(status ? { status } : {}),
      limit: Number(limit),
      offset: Number(offset),
    });
  }
  @Post("plans/import-csv")
  @AccountTypes(UserRoleName.OPERATIONS, UserRoleName.SUPER_ADMIN)
  importPlansCsv(
    @Body()
    body: {
      csv?: string;
      content?: string;
      fileName?: string;
      mode?: "UPDATE_LISTED";
    },
    @Req() req: AuthenticatedRequest,
  ) {
    const content =
      typeof body.content === "string" && body.content.trim()
        ? body.content
        : typeof body.csv === "string" && body.csv.trim()
          ? body.csv
          : "";
    if (!content) throw new BadRequestException("csv/xlsx content is required");
    return this.admin.importPlansFromTabular(
      content,
      body.fileName,
      req.user!.id,
      body.mode,
    );
  }
  @Post("plans/:id/approve")
  approvePlan(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    return this.admin.approvePlan(id, req.user!.id);
  }
  @Post("plans/:id/reject")
  rejectPlan(
    @Param("id") id: string,
    @Body() body: { reason?: string },
    @Req() req: AuthenticatedRequest,
  ) {
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
  @Post("integrations/transatel/sync-usage")
  syncUsage() {
    return this.admin.syncTransatelUsage();
  }
  @Post("integrations/transatel/catalog-export")
  @AccountTypes(UserRoleName.OPERATIONS, UserRoleName.SUPER_ADMIN)
  exportCatalog(@Body() body: { cos?: string }) {
    return this.admin.exportTransatelCatalog(body?.cos);
  }
  @Post("integrations/transatel/ensure-webhook")
  ensureWebhook() {
    return this.admin.ensureTransatelWebhook();
  }
  @Post("integrations/transatel/eligibility")
  eligibility(@Body() body: { planId: string; msisdn: string }) {
    return this.admin.transatelEligibility(body.planId, body.msisdn);
  }
  @Get("users") users(
    @Query("q") q?: string,
    @Query("accountType") accountType?: UserRoleName,
    @Query("status") status?: UserStatus,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.admin.users({
      ...(q ? { q } : {}),
      ...(accountType ? { accountType } : {}),
      ...(status ? { status } : {}),
      limit: Number(limit) || 50,
      offset: Number(offset) || 0,
    });
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
