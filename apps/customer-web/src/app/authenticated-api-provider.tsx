"use client";
import { useAuth } from "@clerk/nextjs";
import { createContext, useCallback, useContext, useRef } from "react";
import { sanitizeApiResponse } from "../lib/sanitize-api-response";
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
  waitForSession = false,
}: {
  children: React.ReactNode;
  waitForSession?: boolean;
}) {
  const { getToken, isLoaded } = useAuth();
  const authMeInFlight = useRef<Promise<Response> | null>(null);
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
      const request = async () => {
        if (url.startsWith(API)) {
          const token = await getToken();
          if (token) headers.set("authorization", `Bearer ${token}`);
        }
        let response = await window.fetch(input, { ...init, headers });
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        const retryable = method === "GET" || method === "HEAD" || headers.has("x-idempotency-key");
        if (response.status === 401 && url.startsWith(API) && retryable && !(input instanceof Request)) {
          const fresh = await getToken({ skipCache: true });
          if (fresh) headers.set("authorization", `Bearer ${fresh}`);
          response = await window.fetch(input, { ...init, headers });
        }
        return sanitizeApiResponse(response);
      };
      if (url === `${API}/auth/me`) {
        if (!authMeInFlight.current) authMeInFlight.current = request().finally(() => { authMeInFlight.current = null; });
        return (await authMeInFlight.current).clone();
      }
      return request();
    },
    [getToken],
  );
  if (waitForSession && !isLoaded)
    return <main className="account-loading">Securing your session…</main>;
  return <Context.Provider value={authFetch}>{children}</Context.Provider>;
}
