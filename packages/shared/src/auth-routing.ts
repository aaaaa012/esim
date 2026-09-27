export type AuthRouteDecision = "ALLOW" | "SIGN_IN" | "UNAUTHORIZED" | "ACCOUNT_UNAVAILABLE" | "RATE_LIMITED" | "SERVICE_UNAVAILABLE";

export function authRouteDecision(input: { status: number; code?: string; accountType?: string; allowedAccountTypes: string[]; requiresSuperAdmin?: boolean }): AuthRouteDecision {
  if (input.status === 401) return "SIGN_IN";
  if (input.code === "ACCOUNT_DISABLED") return "ACCOUNT_UNAVAILABLE";
  if (input.status === 429) return "RATE_LIMITED";
  if (input.status < 200 || input.status >= 300) return input.status === 403 ? "UNAUTHORIZED" : "SERVICE_UNAVAILABLE";
  if (!input.accountType || !input.allowedAccountTypes.includes(input.accountType)) return "UNAUTHORIZED";
  if (input.requiresSuperAdmin && input.accountType !== "SUPER_ADMIN") return "UNAUTHORIZED";
  return "ALLOW";
}
