import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { safeInternalReturnTo, verifyPortalSession } from "@visa-compass/shared";
const isProtected = createRouteMatcher(["/account(.*)"]);
const isTerminal = createRouteMatcher(["/unauthorized", "/account-unavailable", "/rate-limited", "/service-unavailable"]);
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const e2eMode = process.env.NEXT_PUBLIC_E2E_TEST_MODE === "true";
if (e2eMode && process.env.NODE_ENV === "production") {
  throw new Error("E2E middleware bypass is forbidden in production");
}
const productionMiddleware = clerkMiddleware(async (auth, request) => {
  if (isTerminal(request)) return;
  if (!isProtected(request)) return;
  const destination = safeInternalReturnTo(request.nextUrl.pathname + request.nextUrl.search);
  const redirect = (path: string, retryAfterSeconds?: number) => {
    const url = new URL(path, request.url);
    url.searchParams.set(path === "/sign-in" ? "redirect_url" : "returnTo", destination);
    if (path === "/rate-limited" && retryAfterSeconds) url.searchParams.set("retryAfter", String(retryAfterSeconds));
    return NextResponse.redirect(url);
  };
  const session = await auth();
  if (!session.userId) {
    return redirect("/sign-in");
  }
  const token = await session.getToken();
  // A signed-in session that cannot issue a token, or that is not a customer
  // account, must never land on a bare 404. Send them to a meaningful page.
  if (!token) return redirect("/service-unavailable");
  try {
    const result = await verifyPortalSession({ apiUrl: API, token, allowedAccountTypes: ["CUSTOMER"], timeoutMs: Number(process.env.PORTAL_AUTH_TIMEOUT_MS ?? 5_000) });
    if (result.decision !== "ALLOW") {
      console.warn(JSON.stringify({ event: "portal_session_verification", portal: "customer", destination: request.nextUrl.pathname.split("/").slice(0, 3).join("/"), status: result.status, failure: result.failure ?? result.decision.toLowerCase(), latencyMs: result.latencyMs, retryAfterSeconds: result.retryAfterSeconds }));
      return redirect(result.decision === "SIGN_IN" ? "/sign-in" : result.decision === "ACCOUNT_UNAVAILABLE" ? "/account-unavailable" : result.decision === "UNAUTHORIZED" ? "/unauthorized" : result.decision === "RATE_LIMITED" ? "/rate-limited" : "/service-unavailable", result.retryAfterSeconds);
    }
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
