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
import { createClerkClient } from "@clerk/backend";
import { randomUUID } from "node:crypto";
import { ApiException } from "../../common/api-error.js";
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

  /** Changes the password at Clerk before clearing the local security gate. */
  @Post("me/password-changed")
  async passwordChanged(
    @Req() request: AuthenticatedRequest,
    @Body() body: { newPassword?: string },
  ) {
    const user = request.user!;
    const password = body?.newPassword;
    if (typeof password !== "string" || password.length < 12)
      throw new BadRequestException(
        "Choose a password of at least 12 characters",
      );
    if (!process.env.CLERK_SECRET_KEY)
      throw new ApiException({
        code: "IDENTITY_PROVIDER_UNAVAILABLE",
        message: "Password change is temporarily unavailable",
        status: 503,
      });
    const claimToken = randomUUID();
    const claimed = await this.prisma.user.updateMany({
      where: {
        id: user.localUserId,
        mustChangePassword: true,
        OR: [
          { passwordChangeClaimToken: null },
          { passwordChangeClaimExpiresAt: { lte: new Date() } },
        ],
      },
      data: {
        passwordChangeClaimToken: claimToken,
        passwordChangeClaimExpiresAt: new Date(Date.now() + 2 * 60_000),
      },
    });
    if (claimed.count !== 1)
      throw new ApiException({
        code: "PASSWORD_CHANGE_IN_PROGRESS",
        message: "A password change is already being processed",
        status: 409,
      });
    try {
      await createClerkClient({
        secretKey: process.env.CLERK_SECRET_KEY,
      }).users.updateUser(user.id, {
        password,
        signOutOfOtherSessions: true,
      });
      const completedAt = new Date();
      await this.prisma.$transaction(async (tx) => {
        const completed = await tx.user.updateMany({
          where: {
            id: user.localUserId,
            mustChangePassword: true,
            passwordChangeClaimToken: claimToken,
          },
          data: {
            mustChangePassword: false,
            passwordChangeCompletedAt: completedAt,
            passwordChangeClaimToken: null,
            passwordChangeClaimExpiresAt: null,
          },
        });
        if (completed.count !== 1)
          throw new Error("Password-change claim was lost");
        await tx.auditLog.create({
          data: {
            module: "IDENTITY",
            entity: "User",
            entityId: user.localUserId,
            action: "FORCED_PASSWORD_CHANGE_COMPLETED",
            performedById: user.localUserId,
            newValue: {
              provider: "clerk",
              completedAt: completedAt.toISOString(),
            },
          },
        });
      });
    } catch {
      await this.prisma.user.updateMany({
        where: {
          id: user.localUserId,
          passwordChangeClaimToken: claimToken,
        },
        data: {
          passwordChangeClaimToken: null,
          passwordChangeClaimExpiresAt: null,
        },
      });
      throw new ApiException({
        code: "PASSWORD_CHANGE_REJECTED",
        message:
          "The identity provider could not accept this password. Choose another strong password.",
        status: 400,
      });
    }
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
