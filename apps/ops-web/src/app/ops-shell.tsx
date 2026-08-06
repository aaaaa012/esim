"use client";

import { useClerk, UserButton, useAuth } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";
import OpsSidebar from "./ops-sidebar";
import ThemeToggle from "./theme-toggle";

export default function OpsShell({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const pathname = usePathname();
  if (
    pathname.startsWith("/sign-in") ||
    pathname.startsWith("/sign-up") ||
    pathname.startsWith("/staff-onboarding")
  )
    return children;
  if (!isLoaded || !isSignedIn)
    return <main className="empty-table">Securing operator session…</main>;
  return (
    <div className="layout">
      <OpsSidebar />
      <div className="content-shell">
        <header className="portal-topbar">
          <b>Visa Compass Operations</b>
          <div>
            <ThemeToggle />
            <a href={process.env.NEXT_PUBLIC_CUSTOMER_WEB_URL ?? "http://localhost:3000"}>← Customer Portal</a>
            <button
              type="button"
              className="sign-out"
              onClick={() => void signOut()}
              title="Sign out of the operations console"
            >
              <LogOut size={15} />
              Sign out
            </button>
            <UserButton />
          </div>
        </header>
        <main className="main">{children}</main>
      </div>
    </div>
  );
}
