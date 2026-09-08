"use client";

import type { ReactNode } from "react";

const signedIn = process.env.NEXT_PUBLIC_E2E_SIGNED_IN === "true";
const token = process.env.NEXT_PUBLIC_E2E_AUTH_TOKEN ?? "";

export function ClerkProvider({ children }: { children: ReactNode }) {
  return children;
}

export function SignedIn({ children }: { children: ReactNode }) {
  return signedIn ? children : null;
}

export function SignedOut({ children }: { children: ReactNode }) {
  return signedIn ? null : children;
}

export function UserButton() {
  return <button type="button" aria-label="Test account">Account</button>;
}

export function SignInButton({ children }: { children: ReactNode }) {
  return children;
}

export function SignIn() {
  return <div aria-label="Test sign in">Test sign in</div>;
}

export function SignUp() {
  return <div aria-label="Test sign up">Test sign up</div>;
}

export function useAuth() {
  return {
    isLoaded: true,
    isSignedIn: signedIn,
    userId: signedIn ? "e2e-customer" : null,
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
