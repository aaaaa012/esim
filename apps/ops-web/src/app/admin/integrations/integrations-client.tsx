"use client";
import { useAuthenticatedFetch } from "../../authenticated-api-provider";
import { useEffect, useState } from "react";
import {
  FlaskConical,
  History,
  Pencil,
  RefreshCcw,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/spinner";
import { EmptyState } from "@/components/empty-state";
import { toast } from "sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const headers = { "content-type": "application/json" };
type Integration = {
  id: string;
  name: string;
  category: string;
  provider: string;
  enabled: boolean;
  status: string;
  secretValue: string;
  checkedAt: string;
};
type Plan = { id: string; countryCode: string; name: string };
type IntegrationLog = {
  id: string;
  operation: string;
  method: string;
  endpoint: string;
  status: string;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
};

export default function IntegrationsClient() {
  const authFetch = useAuthenticatedFetch();
  const request = async <T,>(path: string, init?: RequestInit) => {
    const r = await authFetch(`${API}${path}`, {
      ...init,
      headers: { ...headers, ...init?.headers },
    });
    const v = await r.json();
    if (!r.ok) throw new Error(v.error?.message ?? "Request failed");
    return v.data as T;
  };
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [logs, setLogs] = useState<IntegrationLog[]>([]);
  const [busy, setBusy] = useState("");
  const [eligibilityPlanId, setEligibilityPlanId] = useState("");
  const [eligibilityPlanQuery, setEligibilityPlanQuery] = useState("");
  const [plansBusy, setPlansBusy] = useState(false);
  const [eligibilityMsisdn, setEligibilityMsisdn] = useState("");
  const [logsBusy, setLogsBusy] = useState(false);
  useEffect(() => {
    void request<Integration[]>("/admin/integrations")
      .then(setIntegrations)
      .catch((e) => toast.error(e.message));
    void request<IntegrationLog[]>("/operations/integration-logs")
      .then(setLogs)
      .catch((e) => toast.error(e.message));
  }, []);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setPlansBusy(true);
      const params = new URLSearchParams({ limit: "50", offset: "0" });
      if (eligibilityPlanQuery.trim())
        params.set("q", eligibilityPlanQuery.trim());
      void request<{ items: Plan[] }>(`/admin/plans/page?${params}`)
        .then((result) => {
          if (!cancelled) setPlans(result.items);
        })
        .catch((e) => {
          if (!cancelled) toast.error(e.message);
        })
        .finally(() => {
          if (!cancelled) setPlansBusy(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [eligibilityPlanQuery]);
  const test = async (item: Integration) => {
    setBusy(item.id);
    try {
      const result = await request<{ message: string }>(
        `/admin/integrations/${item.id}/test`,
        {
          method: "POST",
        },
      );
      toast.success(result.message);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Test failed");
    } finally {
      setBusy("");
    }
  };
  const transatelAction = async (action: "sync-catalog" | "ensure-webhook") => {
    setBusy(`transatel:${action}`);
    try {
      await request(`/admin/integrations/transatel/${action}`, {
        method: "POST",
      });
      toast.success(
        action === "sync-catalog"
          ? "Plans synced with the network provider"
          : "Automatic notifications set up",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${action} failed`);
    } finally {
      setBusy("");
    }
  };
  const checkEligibility = async () => {
    if (!eligibilityPlanId || !eligibilityMsisdn) {
      toast.error("Choose a plan and enter a mobile number first");
      return;
    }
    setBusy("transatel:eligibility");
    try {
      await request("/admin/integrations/transatel/eligibility", {
        method: "POST",
        body: JSON.stringify({
          planId: eligibilityPlanId,
          msisdn: eligibilityMsisdn,
        }),
      });
      toast.success("Eligibility check complete");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Eligibility check failed");
    } finally {
      setBusy("");
    }
  };
  const refreshLogs = async () => {
    setLogsBusy(true);
    try {
      setLogs(await request<IntegrationLog[]>("/operations/integration-logs"));
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Could not load integration logs",
      );
    } finally {
      setLogsBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Integration health"
        description="Live status is shown without exposing stored secrets. Credentials are kept secure and never shown here."
        badge={
          <Badge variant="success" className="gap-1.5">
            <ShieldCheck className="size-3" />
            Super Admin access
          </Badge>
        }
      />
      {!integrations.length ? (
        <div className="flex h-60 items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {integrations.map((item) => (
            <div
              key={item.id}
              className="rounded-xl border bg-card p-5 shadow-card"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-lg bg-success-soft text-success-foreground">
                    <Settings2 className="size-5" />
                  </span>
                  <div>
                    <h3 className="font-semibold">{item.name}</h3>
                    <p className="text-xs text-muted-foreground">
                      {item.category} · {item.provider}
                    </p>
                  </div>
                </div>
                <StatusBadge
                  label={item.status}
                  tone={item.status === "HEALTHY" ? "success" : "warning"}
                />
              </div>
              <Separator className="my-4" />
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {item.enabled
                    ? "Configured and enabled"
                    : "Needs configuration"}
                </span>
                <span className="text-xs text-muted-foreground">
                  Credentials are kept secure.
                </span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Last checked: {new Date(item.checkedAt).toLocaleString()}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    toast.info(
                      `${item.name}: set ${item.provider} credentials as environment/secret values, then restart the API.`,
                    )
                  }
                >
                  <Pencil className="size-4" />
                  Credential guidance
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => test(item)}
                  disabled={busy === item.id}
                >
                  {busy === item.id ? (
                    <Spinner />
                  ) : (
                    <FlaskConical className="size-4" />
                  )}
                  Test
                </Button>
                {item.id === "transatel" && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => transatelAction("sync-catalog")}
                      disabled={busy === "transatel:sync-catalog"}
                    >
                      {busy === "transatel:sync-catalog" ? (
                        <Spinner />
                      ) : (
                        <RefreshCcw className="size-4" />
                      )}
                      Sync catalog
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => transatelAction("ensure-webhook")}
                      disabled={busy === "transatel:ensure-webhook"}
                    >
                      {busy === "transatel:ensure-webhook" ? (
                        <Spinner />
                      ) : (
                        <Pencil className="size-4" />
                      )}
                      Register webhook
                    </Button>
                  </>
                )}
              </div>
              {item.id === "transatel" && (
                <div className="mt-4 space-y-3 rounded-lg border border-dashed p-4">
                  <p className="text-sm font-medium">Eligibility check</p>
                  <Input
                    placeholder="Search country or plan…"
                    value={eligibilityPlanQuery}
                    onChange={(event) =>
                      setEligibilityPlanQuery(event.target.value)
                    }
                  />
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Select
                      value={eligibilityPlanId}
                      onValueChange={setEligibilityPlanId}
                    >
                      <SelectTrigger className="w-full sm:w-auto">
                        <SelectValue
                          placeholder={
                            plansBusy ? "Loading plans…" : "Select plan…"
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {plans.map((plan) => (
                          <SelectItem key={plan.id} value={plan.id}>
                            {plan.countryCode} · {plan.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      placeholder="Mobile number, e.g. 97798…"
                      value={eligibilityMsisdn}
                      onChange={(e) => setEligibilityMsisdn(e.target.value)}
                      className="w-full sm:w-auto sm:flex-1"
                    />
                    <Button
                      variant="outline"
                      disabled={busy === "transatel:eligibility"}
                      onClick={() => void checkEligibility()}
                    >
                      {busy === "transatel:eligibility" ? (
                        <Spinner />
                      ) : (
                        <Settings2 className="size-4" />
                      )}
                      Check
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <Panel
        className="mt-6"
        title="Integration call log"
        description="Outbound integration requests and outcomes (most recent 200)."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refreshLogs()}
            disabled={logsBusy}
          >
            {logsBusy ? <Spinner /> : <History className="size-4" />}
            Refresh
          </Button>
        }
        noPadding
      >
        {!logs.length ? (
          <EmptyState title="No integration calls recorded yet" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Operation</TableHead>
                <TableHead>Endpoint</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="text-muted-foreground">
                    {new Date(log.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="font-medium">{log.operation}</TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {log.method} {log.endpoint}
                    </code>
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      label={log.status}
                      tone={log.status === "SUCCESS" ? "success" : "warning"}
                    />
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {log.durationMs != null ? `${log.durationMs}ms` : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {log.errorMessage ?? log.errorCode ?? "—"}
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
