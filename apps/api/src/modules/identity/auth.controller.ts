import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { UserRoleName } from "@prisma/client";
import {
  AuthGuard,
  isSuperAdminMfaRequired,
  type AuthenticatedRequest,
} from "../../common/auth.guard.js";

@Controller("auth")
@UseGuards(AuthGuard)
export class AuthController {
  @Get("me") me(@Req() request: AuthenticatedRequest) {
    const user = request.user!;
    const customerBase = (process.env.CUSTOMER_WEB_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
    const opsBase = (process.env.OPS_WEB_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
    return {
      id: user.localUserId,
      clerkId: user.id,
      email: user.email,
      accountType: user.accountType,
      effectiveCapabilities: user.capabilities,
      status: user.status,
      mfaRequired:
        user.accountType === UserRoleName.SUPER_ADMIN &&
        isSuperAdminMfaRequired(),
      mfaVerified: user.mfaVerified,
      landingPortal:
        user.accountType === UserRoleName.CUSTOMER
          ? `${customerBase}/account/esims`
          : `${opsBase}/`,
    };
  }
}
