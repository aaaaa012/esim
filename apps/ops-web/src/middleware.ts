import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
const isPublic = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/staff-onboarding(.*)",
]);
const isSecurity = createRouteMatcher(["/security(.*)"]);
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
export default clerkMiddleware(async (auth, request) => {
  if (isPublic(request)) return;
  const session = await auth();
  if (!session.userId) {
    await auth.protect();
    return;
  }
  const token = await session.getToken();
  if (!token) return new NextResponse(null, { status: 404 });
  try {
    const response = await fetch(`${API}/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok) return new NextResponse(null, { status: 404 });
    const envelope = (await response.json()) as {
      data: { accountType: string; mfaRequired: boolean; mfaVerified: boolean };
    };
    if (!["OPERATIONS", "SUPER_ADMIN"].includes(envelope.data.accountType))
      return new NextResponse(null, { status: 404 });
    if (
      envelope.data.mfaRequired &&
      !envelope.data.mfaVerified &&
      !isSecurity(request)
    )
      return NextResponse.redirect(new URL("/security", request.url));
  } catch {
    return new NextResponse(null, { status: 404 });
  }
});
export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
