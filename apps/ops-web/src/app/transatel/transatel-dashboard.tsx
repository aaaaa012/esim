"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  Database,
  Download,
  RefreshCcw,
  RadioTower,
  ShieldAlert,
  XCircle,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import {
  LifecycleActions,
  type LifecycleCompletion,
} from "./lifecycle-actions";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";
import ErrorDialog from "@/components/error-dialog";
import { operationalIssue } from "@/lib/operational-issue";
import { Spinner } from "@/components/spinner";
import { SearchInput } from "@/components/search-input";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { downloadCsv } from "@/lib/csv";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type Subscriber = {
  orderId: string;
  orderNumber: string;
  ownerId: string;
  customer: string;
  email: string;
  iccid: string;
  msisdn?: string | null;
  providerSubscriptionId: string;
  status: string;
  providerStatus?: string | null;
  plan: string;
  usedMb: number;
  totalMb: number;
  remainingMb: number;
  usageLastCheckedAt?: string | null;
  expiresAt?: string | null;
};
type Inventory = {
  id: string;
  iccid: string;
  msisdn?: string | null;
  status: string;
  providerStatus?: string | null;
  lastProviderCheckedAt?: string | null;
  providerCheckError?: string | null;
  quarantineReason?: string | null;
  batchReference: string;
};
type Failure = {
  id: string;
  operation: string;
  endpoint: string;
  status: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt: string;
};
type LifecycleOperation = {
  id: string;
  orderNumber: string;
  action: string;
  state: string;
  reason: string;
  actor: string;
  requesterId: string;
  approvedBy?: string | null;
  approvedAt?: string | null;
  providerTransactionId?: string | null;
  errorMessage?: string | null;
  createdAt: string;
};
type Dashboard = {
  currentActorId?: string | null;
  health: {
    ok: boolean;
    configured?: boolean;
    authenticated?: boolean;
    circuit?: string;
    lastSuccessAt?: string | null;
    error?: string;
  };
  persistence: string;
  counts: {
    available: number;
    quarantined: number;
    activeSubscriptions: number;
    suspended: number;
    provisioningAttention: number;
    webhookDeadLetters: number;
  };
  subscribers: Subscriber[];
  inventory: Inventory[];
  failures: Failure[];
  lifecycleOperations: LifecycleOperation[];
};
type SearchScope = "subscribers" | "inventory" | "actions";
const formatDate = (value?: string | null) =>
  value ? new Date(value).toLocaleString() : "Never";

export function lifecycleApprovalMessage(
  operation: Pick<LifecycleOperation, "state" | "requesterId">,
  currentActorId?: string | null,
) {
  if (operation.state !== "APPROVAL_REQUIRED") return null;
  return operation.requesterId === currentActorId
    ? "Request sent · awaiting another Super Admin"
    : "Awaiting another Super Admin";
}

export default function TransatelDashboard() {
  const authFetch = useAuthenticatedFetch();
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [rejection, setRejection] = useState<LifecycleOperation | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [busy, setBusy] = useState("");
  const [canTerminate, setCanTerminate] = useState(false);
  const [activeTab, setActiveTab] = useState<SearchScope>("subscribers");
  const [searches, setSearches] = useState<Record<SearchScope, string>>({
    subscribers: "",
    inventory: "",
    actions: "",
  });
  const [searchRequest, setSearchRequest] = useState<{
    scope: SearchScope;
    q: string;
  }>({ scope: "subscribers", q: "" });
  const loadSequence = useRef(0);
  const [diagnostics, setDiagnostics] = useState<{
    checks: Array<{
      operation: string;
      status: string;
      durationMs?: number | null;
      checkedAt?: string | null;
    }>;
    webhook: {
      configured: boolean;
      lastReceivedAt?: string | null;
      deadLetters: number;
    };
  } | null>(null);
  const load = useCallback(async () => {
    const requestId = ++loadSequence.current;
    setError("");
    try {
      const params = new URLSearchParams({ scope: searchRequest.scope });
      if (searchRequest.q) params.set("q", searchRequest.q);
      const dashboardResponse = await authFetch(
        `${API}/operations/transatel?${params}`,
      );
      const dashboardValue = await dashboardResponse.json();
      if (!dashboardResponse.ok)
        throw new Error(
          dashboardValue.error?.message ??
            "Transatel dashboard could not be loaded",
        );
      if (requestId === loadSequence.current) setData(dashboardValue.data);
    } catch (cause) {
      if (requestId === loadSequence.current)
        setError(
          cause instanceof Error ? cause.message : "Dashboard load failed",
        );
    }
  }, [authFetch, searchRequest]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void authFetch(`${API}/auth/me`)
      .then((response) => response.json())
      .then((value) =>
        setCanTerminate(value.data?.accountType === "SUPER_ADMIN"),
      )
      .catch(() => undefined);
  }, [authFetch]);
  useEffect(() => {
    const timer = window.setTimeout(
      () =>
        setSearchRequest({ scope: activeTab, q: searches[activeTab].trim() }),
      300,
    );
    return () => window.clearTimeout(timer);
  }, [activeTab, searches]);
  const searchControl = (scope: SearchScope, placeholder: string) => (
    <SearchInput
      value={searches[scope]}
      onChange={(value) =>
        setSearches((current) => ({ ...current, [scope]: value }))
      }
      placeholder={placeholder}
      className="w-full sm:w-80"
    />
  );
  const lifecycleCompleted = (completion: LifecycleCompletion) => {
    if (completion.action === "reactivate-request") {
      setActiveTab("actions");
      setSearchRequest({ scope: "actions", q: "" });
    }
    void load();
  };
  const reconcile = async (profile: Inventory) => {
    setBusy(profile.id);
    try {
      const response = await authFetch(
        `${API}/operations/inventory/profiles/${profile.id}/reconcile`,
        { method: "POST", headers: {} },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error?.message ?? "Reconciliation failed");
      toast.success(`Network status refreshed for ${profile.iccid}`);
      await load();
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "Reconciliation failed",
      );
    } finally {
      setBusy("");
    }
  };
  const releaseToStock = async (profile: Inventory) => {
    setBusy(profile.id);
    try {
      const response = await authFetch(
        `${API}/operations/inventory/profiles/${profile.id}/restore-availability`,
        { method: "POST", headers: {} },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error?.message ?? "Release failed");
      toast.success(`${profile.iccid} released back to stock`);
      await load();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Release failed");
    } finally {
      setBusy("");
    }
  };
  const refreshUsage = async (subscriber: Subscriber) => {
    setBusy(subscriber.orderId);
    try {
      const response = await authFetch(
        `${API}/operations/orders/${subscriber.orderId}/usage/refresh`,
        { method: "POST", headers: {} },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error?.message ?? "Usage refresh failed");
      toast.success(`${subscriber.orderNumber} usage refreshed`);
      await load();
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "Usage refresh failed",
      );
    } finally {
      setBusy("");
    }
  };
  const runDiagnostics = async () => {
    setBusy("diagnostics");
    try {
      const response = await authFetch(
        `${API}/operations/transatel/diagnostics`,
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error?.message ?? "Diagnostics failed");
      setDiagnostics(value.data);
      toast.success("Connectivity diagnostics refreshed");
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "Diagnostics failed",
      );
    } finally {
      setBusy("");
    }
  };
  const metrics: Array<{
    label: string;
    value: string | number;
    icon: LucideIcon;
  }> = data
    ? [
        {
          label: "Network",
          value: data.health.ok ? "Healthy" : "Attention",
          icon: RadioTower,
        },
        { label: "Available stock", value: data.counts.available, icon: Boxes },
        {
          label: "Flagged eSIMs",
          value: data.counts.quarantined,
          icon: ShieldAlert,
        },
        {
          label: "Active plans",
          value: data.counts.activeSubscriptions,
          icon: Wifi,
        },
        {
          label: "Set-ups needing attention",
          value: data.counts.provisioningAttention,
          icon: AlertTriangle,
        },
        {
          label: "Webhook dead letters",
          value: data.counts.webhookDeadLetters,
          icon: Database,
        },
      ]
    : [];

  const syncUsage = async () => {
    setBusy("sync-usage");
    try {
      const response = await authFetch(
        `${API}/operations/transatel/sync-usage`,
        { method: "POST" },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error?.message ?? "Usage sync failed");
      const synced = Number(value.data?.synced ?? 0);
      const failed = Number(value.data?.failed ?? 0);
      if (failed > 0) {
        toast.warning(
          `Usage sync finished: ${synced} eSIMs updated, ${failed} need attention`,
        );
      } else {
        toast.success(`Usage sync finished: ${synced} eSIMs updated`);
      }
      await load();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Usage sync failed");
    } finally {
      setBusy("");
    }
  };

  const refreshDashboard = async () => {
    setBusy("refresh-dashboard");
    try {
      await load();
      toast.success("Saved dashboard data reloaded");
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "Dashboard refresh failed",
      );
    } finally {
      setBusy("");
    }
  };

  const approveReactivation = async (operation: LifecycleOperation) => {
    setBusy(`approve:${operation.id}`);
    try {
      const response = await authFetch(
        `${API}/operations/transatel/reactivations/${operation.id}/approve`,
        {
          method: "POST",
          headers: { "x-idempotency-key": crypto.randomUUID() },
        },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error?.message ?? "Reactivation approval failed");
      toast.success("Reactivation approved and sent to the network");
      await load();
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "Reactivation approval failed",
      );
    } finally {
      setBusy("");
    }
  };

  const rejectReactivation = async () => {
    if (!rejection || rejectionReason.trim().length < 5) return;
    setBusy(`reject:${rejection.id}`);
    try {
      const response = await authFetch(
        `${API}/operations/transatel/reactivations/${rejection.id}/reject`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify({ reason: rejectionReason.trim() }),
        },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(
          value.error?.message ?? "Reactivation rejection failed",
        );
      toast.success("Reactivation request rejected");
      setRejection(null);
      setRejectionReason("");
      await load();
    } catch (cause) {
      toast.error(
        cause instanceof Error
          ? cause.message
          : "Reactivation rejection failed",
      );
    } finally {
      setBusy("");
    }
  };

  const exportCurrentView = () => {
    if (!data) return;
    const date = new Date().toISOString().slice(0, 10);
    if (activeTab === "subscribers") {
      downloadCsv(
        `transatel-customer-plans-${date}.csv`,
        [
          "Customer",
          "Email",
          "Order",
          "ICCID / SIM serial",
          "MSISDN",
          "Plan",
          "Remaining MB",
          "Used MB",
          "Total MB",
          "eSIM status",
          "Package status",
          "Subscription ID",
          "Usage checked at",
          "Expires at",
        ],
        data.subscribers.map((row) => [
          row.customer,
          row.email,
          row.orderNumber,
          row.iccid,
          row.msisdn,
          row.plan,
          row.remainingMb,
          row.usedMb,
          row.totalMb,
          row.providerStatus,
          row.status,
          row.providerSubscriptionId,
          row.usageLastCheckedAt,
          row.expiresAt,
        ]),
      );
      return;
    }
    if (activeTab === "inventory") {
      downloadCsv(
        `transatel-unassigned-esims-${date}.csv`,
        [
          "ICCID / SIM serial",
          "MSISDN",
          "Batch",
          "Local status",
          "Network status",
          "Last checked",
          "Issue",
        ],
        data.inventory.map((row) => [
          row.iccid,
          row.msisdn,
          row.batchReference,
          row.status,
          row.providerStatus,
          row.lastProviderCheckedAt,
          row.quarantineReason ?? row.providerCheckError,
        ]),
      );
      return;
    }
    downloadCsv(
      `transatel-lifecycle-actions-${date}.csv`,
      [
        "Time",
        "Order",
        "Action",
        "State",
        "Actor",
        "Reason",
        "Provider reference",
        "Error",
      ],
      data.lifecycleOperations.map((row) => [
        row.createdAt,
        row.orderNumber,
        row.action,
        row.state,
        row.actor,
        row.reason,
        row.providerTransactionId,
        row.errorMessage,
      ]),
    );
  };

  return (
    <>
      <PageHeader
        title="Provider status"
        description="See the network status, customer plans, stock checks and any issues needing your attention."
        badge={
          data ? (
            <StatusBadge
              label={data.health.ok ? "CONNECTED" : "ATTENTION"}
              tone={data.health.ok ? "success" : "warning"}
            />
          ) : undefined
        }
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={busy === "sync-usage"}
              onClick={() => void syncUsage()}
            >
              {busy === "sync-usage" ? (
                <Spinner />
              ) : (
                <RefreshCcw className="size-4" />
              )}
              Sync usage
            </Button>
            <Button
              variant="outline"
              disabled={busy === "diagnostics"}
              onClick={() => void runDiagnostics()}
            >
              {busy === "diagnostics" ? (
                <Spinner />
              ) : (
                <Database className="size-4" />
              )}
              Check integration health
            </Button>
            <Button
              variant="outline"
              disabled={busy === "refresh-dashboard"}
              onClick={() => void refreshDashboard()}
            >
              {busy === "refresh-dashboard" ? (
                <Spinner />
              ) : (
                <RefreshCcw className="size-4" />
              )}
              {busy === "refresh-dashboard"
                ? "Reloading…"
                : "Reload saved data"}
            </Button>
          </div>
        }
      />
      <ErrorDialog error={error} onClose={() => setError("")} />
      {!data && !error ? (
        <div className="flex h-48 items-center justify-center">
          <Spinner />
        </div>
      ) : null}
      {data ? (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
            {metrics.map(({ label, value, icon: Icon }) => (
              <div key={label} className="rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{label}</span>
                  <Icon className="size-4" />
                </div>
                <p className="mt-2 text-2xl font-semibold">{String(value)}</p>
              </div>
            ))}
          </div>
          <Panel
            className="mb-6"
            title="Connection to the network"
            description="Whether the network provider connection is working"
          >
            <div className="grid gap-4 text-sm sm:grid-cols-4">
              <div>
                <p className="text-muted-foreground">Set up</p>
                <p className="font-medium">
                  {data.health.configured ? "Yes" : "No"}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Connected</p>
                <p className="font-medium">
                  {data.health.authenticated ? "Yes" : "No"}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Protection</p>
                <p className="font-medium">
                  {data.health.circuit ?? "Unknown"}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Last successful check</p>
                <p className="font-medium">
                  {formatDate(data.health.lastSuccessAt)}
                </p>
              </div>
            </div>
            {diagnostics ? (
              <div className="mt-5 border-t pt-4">
                <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
                  {diagnostics.checks.map((check) => (
                    <div
                      key={check.operation}
                      className="rounded-lg border p-2 text-xs"
                    >
                      <div className="flex justify-between gap-2">
                        <b>{check.operation}</b>
                        <StatusBadge
                          label={check.status}
                          tone={check.status === "PASS" ? "success" : "warning"}
                        />
                      </div>
                      <p className="mt-1 text-muted-foreground">
                        {check.durationMs ?? "—"} ms ·{" "}
                        {formatDate(check.checkedAt)}
                      </p>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Automatic notifications:{" "}
                  {diagnostics.webhook.configured ? "Yes" : "No"} · Last
                  received: {formatDate(diagnostics.webhook.lastReceivedAt)} ·
                  Missed notifications: {diagnostics.webhook.deadLetters}
                </p>
              </div>
            ) : null}
          </Panel>
          <Tabs
            value={activeTab}
            onValueChange={(value) => setActiveTab(value as SearchScope)}
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Exports contain the currently displayed section and applied
                search.
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={!data}
                onClick={exportCurrentView}
              >
                <Download className="size-4" /> Export current section
              </Button>
            </div>
            <TabsList>
              <TabsTrigger value="subscribers">Customer plans</TabsTrigger>
              <TabsTrigger value="inventory">Unassigned eSIMs</TabsTrigger>
              <TabsTrigger value="actions">
                Mobile data pause and eSIM closure history
              </TabsTrigger>
            </TabsList>
            <TabsContent value="subscribers" className="mt-4">
              <Panel
                title="Customer plans"
                description="Balances and plan controls"
                actions={searchControl(
                  "subscribers",
                  "Search customer, order, ICCID or plan…",
                )}
                noPadding
              >
                {data.subscribers.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Customer / Order</TableHead>
                        <TableHead>SIM identifiers</TableHead>
                        <TableHead>Plan</TableHead>
                        <TableHead>Balance</TableHead>
                        <TableHead>Network status / Subscription</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.subscribers.map((row) => (
                        <TableRow key={row.providerSubscriptionId}>
                          <TableCell>
                            <p className="font-medium">{row.customer}</p>
                            <p className="text-xs text-muted-foreground">
                              {row.orderNumber} · {row.email}
                            </p>
                          </TableCell>
                          <TableCell>
                            <p className="text-[11px] text-muted-foreground">
                              ICCID / SIM serial
                            </p>
                            <code className="text-xs">{row.iccid}</code>
                            <p className="text-xs text-muted-foreground">
                              MSISDN: {row.msisdn ?? "Not assigned"}
                            </p>
                          </TableCell>
                          <TableCell>
                            {row.plan}
                            <p className="text-xs text-muted-foreground">
                              Expires {formatDate(row.expiresAt)}
                            </p>
                          </TableCell>
                          <TableCell>
                            {row.usageLastCheckedAt ? (
                              <>
                                <p className="font-medium">
                                  {row.status === "EXPIRED"
                                    ? `${row.totalMb.toLocaleString()} MB allowance`
                                    : `${row.remainingMb.toLocaleString()} MB left`}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {row.status === "EXPIRED"
                                    ? "Plan expired"
                                    : `${row.usedMb.toLocaleString()} / ${row.totalMb.toLocaleString()} MB used`}
                                </p>
                              </>
                            ) : (
                              <p className="text-xs text-muted-foreground">
                                Usage not available yet
                              </p>
                            )}
                            <Button
                              className="mt-1 h-7 px-2 text-xs"
                              variant="ghost"
                              disabled={busy === row.orderId}
                              onClick={() => void refreshUsage(row)}
                            >
                              <RefreshCcw className="size-3" /> Refresh
                            </Button>
                          </TableCell>
                          <TableCell>
                            <div className="space-y-1">
                              <div className="flex items-center gap-2 text-xs">
                                <span className="text-muted-foreground">
                                  eSIM
                                </span>
                                <StatusBadge
                                  label={row.providerStatus ?? "UNKNOWN"}
                                />
                              </div>
                              <div className="flex items-center gap-2 text-xs">
                                <span className="text-muted-foreground">
                                  Plan
                                </span>
                                <StatusBadge label={row.status} />
                              </div>
                              <p className="break-all text-[11px] text-muted-foreground">
                                Subscription ID: {row.providerSubscriptionId}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <LifecycleActions
                              orderId={row.orderId}
                              iccid={row.iccid}
                              providerStatus={row.providerStatus}
                              canTerminate={canTerminate}
                              onCompleted={lifecycleCompleted}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <EmptyState
                    title="No customer plans found"
                    description="Try another customer, order, ICCID, MSISDN, or plan."
                  />
                )}
              </Panel>
            </TabsContent>
            <TabsContent value="inventory" className="mt-4">
              <Panel
                title="Unassigned eSIMs"
                description="Compares our records with the network's records"
                actions={searchControl(
                  "inventory",
                  "Search ICCID, EID, MSISDN or batch…",
                )}
                noPadding
              >
                {data.inventory.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>SIM identifiers</TableHead>
                        <TableHead>Batch</TableHead>
                        <TableHead>Our system</TableHead>
                        <TableHead>Network</TableHead>
                        <TableHead>Last checked</TableHead>
                        <TableHead>Issue</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.inventory.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell>
                            <p className="text-[11px] text-muted-foreground">
                              ICCID / SIM serial
                            </p>
                            <code className="text-xs">{row.iccid}</code>
                            <p className="text-[11px] text-muted-foreground">
                              MSISDN: {row.msisdn ?? "Not assigned"}
                            </p>
                          </TableCell>
                          <TableCell>{row.batchReference}</TableCell>
                          <TableCell>
                            <StatusBadge label={row.status} />
                          </TableCell>
                          <TableCell>
                            <StatusBadge
                              label={row.providerStatus ?? "NOT CHECKED"}
                            />
                          </TableCell>
                          <TableCell>
                            {formatDate(row.lastProviderCheckedAt)}
                          </TableCell>
                          <TableCell className="max-w-64 truncate text-xs">
                            {row.quarantineReason ? (
                              <span className="text-destructive">
                                {row.quarantineReason}
                              </span>
                            ) : row.providerCheckError ? (
                              <span className="text-destructive">
                                {operationalIssue(row.providerCheckError).title}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy === row.id}
                                onClick={() => void reconcile(row)}
                              >
                                <RefreshCcw className="size-3.5" /> Refresh
                                network status
                              </Button>
                              {row.status === "QUARANTINED" && canTerminate ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busy === row.id}
                                  onClick={() => void releaseToStock(row)}
                                >
                                  <Boxes className="size-3.5" /> Release &amp;
                                  restock
                                </Button>
                              ) : null}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <EmptyState
                    title="No unassigned eSIMs found"
                    description="Try another ICCID, EID, MSISDN, provider state, or batch."
                  />
                )}
              </Panel>
            </TabsContent>
            <TabsContent value="actions" className="mt-4">
              <Panel
                title="Network lifecycle history"
                description="Audited suspension, reactivation and permanent termination requests"
                actions={searchControl(
                  "actions",
                  "Search order, actor, reason or reference…",
                )}
                noPadding
              >
                {data.lifecycleOperations.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Time</TableHead>
                        <TableHead>Order</TableHead>
                        <TableHead>Action</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead>Actor</TableHead>
                        <TableHead>Reason</TableHead>
                        <TableHead>Reference</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.lifecycleOperations.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell>{formatDate(row.createdAt)}</TableCell>
                          <TableCell>{row.orderNumber}</TableCell>
                          <TableCell>{row.action}</TableCell>
                          <TableCell>
                            <StatusBadge
                              label={row.state}
                              tone={
                                row.state === "FAILED" ||
                                row.state === "RECONCILE_REQUIRED" ||
                                row.state === "APPROVAL_REQUIRED" ||
                                row.state === "REJECTED" ||
                                row.state === "EXPIRED" ||
                                row.state === "CREATED" ||
                                row.state === "SUBMITTING" ||
                                row.state === "ACCEPTED"
                                  ? "warning"
                                  : "success"
                              }
                            />
                          </TableCell>
                          <TableCell>{row.actor}</TableCell>
                          <TableCell className="max-w-64 truncate">
                            {row.reason}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {row.providerTransactionId ?? "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            {canTerminate &&
                            row.action === "REACTIVATE" &&
                            row.state === "APPROVAL_REQUIRED" &&
                            row.requesterId !== data.currentActorId ? (
                              <div className="flex justify-end gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={Boolean(busy)}
                                  onClick={() => setRejection(row)}
                                >
                                  <XCircle className="size-4" />
                                  Reject
                                </Button>
                                <Button
                                  size="sm"
                                  disabled={Boolean(busy)}
                                  onClick={() => void approveReactivation(row)}
                                >
                                  {busy === `approve:${row.id}` ? (
                                    <Spinner />
                                  ) : null}
                                  Approve reactivation
                                </Button>
                              </div>
                            ) : row.state === "APPROVAL_REQUIRED" ? (
                              <span className="text-xs text-muted-foreground">
                                {lifecycleApprovalMessage(
                                  row,
                                  data.currentActorId,
                                )}
                              </span>
                            ) : row.approvedBy ? (
                              <span className="text-xs text-muted-foreground">
                                {row.state === "REJECTED"
                                  ? "Rejected"
                                  : "Approved"}{" "}
                                by {row.approvedBy}
                              </span>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <EmptyState
                    title="No lifecycle actions found"
                    description="Try another order, actor, reason, or provider reference."
                  />
                )}
              </Panel>
            </TabsContent>
          </Tabs>
        </>
      ) : null}
      <Dialog
        open={Boolean(rejection)}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setRejection(null);
            setRejectionReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject reactivation request</DialogTitle>
            <DialogDescription>
              Record why network service must remain suspended. No request will
              be sent to Transatel.
            </DialogDescription>
          </DialogHeader>
          <label className="block space-y-1.5 text-sm font-medium">
            Rejection reason
            <textarea
              className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm"
              maxLength={500}
              value={rejectionReason}
              onChange={(event) => setRejectionReason(event.target.value)}
            />
          </label>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={Boolean(busy)}
              onClick={() => {
                setRejection(null);
                setRejectionReason("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={Boolean(busy) || rejectionReason.trim().length < 5}
              onClick={() => void rejectReactivation()}
            >
              {rejection && busy === `reject:${rejection.id}` ? (
                <Spinner />
              ) : null}
              Reject request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
