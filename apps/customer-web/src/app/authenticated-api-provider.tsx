"use client";
import { useAuth } from "@clerk/nextjs";
import { createContext, useCallback, useContext } from "react";
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
  const { getToken, isLoaded } = useAuth();
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
    return <main className="account-loading">Securing your session…</main>;
  return <Context.Provider value={authFetch}>{children}</Context.Provider>;
}
