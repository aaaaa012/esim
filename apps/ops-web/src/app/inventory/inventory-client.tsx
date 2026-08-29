"use client";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { useCallback, useEffect, useRef, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { EmptyState } from "@/components/empty-state";
import { FileUploader } from "@/components/file-uploader";
import { Spinner } from "@/components/spinner";
import ErrorDialog from "@/components/error-dialog";
import { PaginationBar } from "@/components/pagination-bar";
import { SearchInput } from "@/components/search-input";
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
  quarantineReason?: string | null;
  batchReference?: string | null;
  order?: { orderNumber: string } | null;
};
type ImportResult = {
  imported: number;
  skipped: number;
  errors?: string[];
  batch: string | null;
};
type ReconciliationRun = {
  id: string;
  trigger: string;
  status: string;
  total: number;
  createdAt: string;
  completedAt?: string | null;
  counts: Record<string, number>;
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
const PROFILE_STATUSES = [
  "AVAILABLE",
  "IMPORTED",
  "RESERVED",
  "ASSIGNED",
  "ACTIVATED",
  "EXPIRED",
  "TERMINATED",
  "QUARANTINED",
];
const fileToTabularContent = async (file: File): Promise<string> => {
  if (/\.xlsx?$/i.test(file.name)) {
    const buffer = await file.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i++)
      binary += String.fromCharCode(bytes[i]!);
    return btoa(binary);
  }
  return file.text();
};

function UploadResult({
  message,
  errors,
}: {
  message: string;
  errors: string[];
}) {
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
  const [reconciliationProfiles, setReconciliationProfiles] = useState<
    InventoryProfile[]
  >([]);
  const [reconciling, setReconciling] = useState("");
  const [selectedProfiles, setSelectedProfiles] = useState<Set<string>>(
    new Set(),
  );
  const [reconciliationRun, setReconciliationRun] =
    useState<ReconciliationRun | null>(null);
  const [bulkReconciling, setBulkReconciling] = useState(false);
  const [liveQuery, setLiveQuery] = useState("");
  const [liveSearch, setLiveSearch] = useState("");
  const [batchQuery, setBatchQuery] = useState("");

  const [profileFile, setProfileFile] = useState<File | null>(null);
  const [profileSource, setProfileSource] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileResult, setProfileResult] = useState<{
    message: string;
    errors: string[];
  }>({ message: "", errors: [] });

  const [packageFile, setPackageFile] = useState<File | null>(null);
  const [packageBusy, setPackageBusy] = useState(false);

  const [draftPlans, setDraftPlans] = useState<Plan[]>([]);
  const [planDecision, setPlanDecision] = useState("");
  const [planQuery, setPlanQuery] = useState("");
  const [planSearch, setPlanSearch] = useState("");

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profilesTotal, setProfilesTotal] = useState(0);
  const [profilesPage, setProfilesPage] = useState(1);
  const [profilesStatus, setProfilesStatus] = useState("ALL");
  const [profilesQuery, setProfilesQuery] = useState("");
  const [profilesSearch, setProfilesSearch] = useState("");
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [restoring, setRestoring] = useState("");
  const refreshedReconciliationRun = useRef<string | null>(null);
  const PAGE_SIZE = 50;

  const loadProfiles = () => {
    setProfilesLoading(true);
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String((profilesPage - 1) * PAGE_SIZE),
    });
    if (profilesStatus !== "ALL") params.set("status", profilesStatus);
    if (profilesSearch) params.set("q", profilesSearch);
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
  const inventoryReady = data !== null;
  useEffect(() => {
    if (inventoryReady) loadProfiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profilesPage, profilesStatus, profilesSearch, inventoryReady]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setProfilesPage(1);
      setProfilesSearch(profilesQuery.trim());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [profilesQuery]);

  const load = () => {
    setError("");
    const liveParams = new URLSearchParams({
      limit: "100",
      assignment: "UNASSIGNED",
    });
    if (liveSearch) liveParams.set("q", liveSearch);
    void Promise.all([
      authFetch(`${API}/operations/inventory`, { headers: {} }),
      authFetch(`${API}/operations/inventory/profiles?${liveParams}`, {
        headers: {},
      }),
    ])
      .then(async ([overviewResponse, profilesResponse]) => {
        const [overviewValue, profilesValue] = await Promise.all([
          overviewResponse.json(),
          profilesResponse.json(),
        ]);
        if (!overviewResponse.ok) throw new Error(overviewValue.error?.message);
        if (!profilesResponse.ok) throw new Error(profilesValue.error?.message);
        setData(overviewValue.data);
        setReconciliationProfiles(profilesValue.data.items);
      })
      .catch((e) => setError(e.message));
  };
  useEffect(() => {
    const timer = window.setTimeout(() => setLiveSearch(liveQuery.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [liveQuery]);
  useEffect(() => {
    if (data) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSearch]);
  const reconcileProfile = async (profile: InventoryProfile) => {
    setReconciling(profile.id);
    try {
      const response = await authFetch(
        `${API}/operations/inventory/profiles/${profile.id}/reconcile`,
        { method: "POST", headers: {} },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(
          value.error?.message ?? "Provider reconciliation failed",
        );
      toast.success(`${profile.iccid} checked against Transatel`);
      load();
    } catch (cause) {
      toast.error(
        cause instanceof Error
          ? cause.message
          : "Provider reconciliation failed",
      );
    } finally {
      setReconciling("");
    }
  };
  const loadReconciliationRun = useCallback(
    async (id?: string) => {
      const response = await authFetch(
        `${API}/operations/inventory/reconciliation-runs/${id ?? "latest"}`,
        { headers: {} },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(
          value.error?.message ?? "Inventory refresh unavailable",
        );
      setReconciliationRun(value.data ?? null);
    },
    [authFetch],
  );
  useEffect(() => {
    void loadReconciliationRun().catch(() => undefined);
  }, [loadReconciliationRun]);
  useEffect(() => {
    if (!reconciliationRun || reconciliationRun.status === "COMPLETED") return;
    const timer = window.setInterval(() => {
      void loadReconciliationRun(reconciliationRun.id)
        .catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [loadReconciliationRun, reconciliationRun?.id, reconciliationRun?.status]);
  useEffect(() => {
    if (
      !reconciliationRun ||
      reconciliationRun.status !== "COMPLETED" ||
      refreshedReconciliationRun.current === reconciliationRun.id
    )
      return;
    refreshedReconciliationRun.current = reconciliationRun.id;
    load();
    // Refresh overview and visible reconciliation rows exactly once when a run
    // finishes. `load` intentionally reads the current live-search value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconciliationRun?.id, reconciliationRun?.status]);
  const startBulkReconciliation = async () => {
    setBulkReconciling(true);
    try {
      const profileIds = [...selectedProfiles];
      const response = await authFetch(
        `${API}/operations/inventory/reconciliation-runs`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            profileIds.length
              ? { scope: "SELECTED", profileIds }
              : { scope: "STALE_OR_UNVERIFIED" },
          ),
        },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error?.message ?? "Inventory refresh failed");
      if (!value.data?.run) {
        toast.info(value.data?.message ?? "No profiles need refreshing");
        return;
      }
      setReconciliationRun(value.data.run);
      setSelectedProfiles(new Set());
      toast.success(`Queued ${value.data.run.total} profile(s) for checking`);
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "Inventory refresh failed",
      );
    } finally {
      setBulkReconciling(false);
    }
  };
  const restoreProfile = async (profile: InventoryProfile) => {
    setRestoring(profile.id);
    try {
      const response = await authFetch(
        `${API}/operations/inventory/profiles/${profile.id}/restore-availability`,
        { method: "POST", headers: {} },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(
          value.error?.message ?? "Availability restoration failed",
        );
      toast.success(`${profile.iccid} restored to available stock`);
      load();
    } catch (cause) {
      toast.error(
        cause instanceof Error
          ? cause.message
          : "Availability restoration failed",
      );
    } finally {
      setRestoring("");
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitProfiles = async () => {
    if (!profileFile) {
      toast.error("Choose a CSV or Excel file first");
      return;
    }
    setProfileBusy(true);
    setProfileResult({ message: "", errors: [] });
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
      if (!r.ok) {
        const correlation = v.meta?.correlationId;
        throw new Error(
          `${v.error?.message ?? "CSV/Excel import failed"}${correlation ? ` (reference: ${correlation})` : ""}`,
        );
      }
      const result = v.data as ImportResult;
      const errors = result.errors ?? [];
      const message = result.imported
        ? `Imported ${result.imported} profile(s); skipped ${result.skipped} invalid row(s). The valid profiles await Super Admin approval.`
        : `No eSIM profiles were imported. ${result.skipped} invalid row(s) must be corrected.`;
      setProfileResult({ message, errors });
      if (result.imported > 0) toast.success(message);
      else toast.error(message);
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
          ...(approve
            ? {}
            : { body: JSON.stringify({ reason: "Rejected by Super Admin" }) }),
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
    const params = new URLSearchParams({
      status: "DRAFT",
      limit: "100",
      offset: "0",
    });
    if (planSearch) params.set("q", planSearch);
    void authFetch(`${API}/admin/plans/page?${params}`, { headers: {} })
      .then(async (r) => {
        const v = await r.json();
        if (!r.ok) throw new Error(v.error?.message);
        setDraftPlans(v.data?.items ?? []);
      })
      .catch((e) => toast.error(e.message));
  };
  useEffect(() => {
    const timer = window.setTimeout(() => setPlanSearch(planQuery.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [planQuery]);
  useEffect(() => {
    loadPlans();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planSearch]);

  const decidePlan = async (plan: Plan, approve: boolean) => {
    setPlanDecision(plan.id);
    try {
      const r = await authFetch(
        `${API}/admin/plans/${plan.id}/${approve ? "approve" : "reject"}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
        },
      );
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
      <>
        <ErrorDialog error={error} onClose={() => setError("")} />
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
          {error ? (
            <>
              <p className="max-w-md text-center text-sm text-muted-foreground">
                Could not load inventory. Please try again.
              </p>
              <Button onClick={load}>Try again</Button>
            </>
          ) : (
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Spinner /> Loading inventory…
            </div>
          )}
        </div>
      </>
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
      tone: data.counts.quarantined
        ? ("danger" as const)
        : ("default" as const),
    },
  ];
  const batchSearch = batchQuery.trim().toLowerCase();
  const filteredBatches = data.batches.filter(
    (batch) =>
      !batchSearch ||
      batch.batchReference.toLowerCase().includes(batchSearch) ||
      batch.id.toLowerCase().includes(batchSearch),
  );
  const pendingBatches = filteredBatches.filter(
    (batch) => batch.status === "PENDING",
  );
  const reconciliationCompleted = reconciliationRun
    ? (reconciliationRun.counts.success ?? 0) +
      (reconciliationRun.counts.not_found ?? 0) +
      (reconciliationRun.counts.failed ?? 0)
    : 0;

  return (
    <>
      <ErrorDialog error={error} onClose={() => setError("")} />
      <PageHeader
        title="eSIM stock"
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
              <span className="ml-1 rounded-full bg-destructive/15 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">
                {data.counts.quarantined}
              </span>
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
          <Panel
            title="Stock check against the network provider"
            description="Compares the latest 100 unassigned profiles with the network provider. Profiles that don't match are flagged automatically."
            actions={
              <SearchInput
                value={liveQuery}
                onChange={setLiveQuery}
                placeholder="Search ICCID, EID, MSISDN or batch…"
                className="w-full sm:w-80"
              />
            }
            noPadding
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
              <p className="text-xs text-muted-foreground">
                {selectedProfiles.size
                  ? `${selectedProfiles.size} profile(s) selected`
                  : "Checks profiles never verified or not checked in the last 24 hours."}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={bulkReconciling}
                onClick={() => void startBulkReconciliation()}
              >
                {bulkReconciling ? (
                  <Spinner />
                ) : (
                  <RefreshCcw className="size-3.5" />
                )}
                {selectedProfiles.size
                  ? "Refresh selected"
                  : "Refresh stale & unverified"}
              </Button>
            </div>
            {reconciliationRun && (
              <div className="border-b bg-muted/30 px-4 py-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {humane(reconciliationRun.trigger)} refresh ·{" "}
                    {humane(reconciliationRun.status)}
                  </span>
                  <span className="text-muted-foreground">
                    {reconciliationCompleted}/{reconciliationRun.total} checked
                    {` · ${reconciliationRun.counts.not_found ?? 0} not found · ${reconciliationRun.counts.failed ?? 0} failed`}
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-[width]"
                    style={{
                      width: `${Math.round(
                        (reconciliationCompleted /
                          Math.max(1, reconciliationRun.total)) *
                          100,
                      )}%`,
                    }}
                  />
                </div>
              </div>
            )}
            {!reconciliationProfiles.length ? (
              <EmptyState
                title="No inventory profiles"
                description="Uploaded profiles will appear here."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        aria-label="Select all visible profiles"
                        checked={
                          reconciliationProfiles.length > 0 &&
                          reconciliationProfiles.every((profile) =>
                            selectedProfiles.has(profile.id),
                          )
                        }
                        onChange={(event) =>
                          setSelectedProfiles(
                            event.target.checked
                              ? new Set(
                                  reconciliationProfiles.map(
                                    (profile) => profile.id,
                                  ),
                                )
                              : new Set(),
                          )
                        }
                      />
                    </TableHead>
                    <TableHead>eSIM</TableHead>
                    <TableHead>Our system</TableHead>
                    <TableHead>Network provider</TableHead>
                    <TableHead>Last checked</TableHead>
                    <TableHead>Issue</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reconciliationProfiles.map((profile) => (
                    <TableRow key={profile.id}>
                      <TableCell>
                        <input
                          type="checkbox"
                          aria-label={`Select ${profile.iccid}`}
                          checked={selectedProfiles.has(profile.id)}
                          onChange={(event) => {
                            const next = new Set(selectedProfiles);
                            if (event.target.checked) next.add(profile.id);
                            else next.delete(profile.id);
                            setSelectedProfiles(next);
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <code className="text-xs">{profile.iccid}</code>
                        <p className="text-xs text-muted-foreground">
                          {profile.batchReference ?? "—"}
                        </p>
                      </TableCell>
                      <TableCell>
                        <StatusBadge
                          label={profile.status}
                          {...(profile.status === "QUARANTINED"
                            ? { tone: "warning" as const }
                            : {})}
                        />
                      </TableCell>
                      <TableCell>
                        <StatusBadge
                          label={profile.providerStatus ?? "NOT CHECKED"}
                        />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {profile.lastProviderCheckedAt
                          ? new Date(
                              profile.lastProviderCheckedAt,
                            ).toLocaleString()
                          : "Never"}
                      </TableCell>
                      <TableCell className="max-w-64 whitespace-normal break-words text-xs">
                        {profile.quarantineReason ? (
                          <span className="text-destructive">
                            {profile.quarantineReason}
                          </span>
                        ) : profile.providerCheckError ? (
                          <span className="text-destructive">
                            {profile.providerCheckError}
                          </span>
                        ) : profile.status === "AVAILABLE" &&
                          !["available", "allocated", "released"].includes(
                            profile.providerStatus?.toLowerCase() ?? "",
                          )
                            ? (
                                <span className="text-destructive">
                                  {`Local stock is marked available, but ${humane(profile.providerStatus ?? "not checked")} is not safe for sale`}
                                </span>
                              )
                            : profile.status === "PENDING_PROVIDER_CHECK"
                              ? (
                                  <span className="text-muted-foreground">
                                    Provider verification is required before sale
                                  </span>
                                )
                              : profile.status === "QUARANTINED"
                            ? (
                                <span className="text-destructive">
                                  {`${humane(profile.providerStatus ?? "unknown")} is not currently safe for sale`}
                                </span>
                              )
                            : (
                                <span className="text-muted-foreground">—</span>
                              )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={
                              reconciling === profile.id ||
                              restoring === profile.id
                            }
                            onClick={() => void reconcileProfile(profile)}
                          >
                            {reconciling === profile.id ? (
                              <Spinner />
                            ) : (
                              <RefreshCcw className="size-3.5" />
                            )}{" "}
                            Check network
                          </Button>
                          {isSuperAdmin &&
                          profile.status === "QUARANTINED" &&
                          ["available", "allocated", "released"].includes(
                            profile.providerStatus?.toLowerCase() ?? "",
                          ) ? (
                            <Button
                              size="sm"
                              disabled={
                                restoring === profile.id ||
                                reconciling === profile.id
                              }
                              onClick={() => void restoreProfile(profile)}
                            >
                              {restoring === profile.id ? (
                                <Spinner />
                              ) : (
                                <ShieldCheck className="size-3.5" />
                              )}{" "}
                              Restore availability
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
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
                  onFileSelected={(file) => {
                    setProfileFile(file);
                    setProfileResult({ message: "", errors: [] });
                  }}
                />
                <UploadResult
                  message={profileResult.message}
                  errors={profileResult.errors}
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
                  <Button
                    onClick={() => void submitProfiles()}
                    disabled={profileBusy || !profileFile}
                  >
                    {profileBusy ? (
                      <Spinner className="text-primary-foreground" />
                    ) : (
                      <FileUp className="size-4" />
                    )}
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
                  <Button
                    onClick={() => void submitPackages()}
                    disabled={packageBusy || !packageFile}
                  >
                    {packageBusy ? (
                      <Spinner className="text-primary-foreground" />
                    ) : (
                      <Globe2 className="size-4" />
                    )}
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
            actions={
              <SearchInput
                value={batchQuery}
                onChange={setBatchQuery}
                placeholder="Search batch reference or ID…"
                className="w-full sm:w-72"
              />
            }
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
                        <p className="text-xs text-muted-foreground">
                          {batch.id}
                        </p>
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
                                if (
                                  window.confirm(
                                    `Approve this batch of ${batch.importedCount} profile(s)? They will become available for sale.`,
                                  )
                                )
                                  void decide(batch, true);
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
                                if (
                                  window.confirm(
                                    "Reject this batch? It will not be made available for sale.",
                                  )
                                )
                                  void decide(batch, false);
                              }}
                            >
                              <XCircle className="size-4" />
                              Reject
                            </Button>
                          </div>
                        ) : (
                          <StatusBadge
                            label="Awaiting Super Admin"
                            tone="warning"
                          >
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
            actions={
              <SearchInput
                value={planQuery}
                onChange={setPlanQuery}
                placeholder="Search package or country…"
                className="w-full sm:w-72"
              />
            }
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
                        <p className="text-xs text-muted-foreground">
                          {plan.id}
                        </p>
                      </TableCell>
                      <TableCell>
                        <span className="font-medium">{plan.countryCode}</span>{" "}
                        · {plan.countryName}
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
                                if (
                                  window.confirm(
                                    `Publish "${plan.name}"? It will become available for sale.`,
                                  )
                                )
                                  void decidePlan(plan, true);
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
                                if (
                                  window.confirm(
                                    `Reject "${plan.name}"? It will not be published.`,
                                  )
                                )
                                  void decidePlan(plan, false);
                              }}
                            >
                              <XCircle className="size-4" />
                              Reject
                            </Button>
                          </div>
                        ) : (
                          <StatusBadge
                            label="Awaiting Super Admin"
                            tone="warning"
                          >
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
            actions={
              <SearchInput
                value={batchQuery}
                onChange={setBatchQuery}
                placeholder="Search batch reference or ID…"
                className="w-full sm:w-72"
              />
            }
            noPadding
          >
            {filteredBatches.length === 0 ? (
              <EmptyState
                title="No batches found"
                description={
                  batchSearch
                    ? `No batch matches “${batchQuery.trim()}”.`
                    : "Uploaded batches will appear here."
                }
              />
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
                  {filteredBatches.map((batch) => (
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
                  {profilesTotal.toLocaleString()} profiles · search
                  identifiers, orders, batches, or customers
                </p>
              </div>
              <div className="grid w-full gap-2 sm:w-auto sm:grid-cols-[minmax(20rem,28rem)_14rem]">
                <SearchInput
                  value={profilesQuery}
                  onChange={setProfilesQuery}
                  placeholder="Search ICCID, MSISDN, order or customer…"
                  className="w-full"
                />
                <Select
                  value={profilesStatus}
                  onValueChange={(v) => {
                    setProfilesPage(1);
                    setProfilesStatus(v);
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All statuses</SelectItem>
                    {PROFILE_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {humane(s)}
                      </SelectItem>
                    ))}
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
                description={
                  profilesSearch
                    ? `No eSIM profiles match “${profilesSearch}”.`
                    : "No eSIM profiles match the selected filters."
                }
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
                          {p.msisdn && (
                            <div className="text-xs text-muted-foreground">
                              {p.msisdn}
                            </div>
                          )}
                          {p.order ? (
                            <div className="flex items-center gap-1 text-xs text-emerald-600">
                              <Link2 className="size-3" />
                              Assigned to {p.order.customerCode}
                            </div>
                          ) : (
                            <div className="text-xs text-muted-foreground">
                              Unassigned
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          {p.status === "ACTIVATED" ? (
                            <Badge className="bg-emerald-500/15 text-emerald-600">
                              <CheckCircle2 className="size-3" />{" "}
                              {humane("ACTIVATED")}
                            </Badge>
                          ) : p.status === "AVAILABLE" ? (
                            <Badge className="bg-sky-500/15 text-sky-600">
                              {humane(p.status)}
                            </Badge>
                          ) : (
                            <StatusBadge label={p.status} />
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {p.eid}
                        </TableCell>
                        <TableCell>
                          {p.order ? (
                            <span className="text-xs font-medium">
                              {p.order.orderNumber}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              —
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="text-xs">
                            {p.batchReference ?? "—"}
                          </span>
                          {p.batchReference && (
                            <div className="text-[11px] text-muted-foreground">
                              {p.batchStatus}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-xs">
                          {p.smDpAddress ?? "—"}
                        </TableCell>
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
