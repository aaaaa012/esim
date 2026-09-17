import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { UserRoleName } from "@prisma/client";
import {
  AuthGuard,
  type AuthenticatedRequest,
} from "../../common/auth.guard.js";
import { BootstrapRateLimitGuard } from "../../common/bootstrap-rate-limit.guard.js";
import { AuthMeRateLimitGuard } from "../../common/auth-me-rate-limit.guard.js";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { ClerkSyncService } from "./clerk-sync.service.js";

@Controller("auth")
@UseGuards(AuthGuard)
export class AuthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: ClerkSyncService,
  ) {}
  @Get("me")
  @UseGuards(AuthMeRateLimitGuard)
  me(@Req() request: AuthenticatedRequest) {
    const user = request.user!;
    const customerBase = (
      process.env.CUSTOMER_WEB_URL ?? "http://localhost:3000"
    ).replace(/\/+$/, "");
    const opsBase = (
      process.env.OPS_WEB_URL ?? "http://localhost:3001"
    ).replace(/\/+$/, "");
    return {
      id: user.localUserId,
      clerkId: user.id,
      email: user.email,
      accountType: user.accountType,
      effectiveCapabilities: user.capabilities,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
      mfaRequired: false,
      mfaVerified: user.mfaVerified,
      landingPortal:
        user.accountType === UserRoleName.CUSTOMER
          ? `${customerBase}/account/esims`
          : `${opsBase}/`,
    };
  }

  /**
   * Marks the account's password as changed. Called by the ops change-password
   * page after the user has updated their password through Clerk. Enforced on
   * every operations route via the AccountGuard until cleared.
   */
  @Post("me/password-changed")
  async passwordChanged(@Req() request: AuthenticatedRequest) {
    const user = request.user!;
    await this.prisma.user.update({
      where: { id: user.localUserId },
      data: { mustChangePassword: false },
    });
    await this.prisma.auditLog.create({
      data: {
        module: "IDENTITY",
        entity: "User",
        entityId: user.localUserId,
        action: "PASSWORD_CHANGED",
        performedById: user.localUserId,
      },
    });
    return { ok: true };
  }

  /**
   * Token-verified bootstrap of the first Super Admin. See
   * ClerkSyncService.bootstrapSuperAdmin for the full security contract.
   */
  @Post("bootstrap")
  @UseGuards(BootstrapRateLimitGuard)
  async bootstrap(
    @Req() request: AuthenticatedRequest,
    @Body() body: { token?: string },
  ) {
    const token = body?.token;
    if (typeof token !== "string" || token.length > 256)
      throw new BadRequestException("A bootstrap token is required");
    return this.sync.bootstrapSuperAdmin(request.user!.id, token);
  }
}
