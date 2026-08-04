import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { verifyToken } from "@clerk/backend";
import { UserRole } from "@visa-compass/shared";
import { UserRoleName, UserStatus } from "@prisma/client";
import { Reflector } from "@nestjs/core";
import { PrismaService } from "../infrastructure/prisma.service.js";
import { ClerkSyncService } from "../modules/identity/clerk-sync.service.js";

export const ACCOUNT_TYPES = "account-types";
export const AccountTypes = (...types: UserRoleName[]) =>
  SetMetadata(ACCOUNT_TYPES, types);
export const capabilitiesFor = (type: UserRoleName) =>
  type === UserRoleName.CUSTOMER
    ? ["customer:portal", "customer:orders"]
    : type === UserRoleName.OPERATIONS
      ? ["operations:portal", "operations:review", "operations:inventory"]
      : [
          "operations:portal",
          "operations:review",
          "operations:inventory",
          "admin:portal",
          "admin:users",
          "admin:configuration",
        ];
export const isMfaVerified = (fva: unknown) =>
  Array.isArray(fva) && typeof fva[1] === "number" && fva[1] >= 0;
export const isSuperAdminMfaRequired = () =>
  process.env.ENFORCE_SUPER_ADMIN_MFA !== "false";

export type AuthenticatedUser = {
  id: string;
  localUserId: string;
  email: string;
  accountType: UserRoleName;
  roles: UserRole[];
  capabilities: string[];
  status: UserStatus;
  mfaVerified: boolean;
};
export type AuthenticatedRequest = {
  headers: Record<string, string | undefined>;
  user?: AuthenticatedUser;
  correlationId?: string;
};
const authError = (status: number, code: string, message: string) =>
  new HttpException({ code, message }, status);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clerkSync: ClerkSyncService,
  ) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ") || !process.env.CLERK_SECRET_KEY)
      throw authError(
        401,
        "AUTHENTICATION_REQUIRED",
        "Authentication required",
      );
    try {
      const allowed = [
        process.env.CUSTOMER_WEB_URL ?? "http://localhost:3000",
        process.env.OPS_WEB_URL ?? "http://localhost:3001",
      ];
      const payload = await verifyToken(authorization.slice(7), {
        secretKey: process.env.CLERK_SECRET_KEY,
        authorizedParties: allowed,
      });
      await this.clerkSync.ensureUser(payload.sub);
      const user = await this.prisma.user.findUnique({
        where: { clerkId: payload.sub },
        include: { customer: true },
      });
      if (!user)
        throw authError(
          401,
          "ACCOUNT_SYNCHRONIZATION_FAILED",
          "Account synchronization failed",
        );
      if (
        user.status === UserStatus.DISABLED ||
        user.customer?.status === "BLOCKED"
      )
        throw authError(
          403,
          "ACCOUNT_DISABLED",
          "Account is disabled or blocked",
        );
      const mfaVerified = isMfaVerified(
        (payload as unknown as { fva?: number[] }).fva,
      );
      const roles =
        user.accountType === UserRoleName.SUPER_ADMIN
          ? [UserRole.SUPER_ADMIN, UserRole.OPERATIONS]
          : [user.accountType as UserRole];
      request.user = {
        id: user.clerkId,
        localUserId: user.id,
        email: user.email,
        accountType: user.accountType,
        roles,
        capabilities: capabilitiesFor(user.accountType),
        status: user.status,
        mfaVerified,
      };
      return true;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw authError(
        401,
        "AUTHENTICATION_REQUIRED",
        "Authentication required",
      );
    }
  }
}

@Injectable()
export class AccountGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext) {
    const required = this.reflector.getAllAndOverride<UserRoleName[]>(
      ACCOUNT_TYPES,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) return true;
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user)
      throw authError(
        401,
        "AUTHENTICATION_REQUIRED",
        "Authentication required",
      );
    const allowed =
      required.includes(user.accountType) ||
      (user.accountType === UserRoleName.SUPER_ADMIN &&
        required.includes(UserRoleName.OPERATIONS));
    if (!allowed)
      throw authError(
        403,
        "ACCOUNT_TYPE_FORBIDDEN",
        "Account type is not permitted",
      );
    if (
      user.accountType === UserRoleName.SUPER_ADMIN &&
      isSuperAdminMfaRequired() &&
      !user.mfaVerified
    )
      throw authError(
        403,
        "MFA_REQUIRED",
        "Multi-factor authentication is required",
      );
    return true;
  }
}

export function requireRole(request: AuthenticatedRequest, roles: UserRole[]) {
  if (!request.user || !request.user.roles.some((role) => roles.includes(role)))
    throw authError(
      403,
      "ACCOUNT_TYPE_FORBIDDEN",
      "Account type is not permitted",
    );
  if (
    request.user.accountType === UserRoleName.SUPER_ADMIN &&
    isSuperAdminMfaRequired() &&
    !request.user.mfaVerified
  )
    throw authError(
      403,
      "MFA_REQUIRED",
      "Multi-factor authentication is required",
    );
}
