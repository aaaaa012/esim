"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Download, RefreshCcw } from "lucide-react";
import { downloadCsv } from "@/lib/csv";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import ErrorDialog from "@/components/error-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/status-badge";
import { SearchInput } from "@/components/search-input";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { attentionActionLabel, isAttentionAction } from "@visa-compass/shared";
import { toast } from "sonner";
import { useConfirmation } from "@/components/confirmation-provider";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type Case = {
  id: string;
  orderId?: string;
  category: string;
  severity: string;
  status: string;
  summary: string;
  detail?: string;
  entityType: string;
  entityId: string;
  failureCategory?: string;
  retryCount: number;
  availableActions: string[];
  createdAt: string;
  order?: { orderNumber: string; status: string } | null;
};
export default function AttentionClient() {
  const authFetch = useAuthenticatedFetch();
  const confirm = useConfirmation();
  const [items, setItems] = useState<Case[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [status, setStatus] = useState("OPEN");
  const [category, setCategory] = useState("ALL");
  const [severity, setSeverity] = useState("ALL");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const load = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (status !== "ALL") params.set("status", status);
      if (category !== "ALL") params.set("category", category);
      if (severity !== "ALL") params.set("severity", severity);
      if (debouncedQuery) params.set("q", debouncedQuery);
      if (from)
        params.set("from", new Date(`${from}T00:00:00`).toISOString());
      if (to) params.set("to", new Date(`${to}T23:59:59.999`).toISOString());
      const response = await authFetch(
        `${API}/operations/attention?${params}`,
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(
          value.error?.message ?? "Attention queue could not be loaded",
        );
      setItems(value.data.items);
    } finally {
      setLoading(false);
    }
  }, [authFetch, category, debouncedQuery, from, severity, status, to]);
  useEffect(() => {
    void load().catch((cause) =>
      setError(cause instanceof Error ? cause.message : "Load failed"),
    );
  }, [load]);
  const action = async (item: Case, actionName: string) => {
    if (!isAttentionAction(actionName)) return;
    const label = attentionActionLabel(actionName);
    const descriptions: Record<string, string> = {
      RECHECK_PAYMENT:
        "Checks the payment provider for the latest result. It does not create a new charge.",
      RECHECK_INVENTORY:
        "Reads the eSIM's current network state and may quarantine stock that is not safe to sell.",
      RECHECK_ORDER_PROVIDER:
        "Reads Transatel's current eSIM and package state and reconciles the order. It does not submit another activation.",
      RECONCILE_RESERVATION:
        "Compares the local stock reservation with provider and order evidence before changing it.",
      RECONCILE_PROVISIONING:
        "Recovers this activation from provider evidence without blindly submitting another request.",
      RECONCILE_ORDER_PROVISIONING:
        "Finds this order's activation operation and safely reconciles its current provider result.",
      RETRY_PROVISIONING:
        "Starts another activation attempt only if the order is in a state where retry is safe.",
      RETRY_NOTIFICATION:
        "Queues the stored message again for its original recipient.",
      REPLAY_WEBHOOK:
        "Queues the stored provider update for processing again. The original event remains in the audit history.",
    };
    if (
      !(await confirm({
        title: `${label}?`,
        description:
          descriptions[actionName] ??
          "Open the related operational record and review its current state.",
        confirmLabel: label,
      }))
    )
      return;
    setBusy(item.id);
    setError("");
    try {
      const response = await authFetch(
        `${API}/operations/attention/${item.id}/action`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify({ action: actionName }),
        },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error?.message ?? "Action failed");
      const paymentStatus = value.data?.payment?.status;
      if (actionName === "RECHECK_PAYMENT" && paymentStatus === "PENDING")
        toast.info("Payment is still awaiting provider confirmation");
      else if (
        actionName === "RECHECK_PAYMENT" &&
        paymentStatus === "COMPLETED"
      )
        toast.success("Payment confirmed");
      else toast.success(`${label} completed`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed");
    } finally {
      setBusy("");
    }
  };
  const reviewHref = (item: Case, actionName: string) => {
    if (actionName === "REVIEW_MANUAL_REFUND") return "/manual-refunds";
    if (actionName === "REVIEW_FINANCIAL_DISPUTE" && item.orderId)
      return `/orders/${item.orderId}`;
    return null;
  };
  return (
    <div className="space-y-6">
      <PageHeader
        title="Attention queue"
        description="Recoverable technical and integration cases that need safe operational action."
        actions={
          <Button variant="outline" onClick={() => void load()}>
            <RefreshCcw className="size-4" />
            Refresh
          </Button>
        }
      />
      <ErrorDialog error={error} onClose={() => setError("")} />
      <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(14rem,1fr)_repeat(3,minmax(9rem,12rem))_repeat(2,minmax(9rem,11rem))]">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search cases, orders or failures…"
          className="w-full"
        />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger aria-label="Filter by case status" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All states</SelectItem>
            <SelectItem value="OPEN">Open</SelectItem>
            <SelectItem value="RESOLVED">Resolved</SelectItem>
          </SelectContent>
        </Select>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger aria-label="Filter by category" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All categories</SelectItem>
            <SelectItem value="PAYMENT_SECURITY">Payment security</SelectItem>
            <SelectItem value="PAYMENT_UNCERTAIN">Payment confirmation</SelectItem>
            <SelectItem value="PAYMENT_DISPUTE">Payment dispute</SelectItem>
            <SelectItem value="PAYMENT_REFUND_REVIEW">Payment refund review</SelectItem>
            <SelectItem value="INVENTORY_MISMATCH">Inventory mismatch</SelectItem>
            <SelectItem value="INVENTORY_ASSIGNMENT_CONFLICT">Inventory assignment</SelectItem>
            <SelectItem value="INVENTORY_RESERVATION_STALE">Stale reservation</SelectItem>
            <SelectItem value="INVENTORY_SHORTAGE">Inventory shortage</SelectItem>
            <SelectItem value="PROVISIONING_ATTENTION">Provisioning</SelectItem>
            <SelectItem value="DOCUMENT_MANUAL_REVIEW">Document review</SelectItem>
            <SelectItem value="DOCUMENT_REUPLOAD">Document re-upload</SelectItem>
            <SelectItem value="SUBSCRIPTION_ASSIGNMENT_CONFLICT">Subscription assignment</SelectItem>
            <SelectItem value="WEBHOOK_DEAD_LETTER">Webhook delivery</SelectItem>
            <SelectItem value="NOTIFICATION_FAILED">Notification delivery</SelectItem>
            <SelectItem value="RECONCILIATION">Reconciliation</SelectItem>
          </SelectContent>
        </Select>
        <Select value={severity} onValueChange={setSeverity}>
          <SelectTrigger aria-label="Filter by severity" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All severities</SelectItem>
            <SelectItem value="CRITICAL">Critical</SelectItem>
            <SelectItem value="WARNING">Warning</SelectItem>
            <SelectItem value="INFO">Information</SelectItem>
          </SelectContent>
        </Select>
        <label className="grid gap-1 text-xs text-muted-foreground">
          From
          <Input
            type="date"
            aria-label="Cases created from"
            value={from}
            max={to || undefined}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Through
          <Input
            type="date"
            aria-label="Cases created through"
            value={to}
            min={from || undefined}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
      </div>
      <Panel
        title={status === "OPEN" ? "Open cases" : "Attention cases"}
        description={`${items.length} case(s) shown, newest first`}
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={!items.length}
            onClick={() =>
              downloadCsv(
                `attention-cases-${new Date().toISOString().slice(0, 10)}.csv`,
                [
                  "Created",
                  "Severity",
                  "Category",
                  "Summary",
                  "Order",
                  "Status",
                  "Failure category",
                  "Retry count",
                  "Available actions",
                ],
                items.map((item) => [
                  item.createdAt,
                  item.severity,
                  item.category,
                  item.summary,
                  item.order?.orderNumber,
                  item.status,
                  item.failureCategory,
                  item.retryCount,
                  item.availableActions.join(" | "),
                ]),
              )
            }
          >
            <Download className="size-4" />
            Export CSV
          </Button>
        }
      >
        {loading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            Loading open cases...
          </div>
        ) : !items.length ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            No open attention cases.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Case</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Failure</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 size-4 text-amber-600" />
                      <div>
                        <div className="font-medium">{item.summary}</div>
                        <div className="text-xs text-muted-foreground">
                          {item.category} |{" "}
                          {new Date(item.createdAt).toLocaleString()}
                        </div>
                        {item.detail && (
                          <div className="mt-1 max-w-xl text-xs text-muted-foreground">
                            {item.detail}
                          </div>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    {item.order ? (
                      <Link
                        className="underline"
                        href={`/orders/${item.orderId}`}
                      >
                        {item.order.orderNumber}
                      </Link>
                    ) : (
                      item.entityId
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge label={item.status} />
                  </TableCell>
                  <TableCell>
                    {item.failureCategory ?? "-"}
                    <div className="text-xs text-muted-foreground">
                      Retries: {item.retryCount}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      {item.availableActions
                        .filter(isAttentionAction)
                        .map((name) => {
                          const href = reviewHref(item, name);
                          return href ? (
                            <Button
                              key={name}
                              size="sm"
                              variant="outline"
                              asChild
                            >
                              <Link href={href} prefetch={false}>
                                {attentionActionLabel(name)}
                              </Link>
                            </Button>
                          ) : (
                            <Button
                              key={name}
                              size="sm"
                              variant="outline"
                              disabled={busy === item.id}
                              onClick={() => void action(item, name)}
                            >
                              {attentionActionLabel(name)}
                            </Button>
                          );
                        })}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </div>
  );
}
