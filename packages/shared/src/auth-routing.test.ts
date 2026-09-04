import { describe, expect, it } from "vitest";
import { authRouteDecision } from "./auth-routing.js";

const decide = (input: Partial<Parameters<typeof authRouteDecision>[0]>) => authRouteDecision({ status: 200, accountType: "CUSTOMER", allowedAccountTypes: ["CUSTOMER"], ...input });

describe("authRouteDecision", () => {
  it("keeps authentication, authorization, disabled accounts and outages distinct", () => {
    expect(decide({ status: 401 })).toBe("SIGN_IN");
    expect(decide({ status: 403, code: "ACCOUNT_DISABLED" })).toBe("ACCOUNT_UNAVAILABLE");
    expect(decide({ status: 403 })).toBe("UNAUTHORIZED");
    expect(decide({ status: 503 })).toBe("SERVICE_UNAVAILABLE");
  });
  it("enforces account type and Super Admin routes", () => {
    expect(decide({ accountType: "OPERATIONS" })).toBe("UNAUTHORIZED");
    expect(decide({ accountType: "SUPER_ADMIN", allowedAccountTypes: ["OPERATIONS", "SUPER_ADMIN"], requiresSuperAdmin: true })).toBe("ALLOW");
  });
});
