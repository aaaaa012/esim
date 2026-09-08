"use client";

import type { ReactNode } from "react";

const signedIn = process.env.NEXT_PUBLIC_E2E_SIGNED_IN === "true";
const token = process.env.NEXT_PUBLIC_E2E_AUTH_TOKEN ?? "";

export function ClerkProvider({ children }: { children: ReactNode }) {
  return children;
}

export function UserButton() {
  return <button type="button" aria-label="Test operator account">Account</button>;
}

export function UserProfile() {
  return <div aria-label="Test account security">Test account security</div>;
}

export function useAuth() {
  return {
    isLoaded: true,
    isSignedIn: signedIn,
    userId: signedIn ? "e2e-super-admin" : null,
    getToken: async () => (signedIn ? token : null),
  };
}

export function useClerk() {
  return {
    signOut: async ({ redirectUrl }: { redirectUrl?: string } = {}) => {
      if (redirectUrl) window.location.assign(redirectUrl);
    },
  };
}

export function useSignIn() {
  const complete = { status: "complete", createdSessionId: "e2e-session" };
  return {
    isLoaded: true,
    setActive: async () => undefined,
    signIn: {
      create: async () => complete,
      attemptFirstFactor: async () => complete,
      prepareFirstFactor: async () => undefined,
    },
  };
}
