"use client";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ArrowRight,
  ChevronDown,
  CircleDollarSign,
  ClipboardList,
  Clock,
  RefreshCcw,
  Settings2,
  ShieldQuestion,
  XCircle,
} from "lucide-react";
import { Panel } from "@/components/panel";
import ErrorDialog from "@/components/error-dialog";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { Spinner } from "@/components/spinner";
import { SearchInput } from "@/components/search-input";
import { cn } from "@/lib/utils";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const PAGE_SIZE = 200;

type OpsOrder = {
  id: string;
  orderNumber: string;
  status: string;
  createdAt: string;
  totalAmountNpr: number;
  plan: { name: string; countryCode: string };
  traveler?: { firstName: string; surname: string; email: string };
  partner?: { code: string; name: string } | null;
  documentReviewStatus?: string;
};

type SectionDef = {
  key: string;
  label: string;
  icon: typeof ClipboardList;
  tone: string;
  statuses: string[];
  description?: string;
  matches?: (order: OpsOrder) => boolean;
  todayOnly?: boolean;
};

const SECTIONS: SectionDef[] = [
  {
    key: "partner_finalization",
    label: "Partner finalization",
    icon: Clock,
    tone: "sky",
    statuses: ["REVIEW_PENDING"],
    description: "verified orders waiting for the partner to finalize",
    matches: (order) =>
      Boolean(order.partner) &&
      ["VERIFIED", "MANUALLY_APPROVED", "SKIPPED"].includes(
        order.documentReviewStatus ?? "",
      ),
  },
  {
    key: "review",
    label: "Pending review",
    icon: ClipboardList,
    tone: "amber",
    statuses: ["REVIEW_PENDING"],
    matches: (order) =>
      !Boolean(order.partner) ||
      !["VERIFIED", "MANUALLY_APPROVED", "SKIPPED"].includes(
        order.documentReviewStatus ?? "",
      ),
  },
  {
    key: "awaiting",
    label: "Awaiting customer",
    icon: Clock,
    tone: "sky",
    statuses: ["AWAITING_CUSTOMER"],
  },
  {
    key: "provisioning_failed",
    label: "Provisioning failed",
    icon: XCircle,
    tone: "red",
    statuses: ["PROVISIONING_FAILED"],
  },
  {
    key: "payment",
    label: "Payment verification",
    icon: CircleDollarSign,
    tone: "violet",
    statuses: ["PAYMENT_PENDING", "PAYMENT_FAILED", "PAYMENT_CONFIRMED"],
  },
  {
    key: "refund",
    label: "Refund requests",
    icon: RefreshCcw,
    tone: "slate",
    statuses: ["REFUND_PENDING"],
  },
  {
    key: "completed_today",
    label: "Completed today",
    icon: Settings2,
    tone: "green",
    statuses: ["COMPLETED"],
    todayOnly: true,
  },
];

const toneClass: Record<string, string> = {
  amber: "bg-amber-500/10 text-amber-600",
  sky: "bg-sky-500/10 text-sky-600",
  red: "bg-red-500/10 text-red-600",
  violet: "bg-violet-500/10 text-violet-600",
  slate: "bg-slate-500/10 text-slate-600",
  green: "bg-emerald-500/10 text-emerald-600",
};

export default function QueueClient() {
  const authFetch = useAuthenticatedFetch();
  const [orders, setOrders] = useState<OpsOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({
    review: true,
    partner_finalization: true,
  });

  const statusParam = useSearchParams().get("status");
  const initialOpen = statusParam
    ? (SECTIONS.find((s) => s.statuses.includes(statusParam))?.key ?? "review")
    : "review";

  const load = () => {
    setLoading(true);
    setError("");
    authFetch(`${API}/operations/orders?limit=${PAGE_SIZE}`, { headers: {} })
      .then(async (r) => {
        const v = await r.json();
        if (!r.ok)
          throw new Error(v?.error?.message ?? "Could not load the queue");
        setOrders(v.data?.items ?? []);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Could not load the queue"),
      )
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const today = new Date().toISOString().slice(0, 10);
  const q = query.trim().toLowerCase();

  const grouped = useMemo(() => {
    const result: Record<string, OpsOrder[]> = {};
    const seed: Record<string, OpsOrder[]> = {};
    SECTIONS.forEach((s) => {
      seed[s.key] = [];
    });
    orders.forEach((o) => {
      const matched = SECTIONS.find(
        (s) =>
          s.statuses.includes(o.status) &&
          (!s.matches || s.matches(o)) &&
          (!s.todayOnly || o.createdAt.startsWith(today)),
      );
      if (matched) (seed[matched.key] ??= []).push(o);
    });
    const filteredStatuses = statusParam
      ? SECTIONS.filter((s) => s.statuses.includes(statusParam)).map(
          (s) => s.key,
        )
      : null;
    SECTIONS.forEach((s) => {
      if (filteredStatuses && !filteredStatuses.includes(s.key)) {
        result[s.key] = [];
        return;
      }
      const list = (seed[s.key] ?? []).filter((o) =>
        `${o.orderNumber} ${o.traveler?.firstName ?? ""} ${o.traveler?.surname ?? ""} ${o.traveler?.email ?? ""}`
          .toLowerCase()
          .includes(q),
      );
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      result[s.key] = list;
    });
    return result;
  }, [orders, q, today, statusParam]);

  const total = SECTIONS.reduce((n, s) => n + (grouped[s.key]?.length ?? 0), 0);
  const showSections = statusParam
    ? SECTIONS.filter((s) => s.statuses.includes(statusParam))
    : SECTIONS;

  return (
    <>
      <ErrorDialog error={error} onClose={() => setError("")} />
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput
          placeholder="Search order, customer, email…"
          value={query}
          onChange={setQuery}
          className="sm:w-80"
        />
        <div className="flex items-center gap-2">
          {statusParam && (
            <Link
              href="/work-queue"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Show full queue
            </Link>
          )}
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCcw className={cn("size-4", loading && "animate-spin")} />{" "}
            Refresh
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 p-16 text-muted-foreground">
          <Spinner /> Loading queue…
        </div>
      ) : total === 0 ? (
        <EmptyState
          icon={<ShieldQuestion className="size-6" />}
          title="Queue is clear"
          description="No orders currently require attention."
        />
      ) : (
        <div className="space-y-4">
          {showSections.map((section) => {
            const list = grouped[section.key] ?? [];
            const Icon = section.icon;
            const isOpen =
              open[section.key] ??
              (statusParam ? section.key === initialOpen : false);
            if (list.length === 0 && !isOpen) return null;
            return (
              <Panel key={section.key} className="p-0">
                <button
                  type="button"
                  onClick={() =>
                    setOpen((prev) => ({
                      ...prev,
                      [section.key]: !prev[section.key],
                    }))
                  }
                  className="flex w-full items-center justify-between gap-3 border-b p-4 text-left"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={cn(
                        "flex size-9 items-center justify-center rounded-lg",
                        toneClass[section.tone],
                      )}
                    >
                      <Icon className="size-4" />
                    </span>
                    <div>
                      <div className="font-semibold">{section.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {section.description ??
                          (section.todayOnly
                            ? "orders completed today"
                            : "orders that need your action")}
                      </div>
                    </div>
                    <Badge variant="secondary" className="ml-1">
                      {list.length}
                    </Badge>
                  </div>
                  <ChevronDown
                    className={cn(
                      "size-4 text-muted-foreground transition-transform",
                      isOpen && "rotate-180",
                    )}
                  />
                </button>
                {isOpen && (
                  <ul className="divide-y">
                    {list.length === 0 ? (
                      <li className="p-6 text-sm text-muted-foreground">
                        No orders in this section.
                      </li>
                    ) : (
                      list.map((o) => (
                        <li key={o.id}>
                          <Link
                            href={`/orders/${o.id}`}
                            className="group flex items-center justify-between gap-4 p-4 hover:bg-accent/50"
                          >
                            <div className="flex min-w-0 items-center gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold">
                                    {o.orderNumber}
                                  </span>
                                  <span className="hidden text-xs sm:inline">
                                    {o.plan.countryCode}
                                  </span>
                                </div>
                                <div className="truncate text-sm text-muted-foreground">
                                  {o.traveler
                                    ? `${o.traveler.firstName} ${o.traveler.surname} · ${o.traveler.email}`
                                    : "Customer without a name"}
                                </div>
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-3">
                              {o.partner && (
                                <span className="hidden text-xs text-muted-foreground md:inline">
                                  {o.partner.name}
                                </span>
                              )}
                              <StatusBadge
                                label={
                                  section.key === "partner_finalization"
                                    ? "AWAITING_PARTNER_FINALIZATION"
                                    : o.status
                                }
                              />
                              <span className="text-sm font-medium tabular-nums">
                                NPR {o.totalAmountNpr.toLocaleString()}
                              </span>
                              <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                            </div>
                          </Link>
                        </li>
                      ))
                    )}
                  </ul>
                )}
              </Panel>
            );
          })}
        </div>
      )}
    </>
  );
}
