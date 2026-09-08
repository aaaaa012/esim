import { afterEach, describe, expect, it, vi } from "vitest";
import { UserRoleName } from "@prisma/client";
import {
  AccountGuard,
  capabilitiesFor,
  isMfaVerified,
  localE2eUser,
} from "./auth.guard.js";

const contextFor = (user: unknown) =>
  ({
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as never;

describe("database-authoritative authorization", () => {
  it("exposes inherited Operations and Admin capabilities to Super Admin only", () => {
    expect(capabilitiesFor(UserRoleName.OPERATIONS)).toContain("operations:review");
    expect(capabilitiesFor(UserRoleName.OPERATIONS)).not.toContain("admin:portal");
    expect(capabilitiesFor(UserRoleName.SUPER_ADMIN)).toContain("admin:portal");
  });

  it("interprets Clerk second-factor verification from the signed fva claim", () => {
    expect(isMfaVerified([4, 0])).toBe(true);
    expect(isMfaVerified([4, -1])).toBe(false);
    expect(isMfaVerified(undefined)).toBe(false);
  });

  it("allows Super Admin inherited Operations access without MFA", () => {
    const guard = new AccountGuard({
      getAllAndOverride: () => [UserRoleName.OPERATIONS],
    } as never);
    expect(
      guard.canActivate(
        contextFor({ accountType: UserRoleName.SUPER_ADMIN, mfaVerified: false }),
      ),
    ).toBe(true);
  });

  it("allows an Operations account through an Operations policy without MFA", () => {
    const guard = new AccountGuard({
      getAllAndOverride: () => [UserRoleName.OPERATIONS],
    } as never);
    expect(
      guard.canActivate(
        contextFor({ accountType: UserRoleName.OPERATIONS, mfaVerified: false }),
      ),
    ).toBe(true);
  });
});

describe("localE2eUser", () => {
  const secret = "local-e2e-secret-with-at-least-32-characters";

  afterEach(() => vi.unstubAllEnvs());

  it("authenticates each supported role only in explicit test mode", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("E2E_AUTH_ENABLED", "true");
    vi.stubEnv("E2E_AUTH_SECRET", secret);
    expect(localE2eUser(`${secret}:CUSTOMER`)?.accountType).toBe(
      UserRoleName.CUSTOMER,
    );
    expect(localE2eUser(`${secret}:OPERATIONS`)?.accountType).toBe(
      UserRoleName.OPERATIONS,
    );
    expect(localE2eUser(`${secret}:SUPER_ADMIN`)?.accountType).toBe(
      UserRoleName.SUPER_ADMIN,
    );
  });

  it("fails closed for wrong secrets, roles, modes, and environments", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("E2E_AUTH_ENABLED", "true");
    vi.stubEnv("E2E_AUTH_SECRET", secret);
    expect(localE2eUser(`wrong-secret-that-is-also-long-enough:CUSTOMER`)).toBeNull();
    expect(localE2eUser(`${secret}:UNKNOWN`)).toBeNull();
    vi.stubEnv("E2E_AUTH_ENABLED", "false");
    expect(localE2eUser(`${secret}:CUSTOMER`)).toBeNull();
    vi.stubEnv("E2E_AUTH_ENABLED", "true");
    vi.stubEnv("NODE_ENV", "production");
    expect(localE2eUser(`${secret}:CUSTOMER`)).toBeNull();
  });
});
