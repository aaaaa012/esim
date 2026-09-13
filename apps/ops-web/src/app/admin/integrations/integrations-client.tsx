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
  capabilities?: Record<string, boolean | string>;
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
type FonepayBank = {
  bankCode: string;
  bankName: string;
  packageName?: string | null;
  intentScheme: string;
  active: boolean;
};
type FonepayDirectory = { banks: FonepayBank[]; lastSyncedAt: string | null };
type GatewayCapabilities = {
  checkout: "QR" | "REDIRECT" | "QR_AND_REDIRECT" | "NONE";
  statusLookup: boolean;
  refunds: "SUPPORTED" | "MANUAL" | "NOT_SUPPORTED";
  disputes: "SUPPORTED" | "NOT_SUPPORTED";
  extra?: string[];
};
type PaymentGatewayCapabilities = {
  provider: string;
  configured: boolean;
  capabilities: GatewayCapabilities;
  notes: string[];
};

function capabilityTone(
  value: string | boolean,
): "success" | "warning" | "default" {
  if (value === true || value === "SUPPORTED" || value === "QR_AND_REDIRECT")
    return "success";
  if (value === "MANUAL" || value === "NOT_SUPPORTED") return "warning";
  return "default";
}

function capabilityLabel(value: string | boolean): string {
  if (typeof value === "boolean") return value ? "Available" : "Not available";
  if (value === "QR_AND_REDIRECT") return "QR and redirect";
  return value;
}

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
  const [fonepayDirectory, setFonepayDirectory] = useState<FonepayDirectory>({
    banks: [],
    lastSyncedAt: null,
  });
  const [gateways, setGateways] = useState<PaymentGatewayCapabilities[]>([]);
  useEffect(() => {
    void request<Integration[]>("/admin/integrations")
      .then(setIntegrations)
      .catch((e) => toast.error(e.message));
    void request<IntegrationLog[]>("/operations/integration-logs")
      .then(setLogs)
      .catch((e) => toast.error(e.message));
    void request<FonepayDirectory>("/admin/integrations/fonepay/banks")
      .then(setFonepayDirectory)
      .catch((e) => toast.error(e.message));
    void request<PaymentGatewayCapabilities[]>(
      "/admin/integrations/payment-gateways",
    )
      .then(setGateways)
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
  const transatelAction = async (action: "sync-catalog" | "sync-usage") => {
    setBusy(`transatel:${action}`);
    try {
      await request(`/admin/integrations/transatel/${action}`, {
        method: "POST",
      });
      toast.success(
        action === "sync-catalog"
          ? "Plans synced with the network provider"
          : "Data usage synchronized with network provider",
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
  const syncFonepayBanks = async () => {
    setBusy("fonepay:banks");
    try {
      const directory = await request<FonepayDirectory>(
        "/admin/integrations/fonepay/banks/sync",
        { method: "POST" },
      );
      setFonepayDirectory(directory);
      toast.success(
        `Fonepay bank directory updated (${directory.banks.length} active)`,
      );
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Bank directory sync failed",
      );
    } finally {
      setBusy("");
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
              {item.capabilities ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {Object.entries(item.capabilities).map(([name, value]) => (
                    <Badge key={name} variant="secondary">
                      {name.replace(/([a-z])([A-Z])/g, "$1 $2")}:{" "}
                      {String(value)}
                    </Badge>
                  ))}
                </div>
              ) : null}
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
                      onClick={() => transatelAction("sync-usage")}
                      disabled={busy === "transatel:sync-usage"}
                    >
                      {busy === "transatel:sync-usage" ? (
                        <Spinner />
                      ) : (
                        <RefreshCcw className="size-4" />
                      )}
                      Sync usage
                    </Button>
                  </>
                )}
              </div>
              {item.id === "transatel" && (
                <div className="mt-4 space-y-3 rounded-lg border border-dashed p-4">
                  <div>
                    <p className="text-sm font-medium">
                      Provider notifications
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Configure the callback URL and event subscriptions in the
                      Transatel Developer Console. Transatel no longer permits
                      webhook registration through its API.
                    </p>
                  </div>
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
        title="Payment gateway capabilities"
        description="What each gateway can do today. A capability that is missing is shown explicitly — never implied by the provider's brand."
      >
        {!gateways.length ? (
          <EmptyState
            title="No gateways"
            description="Payment gateways will appear once configured."
          />
        ) : (
          <div className="space-y-4">
            {gateways.map((gateway) => (
              <div key={gateway.provider} className="rounded-lg border p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">{gateway.provider}</p>
                  <StatusBadge
                    label={
                      gateway.configured ? "Configured" : "Config required"
                    }
                    tone={gateway.configured ? "success" : "warning"}
                  />
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <div className="flex items-center justify-between border-b pb-2 text-sm">
                    <span className="text-muted-foreground">Checkout</span>
                    <StatusBadge
                      label={capabilityLabel(gateway.capabilities.checkout)}
                      tone={capabilityTone(gateway.capabilities.checkout)}
                    />
                  </div>
                  <div className="flex items-center justify-between border-b pb-2 text-sm">
                    <span className="text-muted-foreground">Status lookup</span>
                    <StatusBadge
                      label={capabilityLabel(gateway.capabilities.statusLookup)}
                      tone={capabilityTone(gateway.capabilities.statusLookup)}
                    />
                  </div>
                  <div className="flex items-center justify-between border-b pb-2 text-sm">
                    <span className="text-muted-foreground">Refunds</span>
                    <StatusBadge
                      label={capabilityLabel(gateway.capabilities.refunds)}
                      tone={capabilityTone(gateway.capabilities.refunds)}
                    />
                  </div>
                  <div className="flex items-center justify-between border-b pb-2 text-sm">
                    <span className="text-muted-foreground">Disputes</span>
                    <StatusBadge
                      label={capabilityLabel(gateway.capabilities.disputes)}
                      tone={capabilityTone(gateway.capabilities.disputes)}
                    />
                  </div>
                </div>
                {gateway.capabilities.extra?.length ? (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {gateway.capabilities.extra.map((extra) => (
                      <Badge key={extra} variant="outline">
                        {extra}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                {gateway.notes.length ? (
                  <ul className="mt-3 list-disc pl-5 text-xs text-muted-foreground">
                    {gateway.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Panel>
      <Panel
        title="Fonepay bank directory"
        description="Last-known-good mobile banking destinations. Checkout QR generation remains available if this directory is temporarily unavailable."
        action={
          <Button
            variant="outline"
            onClick={() => void syncFonepayBanks()}
            disabled={busy === "fonepay:banks"}
          >
            {busy === "fonepay:banks" ? (
              <Spinner />
            ) : (
              <RefreshCcw className="size-4" />
            )}
            Refresh directory
          </Button>
        }
      >
        <p className="mb-3 text-xs text-muted-foreground">
          Last successful sync:{" "}
          {fonepayDirectory.lastSyncedAt
            ? new Date(fonepayDirectory.lastSyncedAt).toLocaleString()
            : "Not synced yet"}
        </p>
        {!fonepayDirectory.banks.length ? (
          <EmptyState
            title="No cached banks"
            description="Refresh the directory after Fonepay is configured."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Bank</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Mobile package</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fonepayDirectory.banks.map((bank) => (
                  <TableRow key={bank.bankCode}>
                    <TableCell className="font-medium">
                      {bank.bankName}
                    </TableCell>
                    <TableCell>{bank.bankCode}</TableCell>
                    <TableCell>{bank.packageName || "Not supplied"}</TableCell>
                    <TableCell>
                      <StatusBadge
                        label={bank.active ? "Active" : "Inactive"}
                        tone={bank.active ? "success" : "default"}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>
    </>
  );
}
