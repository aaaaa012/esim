"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Boxes, Database, RefreshCcw, RadioTower, ShieldAlert, Wifi, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { LifecycleActions } from "./lifecycle-actions";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";
import { Spinner } from "@/components/spinner";
import { SearchInput } from "@/components/search-input";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type Subscriber = { orderId: string; orderNumber: string; ownerId: string; customer: string; email: string; iccid: string; msisdn?: string | null; providerSubscriptionId: string; status: string; providerStatus?: string | null; plan: string; usedMb: number; totalMb: number; remainingMb: number; usageLastCheckedAt?: string | null; expiresAt?: string | null };
type Inventory = { id: string; iccid: string; status: string; providerStatus?: string | null; lastProviderCheckedAt?: string | null; providerCheckError?: string | null; batchReference: string };
type Failure = { id: string; operation: string; endpoint: string; status: number; errorCode?: string | null; errorMessage?: string | null; createdAt: string };
type LifecycleOperation = { id: string; orderNumber: string; action: string; state: string; reason: string; actor: string; providerTransactionId?: string | null; errorMessage?: string | null; createdAt: string };
type Dashboard = { health: { ok: boolean; configured?: boolean; authenticated?: boolean; circuit?: string; lastSuccessAt?: string | null; error?: string }; persistence: string; counts: { available: number; quarantined: number; activeSubscriptions: number; suspended: number; provisioningAttention: number; webhookDeadLetters: number }; subscribers: Subscriber[]; inventory: Inventory[]; failures: Failure[]; lifecycleOperations: LifecycleOperation[] };
type SearchScope = "subscribers" | "inventory" | "failures" | "actions";
const formatDate = (value?: string | null) => value ? new Date(value).toLocaleString() : "Never";

export default function TransatelDashboard() {
  const authFetch = useAuthenticatedFetch();
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [canTerminate, setCanTerminate] = useState(false);
  const [activeTab, setActiveTab] = useState<SearchScope>("subscribers");
  const [searches, setSearches] = useState<Record<SearchScope, string>>({ subscribers: "", inventory: "", failures: "", actions: "" });
  const [searchRequest, setSearchRequest] = useState<{ scope: SearchScope; q: string }>({ scope: "subscribers", q: "" });
  const loadSequence = useRef(0);
  const [diagnostics, setDiagnostics] = useState<{checks:Array<{operation:string;status:string;durationMs?:number|null;checkedAt?:string|null}>;webhook:{configured:boolean;lastReceivedAt?:string|null;deadLetters:number}}|null>(null);
  const load = useCallback(async () => {
    const requestId = ++loadSequence.current;
    setError("");
    try {
      const params = new URLSearchParams({ scope: searchRequest.scope });
      if (searchRequest.q) params.set("q", searchRequest.q);
      const dashboardResponse = await authFetch(`${API}/operations/transatel?${params}`);
      const dashboardValue = await dashboardResponse.json();
      if (!dashboardResponse.ok) throw new Error(dashboardValue.error?.message ?? "Transatel dashboard could not be loaded");
      if (requestId === loadSequence.current) setData(dashboardValue.data);
    } catch (cause) { if (requestId === loadSequence.current) setError(cause instanceof Error ? cause.message : "Dashboard load failed"); }
  }, [authFetch, searchRequest]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void authFetch(`${API}/auth/me`)
      .then((response) => response.json())
      .then((value) => setCanTerminate(value.data?.accountType === "SUPER_ADMIN"))
      .catch(() => undefined);
  }, [authFetch]);
  useEffect(() => {
    const timer = window.setTimeout(() => setSearchRequest({ scope: activeTab, q: searches[activeTab].trim() }), 300);
    return () => window.clearTimeout(timer);
  }, [activeTab, searches]);
  const searchControl = (scope: SearchScope, placeholder: string) => (
    <SearchInput
      value={searches[scope]}
      onChange={(value) => setSearches((current) => ({ ...current, [scope]: value }))}
      placeholder={placeholder}
      className="w-full sm:w-80"
    />
  );
  const reconcile = async (profile: Inventory) => {
    setBusy(profile.id);
    try {
      const response = await authFetch(`${API}/operations/inventory/profiles/${profile.id}/reconcile`, { method: "POST", headers: {} });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error?.message ?? "Reconciliation failed");
      toast.success(`${profile.iccid} reconciled`); await load();
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : "Reconciliation failed"); } finally { setBusy(""); }
  };
  const refreshUsage = async (subscriber: Subscriber) => {
    setBusy(subscriber.orderId);
    try {
      const response = await authFetch(`${API}/operations/orders/${subscriber.orderId}/usage/refresh`, { method: "POST", headers: {} });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error?.message ?? "Usage refresh failed");
      toast.success(`${subscriber.orderNumber} usage refreshed`); await load();
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : "Usage refresh failed"); } finally { setBusy(""); }
  };
  const runDiagnostics=async()=>{setBusy("diagnostics");try{const response=await authFetch(`${API}/operations/transatel/diagnostics`);const value=await response.json();if(!response.ok)throw new Error(value.error?.message??"Diagnostics failed");setDiagnostics(value.data);toast.success("Connectivity diagnostics refreshed")}catch(cause){toast.error(cause instanceof Error?cause.message:"Diagnostics failed")}finally{setBusy("")}};
  const metrics: Array<{ label: string; value: string | number; icon: LucideIcon }> = data ? [
    { label: "Network", value: data.health.ok ? "Healthy" : "Attention", icon: RadioTower },
    { label: "Available stock", value: data.counts.available, icon: Boxes },
    { label: "Flagged eSIMs", value: data.counts.quarantined, icon: ShieldAlert },
    { label: "Active plans", value: data.counts.activeSubscriptions, icon: Wifi },
    { label: "Set-ups needing attention", value: data.counts.provisioningAttention, icon: AlertTriangle },
    { label: "Missed notifications", value: data.counts.webhookDeadLetters, icon: Database },
  ] : [];
  return (
    <>
      <PageHeader title="Network connectivity" description="See the network status, customer plans, stock checks and any issues needing your attention." badge={data ? <StatusBadge label={data.health.ok ? "CONNECTED" : "ATTENTION"} tone={data.health.ok ? "success" : "warning"} /> : undefined} actions={<div className="flex gap-2"><Button variant="outline" disabled={busy==="diagnostics"} onClick={() => void runDiagnostics()}><Database className="size-4" /> Run diagnostics</Button><Button variant="outline" onClick={() => void load()}><RefreshCcw className="size-4" /> Refresh</Button></div>} />
      {error ? <div className="mb-6 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</div> : null}
      {!data && !error ? <div className="flex h-48 items-center justify-center"><Spinner /></div> : null}
      {data ? <>
        <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
          {metrics.map(({ label, value, icon: Icon }) => <div key={label} className="rounded-xl border bg-card p-4"><div className="flex items-center justify-between text-xs text-muted-foreground"><span>{label}</span><Icon className="size-4" /></div><p className="mt-2 text-2xl font-semibold">{String(value)}</p></div>)}
        </div>
        <Panel className="mb-6" title="Connection to the network" description="Whether the network provider connection is working"><div className="grid gap-4 text-sm sm:grid-cols-4"><div><p className="text-muted-foreground">Set up</p><p className="font-medium">{data.health.configured ? "Yes" : "No"}</p></div><div><p className="text-muted-foreground">Connected</p><p className="font-medium">{data.health.authenticated ? "Yes" : "No"}</p></div><div><p className="text-muted-foreground">Protection</p><p className="font-medium">{data.health.circuit ?? "Unknown"}</p></div><div><p className="text-muted-foreground">Last successful check</p><p className="font-medium">{formatDate(data.health.lastSuccessAt)}</p></div></div>{diagnostics?<div className="mt-5 border-t pt-4"><div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">{diagnostics.checks.map(check=><div key={check.operation} className="rounded-lg border p-2 text-xs"><div className="flex justify-between gap-2"><b>{check.operation}</b><StatusBadge label={check.status} tone={check.status==="PASS"?"success":"warning"}/></div><p className="mt-1 text-muted-foreground">{check.durationMs??"—"} ms · {formatDate(check.checkedAt)}</p></div>)}</div><p className="mt-3 text-xs text-muted-foreground">Automatic notifications: {diagnostics.webhook.configured?"Yes":"No"} · Last received: {formatDate(diagnostics.webhook.lastReceivedAt)} · Missed notifications: {diagnostics.webhook.deadLetters}</p></div>:null}</Panel>
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as SearchScope)}>
          <TabsList><TabsTrigger value="subscribers">Customer plans</TabsTrigger><TabsTrigger value="inventory">Unassigned eSIMs</TabsTrigger><TabsTrigger value="failures">Issues</TabsTrigger><TabsTrigger value="actions">Suspend &amp; terminate history</TabsTrigger></TabsList>
          <TabsContent value="subscribers" className="mt-4"><Panel title="Customer plans" description="Balances and plan controls" actions={searchControl("subscribers", "Search customer, order, ICCID or plan…")} noPadding>{data.subscribers.length ? <Table><TableHeader><TableRow><TableHead>Customer / Order</TableHead><TableHead>eSIM</TableHead><TableHead>Plan</TableHead><TableHead>Balance</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader><TableBody>{data.subscribers.map((row) => <TableRow key={row.providerSubscriptionId}><TableCell><p className="font-medium">{row.customer}</p><p className="text-xs text-muted-foreground">{row.orderNumber} · {row.email}</p></TableCell><TableCell><code className="text-xs">{row.iccid}</code><p className="text-xs text-muted-foreground">{row.msisdn ?? "No mobile number"}</p></TableCell><TableCell>{row.plan}<p className="text-xs text-muted-foreground">Expires {formatDate(row.expiresAt)}</p></TableCell><TableCell><p className="font-medium">{row.remainingMb.toLocaleString()} MB left</p><p className="text-xs text-muted-foreground">{row.usedMb.toLocaleString()} / {row.totalMb.toLocaleString()} MB</p><Button className="mt-1 h-7 px-2 text-xs" variant="ghost" disabled={busy === row.orderId} onClick={() => void refreshUsage(row)}><RefreshCcw className="size-3" /> Refresh</Button></TableCell><TableCell><StatusBadge label={row.providerStatus ?? row.status} /></TableCell><TableCell className="text-right"><LifecycleActions orderId={row.orderId} iccid={row.iccid} providerStatus={row.providerStatus} canTerminate={canTerminate} onCompleted={() => void load()} /></TableCell></TableRow>)}</TableBody></Table> : <EmptyState title="No customer plans found" description="Try another customer, order, ICCID, MSISDN, or plan." />}</Panel></TabsContent>
          <TabsContent value="inventory" className="mt-4"><Panel title="Unassigned eSIMs" description="Compares our records with the network's records" actions={searchControl("inventory", "Search ICCID, EID, MSISDN or batch…")} noPadding>{data.inventory.length ? <Table><TableHeader><TableRow><TableHead>eSIM</TableHead><TableHead>Batch</TableHead><TableHead>Our system</TableHead><TableHead>Network</TableHead><TableHead>Last checked</TableHead><TableHead>Issue</TableHead><TableHead /></TableRow></TableHeader><TableBody>{data.inventory.map((row) => <TableRow key={row.id}><TableCell><code className="text-xs">{row.iccid}</code></TableCell><TableCell>{row.batchReference}</TableCell><TableCell><StatusBadge label={row.status} /></TableCell><TableCell><StatusBadge label={row.providerStatus ?? "NOT CHECKED"} /></TableCell><TableCell>{formatDate(row.lastProviderCheckedAt)}</TableCell><TableCell className="max-w-64 truncate text-xs text-destructive">{row.providerCheckError ?? "—"}</TableCell><TableCell><Button size="sm" variant="outline" disabled={busy === row.id} onClick={() => void reconcile(row)}><RefreshCcw className="size-3.5" /> Check network</Button></TableCell></TableRow>)}</TableBody></Table> : <EmptyState title="No unassigned eSIMs found" description="Try another ICCID, EID, MSISDN, provider state, or batch." />}</Panel></TabsContent>
          <TabsContent value="failures" className="mt-4"><Panel title="Recent network issues" description="Recent requests to the network that did not succeed" actions={searchControl("failures", "Search operation, endpoint or error…")} noPadding>{data.failures.length ? <Table><TableHeader><TableRow><TableHead>Time</TableHead><TableHead>Operation</TableHead><TableHead>Status</TableHead><TableHead>Endpoint</TableHead><TableHead>Error</TableHead></TableRow></TableHeader><TableBody>{data.failures.map((row) => <TableRow key={row.id}><TableCell>{formatDate(row.createdAt)}</TableCell><TableCell>{row.operation}</TableCell><TableCell><StatusBadge label={String(row.status)} tone="warning" /></TableCell><TableCell className="max-w-64 truncate font-mono text-xs">{row.endpoint}</TableCell><TableCell className="max-w-80 truncate text-xs text-destructive">{row.errorCode ?? row.errorMessage ?? "Unknown"}</TableCell></TableRow>)}</TableBody></Table> : <EmptyState title="No network issues found" description="Try another operation, endpoint, error code, or correlation ID." />}</Panel></TabsContent>
          <TabsContent value="actions" className="mt-4"><Panel title="Suspend and terminate history" description="Record of suspend and terminate requests" actions={searchControl("actions", "Search order, actor, reason or reference…")} noPadding>{data.lifecycleOperations.length ? <Table><TableHeader><TableRow><TableHead>Time</TableHead><TableHead>Order</TableHead><TableHead>Action</TableHead><TableHead>State</TableHead><TableHead>Actor</TableHead><TableHead>Reason</TableHead><TableHead>Reference</TableHead></TableRow></TableHeader><TableBody>{data.lifecycleOperations.map((row) => <TableRow key={row.id}><TableCell>{formatDate(row.createdAt)}</TableCell><TableCell>{row.orderNumber}</TableCell><TableCell>{row.action}</TableCell><TableCell><StatusBadge label={row.state} tone={row.state === "FAILED" || row.state === "RECONCILE_REQUIRED" ? "warning" : "success"} /></TableCell><TableCell>{row.actor}</TableCell><TableCell className="max-w-64 truncate">{row.reason}</TableCell><TableCell className="font-mono text-xs">{row.providerTransactionId ?? "—"}</TableCell></TableRow>)}</TableBody></Table> : <EmptyState title="No lifecycle actions found" description="Try another order, actor, reason, or provider reference." />}</Panel></TabsContent>
        </Tabs>
      </> : null}
    </>
  );
}
