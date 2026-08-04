import { afterEach, describe, expect, it, vi } from "vitest";
import { UserRoleName } from "@prisma/client";
import { AccountGuard, capabilitiesFor, isMfaVerified } from "./auth.guard.js";

const contextFor = (user: unknown) =>
  ({
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as never;

describe("database-authoritative authorization", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("exposes inherited Operations and Admin capabilities to Super Admin only", () => {
    expect(capabilitiesFor(UserRoleName.OPERATIONS)).toContain(
      "operations:review",
    );
    expect(capabilitiesFor(UserRoleName.OPERATIONS)).not.toContain(
      "admin:portal",
    );
    expect(capabilitiesFor(UserRoleName.SUPER_ADMIN)).toContain("admin:portal");
  });

  it("interprets Clerk second-factor verification from the signed fva claim", () => {
    expect(isMfaVerified([4, 0])).toBe(true);
    expect(isMfaVerified([4, -1])).toBe(false);
    expect(isMfaVerified(undefined)).toBe(false);
  });

  it("requires MFA even when Super Admin uses inherited Operations access", () => {
    vi.stubEnv("ENFORCE_SUPER_ADMIN_MFA", "true");
    const reflector = { getAllAndOverride: () => [UserRoleName.OPERATIONS] };
    const guard = new AccountGuard(reflector as never);
    const user = { accountType: UserRoleName.SUPER_ADMIN, mfaVerified: false };
    expect(() => guard.canActivate(contextFor(user))).toThrowError(
      /Multi-factor authentication/,
    );
  });

  it("allows local Super Admin access when MFA enforcement is explicitly disabled", () => {
    vi.stubEnv("ENFORCE_SUPER_ADMIN_MFA", "false");
    const reflector = { getAllAndOverride: () => [UserRoleName.OPERATIONS] };
    const guard = new AccountGuard(reflector as never);
    expect(
      guard.canActivate(
        contextFor({
          accountType: UserRoleName.SUPER_ADMIN,
          mfaVerified: false,
        }),
      ),
    ).toBe(true);
  });

  it("allows an Operations account through an Operations policy without MFA", () => {
    const reflector = { getAllAndOverride: () => [UserRoleName.OPERATIONS] };
    const guard = new AccountGuard(reflector as never);
    expect(
      guard.canActivate(
        contextFor({
          accountType: UserRoleName.OPERATIONS,
          mfaVerified: false,
        }),
      ),
    ).toBe(true);
  });
});
