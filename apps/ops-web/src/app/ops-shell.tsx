"use client";

import { useClerk, UserButton, useAuth } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { ExternalLink, LogOut } from "lucide-react";
import OpsSidebar from "./ops-sidebar";
import ThemeToggle from "./theme-toggle";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/spinner";
import { cn } from "@/lib/utils";

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
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Spinner /> Securing operator session…
        </div>
      </div>
    );
  return (
    <div className="min-h-screen bg-muted/30 lg:flex">
      <OpsSidebar />
      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b bg-card px-4 sm:px-6">
          <div className="flex items-center">
            <span className="text-sm font-semibold tracking-tight sm:hidden">
              Visa Compass
            </span>
            <span className="hidden text-sm font-semibold tracking-tight sm:block">
              Visa Compass Operations
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Separator orientation="vertical" className="h-5" />
            <a
              href={process.env.NEXT_PUBLIC_CUSTOMER_WEB_URL ?? "http://localhost:3000"}
              className="hidden items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:inline-flex"
            >
              Customer Portal
              <ExternalLink className="size-3.5" />
            </a>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void signOut()}
              className="text-muted-foreground"
            >
              <LogOut className="size-4" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
            <div className="ml-1">
              <UserButton />
            </div>
          </div>
        </header>
        <main className={cn("flex-1 px-4 py-6 sm:px-6 lg:px-8")}>
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </main>
      </div>
    </div>
  );
}