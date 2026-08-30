"use client";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Bell,
  Boxes,
  ClipboardCheck,
  Gauge,
  Handshake,
  Images,
  History,
  PackageSearch,
  RadioTower,
  RotateCw,
  Settings,
  Undo2,
  Users,
  X,
} from "lucide-react";
import { useAuthenticatedFetch } from "./authenticated-api-provider";
import { humane } from "@/components/status-badge";
import { cn } from "@/lib/utils";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};
const overviewItems: NavItem[] = [
  { href: "/", label: "Home", icon: Gauge },
  { href: "/work-queue", label: "To-do list", icon: ClipboardCheck },
  { href: "/attention", label: "Attention queue", icon: AlertTriangle },
  { href: "/orders", label: "Orders", icon: PackageSearch },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/inventory", label: "eSIM stock", icon: Boxes },
  { href: "/transatel", label: "Provider status", icon: RadioTower },
  {
    href: "/provisioning-operations",
    label: "Pending activations",
    icon: RotateCw,
  },
];
const systemItems: NavItem[] = [
  {
    href: "/admin/homepage-campaigns",
    label: "Homepage campaigns",
    icon: Images,
  },
  { href: "/manual-refunds", label: "Refunds", icon: Undo2 },
  { href: "/notifications", label: "Messages", icon: Bell },
  { href: "/logs", label: "Logs", icon: History },
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

export default function OpsSidebar({
  open = false,
  onClose,
}: {
  open?: boolean;
  onClose?: () => void;
}) {
  const authFetch = useAuthenticatedFetch();
  const [profile, setProfile] = useState<Profile | null>(null);
  useEffect(() => {
    void authFetch(`${API}/auth/me`)
      .then((response) => response.json())
      .then((value) => setProfile(value.data ?? null));
  }, [authFetch]);
  const isAdmin =
    profile?.effectiveCapabilities.includes("admin:portal") ?? false;
  const adminItem: NavItem = {
    href: "/admin",
    label: "Settings",
    icon: Settings,
  };
  const showcaseItem: NavItem = {
    href: "/admin/partners-showcase",
    label: "Partners",
    icon: Handshake,
  };
  const path = usePathname();
  const items = isAdmin
    ? [...overviewItems, ...systemItems, adminItem, showcaseItem]
    : [...overviewItems, ...systemItems];
  return (
    <>
      <button
        type="button"
        aria-label="Close operations navigation"
        className={cn("ops-sidebar-backdrop", open && "open")}
        onClick={onClose}
      />
      <aside
        className={cn("ops-sidebar", open && "open")}
        aria-label="Operations navigation"
      >
        <div className="ops-sidebar-brand" aria-label="Visa Compass Services Operations">
          <Image
            className="ops-brand-mark"
            src="/brand/visa-compass-mark.png"
            alt=""
            width={370}
            height={484}
            priority
          />
          <div className="word">
            <Image
              className="ops-brand-wordmark"
              src="/brand/visa-compass-services-white.png"
              alt=""
              width={933}
              height={373}
              priority
            />
            <span>Operations</span>
          </div>
          <button
            type="button"
            className="ops-sidebar-close"
            aria-label="Close navigation"
            onClick={onClose}
          >
            <X className="size-5" />
          </button>
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
            <span className="avatar">
              {profile?.email.slice(0, 1).toUpperCase() ?? "…"}
            </span>
            <div className="meta">
              <b>{profile?.email ?? "Loading…"}</b>
              <span>
                {profile ? humane(profile.accountType) : "Authenticating"}
              </span>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
