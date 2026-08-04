import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
const isProtected = createRouteMatcher(["/account(.*)", "/esim/checkout(.*)"]);
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
export default clerkMiddleware(async (auth, request) => {
  if (!isProtected(request)) return;
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
      data: { accountType: string };
    };
    if (envelope.data.accountType !== "CUSTOMER")
      return new NextResponse(null, { status: 404 });
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
