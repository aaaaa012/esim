"use client";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  CircleCheck,
  CircleX,
  ClipboardList,
  Download,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

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
  all: "All",
  provider: "Outgoing",
  incoming: "Incoming",
  orders: "Orders",
  staff: "Staff",
};

const GROUP_ICONS: Record<Group, typeof ServerCog> = {
  all: ServerCog,
  provider: Network,
  incoming: ArrowDownToLine,
  orders: ClipboardList,
  staff: History,
};

function dump(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function serialise(entry: LogEntry): string {
  const lines: string[] = [];
  lines.push("Visa Compass - Log record");
  lines.push("=".repeat(78));
  lines.push(`When:     ${new Date(entry.createdAt).toLocaleString()}`);
  lines.push(`Type:     ${GROUP_LABELS[entry.group]}`);
  if (entry.identifier) lines.push(`Provider: ${entry.identifier}`);
  lines.push(`Action:   ${entry.title}`);
  lines.push(`Details:  ${entry.detail}`);
  if (entry.status != null) lines.push(`Status:   ${entry.status}`);
  if (entry.statusLabel) lines.push(`Result:   ${entry.statusLabel}`);
  if (entry.durationMs != null) lines.push(`Duration: ${entry.durationMs} ms`);
  if (entry.error) lines.push(`Error:    ${entry.error}`);
  if (entry.requestBody !== undefined && entry.requestBody !== null) {
    lines.push("");
    lines.push("--- REQUEST ---");
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
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/plain;charset=utf-8" }),
  );
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
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
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
      return authFetch(`${API}/operations/logs?${params.toString()}`, {
        headers,
      })
        .then(async (response) => {
          const value = await response.json();
          if (!response.ok)
            throw new Error(value.error?.message ?? "Could not load logs");
          setItems(value.data?.items ?? []);
          setTotal(value.data?.total ?? 0);
          setError("");
        })
        .catch((cause: unknown) =>
          setError(
            cause instanceof Error ? cause.message : "Could not load logs",
          ),
        )
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

  const maxPage = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(total, page * pageSize);

  const stats = useMemo(() => {
    const withStatus = items.filter((item) => item.status != null);
    const ok = withStatus.filter(
      (item) => item.status! >= 200 && item.status! < 400,
    ).length;
    return { total: items.length, ok, failed: withStatus.length - ok };
  }, [items]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length };
    for (const g of Object.keys(GROUP_LABELS) as Group[]) {
      c[g] = items.filter((item) => item.group === g).length;
    }
    return c;
  }, [items]);

  const downloadAll = () => {
    const body = items.map(serialise).join("\n\n");
    downloadTxt(
      `logs-${group}-${new Date().toISOString().slice(0, 10)}.txt`,
      body,
    );
  };

  return (
    <>
      <ErrorDialog error={error} onClose={() => setError("")} />
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-card">
          <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ServerCog className="size-5" />
          </span>
          <div className="leading-tight">
            <p className="text-2xl font-semibold tracking-tight tabular-nums">
              {counts.all}
            </p>
            <p className="text-xs text-muted-foreground">On this page</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-card">
          <span className="flex size-10 items-center justify-center rounded-lg bg-success-soft text-success-foreground">
            <CircleCheck className="size-5" />
          </span>
          <div className="leading-tight">
            <p className="text-2xl font-semibold tracking-tight tabular-nums">
              {stats.ok}
            </p>
            <p className="text-xs text-muted-foreground">Succeeded</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-card">
          <span className="flex size-10 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
            <CircleX className="size-5" />
          </span>
          <div className="leading-tight">
            <p className="text-2xl font-semibold tracking-tight tabular-nums">
              {stats.failed}
            </p>
            <p className="text-xs text-muted-foreground">Failed</p>
          </div>
        </div>
      </div>

      <Panel
        title="All records"
        description="Filter by category or search, then download any record as a text file. The latest records are shown first."
        actions={
          <>
            <div className="w-64">
              <Select
                value={group}
                onValueChange={(v) => changeGroup(v as Group)}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(GROUP_LABELS) as Group[]).map((g) => (
                    <SelectItem key={g} value={g}>
                      {GROUP_LABELS[g]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <SearchInput
              placeholder="Search logs…"
              value={query}
              onChange={changeQuery}
              className="w-56"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={downloadAll}
              disabled={!items.length}
            >
              <Download className="size-4" />
              Download all
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load(true)}
              disabled={refreshing}
            >
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
        ) : !items.length ? (
          <EmptyState
            title="No records found"
            description="Try a different category or search term. Records appear as the system actually receives and sends messages."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="text-right">Download</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((entry) => {
                const Icon = GROUP_ICONS[entry.group];
                const failed =
                  entry.status != null &&
                  (entry.status < 200 || entry.status >= 400);
                return (
                  <TableRow
                    key={`${entry.group}-${entry.id}`}
                    className={cn(failed && "bg-destructive/[0.03]")}
                  >
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {new Date(entry.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 font-medium">
                        <Icon className="size-3.5 text-muted-foreground" />
                        {GROUP_LABELS[entry.group]}
                      </span>
                      {entry.identifier && (
                        <span className="ml-2 inline-flex items-center rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                          {entry.identifier}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {entry.statusLabel ? (
                        <StatusBadge
                          label={entry.statusLabel}
                          tone={
                            failed
                              ? "danger"
                              : entry.statusLabel === "SUCCESS" ||
                                  entry.statusLabel === "PROCESSED" ||
                                  entry.statusLabel === "ACTIVATED" ||
                                  entry.statusLabel === "SUCCEEDED"
                                ? "success"
                                : entry.statusLabel === "FAILED"
                                  ? "danger"
                                  : "default"
                          }
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Not recorded
                        </span>
                      )}
                      {entry.status != null && (
                        <span className="ml-2 text-xs tabular-nums text-muted-foreground">
                          {entry.status}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          downloadTxt(
                            `log-${entry.group}-${entry.id}.txt`,
                            serialise(entry),
                          )
                        }
                      >
                        <Download className="size-3.5" />
                        .txt
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {!loading && items.length > 0 && (
          <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
            <p className="text-sm tabular-nums text-muted-foreground">
              {rangeStart}-{rangeEnd} of {total} records
            </p>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <span className="px-3 text-sm tabular-nums text-muted-foreground">
                Page {page} of {maxPage}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= maxPage || loading}
                onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Panel>
    </>
  );
}
