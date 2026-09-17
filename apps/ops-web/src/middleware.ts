import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { safeInternalReturnTo, verifyPortalSession } from "@visa-compass/shared";
const isPublic = createRouteMatcher([
  "/sign-in(.*)",
  "/staff-onboarding(.*)",
  "/staff-activate(.*)",
  "/unauthorized",
  "/account-unavailable",
  "/service-unavailable",
  "/rate-limited",
  "/super-admin(.*)",
]);
const isTerminal = createRouteMatcher(["/access-error", "/unauthorized", "/account-unavailable", "/rate-limited", "/service-unavailable"]);
const isSecurity = createRouteMatcher(["/security(.*)"]);
const isChangePassword = createRouteMatcher(["/change-password(.*)"]);
const isSuperAdminOnly = createRouteMatcher([
  "/admin",
  "/admin/integrations(.*)",
  "/admin/partners/(.*)",
]);
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const e2eMode = process.env.NEXT_PUBLIC_E2E_TEST_MODE === "true";
if (e2eMode && process.env.NODE_ENV === "production") {
  throw new Error("E2E middleware bypass is forbidden in production");
}
const productionMiddleware = clerkMiddleware(async (auth, request) => {
  if (isTerminal(request)) return;
  if (isPublic(request)) return;
  const session = await auth();
  if (!session?.userId) {
    const signInUrl = new URL("/sign-in", request.url);
    signInUrl.searchParams.set(
      "redirect_url",
      request.nextUrl.pathname + request.nextUrl.search,
    );
    return NextResponse.redirect(signInUrl);
  }
  const token = await session.getToken();
  const destination = safeInternalReturnTo(request.nextUrl.pathname + request.nextUrl.search);
  const redirect = (path: string, retryAfterSeconds?: number) => {
    const url = new URL(path, request.url);
    url.searchParams.set(path === "/sign-in" ? "redirect_url" : "returnTo", destination);
    if (path === "/rate-limited" && retryAfterSeconds) url.searchParams.set("retryAfter", String(retryAfterSeconds));
    return NextResponse.redirect(url);
  };
  if (!token) return redirect("/service-unavailable");
  try {
    const result = await verifyPortalSession({ apiUrl: API, token, allowedAccountTypes: ["OPERATIONS", "SUPER_ADMIN"], requiresSuperAdmin: isSuperAdminOnly(request), timeoutMs: Number(process.env.PORTAL_AUTH_TIMEOUT_MS ?? 5_000) });
    if (result.decision !== "ALLOW") {
      console.warn(JSON.stringify({ event: "portal_session_verification", portal: "operations", destination: request.nextUrl.pathname.split("/").slice(0, 3).join("/"), status: result.status, failure: result.failure ?? result.decision.toLowerCase(), latencyMs: result.latencyMs, retryAfterSeconds: result.retryAfterSeconds }));
      return redirect(result.decision === "SIGN_IN" ? "/sign-in" : result.decision === "ACCOUNT_UNAVAILABLE" ? "/account-unavailable" : result.decision === "UNAUTHORIZED" ? "/unauthorized" : result.decision === "RATE_LIMITED" ? "/rate-limited" : "/service-unavailable", result.retryAfterSeconds);
    }
    if (result.mustChangePassword && !isChangePassword(request))
      return NextResponse.redirect(new URL("/change-password", request.url));
    if (
      result.mfaRequired &&
      !result.mfaVerified &&
      !isSecurity(request)
    )
      return NextResponse.redirect(new URL("/security", request.url));
  } catch {
    return redirect("/service-unavailable");
  }
});
export default e2eMode
  ? function localE2eMiddleware() {
      return NextResponse.next();
    }
  : productionMiddleware;
export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
