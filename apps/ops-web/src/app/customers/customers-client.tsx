"use client";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CalendarDays,
  CircleDashed,
  Globe2,
  Mail,
  Phone,
  Ruler,
  Wallet,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { SearchInput } from "@/components/search-input";
import { Spinner } from "@/components/spinner";
import { PaginationBar } from "@/components/pagination-bar";
import { cn } from "@/lib/utils";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type Customer = {
  ownerId: string;
  name: string;
  email: string;
  phone?: string | null;
  orders: number;
  completedEsims: number;
  spendNpr: number;
  firstOrderAt?: string | null;
  lastOrderAt?: string | null;
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

const avatarTone = (name: string) => {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const tones = [
    "bg-primary/10 text-primary",
    "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
    "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  ];
  return tones[hash % tones.length];
};

const npr = (value: number) => `NPR ${value.toLocaleString("en-NP")}`;

export default function CustomersClient() {
  const authFetch = useAuthenticatedFetch();
  const [items, setItems] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ limit: "50", offset: String((page - 1) * 50) });
    if (debouncedQuery.trim()) params.set("q", debouncedQuery.trim());
    void authFetch(`${API}/operations/customers?${params}`, { headers: {} })
      .then((r) => r.json())
      .then((v) => {
        setItems(v.data?.items ?? []);
        setTotal(v.data?.total ?? 0);
      })
      .finally(() => setLoading(false));
  }, [page, debouncedQuery]);

  return (
    <>
      <PageHeader
        title="Customers"
        description="Interconnected traveller profiles and their order history."
        actions={
          <SearchInput
            placeholder="Search name, email, phone…"
            value={query}
            onChange={setQuery}
            className="w-full sm:w-80"
          />
        }
      />
      {loading ? (
        <div className="flex h-72 items-center justify-center">
          <Spinner />
        </div>
      ) : !items.length ? (
        <div className="flex h-64 items-center justify-center rounded-xl border bg-card text-sm text-muted-foreground">
          No customers found.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((customer) => (
            <div
              key={customer.ownerId}
              className="group relative overflow-hidden rounded-2xl border bg-card p-5 shadow-card transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
            >
              <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary via-cyan-500 to-primary opacity-70" />
              <div className="flex items-start justify-between gap-4">
                <span
                  className={cn(
                    "flex size-14 shrink-0 items-center justify-center rounded-2xl text-lg font-bold",
                    avatarTone(customer.name),
                  )}
                >
                  {initials(customer.name)}
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-muted-foreground">
                  <CircleDashed className="size-3.5" />
                  {customer.orders} order{customer.orders === 1 ? "" : "s"}
                </span>
              </div>
              <div className="mt-4">
                <h3 className="text-base font-semibold leading-tight tracking-tight">
                  {customer.name}
                </h3>
                <div className="mt-1.5 space-y-1 text-sm">
                  <p className="flex items-center gap-2 text-muted-foreground">
                    <Mail className="size-3.5 shrink-0" />
                    <span className="truncate">{customer.email}</span>
                  </p>
                  {customer.phone && (
                    <p className="flex items-center gap-2 text-muted-foreground">
                      <Phone className="size-3.5 shrink-0" />
                      {customer.phone}
                    </p>
                  )}
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2.5 rounded-xl bg-muted/60 p-3">
                <div className="flex items-center gap-2">
                  <Wallet className="size-4 shrink-0 text-primary" />
                  <div className="min-w-0 leading-tight">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Spend</p>
                    <p className="truncate text-sm font-semibold">{npr(customer.spendNpr)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Ruler className="size-4 shrink-0 text-primary" />
                  <div className="min-w-0 leading-tight">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">eSIMs</p>
                    <p className="text-sm font-semibold">{customer.completedEsims} completed</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <CalendarDays className="size-4 shrink-0 text-primary" />
                  <div className="min-w-0 leading-tight">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Customer since</p>
                    <p className="truncate text-sm font-semibold">
                      {customer.firstOrderAt
                        ? new Date(customer.firstOrderAt).toLocaleDateString("en-NP", {
                            year: "numeric",
                            month: "short",
                          })
                        : "—"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Globe2 className="size-4 shrink-0 text-primary" />
                  <div className="min-w-0 leading-tight">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Last order</p>
                    <p className="truncate text-sm font-semibold">
                      {customer.lastOrderAt
                        ? new Date(customer.lastOrderAt).toLocaleDateString("en-NP", {
                            year: "numeric",
                            month: "short",
                          })
                        : "—"}
                    </p>
                  </div>
                </div>
              </div>
              <Link
                href={`/customers/${customer.ownerId}`}
                className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-secondary px-4 py-2.5 text-sm font-medium text-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground"
              >
                View order history
                <ArrowRight className="size-4" />
              </Link>
            </div>
          ))}
        </div>
      )}
      {!loading && total > 0 && (
        <div className="mt-6">
          <PaginationBar page={page} pageSize={50} total={total} onPageChange={setPage} />
        </div>
      )}
    </>
  );
}