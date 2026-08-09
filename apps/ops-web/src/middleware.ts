import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
const isPublic = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/staff-onboarding(.*)",
  "/unauthorized",
  "/super-admin(.*)",
]);
const isSecurity = createRouteMatcher(["/security(.*)"]);
const isChangePassword = createRouteMatcher(["/change-password(.*)"]);
const isAdmin = createRouteMatcher(["/admin(.*)"]);
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
export default clerkMiddleware(async (auth, request) => {
  if (isPublic(request)) return;
  const session = await auth();
  if (!session?.userId) {
    const signInUrl = new URL("/sign-in", request.url);
    signInUrl.searchParams.set("redirect_url", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(signInUrl);
  }
  const token = await session.getToken();
  if (!token) return NextResponse.redirect(new URL("/unauthorized", request.url));
  try {
    const response = await fetch(`${API}/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok) return NextResponse.redirect(new URL("/unauthorized", request.url));
    const envelope = (await response.json()) as {
      data: {
        accountType: string;
        mfaRequired: boolean;
        mfaVerified: boolean;
        mustChangePassword: boolean;
      };
    };
    if (!["OPERATIONS", "SUPER_ADMIN"].includes(envelope.data.accountType))
      return NextResponse.redirect(new URL("/unauthorized", request.url));
    if (
      isAdmin(request) &&
      envelope.data.accountType !== "SUPER_ADMIN"
    )
      return NextResponse.redirect(new URL("/unauthorized", request.url));
    if (
      envelope.data.mustChangePassword &&
      !isChangePassword(request)
    )
      return NextResponse.redirect(new URL("/change-password", request.url));
    if (
      envelope.data.mfaRequired &&
      !envelope.data.mfaVerified &&
      !isSecurity(request)
    )
      return NextResponse.redirect(new URL("/security", request.url));
  } catch {
    return NextResponse.redirect(new URL("/unauthorized", request.url));
  }
});
export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
