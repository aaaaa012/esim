"use client";

import { useClerk, UserButton, useAuth } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ExternalLink, LogOut, Menu } from "lucide-react";
import OpsSidebar from "./ops-sidebar";
import ThemeToggle from "./theme-toggle";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/spinner";
import { cn } from "@/lib/utils";
import { isShellFreePath } from "@/lib/shell-routes";

export default function OpsShell({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useEffect(() => setMobileNavOpen(false), [pathname]);
  useEffect(() => {
    if (!mobileNavOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setMobileNavOpen(false); };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.body.style.overflow = previous; document.removeEventListener("keydown", onKeyDown); };
  }, [mobileNavOpen]);
  const customerPortalUrl = process.env.NEXT_PUBLIC_CUSTOMER_WEB_URL;
  if (isShellFreePath(pathname)) return children;
  if (!isLoaded || !isSignedIn)
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Spinner /> Securing operator session…
        </div>
      </div>
    );
  return (
    <div className="ops-shell lg:flex">
      <OpsSidebar open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
      <div className="flex min-h-screen min-w-0 flex-1 flex-col lg:pl-0">
        <header className="ops-header">
          <div className="flex min-w-0 items-center gap-2">
            <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open operations navigation" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(true)}>
              <Menu className="size-5" />
            </Button>
          <div className="ops-header-title min-w-0">
            <span className="sm:hidden">Visa Compass</span>
            <span className="hidden sm:inline">
              Visa Compass <b>Operations</b>
            </span>
          </div>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Separator orientation="vertical" className="hidden h-5 sm:block" />
            {customerPortalUrl ? (
              <a href={customerPortalUrl} className="hidden items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:inline-flex">
                Customer Portal <ExternalLink className="size-3.5" />
              </a>
            ) : (
              <span className="hidden rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800 md:inline-flex" title="Set NEXT_PUBLIC_CUSTOMER_WEB_URL during the ops-web build">
                Customer portal URL missing
              </span>
            )}
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
        <main className={cn("ops-content flex-1")}>
          <div className="mx-auto w-full">{children}</div>
        </main>
      </div>
    </div>
  );
}
