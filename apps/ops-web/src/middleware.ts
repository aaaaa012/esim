import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { authRouteDecision } from "@visa-compass/shared";
const isPublic = createRouteMatcher([
  "/sign-in(.*)",
  "/staff-onboarding(.*)",
  "/staff-activate(.*)",
  "/unauthorized",
  "/account-unavailable",
  "/service-unavailable",
  "/super-admin(.*)",
]);
const isTerminal = createRouteMatcher(["/access-error", "/unauthorized", "/account-unavailable", "/service-unavailable"]);
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
  const destination = request.nextUrl.pathname + request.nextUrl.search;
  const redirect = (path: string) => {
    const url = new URL(path, request.url);
    url.searchParams.set(path === "/sign-in" ? "redirect_url" : "returnTo", destination);
    return NextResponse.redirect(url);
  };
  if (!token) return redirect("/service-unavailable");
  try {
    const response = await fetch(`${API}/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const envelope = await response.json().catch(() => null) as {
      data?: {
        accountType: string;
        mfaRequired: boolean;
        mfaVerified: boolean;
        mustChangePassword: boolean;
      };
      error?: { code?: string };
    } | null;
    const decision = authRouteDecision({ status: response.status, ...(envelope?.error?.code ? { code: envelope.error.code } : {}), ...(envelope?.data?.accountType ? { accountType: envelope.data.accountType } : {}), allowedAccountTypes: ["OPERATIONS", "SUPER_ADMIN"], requiresSuperAdmin: isSuperAdminOnly(request) });
    if (decision !== "ALLOW") return redirect(decision === "SIGN_IN" ? "/sign-in" : decision === "ACCOUNT_UNAVAILABLE" ? "/account-unavailable" : decision === "UNAUTHORIZED" ? "/unauthorized" : "/service-unavailable");
    if (envelope!.data!.mustChangePassword && !isChangePassword(request))
      return NextResponse.redirect(new URL("/change-password", request.url));
    if (
      envelope!.data!.mfaRequired &&
      !envelope!.data!.mfaVerified &&
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
