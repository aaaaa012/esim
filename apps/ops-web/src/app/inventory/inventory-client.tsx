"use client";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ClipboardList,
  Clock,
  FileUp,
  Globe2,
  Link2,
  PackageCheck,
  PackageOpen,
  RefreshCcw,
  ShieldCheck,
  UploadCloud,
  XCircle,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Panel } from "@/components/panel";
import { StatusBadge, humane } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { EmptyState } from "@/components/empty-state";
import { FileUploader } from "@/components/file-uploader";
import { Spinner } from "@/components/spinner";
import { PaginationBar } from "@/components/pagination-bar";
import { cn } from "@/lib/utils";
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
type Batch = {
  id: string;
  batchReference: string;
  totalProfiles: number;
  importedCount: number;
  failedCount: number;
  status: "PENDING" | "APPROVED" | "REJECTED";
  rejectionReason?: string;
  createdAt: string;
};
type Overview = {
  counts: {
    available: number;
    reserved: number;
    assigned: number;
    activated: number;
    expired: number;
    terminated: number;
    pending: number;
    quarantined?: number;
  };
  lowStockThreshold: number;
  lowStock: boolean;
  batches: Batch[];
};
type InventoryProfile = {
  id: string;
  iccid: string;
  msisdn?: string | null;
  status: string;
  providerStatus?: string | null;
  lastProviderCheckedAt?: string | null;
  providerCheckError?: string | null;
  batchReference?: string | null;
  order?: { orderNumber: string } | null;
};
type ImportResult = {
  imported: number;
  skipped: number;
  errors?: string[];
  batch: string | null;
};
type Plan = {
  id: string;
  name: string;
  countryCode: string;
  countryName: string;
  dataAllowance: string;
  validityDays: number;
  sellingPriceNpr: number;
  status: "DRAFT" | "ACTIVE" | "DISABLED" | "ARCHIVED";
};
type Profile = {
  id: string;
  iccid: string;
  eid: string;
  msisdn?: string | null;
  status: string;
  smDpAddress?: string | null;
  providerSubscriptionId?: string | null;
  providerStatus?: string | null;
  activatedAt?: string | null;
  expiresAt?: string | null;
  batchReference?: string | null;
  batchStatus?: string | null;
  order?: {
    orderNumber: string;
    orderStatus: string;
    customerEmail: string;
    customerCode: string;
    planName: string;
    planCountry: string;
    planCountryCode: string;
    dataAllowance: string;
  } | null;
};
const PROFILE_STATUSES = ["AVAILABLE", "IMPORTED", "RESERVED", "ASSIGNED", "ACTIVATED", "EXPIRED", "TERMINATED", "QUARANTINED"];
const fileToTabularContent = async (file: File): Promise<string> => {
  if (/\.xlsx?$/i.test(file.name)) {
    const buffer = await file.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary);
  }
  return file.text();
};

function UploadResult({ message, errors }: { message: string; errors: string[] }) {
  if (!message && !errors.length) return null;
  return (
    <div
      className={cn(
        "rounded-lg border px-4 py-3 text-sm",
        errors.length
          ? "border-destructive/30 bg-destructive/5 text-destructive"
          : "border-border bg-muted/40 text-foreground",
      )}
    >
      <p className="flex items-center gap-2 font-medium">
        {errors.length ? (
          <XCircle className="size-4" />
        ) : (
          <CheckCircle2 className="size-4 text-success" />
        )}
        {message}
      </p>
      {errors.length > 0 && (
        <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-muted-foreground">
          {errors.slice(0, 8).map((error, index) => (
            <li key={index}>{error}</li>
          ))}
          {errors.length > 8 && <li>+{errors.length - 8} more errors</li>}
        </ul>
      )}
    </div>
  );
}

export default function InventoryClient() {
  const authFetch = useAuthenticatedFetch();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [decision, setDecision] = useState("");
  const [reconciliationProfiles, setReconciliationProfiles] = useState<InventoryProfile[]>([]);
  const [reconciling, setReconciling] = useState("");

  const [profileFile, setProfileFile] = useState<File | null>(null);
  const [profileSource, setProfileSource] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);

  const [packageFile, setPackageFile] = useState<File | null>(null);
  const [packageBusy, setPackageBusy] = useState(false);

  const [draftPlans, setDraftPlans] = useState<Plan[]>([]);
  const [planDecision, setPlanDecision] = useState("");

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profilesTotal, setProfilesTotal] = useState(0);
  const [profilesPage, setProfilesPage] = useState(1);
  const [profilesStatus, setProfilesStatus] = useState("ALL");
  const [profilesLoading, setProfilesLoading] = useState(false);
  const PAGE_SIZE = 50;

  const loadProfiles = () => {
    setProfilesLoading(true);
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String((profilesPage - 1) * PAGE_SIZE),
    });
    if (profilesStatus !== "ALL") params.set("status", profilesStatus);
    authFetch(`${API}/operations/inventory/profiles?${params}`, { headers: {} })
      .then(async (r) => {
        const v = await r.json();
        if (!r.ok) throw new Error(v.error?.message);
        setProfiles(v.data?.items ?? []);
        setProfilesTotal(v.data?.total ?? 0);
      })
      .catch((e) => toast.error(e.message))
      .finally(() => setProfilesLoading(false));
  };
  useEffect(() => {
    if (data) loadProfiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profilesPage, profilesStatus, data]);

  const load = () => {
    void Promise.all([
      authFetch(`${API}/operations/inventory`, { headers: {} }),
      authFetch(`${API}/operations/inventory/profiles?limit=100`, { headers: {} }),
    ])
      .then(async ([overviewResponse, profilesResponse]) => {
        const [overviewValue, profilesValue] = await Promise.all([overviewResponse.json(), profilesResponse.json()]);
        if (!overviewResponse.ok) throw new Error(overviewValue.error?.message);
        if (!profilesResponse.ok) throw new Error(profilesValue.error?.message);
        setData(overviewValue.data);
        setReconciliationProfiles(profilesValue.data.items);
      })
      .catch((e) => setError(e.message));
  };
  const reconcileProfile = async (profile: InventoryProfile) => {
    setReconciling(profile.id);
    try {
      const response = await authFetch(`${API}/operations/inventory/profiles/${profile.id}/reconcile`, { method: "POST", headers: {} });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error?.message ?? "Provider reconciliation failed");
      toast.success(`${profile.iccid} checked against Transatel`);
      load();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Provider reconciliation failed");
    } finally {
      setReconciling("");
    }
  };
  useEffect(() => {
    void authFetch(`${API}/auth/me`, { headers: {} })
      .then((r) => r.json())
      .then((v) => {
        const caps = v.data?.effectiveCapabilities ?? [];
        setIsSuperAdmin(caps.includes("admin:portal"));
      })
      .catch(() => undefined);
    load();
    loadPlans();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitProfiles = async () => {
    if (!profileFile) {
      toast.error("Choose a CSV or Excel file first");
      return;
    }
    setProfileBusy(true);
    try {
      const content = await fileToTabularContent(profileFile);
      const r = await authFetch(`${API}/operations/inventory/import-csv`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content,
          fileName: profileFile.name,
          source: profileSource.trim() || undefined,
        }),
      });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error?.message);
      const result = v.data as ImportResult;
      toast.success(
        `Imported ${result.imported} profiles, skipped ${result.skipped} row(s). Awaiting Super Admin approval.`,
      );
      if (result.imported > 0) {
        setProfileFile(null);
        setProfileSource("");
      }
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "CSV/Excel import failed");
    } finally {
      setProfileBusy(false);
    }
  };

  const submitPackages = async () => {
    if (!packageFile) {
      toast.error("Choose a CSV or Excel file first");
      return;
    }
    setPackageBusy(true);
    try {
      const content = await fileToTabularContent(packageFile);
      const r = await authFetch(`${API}/admin/plans/import-csv`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, fileName: packageFile.name }),
      });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error?.message);
      const result = v.data as ImportResult;
      toast.success(
        `Imported ${result.imported} package(s), skipped ${result.skipped} row(s). They are DRAFT until approved.`,
      );
      if (result.imported > 0) setPackageFile(null);
      loadPlans();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Package import failed");
    } finally {
      setPackageBusy(false);
    }
  };

  const decide = async (batch: Batch, approve: boolean) => {
    setDecision(batch.id);
    try {
      const r = await authFetch(
        `${API}/operations/inventory/batches/${batch.id}/${approve ? "approve" : "reject"}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          ...(approve ? {} : { body: JSON.stringify({ reason: "Rejected by Super Admin" }) }),
        },
      );
      const v = await r.json();
      if (!r.ok) throw new Error(v.error?.message);
      toast.success(
        approve
          ? `Batch ${batch.batchReference} approved — ${batch.importedCount} profile(s) sellable`
          : `Batch ${batch.batchReference} rejected`,
      );
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Decision failed");
    } finally {
      setDecision("");
    }
  };

  const loadPlans = () => {
    void authFetch(`${API}/admin/plans`, { headers: {} })
      .then(async (r) => {
        const v = await r.json();
        if (!r.ok) throw new Error(v.error?.message);
        setDraftPlans((Array.isArray(v.data) ? v.data : v.data?.plans ?? []).filter((p: Plan) => p.status === "DRAFT"));
      })
      .catch((e) => toast.error(e.message));
  };

  const decidePlan = async (plan: Plan, approve: boolean) => {
    setPlanDecision(plan.id);
    try {
      const r = await authFetch(`${API}/admin/plans/${plan.id}/${approve ? "approve" : "reject"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error?.message);
      toast.success(
        approve
          ? `Package "${plan.name}" approved and sellable`
          : `Package "${plan.name}" rejected`,
      );
      loadPlans();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Package decision failed");
    } finally {
      setPlanDecision("");
    }
  };

  if (!data)
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Spinner /> Loading inventory…
        </div>
      </div>
    );

  const metrics = [
    {
      label: "Available",
      value: data.counts.available,
      icon: <PackageOpen className="size-4" />,
      tone: "success" as const,
    },
    {
      label: "Pending approval",
      value: data.counts.pending,
      icon: <Clock className="size-4" />,
      tone: "warning" as const,
    },
    {
      label: "Reserved",
      value: data.counts.reserved,
      icon: <RefreshCcw className="size-4" />,
      tone: "info" as const,
    },
    {
      label: "Assigned",
      value: data.counts.assigned,
      icon: <PackageCheck className="size-4" />,
      tone: "default" as const,
    },
    {
      label: "Activated",
      value: data.counts.activated,
      icon: <CheckCircle2 className="size-4" />,
      tone: "default" as const,
    },
    {
      label: "Quarantined",
      value: data.counts.quarantined ?? 0,
      icon: <AlertTriangle className="size-4" />,
      tone: data.counts.quarantined ? ("danger" as const) : ("default" as const),
    },
  ];
  const pendingBatches = data.batches.filter((batch) => batch.status === "PENDING");

  return (
    <>
      <PageHeader
        title="eSIM Inventory"
        description="Upload eSIM profiles and packages, review pending approvals, and track stock."
        badge={
          <Badge
            variant={data.lowStock ? "warning" : "success"}
            className="gap-1.5"
          >
            {data.lowStock ? (
              <AlertTriangle className="size-3" />
            ) : (
              <CheckCircle2 className="size-3" />
            )}
            {data.lowStock ? "Low stock" : "Stock healthy"}
          </Badge>
        }
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
        {metrics.map((metric) => (
          <StatCard key={metric.label} {...metric} />
        ))}
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Low-stock alert triggers at {data.lowStockThreshold} available profiles.
        {data.counts.pending > 0 && !isSuperAdmin && (
          <span className="text-warning-foreground">
            {" "}
            · {data.counts.pending} profile(s) await Super Admin approval.
          </span>
        )}
      </p>

      <Tabs defaultValue="upload" className="mt-8">
        <TabsList>
          <TabsTrigger value="upload" className="gap-1.5">
            <UploadCloud className="size-4" />
            Bulk upload
          </TabsTrigger>
          <TabsTrigger value="live-stock" className="gap-1.5">
            <RefreshCcw className="size-4" />
            Live stock
            {(data.counts.quarantined ?? 0) > 0 && (
              <span className="ml-1 rounded-full bg-destructive/15 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">{data.counts.quarantined}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="approvals" className="gap-1.5">
            <ShieldCheck className="size-4" />
            Pending approvals
            {pendingBatches.length + draftPlans.length > 0 && (
              <span className="ml-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                {pendingBatches.length + draftPlans.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-1.5">
            <ClipboardList className="size-4" />
            Batch history
          </TabsTrigger>
          <TabsTrigger value="profiles" className="gap-1.5">
            <Boxes className="size-4" />
            eSIM Profiles
          </TabsTrigger>
        </TabsList>

        <TabsContent value="live-stock" className="mt-6">
          <Panel title="Stock check against the network provider" description="Compares the latest 100 profiles with the network provider. Profiles that don't match are flagged automatically." noPadding>
            {!reconciliationProfiles.length ? <EmptyState title="No inventory profiles" description="Uploaded profiles will appear here." /> : (
              <Table>
                <TableHeader><TableRow><TableHead>eSIM</TableHead><TableHead>Our system</TableHead><TableHead>Network provider</TableHead><TableHead>Last checked</TableHead><TableHead>Issue</TableHead><TableHead className="text-right">Action</TableHead></TableRow></TableHeader>
                <TableBody>{reconciliationProfiles.map((profile) => (
                  <TableRow key={profile.id}>
                    <TableCell><code className="text-xs">{profile.iccid}</code><p className="text-xs text-muted-foreground">{profile.batchReference ?? "—"}</p></TableCell>
                    <TableCell><StatusBadge label={profile.status} {...(profile.status === "QUARANTINED" ? { tone: "warning" as const } : {})} /></TableCell>
                    <TableCell><StatusBadge label={profile.providerStatus ?? "NOT CHECKED"} /></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{profile.lastProviderCheckedAt ? new Date(profile.lastProviderCheckedAt).toLocaleString() : "Never"}</TableCell>
                    <TableCell className="max-w-64 truncate text-xs text-destructive">{profile.providerCheckError ?? "—"}</TableCell>
                    <TableCell className="text-right"><Button size="sm" variant="outline" disabled={reconciling === profile.id} onClick={() => void reconcileProfile(profile)}>{reconciling === profile.id ? <Spinner /> : <RefreshCcw className="size-3.5" />} Check with network</Button></TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="upload" className="mt-4 space-y-6">
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Panel
              title={
                <span className="flex items-center gap-2">
                  <PackageOpen className="size-4 text-primary" />
                  Upload eSIM profiles
                </span>
              }
              description="Bulk-add profile inventory from CSV or Excel. Batches enter a pending review before becoming sellable."
            >
              <div className="space-y-4">
                <FileUploader
                  accept=".csv,.xlsx,.xls,text/csv"
                  hint="Columns: iccid (required) · msisdn (recommended) · eid (optional)"
                  value={profileFile}
                  busy={profileBusy}
                  onFileSelected={setProfileFile}
                />
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    Source label (optional)
                  </label>
                  <input
                    type="text"
                    value={profileSource}
                    onChange={(e) => setProfileSource(e.target.value)}
                    placeholder="e.g. warehouse A, supplier B"
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">
                    Uploads are checked automatically before being added.
                  </p>
                  <Button onClick={() => void submitProfiles()} disabled={profileBusy || !profileFile}>
                    {profileBusy ? <Spinner className="text-primary-foreground" /> : <FileUp className="size-4" />}
                    Upload profiles
                  </Button>
                </div>
              </div>
            </Panel>

            <Panel
              title={
                <span className="flex items-center gap-2">
                  <Globe2 className="size-4 text-primary" />
                  Upload packages
                </span>
              }
              description="Create eSIM data packages at scale. New packages start as DRAFT for Super Admin approval."
            >
              <div className="space-y-4">
                <FileUploader
                  accept=".csv,.xlsx,.xls,text/csv"
                  hint="Columns: countryIso2, name, providerPlanId, dataAllowance, validityDays, costPrice, sellingPrice"
                  value={packageFile}
                  busy={packageBusy}
                  onFileSelected={setPackageFile}
                />
                <p className="text-xs text-muted-foreground">
                  Optional columns: currency, popular, status.
                </p>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">
                    Uploaded packages appear under Pending approvals.
                  </p>
                  <Button onClick={() => void submitPackages()} disabled={packageBusy || !packageFile}>
                    {packageBusy ? <Spinner className="text-primary-foreground" /> : <Globe2 className="size-4" />}
                    Upload packages
                  </Button>
                </div>
              </div>
            </Panel>
          </div>
        </TabsContent>

        <TabsContent value="approvals" className="mt-4 space-y-6">
          <Panel
            title="Profile batches awaiting approval"
            description="Super Admin must approve every upload before it becomes sellable."
            noPadding
          >
            {pendingBatches.length === 0 ? (
              <EmptyState
                title="No batches awaiting approval"
                description="Uploaded profiles will appear here for review."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Batch</TableHead>
                    <TableHead>Profiles</TableHead>
                    <TableHead>Uploaded</TableHead>
                    <TableHead className="text-right">Decision</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pendingBatches.map((batch) => (
                    <TableRow key={batch.id}>
                      <TableCell>
                        <p className="font-medium">{batch.batchReference}</p>
                        <p className="text-xs text-muted-foreground">{batch.id}</p>
                      </TableCell>
                      <TableCell>{batch.importedCount}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(batch.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        {isSuperAdmin ? (
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="success"
                              disabled={decision === batch.id}
                              onClick={() => {
                                if (window.confirm(`Approve this batch of ${batch.importedCount} profile(s)? They will become available for sale.`)) void decide(batch, true);
                              }}
                            >
                              {decision === batch.id ? (
                                <Spinner className="text-success-foreground" />
                              ) : (
                                <CheckCircle2 className="size-4" />
                              )}
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-destructive hover:bg-destructive/10"
                              disabled={decision === batch.id}
                              onClick={() => {
                                if (window.confirm("Reject this batch? It will not be made available for sale.")) void decide(batch, false);
                              }}
                            >
                              <XCircle className="size-4" />
                              Reject
                            </Button>
                          </div>
                        ) : (
                          <StatusBadge label="Awaiting Super Admin" tone="warning">
                            <ShieldCheck className="size-3" />
                          </StatusBadge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Panel>

          <Separator />

          <Panel
            title="Packages awaiting approval"
            description="Uploaded packages are DRAFT; approval releases them for sale."
            noPadding
          >
            {draftPlans.length === 0 ? (
              <EmptyState
                title="No packages awaiting approval"
                description="Uploaded packages will appear here for review."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Package</TableHead>
                    <TableHead>Country</TableHead>
                    <TableHead>Data</TableHead>
                    <TableHead>Price (NPR)</TableHead>
                    <TableHead className="text-right">Decision</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {draftPlans.map((plan) => (
                    <TableRow key={plan.id}>
                      <TableCell>
                        <p className="font-medium">{plan.name}</p>
                        <p className="text-xs text-muted-foreground">{plan.id}</p>
                      </TableCell>
                      <TableCell>
                        <span className="font-medium">{plan.countryCode}</span> · {plan.countryName}
                      </TableCell>
                      <TableCell>
                        {plan.dataAllowance} / {plan.validityDays} days
                      </TableCell>
                      <TableCell>NPR {plan.sellingPriceNpr}</TableCell>
                      <TableCell className="text-right">
                        {isSuperAdmin ? (
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="success"
                              disabled={planDecision === plan.id}
                              onClick={() => {
                                if (window.confirm(`Publish "${plan.name}"? It will become available for sale.`)) void decidePlan(plan, true);
                              }}
                            >
                              {planDecision === plan.id ? (
                                <Spinner className="text-success-foreground" />
                              ) : (
                                <CheckCircle2 className="size-4" />
                              )}
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-destructive hover:bg-destructive/10"
                              disabled={planDecision === plan.id}
                              onClick={() => {
                                if (window.confirm(`Reject "${plan.name}"? It will not be published.`)) void decidePlan(plan, false);
                              }}
                            >
                              <XCircle className="size-4" />
                              Reject
                            </Button>
                          </div>
                        ) : (
                          <StatusBadge label="Awaiting Super Admin" tone="warning">
                            <ShieldCheck className="size-3" />
                          </StatusBadge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <Panel
            title="Batch history"
            description="Traceability for every profile upload."
            noPadding
          >
            {data.batches.length === 0 ? (
              <EmptyState title="No batches yet" description="Uploaded batches will appear here." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reference</TableHead>
                    <TableHead>Profiles</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Uploaded</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.batches.slice(0, 15).map((batch) => (
                    <TableRow key={batch.id}>
                      <TableCell>
                        <p className="font-medium">{batch.batchReference}</p>
                      </TableCell>
                      <TableCell>
                        {batch.importedCount} / {batch.totalProfiles}
                      </TableCell>
                      <TableCell>
                        <StatusBadge label={batch.status} />
                        {batch.rejectionReason && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {batch.rejectionReason}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {new Date(batch.createdAt).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Panel>
        </TabsContent>
        <TabsContent value="profiles" className="mt-4">
          <Panel className="p-0">
            <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="font-semibold">eSIM profiles</h3>
                <p className="text-sm text-muted-foreground">
                  {profilesTotal.toLocaleString()} profiles · filter by status to see assignment and availability
                </p>
              </div>
              <div className="w-full sm:w-56">
                <Select value={profilesStatus} onValueChange={(v) => { setProfilesPage(1); setProfilesStatus(v); }}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All statuses</SelectItem>
                    {PROFILE_STATUSES.map((s) => <SelectItem key={s} value={s}>{humane(s)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {profilesLoading ? (
              <div className="flex items-center justify-center gap-2 p-10 text-muted-foreground">
                <Spinner /> Loading profiles…
              </div>
            ) : profiles.length === 0 ? (
              <EmptyState
                            icon={<Boxes className="size-6" />}
                            title="No profiles"
                            description="No eSIM profiles match the selected filters."
                          />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>eSIM</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Device eID</TableHead>
                      <TableHead>Orders</TableHead>
                      <TableHead>Batch</TableHead>
                      <TableHead className="text-right">Provider</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {profiles.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell>
                          <div className="font-mono text-xs">{p.iccid}</div>
                          {p.msisdn && <div className="text-xs text-muted-foreground">{p.msisdn}</div>}
                          {p.order ? (
                            <div className="flex items-center gap-1 text-xs text-emerald-600">
                              <Link2 className="size-3" />
                              Assigned to {p.order.customerCode}
                            </div>
                          ) : (
                            <div className="text-xs text-muted-foreground">Unassigned</div>
                          )}
                        </TableCell>
                        <TableCell>
                          {p.status === "ACTIVATED" ? (
                            <Badge className="bg-emerald-500/15 text-emerald-600"><CheckCircle2 className="size-3" /> {humane('ACTIVATED')}</Badge>
                          ) : p.status === "AVAILABLE" ? (
                            <Badge className="bg-sky-500/15 text-sky-600">{humane(p.status)}</Badge>
                          ) : (
                            <StatusBadge label={p.status} />
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{p.eid}</TableCell>
                        <TableCell>
                          {p.order ? (
                            <span className="text-xs font-medium">{p.order.orderNumber}</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="text-xs">{p.batchReference ?? "—"}</span>
                          {p.batchReference && <div className="text-[11px] text-muted-foreground">{p.batchStatus}</div>}
                        </TableCell>
                        <TableCell className="text-right text-xs">{p.smDpAddress ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <div className="border-t p-4">
              <PaginationBar
                total={profilesTotal}
                page={profilesPage}
                pageSize={PAGE_SIZE}
                onPageChange={setProfilesPage}
              />
            </div>
          </Panel>
        </TabsContent>
      </Tabs>
    </>
  );
}
