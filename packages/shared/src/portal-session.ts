import { authRouteDecision, type AuthRouteDecision } from "./auth-routing.js";

const RETRYABLE_STATUSES = new Set([502, 503, 504]);

export type PortalSessionResult = {
  decision: AuthRouteDecision;
  accountType?: string;
  mfaRequired?: boolean;
  mfaVerified?: boolean;
  mustChangePassword?: boolean;
  retryAfterSeconds?: number;
  status?: number;
  failure?: "network" | "timeout" | "malformed" | "http";
  latencyMs: number;
};

export function safeInternalReturnTo(value: string | null | undefined, fallback = "/") {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;
  try {
    const parsed = new URL(value, "https://portal.invalid");
    if (parsed.origin !== "https://portal.invalid") return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function boundedRetryAfter(value: string | null | undefined) {
  const seconds = Number.parseInt(value ?? "", 10);
  return Number.isFinite(seconds) ? Math.min(60, Math.max(1, seconds)) : 10;
}

export async function verifyPortalSession(input: {
  apiUrl: string;
  token: string;
  allowedAccountTypes: string[];
  requiresSuperAdmin?: boolean;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<PortalSessionResult> {
  const started = Date.now();
  const fetcher = input.fetcher ?? fetch;
  const sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = input.timeoutMs ?? 5_000;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`${input.apiUrl}/auth/me`, {
        headers: { authorization: `Bearer ${input.token}` },
        cache: "no-store",
        signal: controller.signal,
      });
      const envelope = await response.json().catch(() => null) as {
        data?: { accountType?: string; mfaRequired?: boolean; mfaVerified?: boolean; mustChangePassword?: boolean };
        error?: { code?: string };
      } | null;
      if (response.ok && !envelope?.data?.accountType) {
        return { decision: "SERVICE_UNAVAILABLE", status: response.status, failure: "malformed", latencyMs: Date.now() - started };
      }
      if (RETRYABLE_STATUSES.has(response.status) && attempt === 0) {
        await sleep(50 + Math.floor(Math.random() * 100));
        continue;
      }
      const decision = authRouteDecision({
        status: response.status,
        ...(envelope?.error?.code ? { code: envelope.error.code } : {}),
        ...(envelope?.data?.accountType ? { accountType: envelope.data.accountType } : {}),
        allowedAccountTypes: input.allowedAccountTypes,
        ...(input.requiresSuperAdmin !== undefined ? { requiresSuperAdmin: input.requiresSuperAdmin } : {}),
      });
      return {
        decision,
        status: response.status,
        ...(!response.ok ? { failure: "http" as const } : {}),
        ...(envelope?.data?.accountType !== undefined ? { accountType: envelope.data.accountType } : {}),
        ...(envelope?.data?.mfaRequired !== undefined ? { mfaRequired: envelope.data.mfaRequired } : {}),
        ...(envelope?.data?.mfaVerified !== undefined ? { mfaVerified: envelope.data.mfaVerified } : {}),
        ...(envelope?.data?.mustChangePassword !== undefined ? { mustChangePassword: envelope.data.mustChangePassword } : {}),
        ...(response.status === 429 ? { retryAfterSeconds: boundedRetryAfter(response.headers.get("retry-after")) } : {}),
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      const timeoutFailure = error instanceof Error && error.name === "AbortError";
      if (attempt === 0) {
        await sleep(50 + Math.floor(Math.random() * 100));
        continue;
      }
      return { decision: "SERVICE_UNAVAILABLE", failure: timeoutFailure ? "timeout" : "network", latencyMs: Date.now() - started };
    } finally {
      clearTimeout(timeout);
    }
  }
  return { decision: "SERVICE_UNAVAILABLE", failure: "network", latencyMs: Date.now() - started };
}
