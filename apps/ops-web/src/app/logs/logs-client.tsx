"use client";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  Check,
  CircleCheck,
  CircleX,
  ClipboardList,
  Copy,
  Download,
  Eye,
  History,
  Network,
  RefreshCcw,
  ServerCog,
} from "lucide-react";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { Spinner } from "@/components/spinner";
import { SearchInput } from "@/components/search-input";
import ErrorDialog from "@/components/error-dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { activityLabel } from "./log-activity";
import { toast } from "sonner";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const headers = {};

type Group = "all" | "provider" | "incoming" | "orders" | "staff";

type LogEntry = {
  group: Group;
  id: string;
  identifier?: string;
  title: string;
  detail: string;
  status?: number;
  statusLabel?: string;
  createdAt: string;
  durationMs?: number | null;
  error?: string | null;
  requestBody?: unknown;
  responseBody?: unknown;
};

const GROUP_LABELS: Record<Group, string> = {
  all: "All Categories",
  provider: "Outgoing (API Requests)",
  incoming: "Incoming (Callbacks)",
  orders: "Order Operations",
  staff: "Staff Audit Logs",
};

const GROUP_ICONS: Record<Group, typeof ServerCog> = {
  all: ServerCog,
  provider: Network,
  incoming: ArrowDownToLine,
  orders: ClipboardList,
  staff: History,
};

const ACTION_FILTER_OPTIONS = [
  { value: "all", label: "All Actions" },
  { value: "transatel-usage", label: "Transatel Data-Usage Lookup" },
  { value: "transatel-provision", label: "Transatel eSIM Provisioning" },
  { value: "transatel-esim-details", label: "Transatel eSIM Details Lookup" },
  { value: "transatel-catalog", label: "Transatel Plan Catalog Lookup" },
  { value: "transatel-eligibility", label: "Transatel Eligibility Check" },
  { value: "transatel-suspend", label: "Transatel eSIM Suspension" },
  { value: "transatel-terminate", label: "Transatel eSIM Termination" },
  { value: "transatel-webhook", label: "Transatel Webhook Setup" },
  { value: "khalti-lookup", label: "Khalti Payment Lookup" },
  { value: "khalti-initiate", label: "Khalti Payment Initiation" },
  { value: "khalti-callback", label: "Khalti Payment Callback Received" },
  { value: "transatel-callback", label: "Transatel Network Update Received" },
  { value: "partner-api", label: "Partner API Request" },
  { value: "customer-topup-lookup", label: "Customer eSIM Lookup" },
  { value: "customer-topup-eligibility", label: "Customer Top-up Eligibility" },
];

function dump(value: unknown): string {
  const redact = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(redact);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([key, child]) => [
          key,
          /(^|_)(access_?token|refresh_?token|authorization|secret|password|api_?key|activation_?code|matching_?id|qr_?(code|payload)|data_?url)$/i.test(key)
            ? "[REDACTED]"
            : redact(child),
        ]),
      );
    return item;
  };
  const safe = redact(value);
  if (safe === undefined || safe === null) return "";
  if (typeof safe === "string") return safe;
  try {
    return JSON.stringify(safe, null, 2);
  } catch {
    return String(value);
  }
}

function serialise(entry: LogEntry): string {
  const lines: string[] = [];
  lines.push("Visa Compass — Log record");
  lines.push("=".repeat(78));
  lines.push(`When:     ${new Date(entry.createdAt).toLocaleString()}`);
  lines.push(`Type:     ${GROUP_LABELS[entry.group] ?? entry.group}`);
  if (entry.identifier) lines.push(`Provider: ${entry.identifier}`);
  lines.push(`Action:   ${activityLabel(entry)}`);
  lines.push(`Details:  ${entry.detail}`);
  if (entry.status != null) lines.push(`Status:   ${entry.status}`);
  if (entry.statusLabel) lines.push(`Result:   ${entry.statusLabel}`);
  if (entry.durationMs != null) lines.push(`Duration: ${entry.durationMs} ms`);
  if (entry.error) lines.push(`Error:    ${entry.error}`);

  if (entry.requestBody !== undefined && entry.requestBody !== null) {
    lines.push("");
    lines.push("-- REQUEST --");
    lines.push(dump(entry.requestBody));
  }
  if (entry.responseBody !== undefined && entry.responseBody !== null) {
    lines.push("");
    lines.push("--- RESPONSE ---");
    lines.push(dump(entry.responseBody));
  }
  lines.push("");
  return lines.join("\n");
}

function downloadTxt(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export default function LogsClient() {
  const authFetch = useAuthenticatedFetch();
  const [items, setItems] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [group, setGroup] = useState<Group>("all");
  const [actionFilter, setActionFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [inspectEntry, setInspectEntry] = useState<LogEntry | null>(null);
  const [copied, setCopied] = useState(false);
  const pageSize = 25;

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 350);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(
    (refreshOnly = false) => {
      if (refreshOnly) setRefreshing(true);
      else setLoading(true);
      const params = new URLSearchParams();
      if (group !== "all") params.set("group", group);
      if (search) params.set("q", search);
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      return authFetch(`${API}/operations/logs?${params.toString()}`, { headers })
        .then(async (response) => {
          const value = await response.json();
          if (!response.ok) throw new Error(value.error?.message ?? "Could not load logs");
          setItems(value.data?.items ?? []);
          setTotal(value.data?.total ?? 0);
          setError("");
          if (refreshOnly) toast.success("Logs refreshed");
        })
        .catch((cause) => setError(cause.message))
        .finally(() => {
          setLoading(false);
          setRefreshing(false);
        });
    },
    [authFetch, group, search, page],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const changeGroup = (next: Group) => {
    setPage(1);
    setGroup(next);
  };
  const changeQuery = (next: string) => {
    setPage(1);
    setQuery(next);
  };

  const filteredItems = useMemo(() => {
    if (actionFilter === "all") return items;
    return items.filter((entry) => {
      const act = activityLabel(entry).toLowerCase();
      if (actionFilter === "transatel-usage") return act.includes("usage");
      if (actionFilter === "transatel-provision") return act.includes("provisioning");
      if (actionFilter === "transatel-esim-details") return act.includes("esim details");
      if (actionFilter === "transatel-catalog") return act.includes("catalog");
      if (actionFilter === "transatel-eligibility") return act.includes("eligibility");
      if (actionFilter === "transatel-suspend") return act.includes("suspension");
      if (actionFilter === "transatel-terminate") return act.includes("termination");
      if (actionFilter === "transatel-webhook") return act.includes("webhook");
      if (actionFilter === "khalti-lookup") return act.includes("khalti payment lookup");
      if (actionFilter === "khalti-initiate") return act.includes("khalti payment initiation");
      if (actionFilter === "khalti-callback") return act.includes("khalti payment callback");
      if (actionFilter === "transatel-callback") return act.includes("transatel network update");
      if (actionFilter === "customer-topup-lookup") return act.includes("customer esim lookup");
      if (actionFilter === "customer-topup-eligibility") return act.includes("customer top-up eligibility");
      return true;
    });
  }, [items, actionFilter]);

  const maxPage = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(total, page * pageSize);

  const stats = useMemo(() => {
    const withStatus = filteredItems.filter((item) => item.status != null);
    const ok = withStatus.filter((item) => item.status! >= 200 && item.status! < 400).length;
    return { total: filteredItems.length, ok, failed: withStatus.length - ok };
  }, [filteredItems]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length };
    for (const g of Object.keys(GROUP_LABELS) as Group[]) {
      c[g] = items.filter((item) => item.group === g).length;
    }
    return c;
  }, [items]);

  const downloadAll = () => {
    const body = filteredItems.map(serialise).join("\n\n");
    downloadTxt(`logs-${group}-${new Date().toISOString().slice(0, 10)}.txt`, body);
  };

  const copyText = (content: string) => {
    void navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <ErrorDialog error={error} onClose={() => setError("")} />

      {/* Log Details Modal */}
      <Dialog open={Boolean(inspectEntry)} onOpenChange={(open) => !open && setInspectEntry(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          {inspectEntry && (
            <>
              <DialogHeader>
                <div className="flex items-center justify-between gap-3 pr-6">
                  <DialogTitle className="text-lg font-bold">
                    Log Record Details
                  </DialogTitle>
                  {inspectEntry.statusLabel && (
                    <StatusBadge
                      label={inspectEntry.statusLabel}
                      tone={
                        inspectEntry.status != null && (inspectEntry.status < 200 || inspectEntry.status >= 400)
                          ? "danger"
                          : "success"
                      }
                    />
                  )}
                </div>
                <DialogDescription className="text-xs text-muted-foreground">
                  {activityLabel(inspectEntry)} · {new Date(inspectEntry.createdAt).toLocaleString()}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-2 text-sm">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-lg border bg-muted/30 p-3 text-xs">
                  <div>
                    <span className="text-muted-foreground block text-[11px]">Type</span>
                    <span className="font-semibold">{GROUP_LABELS[inspectEntry.group] ?? inspectEntry.group}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-[11px]">Provider / ID</span>
                    <span className="font-semibold">{inspectEntry.identifier ?? "N/A"}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-[11px]">HTTP Status</span>
                    <span className="font-semibold tabular-nums">{inspectEntry.status ?? "—"}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-[11px]">Duration</span>
                    <span className="font-semibold tabular-nums">{inspectEntry.durationMs != null ? `${inspectEntry.durationMs} ms` : "—"}</span>
                  </div>
                </div>

                {/* Serialised Log Preview */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Full Log Record Text</span>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs gap-1"
                        onClick={() => copyText(serialise(inspectEntry))}
                      >
                        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
                        {copied ? "Copied" : "Copy Log"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1"
                        onClick={() => downloadTxt(`log-${inspectEntry.group}-${inspectEntry.id}.txt`, serialise(inspectEntry))}
                      >
                        <Download className="size-3.5" />
                        Download .txt
                      </Button>
                    </div>
                  </div>
                  <pre className="p-3 rounded-lg bg-zinc-950 text-zinc-100 font-mono text-xs overflow-x-auto whitespace-pre-wrap leading-relaxed border border-zinc-800">
                    {serialise(inspectEntry)}
                  </pre>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-card">
          <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ServerCog className="size-5" />
          </span>
          <div className="leading-tight">
            <p className="text-2xl font-semibold tracking-tight tabular-nums">{counts.all}</p>
            <p className="text-xs text-muted-foreground">On this page</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-card">
          <span className="flex size-10 items-center justify-center rounded-lg bg-success-soft text-success-foreground">
            <CircleCheck className="size-5" />
          </span>
          <div className="leading-tight">
            <p className="text-2xl font-semibold tracking-tight tabular-nums">{stats.ok}</p>
            <p className="text-xs text-muted-foreground">Succeeded</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-card">
          <span className="flex size-10 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
            <CircleX className="size-5" />
          </span>
          <div className="leading-tight">
            <p className="text-2xl font-semibold tracking-tight tabular-nums">{stats.failed}</p>
            <p className="text-xs text-muted-foreground">Failed</p>
          </div>
        </div>
      </div>

      <Panel
        title="All records"
        description="Filter by category or exact action, click any row to inspect complete request/response headers & payloads."
        actions={
          <>
            <div className="w-56">
              <Select value={group} onValueChange={(v) => changeGroup(v as Group)}>
                <SelectTrigger aria-label="Filter logs by category" className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(GROUP_LABELS) as Group[]).map((g) => (
                    <SelectItem key={g} value={g}>{GROUP_LABELS[g]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-64">
              <Select value={actionFilter} onValueChange={setActionFilter}>
                <SelectTrigger aria-label="Filter logs by action" className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ACTION_FILTER_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <SearchInput
              placeholder="Search logs…"
              value={query}
              onChange={changeQuery}
              className="w-48"
            />
            <Button variant="outline" size="sm" onClick={downloadAll} disabled={!filteredItems.length}>
              <Download className="size-4" />
              Download all
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={refreshing}>
              {refreshing ? <Spinner /> : <RefreshCcw className="size-4" />}
              Refresh
            </Button>
          </>
        }
        noPadding
      >
        {loading ? (
          <EmptyState loading>
            <span className="text-sm text-muted-foreground">Loading logs…</span>
          </EmptyState>
        ) : !filteredItems.length ? (
          <EmptyState
            title="No records found"
            description="Try a different category or search term. Records appear as the system actually receives and sends messages."
          />
        ) : (
          <Table className="responsive-log-table">
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Type & Action</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredItems.map((entry) => {
                const Icon = GROUP_ICONS[entry.group];
                const failed = entry.status != null && (entry.status < 200 || entry.status >= 400);
                return (
                  <TableRow
                    key={`${entry.group}-${entry.id}`}
                    className={cn("cursor-pointer hover:bg-muted/60 transition-colors", failed && "bg-destructive/[0.03]")}
                    onClick={() => setInspectEntry(entry)}
                  >
                    <TableCell data-label="Time" className="whitespace-nowrap text-muted-foreground text-xs font-mono">
                      {new Date(entry.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell data-label="Type and action">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-1 font-semibold text-xs">
                          <Icon className="size-3.5 text-muted-foreground" />
                          {GROUP_LABELS[entry.group] ?? entry.group}
                        </span>
                        {entry.identifier && (
                          <span className="inline-flex items-center rounded-full border bg-muted/40 px-2 py-0.5 text-[10px] font-mono text-muted-foreground">
                            {entry.identifier}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs font-medium text-foreground">{activityLabel(entry)}</p>
                      {entry.detail && (
                        <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-1">{entry.detail}</p>
                      )}
                    </TableCell>
                    <TableCell data-label="Result">
                      {entry.statusLabel ? (
                        <StatusBadge
                          label={entry.statusLabel}
                          tone={
                            failed
                              ? "danger"
                              : entry.statusLabel === "SUCCESS" || entry.statusLabel === "PROCESSED" || entry.statusLabel === "ACTIVATED" || entry.statusLabel === "SUCCEEDED"
                                ? "success"
                                : entry.statusLabel === "FAILED"
                                  ? "danger"
                                  : "default"
                          }
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                      {entry.status != null && (
                        <span className="ml-2 text-xs tabular-nums text-muted-foreground">{entry.status}</span>
                      )}
                    </TableCell>
                    <TableCell data-label="Actions" className="text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 px-2 text-xs"
                          onClick={() => setInspectEntry(entry)}
                        >
                          <Eye className="size-3.5 mr-1" />
                          Inspect
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 px-2 text-xs"
                          onClick={() => downloadTxt(`log-${entry.group}-${entry.id}.txt`, serialise(entry))}
                        >
                          <Download className="size-3.5 mr-1" />
                          .txt
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {!loading && filteredItems.length > 0 && (
          <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
            <p className="text-sm tabular-nums text-muted-foreground">
              {rangeStart}–{rangeEnd} of {total} records
            </p>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                Previous
              </Button>
              <span className="px-3 text-sm tabular-nums text-muted-foreground">Page {page} of {maxPage}</span>
              <Button variant="outline" size="sm" disabled={page >= maxPage || loading} onClick={() => setPage((p) => Math.min(maxPage, p + 1))}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Panel>
    </>
  );
}
