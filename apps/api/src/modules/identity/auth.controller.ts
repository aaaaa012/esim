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
          ? "http://localhost:3000/account/esims"
          : "http://localhost:3001/",
    };
  }
}
