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
} from "lucide-react";
import { useAuthenticatedFetch } from "./authenticated-api-provider";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const baseItems = [
  ["/", Gauge, "Dashboard"],
  ["/work-queue", ClipboardCheck, "Work Queue"],
  ["/orders", PackageSearch, "Orders"],
  ["/customers", Users, "Customers"],
  ["/inventory", Boxes, "Inventory"],
  ["/notifications", Bell, "Notifications"],
  ["/integration-events", PlugZap, "Integration Events"],
  ["/audit", History, "Audit Log"],
] as const;
type Profile = {
  email: string;
  accountType: "OPERATIONS" | "SUPER_ADMIN";
  effectiveCapabilities: string[];
};
export default function OpsSidebar() {
  const path = usePathname(),
    authFetch = useAuthenticatedFetch();
  const [profile, setProfile] = useState<Profile | null>(null);
  useEffect(() => {
    void authFetch(`${API}/auth/me`)
      .then((response) => response.json())
      .then((value) => setProfile(value.data ?? null));
  }, [authFetch]);
  const items = profile?.effectiveCapabilities.includes("admin:portal")
    ? [...baseItems, ["/admin", Settings, "Administration"] as const]
    : baseItems;
  return (
    <aside className="sidebar">
      <div className="brand">
        Visa Compass<small>OPERATIONS PORTAL</small>
      </div>
      <nav className="menu">
        {items.map(([href, Icon, label]) => (
          <Link
            key={href}
            href={href}
            className={
              href === "/"
                ? path === "/"
                  ? "active"
                  : ""
                : path.startsWith(href)
                  ? "active"
                  : ""
            }
          >
            <Icon size={16} />
            {label}
          </Link>
        ))}
      </nav>
      <div className="profile">
        <span className="profile-avatar">
          {profile?.email.slice(0, 1).toUpperCase() ?? "…"}
        </span>
        <div>
          <b>{profile?.email ?? "Loading identity…"}</b>
          <span>
            {profile?.accountType.replace("_", " ") ?? "AUTHENTICATING"}
          </span>
        </div>
      </div>
    </aside>
  );
}
