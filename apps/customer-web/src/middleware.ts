import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
const isProtected = createRouteMatcher(["/account(.*)"]);
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
export default clerkMiddleware(async (auth, request) => {
  if (!isProtected(request)) return;
  const session = await auth();
  if (!session.userId) {
    await auth.protect();
    return;
  }
  const token = await session.getToken();
  // A signed-in session that cannot issue a token, or that is not a customer
  // account, must never land on a bare 404. Send them to a meaningful page.
  if (!token) return NextResponse.redirect(new URL("/", request.url));
  try {
    const response = await fetch(`${API}/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok) return NextResponse.redirect(new URL("/", request.url));
    const envelope = (await response.json()) as {
      data: { accountType: string };
    };
    if (envelope.data.accountType !== "CUSTOMER")
      return NextResponse.redirect(new URL("/", request.url));
  } catch {
    return NextResponse.redirect(new URL("/", request.url));
  }
});
export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
