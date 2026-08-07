"use client";
import { useAuth } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext } from "react";
import { Spinner } from "@/components/spinner";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type AuthFetch = typeof window.fetch;
const Context = createContext<AuthFetch | null>(null);
export function useAuthenticatedFetch() {
  const value = useContext(Context);
  if (!value) throw new Error("Authenticated API client is unavailable");
  return value;
}
export default function AuthenticatedApiProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const pathname = usePathname();
  const authFetch = useCallback<AuthFetch>(
    async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      if (url.startsWith(API)) {
        const token = await getToken({ skipCache: true });
        if (token) headers.set("authorization", `Bearer ${token}`);
      }
      return window.fetch(input, { ...init, headers });
    },
    [getToken],
  );
  if (!isLoaded)
    return (
      <div className="flex min-h-screen items-center justify-center gap-3 text-sm text-muted-foreground">
        <Spinner /> Securing operator session…
      </div>
    );
  if (
    !isSignedIn &&
    !pathname.startsWith("/sign-in") &&
    !pathname.startsWith("/sign-up") &&
    !pathname.startsWith("/staff-onboarding")
  )
    return (
      <div className="flex min-h-screen items-center justify-center px-4 text-sm text-muted-foreground">
        Your session has ended. Sign in again to continue.
      </div>
    );
  return <Context.Provider value={authFetch}>{children}</Context.Provider>;
}
