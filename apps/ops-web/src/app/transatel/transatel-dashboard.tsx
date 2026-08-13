"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Boxes, Database, RefreshCcw, RadioTower, ShieldAlert, Wifi, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { LifecycleActions } from "./lifecycle-actions";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type Subscriber = { orderId: string; orderNumber: string; ownerId: string; customer: string; email: string; iccid: string; msisdn?: string | null; providerSubscriptionId: string; status: string; providerStatus?: string | null; plan: string; usedMb: number; totalMb: number; remainingMb: number; usageLastCheckedAt?: string | null; expiresAt?: string | null };
type Inventory = { id: string; iccid: string; status: string; providerStatus?: string | null; lastProviderCheckedAt?: string | null; providerCheckError?: string | null; batchReference: string };
type Failure = { id: string; operation: string; endpoint: string; status: number; errorCode?: string | null; errorMessage?: string | null; createdAt: string };
type LifecycleOperation = { id: string; orderNumber: string; action: string; state: string; reason: string; actor: string; providerTransactionId?: string | null; errorMessage?: string | null; createdAt: string };
type Dashboard = { health: { ok: boolean; configured?: boolean; authenticated?: boolean; circuit?: string; lastSuccessAt?: string | null; error?: string }; persistence: string; counts: { available: number; quarantined: number; activeSubscriptions: number; suspended: number; provisioningAttention: number; webhookDeadLetters: number }; subscribers: Subscriber[]; inventory: Inventory[]; failures: Failure[]; lifecycleOperations: LifecycleOperation[] };
const formatDate = (value?: string | null) => value ? new Date(value).toLocaleString() : "Never";

export default function TransatelDashboard() {
  const authFetch = useAuthenticatedFetch();
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [canTerminate, setCanTerminate] = useState(false);
  const [diagnostics, setDiagnostics] = useState<{checks:Array<{operation:string;status:string;durationMs?:number|null;checkedAt?:string|null}>;webhook:{configured:boolean;lastReceivedAt?:string|null;deadLetters:number}}|null>(null);
  const load = useCallback(async () => {
    setError("");
    try {
      const [dashboardResponse, profileResponse] = await Promise.all([authFetch(`${API}/operations/transatel`), authFetch(`${API}/auth/me`)]);
      const [dashboardValue, profileValue] = await Promise.all([dashboardResponse.json(), profileResponse.json()]);
      if (!dashboardResponse.ok) throw new Error(dashboardValue.error?.message ?? "Transatel dashboard could not be loaded");
      setData(dashboardValue.data);
      setCanTerminate(profileValue.data?.accountType === "SUPER_ADMIN");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Dashboard load failed"); }
  }, [authFetch]);
  useEffect(() => { void load(); }, [load]);
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
    { label: "Provider", value: data.health.ok ? "Healthy" : "Attention", icon: RadioTower },
    { label: "Available stock", value: data.counts.available, icon: Boxes },
    { label: "Quarantined", value: data.counts.quarantined, icon: ShieldAlert },
    { label: "Active plans", value: data.counts.activeSubscriptions, icon: Wifi },
    { label: "Provisioning", value: data.counts.provisioningAttention, icon: AlertTriangle },
    { label: "Dead letters", value: data.counts.webhookDeadLetters, icon: Database },
  ] : [];
  return (
    <>
      <PageHeader title="Connectivity operations" description="Network health, subscriber lifecycle, live inventory reconciliation, balances, and failure queues." badge={data ? <StatusBadge label={data.health.ok ? "CONNECTED" : "ATTENTION"} tone={data.health.ok ? "success" : "warning"} /> : undefined} actions={<div className="flex gap-2"><Button variant="outline" disabled={busy==="diagnostics"} onClick={() => void runDiagnostics()}><Database className="size-4" /> Run diagnostics</Button><Button variant="outline" onClick={() => void load()}><RefreshCcw className="size-4" /> Refresh</Button></div>} />
      {error ? <div className="mb-6 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</div> : null}
      {!data && !error ? <div className="flex h-48 items-center justify-center"><Spinner /></div> : null}
      {data ? <>
        <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
          {metrics.map(({ label, value, icon: Icon }) => <div key={label} className="rounded-xl border bg-card p-4"><div className="flex items-center justify-between text-xs text-muted-foreground"><span>{label}</span><Icon className="size-4" /></div><p className="mt-2 text-2xl font-semibold">{String(value)}</p></div>)}
        </div>
        <Panel className="mb-6" title="Connection details" description="Live authentication and circuit-breaker state"><div className="grid gap-4 text-sm sm:grid-cols-4"><div><p className="text-muted-foreground">Configured</p><p className="font-medium">{data.health.configured ? "Yes" : "No"}</p></div><div><p className="text-muted-foreground">Authenticated</p><p className="font-medium">{data.health.authenticated ? "Yes" : "No"}</p></div><div><p className="text-muted-foreground">Circuit</p><p className="font-medium">{data.health.circuit ?? "Unknown"}</p></div><div><p className="text-muted-foreground">Last success</p><p className="font-medium">{formatDate(data.health.lastSuccessAt)}</p></div></div>{diagnostics?<div className="mt-5 border-t pt-4"><div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">{diagnostics.checks.map(check=><div key={check.operation} className="rounded-lg border p-2 text-xs"><div className="flex justify-between gap-2"><b>{check.operation}</b><StatusBadge label={check.status} tone={check.status==="PASS"?"success":"warning"}/></div><p className="mt-1 text-muted-foreground">{check.durationMs??"—"} ms · {formatDate(check.checkedAt)}</p></div>)}</div><p className="mt-3 text-xs text-muted-foreground">Webhook configured: {diagnostics.webhook.configured?"Yes":"No"} · Last received: {formatDate(diagnostics.webhook.lastReceivedAt)} · Dead letters: {diagnostics.webhook.deadLetters}</p></div>:null}</Panel>
        <Tabs defaultValue="subscribers">
          <TabsList><TabsTrigger value="subscribers">Subscribers</TabsTrigger><TabsTrigger value="inventory">Unassigned inventory</TabsTrigger><TabsTrigger value="failures">Failures</TabsTrigger><TabsTrigger value="actions">Lifecycle history</TabsTrigger></TabsList>
          <TabsContent value="subscribers" className="mt-4"><Panel title="Customer subscriptions" description="Balances and lifecycle controls" noPadding><Table><TableHeader><TableRow><TableHead>Customer / Order</TableHead><TableHead>eSIM</TableHead><TableHead>Plan</TableHead><TableHead>Balance</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader><TableBody>{data.subscribers.map((row) => <TableRow key={row.providerSubscriptionId}><TableCell><p className="font-medium">{row.customer}</p><p className="text-xs text-muted-foreground">{row.orderNumber} · {row.email}</p></TableCell><TableCell><code className="text-xs">{row.iccid}</code><p className="text-xs text-muted-foreground">{row.msisdn ?? "No MSISDN"}</p></TableCell><TableCell>{row.plan}<p className="text-xs text-muted-foreground">Expires {formatDate(row.expiresAt)}</p></TableCell><TableCell><p className="font-medium">{row.remainingMb.toLocaleString()} MB left</p><p className="text-xs text-muted-foreground">{row.usedMb.toLocaleString()} / {row.totalMb.toLocaleString()} MB</p><Button className="mt-1 h-7 px-2 text-xs" variant="ghost" disabled={busy === row.orderId} onClick={() => void refreshUsage(row)}><RefreshCcw className="size-3" /> Refresh</Button></TableCell><TableCell><StatusBadge label={row.providerStatus ?? row.status} /></TableCell><TableCell className="text-right"><LifecycleActions orderId={row.orderId} iccid={row.iccid} providerStatus={row.providerStatus} canTerminate={canTerminate} onCompleted={() => void load()} /></TableCell></TableRow>)}</TableBody></Table></Panel></TabsContent>
          <TabsContent value="inventory" className="mt-4"><Panel title="Live unassigned inventory" description="Provider state must match local sellable state" noPadding><Table><TableHeader><TableRow><TableHead>ICCID</TableHead><TableHead>Batch</TableHead><TableHead>Local</TableHead><TableHead>Transatel</TableHead><TableHead>Last checked</TableHead><TableHead>Error</TableHead><TableHead /></TableRow></TableHeader><TableBody>{data.inventory.map((row) => <TableRow key={row.id}><TableCell><code className="text-xs">{row.iccid}</code></TableCell><TableCell>{row.batchReference}</TableCell><TableCell><StatusBadge label={row.status} /></TableCell><TableCell><StatusBadge label={row.providerStatus ?? "NOT CHECKED"} /></TableCell><TableCell>{formatDate(row.lastProviderCheckedAt)}</TableCell><TableCell className="max-w-64 truncate text-xs text-destructive">{row.providerCheckError ?? "—"}</TableCell><TableCell><Button size="sm" variant="outline" disabled={busy === row.id} onClick={() => void reconcile(row)}><RefreshCcw className="size-3.5" /> Check live</Button></TableCell></TableRow>)}</TableBody></Table></Panel></TabsContent>
          <TabsContent value="failures" className="mt-4"><Panel title="Recent provider failures" description="Latest unsuccessful Transatel calls" noPadding><Table><TableHeader><TableRow><TableHead>Time</TableHead><TableHead>Operation</TableHead><TableHead>Status</TableHead><TableHead>Endpoint</TableHead><TableHead>Error</TableHead></TableRow></TableHeader><TableBody>{data.failures.map((row) => <TableRow key={row.id}><TableCell>{formatDate(row.createdAt)}</TableCell><TableCell>{row.operation}</TableCell><TableCell><StatusBadge label={String(row.status)} tone="warning" /></TableCell><TableCell className="max-w-64 truncate font-mono text-xs">{row.endpoint}</TableCell><TableCell className="max-w-80 truncate text-xs text-destructive">{row.errorCode ?? row.errorMessage ?? "Unknown"}</TableCell></TableRow>)}</TableBody></Table></Panel></TabsContent>
          <TabsContent value="actions" className="mt-4"><Panel title="Lifecycle action history" description="Audited suspend and terminate requests" noPadding><Table><TableHeader><TableRow><TableHead>Time</TableHead><TableHead>Order</TableHead><TableHead>Action</TableHead><TableHead>State</TableHead><TableHead>Actor</TableHead><TableHead>Reason</TableHead><TableHead>Provider transaction</TableHead></TableRow></TableHeader><TableBody>{data.lifecycleOperations.map((row) => <TableRow key={row.id}><TableCell>{formatDate(row.createdAt)}</TableCell><TableCell>{row.orderNumber}</TableCell><TableCell>{row.action}</TableCell><TableCell><StatusBadge label={row.state} tone={row.state === "FAILED" || row.state === "RECONCILE_REQUIRED" ? "warning" : "success"} /></TableCell><TableCell>{row.actor}</TableCell><TableCell className="max-w-64 truncate">{row.reason}</TableCell><TableCell className="font-mono text-xs">{row.providerTransactionId ?? "—"}</TableCell></TableRow>)}</TableBody></Table></Panel></TabsContent>
        </Tabs>
      </> : null}
    </>
  );
}
