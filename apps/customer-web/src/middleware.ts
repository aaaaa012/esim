import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { authRouteDecision } from "@visa-compass/shared";
const isProtected = createRouteMatcher(["/account(.*)"]);
const isTerminal = createRouteMatcher(["/unauthorized", "/account-unavailable", "/service-unavailable"]);
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const e2eMode = process.env.NEXT_PUBLIC_E2E_TEST_MODE === "true";
if (e2eMode && process.env.NODE_ENV === "production") {
  throw new Error("E2E middleware bypass is forbidden in production");
}
const productionMiddleware = clerkMiddleware(async (auth, request) => {
  if (isTerminal(request)) return;
  if (!isProtected(request)) return;
  const destination = request.nextUrl.pathname + request.nextUrl.search;
  const redirect = (path: string) => {
    const url = new URL(path, request.url);
    url.searchParams.set(path === "/sign-in" ? "redirect_url" : "returnTo", destination);
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
    const response = await fetch(`${API}/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const envelope = await response.json().catch(() => null) as { data?: { accountType?: string }; error?: { code?: string } } | null;
    const decision = authRouteDecision({ status: response.status, ...(envelope?.error?.code ? { code: envelope.error.code } : {}), ...(envelope?.data?.accountType ? { accountType: envelope.data.accountType } : {}), allowedAccountTypes: ["CUSTOMER"] });
    if (decision !== "ALLOW") return redirect(decision === "SIGN_IN" ? "/sign-in" : decision === "ACCOUNT_UNAVAILABLE" ? "/account-unavailable" : decision === "UNAUTHORIZED" ? "/unauthorized" : "/service-unavailable");
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
