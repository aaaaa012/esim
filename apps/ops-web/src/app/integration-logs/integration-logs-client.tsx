"use client";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleCheck,
  CircleX,
  Download,
  History,
  RefreshCcw,
  Timer,
  Zap,
} from "lucide-react";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { Spinner } from "@/components/spinner";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const headers = {};
type Log = {
  id: string;
  operation: string;
  method: string;
  endpoint: string;
  status: number;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  correlationId?: string;
  requestBody?: unknown;
  responseBody?: unknown;
  createdAt: string;
};

type LogContext = {
  caller: string;
  order?: string;
  job?: string;
};

const objectValue = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const findLogValue = (
  value: unknown,
  keys: string[],
  depth = 0,
): string | undefined => {
  if (depth > 5) return undefined;
  const record = objectValue(value);
  if (!record) return undefined;
  for (const key of keys) {
    const found = record[key];
    if (["string", "number"].includes(typeof found)) return String(found);
  }
  for (const child of Object.values(record)) {
    const found = findLogValue(child, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
};

const logContext = (log: Log): LogContext => {
  const partnerCode = findLogValue(log.requestBody, ["partnerCode"]);
  const order = findLogValue(log.requestBody, [
    "orderNumber",
    "orderId",
    "orderReference",
    "merchantTxnId",
    "purchase_order_id",
  ]);
  const job = findLogValue(log.requestBody, ["jobName", "jobId", "queue"]);
  const operation = log.operation.toLowerCase();
  const caller = partnerCode
    ? `Partner API · ${partnerCode}`
    : operation === "partner-api"
      ? "Partner API"
      : operation.startsWith("customer-")
        ? "Customer web"
        : job
          ? `Background job · ${job}`
          : "Visa Compass backend";
  return {
    caller,
    ...(order ? { order } : {}),
    ...(job ? { job } : {}),
  };
};

const OK = (status: number) => status >= 200 && status < 400;

export default function IntegrationLogsClient() {
  const authFetch = useAuthenticatedFetch();
  const [items, setItems] = useState<Log[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [operation, setOperation] = useState("ALL");
  const [query, setQuery] = useState("");
  const [oldestFirst, setOldestFirst] = useState(false);
  const [selected, setSelected] = useState<Log | null>(null);

  const load = (refreshOnly = false) => {
    if (refreshOnly) setRefreshing(true);
    else setLoading(true);
    return authFetch(`${API}/operations/integration-logs`, { headers })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok)
          throw new Error(value.error?.message ?? "Could not load logs");
        setItems(value.data ?? []);
        setError("");
      })
      .catch((cause) => setError(cause.message))
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  };
  useEffect(() => {
    void load();
  }, []);

  const operations = useMemo(
    () => Array.from(new Set(items.map((item) => item.operation))).sort(),
    [items],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const visible = items
    .filter((item) => {
      const context = logContext(item);
      return (
        (operation === "ALL" || item.operation === operation) &&
        (!normalizedQuery ||
          [
            item.correlationId,
            item.operation,
            item.method,
            item.endpoint,
            item.errorCode,
            item.errorMessage,
            context.caller,
            context.order,
            context.job,
          ].some((value) => value?.toLowerCase().includes(normalizedQuery)))
      );
    })
    .sort((left, right) => {
      const difference =
        new Date(left.createdAt).getTime() -
        new Date(right.createdAt).getTime();
      return oldestFirst ? difference : -difference;
    });
  const stats = useMemo(() => {
    const ok = items.filter((item) => OK(item.status)).length;
    return { total: items.length, ok, failed: items.length - ok };
  }, [items]);

  const downloadTxt = () => {
    const lines = visible.map((log) =>
      [
        `[${new Date(log.createdAt).toISOString()}]`,
        log.method,
        log.endpoint,
        `=> ${log.status}`,
        log.correlationId ? `correlation=${log.correlationId}` : "",
        log.durationMs != null ? `(${log.durationMs}ms)` : "( - ms)",
        log.errorMessage ?? log.errorCode ?? "",
      ]
        .filter(Boolean)
        .join(" "),
    );
    const body = [
      `Visa Compass — Integration log (${new Date().toISOString()})`,
      `Rows: ${visible.length} · Succeeded: ${visible.filter((l) => OK(l.status)).length} · Failed: ${visible.filter((l) => !OK(l.status)).length}`,
      "=".repeat(78),
      "",
      ...lines,
    ].join("\n");
    const url = URL.createObjectURL(
      new Blob([body], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `integration-logs-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <ErrorDialog error={error} onClose={() => setError("")} />
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <DialogContent className="max-h-[90dvh] w-[min(94vw,760px)] max-w-none overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Technical request details</DialogTitle>
            <DialogDescription>
              Redacted request and response data for technical troubleshooting.
              Customer-facing screens never display this content.
            </DialogDescription>
          </DialogHeader>
          {selected ? (
            <div className="grid min-w-0 gap-4 text-sm">
              <div className="grid gap-2 rounded-lg bg-muted/50 p-3 sm:grid-cols-2">
                <span>
                  <b>Request:</b> {selected.method} {selected.endpoint}
                </span>
                <span>
                  <b>Result:</b> HTTP {selected.status} ·{" "}
                  {selected.durationMs ?? "—"} ms
                </span>
                <span>
                  <b>Caller:</b> {logContext(selected).caller}
                </span>
                <span>
                  <b>Order:</b> {logContext(selected).order ?? "Not recorded"}
                </span>
                <span className="min-w-0 break-all sm:col-span-2">
                  <b>Correlation:</b> {selected.correlationId ?? "Not recorded"}
                </span>
              </div>
              <section className="min-w-0">
                <h3 className="mb-2 font-semibold">Redacted request</h3>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-950 p-3 text-xs text-slate-100">
                  {JSON.stringify(selected.requestBody ?? null, null, 2)}
                </pre>
              </section>
              <section className="min-w-0">
                <h3 className="mb-2 font-semibold">Redacted response</h3>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-950 p-3 text-xs text-slate-100">
                  {JSON.stringify(selected.responseBody ?? null, null, 2)}
                </pre>
              </section>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-card">
          <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Zap className="size-5" />
          </span>
          <div className="leading-tight">
            <p className="text-2xl font-semibold tracking-tight tabular-nums">
              {stats.total}
            </p>
            <p className="text-xs text-muted-foreground">Requests</p>
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
        title="Technical record"
        description={`The most recent 200 requests`}
        actions={
          <>
            <input
              className="h-9 w-64 rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Order, reference, endpoint or error"
              aria-label="Search integration logs"
            />
            <div className="w-52">
              <Select value={operation} onValueChange={setOperation}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All operations</SelectItem>
                  {operations.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOldestFirst((current) => !current)}
              title="Change the chronological order of the displayed calls"
            >
              {oldestFirst ? "Oldest first" : "Newest first"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={downloadTxt}
              disabled={!visible.length}
            >
              <Download className="size-4" />
              Download .txt
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
            <span className="text-sm text-muted-foreground">
              Loading activity…
            </span>
          </EmptyState>
        ) : !visible.length ? (
          <EmptyState
            title="No requests recorded yet"
            description="This technical record is for troubleshooting with our technical team."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Operation</TableHead>
                <TableHead>Caller / order</TableHead>
                <TableHead>Correlation trace</TableHead>
                <TableHead>Request</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Error</TableHead>
                <TableHead className="text-right">Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((log) => (
                <TableRow
                  key={log.id}
                  className={cn(!OK(log.status) && "bg-destructive/[0.03]")}
                >
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {new Date(log.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      {OK(log.status) ? (
                        <ArrowUpFromLine className="size-3.5 text-success" />
                      ) : (
                        <ArrowDownToLine className="size-3.5 text-destructive" />
                      )}
                      {log.operation}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-[190px] text-xs">
                    <span className="font-medium">
                      {logContext(log).caller}
                    </span>
                    {logContext(log).order ? (
                      <span className="mt-1 block break-all font-mono text-muted-foreground">
                        {logContext(log).order}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-[180px] break-all font-mono text-xs text-muted-foreground">
                    {log.correlationId ?? "—"}
                  </TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-semibold">
                      {log.method}
                    </code>{" "}
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {log.endpoint}
                    </code>
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      label={OK(log.status) ? "SUCCESS" : "FAILED"}
                      tone={OK(log.status) ? "success" : "danger"}
                    />
                    <span className="ml-2 text-xs tabular-nums text-muted-foreground">
                      {log.status}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <Timer className="size-3.5" />
                      {log.durationMs != null ? `${log.durationMs}ms` : "—"}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-[220px] text-xs text-muted-foreground">
                    {log.errorMessage ? (
                      <span className="text-destructive">
                        {log.errorMessage}
                      </span>
                    ) : log.errorCode ? (
                      <span className="text-destructive">{log.errorCode}</span>
                    ) : (
                      <History className="size-4 text-muted-foreground/50" />
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setSelected(log)}
                    >
                      View details
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </>
  );
}
