"use client";

import { UserButton, useAuth } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import OpsSidebar from "./ops-sidebar";
import ThemeToggle from "./theme-toggle";

export default function OpsShell({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
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
            <a href="http://localhost:3000">← Customer Portal</a>
            <UserButton />
          </div>
        </header>
        <main className="main">{children}</main>
      </div>
    </div>
  );
}
