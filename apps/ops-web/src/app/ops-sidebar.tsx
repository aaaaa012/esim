"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Bell,
  Boxes,
  ClipboardCheck,
  Gauge,
  History,
  PackageSearch,
  PlugZap,
  Settings,
  Users,
  Compass,
} from "lucide-react";
import { useAuthenticatedFetch } from "./authenticated-api-provider";
import { cn } from "@/lib/utils";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};
const baseItems: NavItem[] = [
  { href: "/", label: "Dashboard", icon: Gauge },
  { href: "/work-queue", label: "Work Queue", icon: ClipboardCheck },
  { href: "/orders", label: "Orders", icon: PackageSearch },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/inventory", label: "Inventory", icon: Boxes },
  { href: "/notifications", label: "Notifications", icon: Bell },
  { href: "/integration-events", label: "Integration Events", icon: PlugZap },
  { href: "/audit", label: "Audit Log", icon: History },
];
type Profile = {
  email: string;
  accountType: "OPERATIONS" | "SUPER_ADMIN";
  effectiveCapabilities: string[];
};

function SidebarLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      {item.label}
    </Link>
  );
}

export default function OpsSidebar() {
  const path = usePathname(),
    authFetch = useAuthenticatedFetch();
  const [profile, setProfile] = useState<Profile | null>(null);
  useEffect(() => {
    void authFetch(`${API}/auth/me`)
      .then((response) => response.json())
      .then((value) => setProfile(value.data ?? null));
  }, [authFetch]);
  const adminItem: NavItem = { href: "/admin", label: "Administration", icon: Settings };
  const items = profile?.effectiveCapabilities.includes("admin:portal")
    ? [...baseItems, adminItem]
    : baseItems;
  return (
    <aside className="sticky top-0 flex h-screen w-64 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="border-b border-sidebar-border px-5 py-5">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Compass className="size-4" />
          </span>
          <div className="leading-tight">
            <p className="font-semibold tracking-tight">Visa Compass</p>
            <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
              Operations
            </p>
          </div>
        </div>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        <p className="px-3 pb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Menu
        </p>
        {items.map((item) => (
          <SidebarLink
            key={item.href}
            item={item}
            active={
              item.href === "/"
                ? path === "/"
                : path.startsWith(item.href)
            }
          />
        ))}
      </nav>
      <div className="border-t border-sidebar-border p-3">
        <div className="flex items-center gap-3 rounded-lg bg-secondary px-3 py-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
            {profile?.email.slice(0, 1).toUpperCase() ?? "…"}
          </span>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-xs font-medium">{profile?.email ?? "Loading…"}</p>
            <p className="text-[11px] text-muted-foreground">
              {profile?.accountType.replace("_", " ") ?? "Authenticating"}
            </p>
          </div>
        </div>
      </div>
    </aside>
  );
}