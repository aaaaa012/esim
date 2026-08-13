"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Bell,
  Boxes,
  ClipboardCheck,
  Compass,
  Gauge,
  Handshake,
  History,
  PackageSearch,
  PlugZap,
  RadioTower,
  Server,
  RotateCw,
  Settings,
  Users,
} from "lucide-react";
import { useAuthenticatedFetch } from "./authenticated-api-provider";
import { cn } from "@/lib/utils";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};
const overviewItems: NavItem[] = [
  { href: "/", label: "Dashboard", icon: Gauge },
  { href: "/work-queue", label: "Review Queue", icon: ClipboardCheck },
  { href: "/orders", label: "Orders", icon: PackageSearch },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/inventory", label: "Inventory", icon: Boxes },
  { href: "/transatel", label: "Connectivity", icon: RadioTower },
  { href: "/provisioning-operations", label: "Provisioning recovery", icon: RotateCw },
];
const systemItems: NavItem[] = [
  { href: "/notifications", label: "Notifications", icon: Bell },
  { href: "/integration-events", label: "Events", icon: PlugZap },
  { href: "/integration-logs", label: "Provider Logs", icon: Server },
  { href: "/audit", label: "Activity Log", icon: History },
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
      className={cn("ops-sidebar-link", active && "active")}
    >
      <Icon className="size-4" />
      {item.label}
    </Link>
  );
}

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path.startsWith(href);
}

export default function OpsSidebar() {
  const authFetch = useAuthenticatedFetch();
  const [profile, setProfile] = useState<Profile | null>(null);
  useEffect(() => {
    void authFetch(`${API}/auth/me`)
      .then((response) => response.json())
      .then((value) => setProfile(value.data ?? null));
  }, [authFetch]);
  const isAdmin = profile?.effectiveCapabilities.includes("admin:portal") ?? false;
  const adminItem: NavItem = { href: "/admin", label: "Administration", icon: Settings };
  const showcaseItem: NavItem = { href: "/admin/partners-showcase", label: "Partner Showcase", icon: Handshake };
  const path = usePathname();
  const items = isAdmin ? [...overviewItems, ...systemItems, adminItem, showcaseItem] : [...overviewItems, ...systemItems];
  return (
    <aside className="ops-sidebar">
      <div className="ops-sidebar-brand">
        <span className="mark">
          <Compass className="size-4" />
        </span>
        <div className="word">
          <b>Visa Compass</b>
          <span>Operations</span>
        </div>
      </div>

      <nav className="ops-sidebar-nav">
        {items.map((item) => (
          <SidebarLink
            key={item.href}
            item={item}
            active={isActive(path, item.href)}
          />
        ))}
      </nav>

      <div className="ops-sidebar-foot">
        <div className="ops-sidebar-user">
          <span className="avatar">{profile?.email.slice(0, 1).toUpperCase() ?? "…"}</span>
          <div className="meta">
            <b>{profile?.email ?? "Loading…"}</b>
            <span>{profile?.accountType.replace("_", " ") ?? "Authenticating"}</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
