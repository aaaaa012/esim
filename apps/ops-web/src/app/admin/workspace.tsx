"use client";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Building2,
  CheckCircle2,
  Download,
  FlaskConical,
  History,
  KeyRound,
  Link2,
  Pencil,
  RefreshCcw,
  Save,
  Settings2,
  ShieldCheck,
  Upload,
  UsersRound,
  XCircle,
  Wallet,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/spinner";
import { EmptyState } from "@/components/empty-state";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
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
type Plan = {
  id: string;
  name: string;
  countryCode: string;
  countryName: string;
  dataAllowance: string;
  validityDays: number;
  sellingPriceNpr: number;
  costPriceNpr: number;
  currency: string;
  popular: boolean;
  status: "DRAFT" | "ACTIVE" | "DISABLED" | "ARCHIVED";
};
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
type User = {
  id: string;
  clerkId: string;
  email: string;
  status: "ACTIVE" | "DISABLED";
  accountType: "CUSTOMER" | "OPERATIONS" | "SUPER_ADMIN";
  effectiveCapabilities: string[];
  customerCode?: string;
  createdAt: string;
};
type Invitation = {
  id: string;
  email: string;
  accountType: "OPERATIONS" | "SUPER_ADMIN";
  status: string;
  expiresAt: string;
};
type IntegrationLog = {
  id: string;
  operation: string;
  method: string;
  endpoint: string;
  status: number;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
};
type Partner = {
  id: string;
  code: string;
  name: string;
  status: "PENDING" | "ACTIVE" | "SUSPENDED" | "DISABLED";
  integrationType: "API" | "CHECKOUT_LINK";
  rateLimitPerMinute: number;
  account?: {
    balancePaisa: number;
    creditLimitPaisa: number;
    reservedPaisa: number;
  } | null;
  credentials: Array<{ id: string; keyPrefix: string; status: string }>;
  _count: { orders: number; quotes: number };
};

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

export default function AdminWorkspace() {
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
  const [tab, setTab] = useState("Plans");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteType, setInviteType] = useState<"OPERATIONS" | "SUPER_ADMIN">("OPERATIONS");
  const [partners, setPartners] = useState<Partner[]>([]);
  const [partnerCode, setPartnerCode] = useState("");
  const [partnerName, setPartnerName] = useState("");
  const [issuedPartnerKey, setIssuedPartnerKey] = useState<{
    partnerName: string;
    apiKey: string;
  } | null>(null);
  const [partnerBalance, setPartnerBalance] = useState("");
  const [partnerType, setPartnerType] = useState<"API" | "CHECKOUT_LINK">("API");
  const [hostedLinkFor, setHostedLinkFor] = useState<Partner | null>(null);
  const [hostedLinkPlanId, setHostedLinkPlanId] = useState("");
  const [hostedLinkMobile, setHostedLinkMobile] = useState("");
  const [hostedLinkResult, setHostedLinkResult] = useState<{
    partnerName: string;
    checkoutUrl: string;
    orderType?: string;
    topUpMobile?: string;
    topUpStatus?: "BOUND" | "UNAVAILABLE";
  } | null>(null);
  const [hostedLinkBusy, setHostedLinkBusy] = useState(false);
  const [lookupState, setLookupState] = useState<{
    status: "idle" | "checking" | "ok" | "error";
    message?: string | undefined;
    subscriber?: {
      countryCode: string;
      countryName: string;
      currentPlan?: string | undefined;
      hasActiveEsim?: boolean | undefined;
    };
    planCountryCode?: string | undefined;
  } | null>(null);
  const [adjustFor, setAdjustFor] = useState<Partner | null>(null);
  const [adjustType, setAdjustType] = useState<"credit" | "debit">("credit");
  const [adjustAmountNpr, setAdjustAmountNpr] = useState("");
  const [adjustReference, setAdjustReference] = useState("");
  const [adjustBusy, setAdjustBusy] = useState(false);
  const [busy, setBusy] = useState("");
  const [planCsvFile, setPlanCsvFile] = useState<File | null>(null);
  const [planCsvBusy, setPlanCsvBusy] = useState(false);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [eligibilityPlanId, setEligibilityPlanId] = useState("");
  const [eligibilityMsisdn, setEligibilityMsisdn] = useState("");
  const [logs, setLogs] = useState<IntegrationLog[]>([]);
  const [logsBusy, setLogsBusy] = useState(false);

  const load = () =>
    Promise.all([
      request<Plan[]>("/admin/plans"),
      request<Integration[]>("/admin/integrations"),
      request<User[]>("/admin/users"),
      request<Invitation[]>("/admin/staff-invitations"),
      request<Partner[]>("/admin/partners"),
    ])
      .then(([p, i, u, invitationsValue, partnerValues]) => {
        setPlans(p);
        setIntegrations(i);
        setUsers(u);
        setInvitations(invitationsValue);
        setPartners(partnerValues);
      })
      .catch((e) => toast.error(e.message));
  useEffect(() => {
    void load();
  }, []);
  const savePlan = async (plan: Plan) => {
    setBusy(plan.id);
    try {
      const updated = await request<Plan>(`/admin/plans/${plan.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          sellingPriceNpr: plan.sellingPriceNpr,
          popular: plan.popular,
          status: plan.status,
        }),
      });
      setPlans((v) => v.map((item) => (item.id === updated.id ? updated : item)));
      toast.success(`${updated.name} saved`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy("");
    }
  };
  const reviewPlan = async (plan: Plan, approve: boolean) => {
    setBusy(`${plan.id}:${approve ? "approve" : "reject"}`);
    try {
      const updated = await request<Plan>(
        `/admin/plans/${plan.id}/${approve ? "approve" : "reject"}`,
        {
          method: "POST",
          body: JSON.stringify({ reason: approve ? undefined : "Rejected by Super Admin" }),
        },
      );
      setPlans((v) => v.map((item) => (item.id === updated.id ? updated : item)));
      toast.success(
        approve
          ? `${updated.name} approved and now visible to customers`
          : `${updated.name} rejected and archived`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Review failed");
    } finally {
      setBusy("");
    }
  };
  const importPlanCsv = async () => {
    if (!planCsvFile) {
      toast.error("Choose a CSV or Excel file first");
      return;
    }
    setPlanCsvBusy(true);
    try {
      const content = await fileToTabularContent(planCsvFile);
      const result = await request<{
        imported: number;
        updated: number;
        skipped: number;
        errors: string[];
      }>("/admin/plans/import-csv", {
        method: "POST",
        body: JSON.stringify({ content, fileName: planCsvFile.name }),
      });
      toast.success(
        `Imported ${result.imported}, updated ${result.updated}, skipped ${result.skipped} row(s)`,
      );
      if (result.errors?.length) toast.error(result.errors.slice(0, 5).join(" · "));
      setPlanCsvFile(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "CSV import failed");
    } finally {
      setPlanCsvBusy(false);
    }
  };
  const downloadCatalog = async () => {
    setCatalogBusy(true);
    try {
      const result = await request<{ fileName: string; csv: string; count: number; skipped: number }>(
        "/admin/integrations/transatel/catalog-export",
        { method: "POST" },
      );
      const blob = new Blob(["\uFEFF" + result.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success(
        `Downloaded ${result.count} catalog row(s)${result.skipped ? ` (${result.skipped} skipped)` : ""}`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Catalog download failed");
    } finally {
      setCatalogBusy(false);
    }
  };
  const test = async (item: Integration) => {
    setBusy(item.id);
    try {
      const result = await request<{ message: string }>(`/admin/integrations/${item.id}/test`, {
        method: "POST",
      });
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
      const result = await request<Record<string, unknown>>(
        `/admin/integrations/transatel/${action}`,
        { method: "POST" },
      );
      toast.success(
        JSON.stringify(result, null, 2).slice(0, 400) || `${action.replace("-", " ")} complete`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${action} failed`);
    } finally {
      setBusy("");
    }
  };
  const inviteStaff = async () => {
    setBusy("invite");
    try {
      const result = await request<{
        email: string;
        accountType: string;
        temporaryPassword: string;
      }>("/admin/staff-invitations", {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail, accountType: inviteType }),
      });
      setInviteEmail("");
      await load();
      toast.success(
        `Account created for ${result.email}. One-time password: ${result.temporaryPassword} — share it securely; the staff member should change it after signing in.`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invitation failed");
    } finally {
      setBusy("");
    }
  };
  const saveUser = async (user: User) => {
    setBusy(user.id);
    try {
      let updated = user;
      if (user.accountType !== "CUSTOMER")
        updated = await request<User>(`/admin/users/${user.id}/account-type`, {
          method: "PATCH",
          body: JSON.stringify({ accountType: user.accountType }),
        });
      await request(`/admin/users/${user.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: user.status }),
      });
      setUsers((v) => v.map((item) => (item.id === updated.id ? updated : item)));
      toast.success(`Account updated for ${user.email}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Account update failed");
    } finally {
      setBusy("");
    }
  };
  const createPartner = async () => {
    setBusy("partner-create");
    try {
      await request("/admin/partners", {
        method: "POST",
        body: JSON.stringify({
          code: partnerCode,
          name: partnerName,
          settlementMethods: ["PARTNER_ACCOUNT"],
          integrationType: partnerType,
          ...(partnerBalance
            ? { balancePaisa: Math.round(Number(partnerBalance) * 100) }
            : {}),
        }),
      });
      setPartnerCode("");
      setPartnerName("");
      setPartnerBalance("");
      await load();
      toast.success("Partner created in pending state");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Partner creation failed");
    } finally {
      setBusy("");
    }
  };
  const changePartnerStatus = async (partner: Partner, status: Partner["status"]) => {
    setBusy(partner.id);
    try {
      await request(`/admin/partners/${partner.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      await load();
      toast.success(`${partner.name} is now ${status.toLowerCase()}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Partner update failed");
    } finally {
      setBusy("");
    }
  };
  const issuePartnerKey = async (partner: Partner) => {
    setBusy(`key-${partner.id}`);
    try {
      const result = await request<{ apiKey: string }>(`/admin/partners/${partner.id}/credentials`, {
        method: "POST",
        body: JSON.stringify({
          name: `Key ${partner.credentials.length + 1}`,
          scopes:
            partner.integrationType === "CHECKOUT_LINK"
              ? ["catalog:read", "checkout:write", "orders:read"]
              : [
                  "catalog:read",
                  "checkout:write",
                  "orders:read",
                  "orders:write",
                  "documents:write",
                  "refunds:write",
                  "usage:read",
                  "esims:read",
                ],
        }),
      });
      setIssuedPartnerKey({ partnerName: partner.name, apiKey: result.apiKey });
      let copied = false;
      try {
        await navigator.clipboard.writeText(result.apiKey);
        copied = true;
      } catch {
        // The one-time key remains visible below when clipboard access is denied.
      }
      await load();
      toast.success(
        copied
          ? "New API key issued and copied. Verify the visible value before use."
          : "New API key issued. Copy the visible value before dismissing it.",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Credential creation failed");
    } finally {
      setBusy("");
    }
  };
  const revokePartnerKey = async (partner: Partner, credentialId: string) => {
    setBusy(`revoke-${credentialId}`);
    try {
      await request(`/admin/partners/${partner.id}/credentials/${credentialId}`, { method: "DELETE" });
      await load();
      toast.success(`Credential revoked for ${partner.name}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Credential revocation failed");
    } finally {
      setBusy("");
    }
  };
  const generateCheckoutLink = async () => {
    if (!hostedLinkFor || !hostedLinkPlanId) {
      toast.error("Choose a plan first");
      return;
    }
    setHostedLinkBusy(true);
    try {
      const result = await request<{ checkoutUrl: string; orderType?: string; topUp?: { mobile?: string; status?: string } }>(
        `/admin/partners/${hostedLinkFor.id}/hosted-checkout-sessions`,
        {
          method: "POST",
          body: JSON.stringify({
            planId: hostedLinkPlanId,
            externalOrderId: `vc-portal-${Date.now()}`,
            externalCustomerId: `portal-customer-${Date.now()}`,
            ...(hostedLinkMobile.trim() ? { topUpMobile: hostedLinkMobile.trim() } : {}),
          }),
        },
      );
      setHostedLinkResult({
        partnerName: hostedLinkFor.name,
        checkoutUrl: result.checkoutUrl,
        ...(result.orderType ? { orderType: result.orderType } : {}),
        ...(result.topUp?.mobile ? { topUpMobile: result.topUp.mobile } : {}),
        ...(result.topUp?.status === "UNAVAILABLE" ? { topUpStatus: "UNAVAILABLE" } : result.topUp?.status === "BOUND" ? { topUpStatus: "BOUND" } : {}),
      });
      toast.success("Checkout link generated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Link generation failed");
    } finally {
      setHostedLinkBusy(false);
    }
  };
  const validateMobile = async () => {
    const mobile = hostedLinkMobile.trim();
    const plan = plans.find((plan) => plan.id === hostedLinkPlanId);
    if (!mobile) {
      setLookupState(null);
      return;
    }
    setLookupState({ status: "checking" });
    try {
      const result = await request<{
        found: boolean;
        subscriber?: {
          countryCode: string;
          countryName: string;
          currentPlan?: { name?: string; countryCode?: string };
          hasActiveEsim?: boolean | undefined;
        };
      }>(`/operations/topup/lookup?mobile=${encodeURIComponent(mobile)}`);
      if (!result.found || !result.subscriber) {
        setLookupState({
          status: "error",
          message:
            "No completed order found for this number. This link will create a new purchase, not a top-up.",
        });
        return;
      }
      const sub = result.subscriber;
      const sameCountry =
        plan !== undefined &&
        sub.countryCode.toUpperCase() === plan.countryCode.toUpperCase();
      if (!sameCountry) {
        setLookupState({
          status: "error",
          subscriber: { countryCode: sub.countryCode, countryName: sub.countryName, currentPlan: sub.currentPlan?.name, hasActiveEsim: sub.hasActiveEsim },
          planCountryCode: plan?.countryCode,
          message: `Subscriber's existing plan is in ${sub.countryName} (${sub.countryCode}), which does not match the selected plan (${plan?.countryCode ?? "?"}). A top-up requires the same country — this will be a new purchase.`,
        });
        return;
      }
      setLookupState({
        status: "ok",
        subscriber: { countryCode: sub.countryCode, countryName: sub.countryName, currentPlan: sub.currentPlan?.name, hasActiveEsim: sub.hasActiveEsim },
        planCountryCode: plan?.countryCode,
        message: sub.hasActiveEsim === false
          ? "Subscriber found, but no active eSIM was detected. Confirm this is the correct number."
          : undefined,
      });
    } catch (error) {
      setLookupState({
        status: "error",
        message: error instanceof Error ? error.message : "Lookup failed",
      });
    }
  };
  const applyAdjustment = async () => {
    if (!adjustFor || !adjustAmountNpr) {
      toast.error("Enter an amount first");
      return;
    }
    setAdjustBusy(true);
    try {
      const amountNpr = Number(adjustAmountNpr);
      if (!Number.isFinite(amountNpr) || amountNpr <= 0) {
        toast.error("Enter a positive amount");
        return;
      }
      const amountPaisa =
        (adjustType === "credit" ? 1 : -1) * Math.round(amountNpr * 100);
      await request(`/admin/partners/${adjustFor.id}/ledger-adjustments`, {
        method: "POST",
        body: JSON.stringify({
          amountPaisa,
          creditLimitPaisa: 0,
          reference: adjustReference || `portal-adjustment-${Date.now()}`,
          reason: `Balance ${adjustType} via portal`,
        }),
      });
      toast.success(`Balance ${adjustType === "credit" ? "credited" : "debited"}`);
      setAdjustFor(null);
      setAdjustAmountNpr("");
      setAdjustReference("");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Adjustment failed");
    } finally {
      setAdjustBusy(false);
    }
  };
  const checkEligibility = async () => {
    if (!eligibilityPlanId || !eligibilityMsisdn) {
      toast.error("Choose a plan and enter an MSISDN first");
      return;
    }
    setBusy("transatel:eligibility");
    try {
      const result = await request<Record<string, unknown>>(
        "/admin/integrations/transatel/eligibility",
        {
          method: "POST",
          body: JSON.stringify({ planId: eligibilityPlanId, msisdn: eligibilityMsisdn }),
        },
      );
      toast.success(JSON.stringify(result, null, 2).slice(0, 400) || "Eligibility check complete");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Eligibility check failed");
    } finally {
      setBusy("");
    }
  };
  const loadLogs = async () => {
    setLogsBusy(true);
    try {
      setLogs(await request<IntegrationLog[]>("/operations/integration-logs"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load integration logs");
    } finally {
      setLogsBusy(false);
    }
  };
  useEffect(() => {
    if (tab === "Integrations") void loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const planTabVisible = tab === "Plans";

  return (
    <>
      <PageHeader
        title="Administration"
        description="Manage plans, pricing, integrations, document rules, inventory settings, users, and system configuration."
        badge={
          <Badge variant="success" className="gap-1.5">
            <ShieldCheck className="size-3" />
            Super Admin access
          </Badge>
        }
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-6 flex h-10 w-full justify-start overflow-x-auto rounded-lg bg-transparent p-0">
          {["Plans", "Integrations", "Document Rules", "Inventory Settings", "Users", "Partners", "System Config"].map((item) => (
            <TabsTrigger
              key={item}
              value={item}
              className={cn(
                "flex-none rounded-md px-4 py-2 text-sm",
                tab === item && "bg-card shadow-xs",
              )}
            >
              {item}
            </TabsTrigger>
          ))}
        </TabsList>

        {(planTabVisible) && (
          <TabsContent value={planTabVisible ? tab : ""} className="mt-0">
            <Panel
              title="Plan catalogue"
              description="Changes affect new immutable order quotes only."
              actions={
                <div className="flex items-center gap-3">
                  <Button
                    variant="outline"
                    onClick={() => void downloadCatalog()}
                    disabled={catalogBusy}
                  >
                    {catalogBusy ? <Spinner /> : <Download className="size-4" />}
                    Download catalog
                  </Button>
                  <Input
                    type="file"
                    accept=".csv,.xlsx,.xls,text/csv"
                    onChange={(e) => setPlanCsvFile(e.target.files?.[0] ?? null)}
                    className="h-9 w-64 text-xs"
                  />
                  <Button
                    onClick={() => void importPlanCsv()}
                    disabled={planCsvBusy || !planCsvFile}
                  >
                    {planCsvBusy ? <Spinner className="text-primary-foreground" /> : <Upload className="size-4" />}
                    Upload CSV
                  </Button>
                </div>
              }
              noPadding
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Plan</TableHead>
                    <TableHead>Package</TableHead>
                    <TableHead>Cost</TableHead>
                    <TableHead>Selling price</TableHead>
                    <TableHead>Visibility</TableHead>
                    <TableHead>Popular</TableHead>
                    <TableHead className="text-right"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plans.map((plan) => (
                    <TableRow key={plan.id}>
                      <TableCell>
                        <p className="font-medium">
                          {plan.countryCode} · {plan.name}
                        </p>
                        <p className="text-xs text-muted-foreground">{plan.countryName}</p>
                      </TableCell>
                      <TableCell>
                        {plan.dataAllowance} · {plan.validityDays} days
                      </TableCell>
                      <TableCell className="tabular-nums">NPR {plan.costPriceNpr.toLocaleString()}</TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          className="w-28"
                          value={plan.sellingPriceNpr}
                          onChange={(e) =>
                            setPlans((v) =>
                              v.map((item) =>
                                item.id === plan.id
                                  ? { ...item, sellingPriceNpr: Number(e.target.value) }
                                  : item,
                              ),
                            )
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <Select
                          value={plan.status}
                          onValueChange={(value) =>
                            setPlans((v) =>
                              v.map((item) =>
                                item.id === plan.id
                                  ? { ...item, status: value as Plan["status"] }
                                  : item,
                              ),
                            )
                          }
                        >
                          <SelectTrigger className="w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="ACTIVE">ACTIVE</SelectItem>
                            <SelectItem value="DISABLED">DISABLED</SelectItem>
                            <SelectItem value="DRAFT">DRAFT</SelectItem>
                            <SelectItem value="ARCHIVED">ARCHIVED</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={plan.popular}
                          onCheckedChange={() =>
                            setPlans((v) =>
                              v.map((item) =>
                                item.id === plan.id ? { ...item, popular: !item.popular } : item,
                              ),
                            )
                          }
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          {plan.status === "DRAFT" && (
                            <>
                              <Button
                                size="sm"
                                variant="success"
                                disabled={busy === `${plan.id}:approve`}
                                onClick={() => void reviewPlan(plan, true)}
                              >
                                {busy === `${plan.id}:approve` ? <Spinner className="text-success-foreground" /> : <CheckCircle2 className="size-4" />}
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-destructive hover:bg-destructive/10"
                                disabled={busy === `${plan.id}:reject`}
                                onClick={() => void reviewPlan(plan, false)}
                              >
                                <XCircle className="size-4" />
                                Reject
                              </Button>
                            </>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === plan.id}
                            onClick={() => savePlan(plan)}
                          >
                            {busy === plan.id ? <Spinner /> : <Save className="size-4" />}
                            Save
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Panel>
          </TabsContent>
        )}

        {tab === "Integrations" && (
          <TabsContent value="Integrations" className="mt-0 space-y-6">
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {integrations.map((item) => (
                <div key={item.id} className="rounded-xl border bg-card p-5 shadow-card">
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
                    <StatusBadge label={item.status} tone={item.status === "HEALTHY" ? "success" : "warning"} />
                  </div>
                  <Separator className="my-4" />
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      {item.enabled ? "Enabled" : "Environment setup required"}
                    </span>
                    <code className="rounded bg-muted px-2 py-0.5 text-xs">{item.secretValue}</code>
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
                          `Set ${item.provider} credentials as environment/secret values, then restart the API. They are never returned to this UI.`,
                        )
                      }
                    >
                      <Pencil className="size-4" />
                      Credential guidance
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => test(item)} disabled={busy === item.id}>
                      {busy === item.id ? <Spinner /> : <FlaskConical className="size-4" />}
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
                          {busy === "transatel:sync-catalog" ? <Spinner /> : <RefreshCcw className="size-4" />}
                          Sync catalog
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => transatelAction("ensure-webhook")}
                          disabled={busy === "transatel:ensure-webhook"}
                        >
                          {busy === "transatel:ensure-webhook" ? <Spinner /> : <Pencil className="size-4" />}
                          Register webhook
                        </Button>
                      </>
                    )}
                  </div>
                  {item.id === "transatel" && (
                    <div className="mt-4 space-y-3 rounded-lg border border-dashed p-4">
                      <div>
                        <p className="text-sm font-medium">Eligibility check</p>
                        <p className="text-xs text-muted-foreground">
                          Confirm a plan works for a subscriber MSISDN before approval.
                        </p>
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Select value={eligibilityPlanId} onValueChange={setEligibilityPlanId}>
                          <SelectTrigger className="w-full sm:w-auto">
                            <SelectValue placeholder="Select plan…" />
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
                          placeholder="MSISDN, e.g. 97798…"
                          value={eligibilityMsisdn}
                          onChange={(event) => setEligibilityMsisdn(event.target.value)}
                          className="w-full sm:w-auto sm:flex-1"
                        />
                        <Button
                          variant="outline"
                          disabled={busy === "transatel:eligibility"}
                          onClick={() => void checkEligibility()}
                        >
                          {busy === "transatel:eligibility" ? <Spinner /> : <Settings2 className="size-4" />}
                          Check
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <Panel
              title="Integration call log"
              description="Outbound integration requests and outcomes (most recent 200)."
              actions={
                <Button variant="outline" size="sm" onClick={() => void loadLogs()} disabled={logsBusy}>
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
                          <StatusBadge label={String(log.status)} tone={log.status >= 200 && log.status < 400 ? "success" : "warning"} />
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
          </TabsContent>
        )}

        {tab === "Users" && (
          <TabsContent value="Users" className="mt-0">
            <Panel
              title="Users and account types"
              description="Assign least-privilege access. Role changes are persisted transactionally."
              actions={
                <span className="flex size-9 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                  <UsersRound className="size-4" />
                </span>
              }
              noPadding
            >
              <div className="flex flex-col gap-3 border-b p-6 sm:flex-row sm:items-end">
                <div className="grid w-full gap-3 sm:grid-cols-[1fr_auto_auto]">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Staff email</Label>
                    <Input
                      type="email"
                      placeholder="staff@company.com"
                      value={inviteEmail}
                      onChange={(event) => setInviteEmail(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Role</Label>
                    <Select value={inviteType} onValueChange={(value) => setInviteType(value as typeof inviteType)}>
                      <SelectTrigger className="w-full sm:w-40">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="OPERATIONS">OPERATIONS</SelectItem>
                        <SelectItem value="SUPER_ADMIN">SUPER_ADMIN</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    className="self-end"
                    disabled={!inviteEmail || busy === "invite"}
                    onClick={() => void inviteStaff()}
                  >
                    {busy === "invite" ? <Spinner className="text-primary-foreground" /> : <ShieldCheck className="size-4" />}
                    Invite staff
                  </Button>
                </div>
              </div>
              {invitations.filter((item) => item.status === "PENDING").length > 0 && (
                <div className="space-y-2 p-6">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Pending invitations
                  </p>
                  {invitations
                    .filter((item) => item.status === "PENDING")
                    .map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center justify-between rounded-lg border px-4 py-3"
                      >
                        <div>
                          <p className="font-medium">{item.email}</p>
                          <p className="text-xs text-muted-foreground">
                            {item.accountType.replace("_", " ")} · expires{" "}
                            {new Date(item.expiresAt).toLocaleDateString()}
                          </p>
                        </div>
                        <StatusBadge label="PENDING" tone="warning" />
                      </div>
                    ))}
                </div>
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Account type</TableHead>
                    <TableHead className="text-right"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell>
                        <p className="font-medium">{user.email}</p>
                        <p className="text-xs text-muted-foreground">{user.clerkId}</p>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={user.status}
                          onValueChange={(value) =>
                            setUsers((values) =>
                              values.map((item) =>
                                item.id === user.id ? { ...item, status: value as User["status"] } : item,
                              ),
                            )
                          }
                        >
                          <SelectTrigger className="w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="ACTIVE">ACTIVE</SelectItem>
                            <SelectItem value="DISABLED">DISABLED</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>{user.customerCode ?? "—"}</TableCell>
                      <TableCell>
                        <Select
                          disabled={user.accountType === "CUSTOMER"}
                          value={user.accountType}
                          onValueChange={(value) =>
                            setUsers((values) =>
                              values.map((item) =>
                                item.id === user.id ? { ...item, accountType: value as User["accountType"] } : item,
                              ),
                            )
                          }
                        >
                          <SelectTrigger className="w-40">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="CUSTOMER">CUSTOMER</SelectItem>
                            <SelectItem value="OPERATIONS">OPERATIONS</SelectItem>
                            <SelectItem value="SUPER_ADMIN">SUPER_ADMIN</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy === user.id}
                          onClick={() => void saveUser(user)}
                        >
                          {busy === user.id ? <Spinner /> : <Save className="size-4" />}
                          Apply
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Panel>
          </TabsContent>
        )}

        {tab === "Partners" && (
          <TabsContent value="Partners" className="mt-0">
            <Panel
              title="Agency and reseller partners"
              description="Approve tenants, rotate scoped credentials, and monitor commercial exposure."
              actions={
                <span className="flex size-9 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                  <Building2 className="size-4" />
                </span>
              }
              noPadding
            >
              <div className="flex flex-col gap-3 border-b p-6 sm:flex-row sm:items-end">
                <div className="grid w-full gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Partner code</Label>
                    <Input
                      placeholder="agency-code"
                      value={partnerCode}
                      onChange={(event) => setPartnerCode(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Legal/display name</Label>
                    <Input
                      placeholder="Agency name"
                      value={partnerName}
                      onChange={(event) => setPartnerName(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Starting balance (NPR)</Label>
                    <Input
                      type="number"
                      min="0"
                      placeholder="0"
                      value={partnerBalance}
                      onChange={(event) => setPartnerBalance(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Partner type</Label>
                    <Select
                      value={partnerType}
                      onValueChange={(value) => setPartnerType(value as "API" | "CHECKOUT_LINK")}
                    >
                      <SelectTrigger className="w-40">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="API">API</SelectItem>
                        <SelectItem value="CHECKOUT_LINK">Checkout link</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    className="self-end"
                    disabled={!partnerCode || !partnerName || busy === "partner-create"}
                    onClick={() => void createPartner()}
                  >
                    {busy === "partner-create" ? <Spinner className="text-primary-foreground" /> : <Building2 className="size-4" />}
                    Create partner
                  </Button>
                </div>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Partner</TableHead>
                    <TableHead>Settlement account</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Activity</TableHead>
                    <TableHead className="text-right">Workspace</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {partners.map((partner) => (
                    <TableRow key={partner.id}>
                      <TableCell>
                        <p className="font-medium">{partner.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {partner.code} · {partner.rateLimitPerMinute}/min
                        </p>
                        <span className="mt-1 inline-block rounded bg-muted px-1.5 py-0.5 text-[11px] uppercase tracking-wide">
                          {partner.integrationType === "CHECKOUT_LINK" ? "Checkout link" : "API"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <p className="font-medium tabular-nums">
                          NPR {((partner.account?.balancePaisa ?? 0) / 100).toLocaleString()}
                        </p>
                        <p className="text-xs text-muted-foreground">Prepaid available balance</p>
                      </TableCell>
                      <TableCell>
                        <StatusBadge label={partner.status} />
                      </TableCell>
                      <TableCell>
                        <p>{partner._count.orders} orders</p>
                        <p className="text-xs text-muted-foreground">
                          {partner.credentials.filter((key) => key.status === "ACTIVE").length} active credential(s)
                        </p>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button asChild variant="outline" size="sm">
                          <Link href={`/admin/partners/${partner.id}`}>Open workspace</Link>
                        </Button>
                      </TableCell>
                      <TableCell>
                        <Select
                          disabled={busy === partner.id}
                          value={partner.status}
                          onValueChange={(value) => void changePartnerStatus(partner, value as Partner["status"])}
                        >
                          <SelectTrigger className="w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="PENDING">PENDING</SelectItem>
                            <SelectItem value="ACTIVE">ACTIVE</SelectItem>
                            <SelectItem value="SUSPENDED">SUSPENDED</SelectItem>
                            <SelectItem value="DISABLED">DISABLED</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col items-start gap-1.5">
                          {partner.integrationType === "API" && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy === `key-${partner.id}`}
                              onClick={() => void issuePartnerKey(partner)}
                            >
                              {busy === `key-${partner.id}` ? <Spinner /> : <KeyRound className="size-4" />}
                              Issue key
                            </Button>
                          )}
                          <div className="flex items-center gap-1.5">
                            {partner.integrationType === "CHECKOUT_LINK" && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy === `link-${partner.id}`}
                                onClick={() => { setHostedLinkPlanId(""); setHostedLinkMobile(""); setHostedLinkResult(null); setLookupState(null); setHostedLinkFor(partner); }}
                              >
                                <Link2 className="size-4" />
                                Checkout link
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy === `adjust-${partner.id}`}
                              onClick={() => { setAdjustType("credit"); setAdjustAmountNpr(""); setAdjustReference(""); setAdjustFor(partner); }}
                            >
                              <Wallet className="size-4" />
                              Adjust balance
                            </Button>
                          </div>
                          {partner.integrationType === "API" && (
                            <>
                              <span className="text-xs text-muted-foreground">
                                {partner.credentials.filter((creditKey) => creditKey.status === "ACTIVE").length} active
                              </span>
                              {partner.credentials
                                .filter((key) => key.status === "ACTIVE")
                                .map((key) => (
                                  <button
                                    key={key.id}
                                    className="text-xs text-destructive underline-offset-2 hover:underline disabled:opacity-50"
                                    disabled={busy === `revoke-${key.id}`}
                                    onClick={() => void revokePartnerKey(partner, key.id)}
                                  >
                                    Revoke {key.keyPrefix}
                                  </button>
                                ))}
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Dialog open={!!hostedLinkFor} onOpenChange={(open) => { if (!open) setHostedLinkFor(null); }}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Generate checkout link</DialogTitle>
                    <DialogDescription>
                      Create a hosted no-code checkout link for {hostedLinkFor?.name}. Share it with the traveler; no API required.
                    </DialogDescription>
                  </DialogHeader>
                  {!hostedLinkResult ? (
                    <div className="space-y-4 pt-1">
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">Plan</Label>
                        <Select value={hostedLinkPlanId} onValueChange={setHostedLinkPlanId}>
                          <SelectTrigger>
                            <SelectValue placeholder="Choose a plan" />
                          </SelectTrigger>
                          <SelectContent>
                            {plans
                              .filter((plan) => plan.status === "ACTIVE")
                              .map((plan) => (
                                <SelectItem key={plan.id} value={plan.id}>
                                  {plan.countryName} · {plan.name} · NPR {plan.sellingPriceNpr.toLocaleString()}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">
                          Earlier subscriber MSISDN (optional)
                        </Label>
                        <Input
                          value={hostedLinkMobile}
                          onChange={(event) => {
                            setHostedLinkMobile(event.target.value);
                            setLookupState(null);
                          }}
                          onBlur={() => void validateMobile()}
                          placeholder="e.g. 9779800000000 — the number used on the subscriber's earlier order, to top-up that same eSIM"
                        />
                        {lookupState && lookupState.status === "checking" && (
                          <p className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Spinner className="size-3" /> Checking for an existing eSIM…
                          </p>
                        )}
                        {lookupState && lookupState.status === "ok" && (
                          <div className="space-y-1 rounded-md bg-emerald-500/10 px-3 py-2 text-xs">
                            <p className="font-medium text-emerald-600">
                              ✓ Top-up available — subscriber found
                            </p>
                            {lookupState.subscriber?.countryName && (
                              <p className="text-muted-foreground">
                                Existing eSIM: {lookupState.subscriber.countryName} ({lookupState.subscriber.countryCode})
                                {lookupState.subscriber.currentPlan ? ` · ${lookupState.subscriber.currentPlan}` : ""}
                              </p>
                            )}
                            {lookupState.message && (
                              <p className="text-amber-600">{lookupState.message}</p>
                            )}
                          </div>
                        )}
                        {lookupState && lookupState.status === "error" && (
                          <div className="space-y-1 rounded-md bg-destructive/10 px-3 py-2 text-xs">
                            <p className="font-medium text-destructive">
                              {lookupState.message}
                            </p>
                            {lookupState.subscriber?.countryName && (
                              <p className="text-muted-foreground">
                                Existing plan: {lookupState.subscriber.countryName} ({lookupState.subscriber.countryCode})
                                {lookupState.subscriber.currentPlan ? ` · ${lookupState.subscriber.currentPlan}` : ""} — selected plan is ({lookupState.planCountryCode ?? "?"})
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" onClick={() => setHostedLinkFor(null)}>Cancel</Button>
                        <Button
                          disabled={!hostedLinkPlanId || hostedLinkBusy}
                          onClick={() => void generateCheckoutLink()}
                        >
                          {hostedLinkBusy ? <Spinner className="size-4" /> : <Link2 className="size-4" />}
                          Generate
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3 pt-1">
                      <p className="text-sm font-medium">Checkout link for {hostedLinkResult.partnerName}</p>
                      {hostedLinkResult.orderType === "TOPUP" ? (
                        <p className="rounded-md bg-primary/10 px-3 py-2 text-xs font-medium text-primary">
                          Top-up link — will attach to eSIM for {hostedLinkResult.topUpMobile}. The traveler only sees 2 steps.
                        </p>
                      ) : (
                        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                          New-purchase link — the traveler will complete all checkout steps.
                          {hostedLinkResult.topUpMobile ? " Note: mobile did not match an existing eSIM, so this is a new purchase." : ""}
                        </p>
                      )}
                      {hostedLinkResult.topUpStatus === "UNAVAILABLE" && (
                        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700">
                          {hostedLinkResult.topUpMobile} matched a subscriber but no active eSIM could be bound — this
                          link will be processed as a new purchase, not a top-up. Proceed only if that is intended.
                        </p>
                      )}
                      <code className="block break-all rounded-lg bg-muted px-3 py-2 text-xs">
                        {hostedLinkResult.checkoutUrl}
                      </code>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(hostedLinkResult.checkoutUrl);
                              toast.success("Checkout link copied.");
                            } catch {
                              toast.error("Clipboard permission denied. Copy it manually.");
                            }
                          }}
                        >
                          Copy link
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => { setHostedLinkFor(null); setHostedLinkResult(null); }}
                        >
                          Done
                        </Button>
                      </div>
                    </div>
                  )}
                </DialogContent>
              </Dialog>
              <Dialog open={!!adjustFor} onOpenChange={(open) => { if (!open) setAdjustFor(null); }}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Adjust balance</DialogTitle>
                    <DialogDescription>
                      Credit or debit the prepaid account of {adjustFor?.name}.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4 pt-1">
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Type</Label>
                      <Select value={adjustType} onValueChange={(value) => setAdjustType(value as "credit" | "debit")}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="credit">Credit (top up)</SelectItem>
                          <SelectItem value="debit">Debit (withdraw)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Amount (NPR)</Label>
                      <Input
                        type="number"
                        min="0"
                        placeholder="1000"
                        value={adjustAmountNpr}
                        onChange={(event) => setAdjustAmountNpr(event.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Reference</Label>
                      <Input
                        placeholder="Top-up voucher"
                        value={adjustReference}
                        onChange={(event) => setAdjustReference(event.target.value)}
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" onClick={() => setAdjustFor(null)}>Cancel</Button>
                      <Button disabled={!adjustAmountNpr || adjustBusy} onClick={() => void applyAdjustment()}>
                        {adjustBusy ? <Spinner className="size-4" /> : <Wallet className="size-4" />}
                        Apply
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </Panel>
          </TabsContent>
        )}

        {["Document Rules", "Inventory Settings", "System Config"].includes(tab) && (
          <TabsContent value={tab} className="mt-0">
            <ConfigPanel tab={tab} request={request} />
          </TabsContent>
        )}
      </Tabs>
    </>
  );
}

function ConfigPanel({
  tab,
  request,
}: {
  tab: string;
  request: <T,>(path: string, init?: RequestInit) => Promise<T>;
}) {
  type InventoryOverview = {
    counts: { available: number; reserved: number; assigned: number; activated: number };
    lowStockThreshold: number;
    lowStock: boolean;
  };
  const [inventory, setInventory] = useState<InventoryOverview | null>(null);
  const [systemConfig, setSystemConfig] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [topupMobile, setTopupMobile] = useState("");
  const [topupResult, setTopupResult] = useState<null | {
    found: boolean;
    subscriber?: {
      identity?: { firstName?: string; surname?: string };
      currentPlan?: { name: string };
      expiresAt?: string;
    };
    topUpAvailable?: boolean;
  }>(null);
  const [busy, setBusy] = useState("");
  const [sweepResult, setSweepResult] = useState("");
  useEffect(() => {
    if (tab === "Inventory Settings") {
      setError("");
      request<InventoryOverview>("/operations/inventory")
        .then(setInventory)
        .catch((e) => setError(e instanceof Error ? e.message : "Inventory unavailable"));
    } else if (tab === "System Config") {
      setError("");
      request<Integration[]>("/admin/integrations")
        .then((items) => {
          const map: Record<string, string> = {};
          for (const item of items) map[item.name] = item.status;
          setSystemConfig(map);
        })
        .catch((e) => setError(e instanceof Error ? e.message : "System config unavailable"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  const rows: { label: string; value: string | number; ok?: boolean }[] =
    tab === "Document Rules"
      ? [
          { label: "Passport", value: "Required and verified for every purchase" },
          { label: "Travel ticket", value: "Required and verified before payment" },
          { label: "Supported formats", value: "JPEG, PNG, or PDF" },
          { label: "Maximum file size", value: "10 MB" },
          { label: "Review", value: "Operationally verified before approval" },
        ]
      : tab === "Inventory Settings"
        ? inventory
          ? [
              { label: "Available profiles", value: inventory.counts.available },
              { label: "Reserved", value: inventory.counts.reserved },
              { label: "Assigned", value: inventory.counts.assigned },
              { label: "Activated", value: inventory.counts.activated },
              { label: "Low-stock threshold", value: inventory.lowStockThreshold },
              { label: "Inventory status", value: inventory.lowStock ? "LOW STOCK" : "Healthy", ok: !inventory.lowStock },
            ]
          : []
        : [
            { label: "Default purchase country", value: "Nepal (NP)" },
            { label: "Default currency", value: "NPR" },
            { label: "Subscriber language", value: "English" },
            { label: "Connectivity provider", value: systemConfig["Transatel Connectivity"] ?? "—" },
            { label: "Payment gateway (Khalti)", value: systemConfig["Khalti Payment Gateway"] ?? "—" },
          ];

  return (
    <Panel title={tab} description="Live platform defaults and enforced business rules." bodyClassName="p-0">
      {error ? (
        <div className="m-6 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {rows.length ? (
        <div className="divide-y">
          {rows.map(({ label, value, ok }) => (
            <div key={label} className="flex items-center justify-between px-6 py-4">
              <div>
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{value}</p>
              </div>
              {ok !== undefined ? (
                ok ? (
                  <span className="text-success">
                    <CheckCircle2 className="size-5" />
                  </span>
                ) : (
                  <StatusBadge label="ATTENTION" tone="warning" />
                )
              ) : (
                <span className="text-success">
                  <CheckCircle2 className="size-5" />
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <EmptyState loading>
          <span className="text-sm text-muted-foreground">Loading live data…</span>
        </EmptyState>
      )}
      {tab === "System Config" && (
        <div className="space-y-4 p-6">
          <div className="rounded-lg border p-4">
            <p className="font-medium">Look up a subscriber by MSISDN</p>
            <p className="text-xs text-muted-foreground">
              Detect an existing eSIM so future purchases are routed as top-ups.
            </p>
            <div className="mt-3 flex gap-2">
              <Input
                value={topupMobile}
                onChange={(e) => setTopupMobile(e.target.value)}
                placeholder="e.g. 9841234567"
              />
              <Button
                variant="outline"
                disabled={Boolean(busy)}
                onClick={() => {
                  setBusy("lookup");
                  setError("");
                  setTopupResult(null);
                  request<{
                    found: boolean;
                    subscriber?: {
                      identity?: { firstName?: string; surname?: string };
                      currentPlan?: { name: string };
                      expiresAt?: string;
                    };
                    topUpAvailable?: boolean;
                  }>(`/operations/topup/lookup?mobile=${encodeURIComponent(topupMobile)}`)
                    .then(setTopupResult)
                    .catch((e) =>
                      setError(e instanceof Error ? e.message : "Lookup failed"),
                    )
                    .finally(() => setBusy(""));
                }}
              >
                {busy === "lookup" ? <Spinner /> : null}
                Look up
              </Button>
            </div>
            {topupResult &&
              (topupResult.found && topupResult.subscriber ? (
                <p className="mt-3 flex items-center gap-2 text-sm text-success-foreground">
                  <CheckCircle2 className="size-4" />
                  Found {topupResult.subscriber.identity?.firstName} {topupResult.subscriber.identity?.surname} —{" "}
                  {topupResult.subscriber.currentPlan?.name ?? "active subscriber"}
                  {topupResult.subscriber.expiresAt
                    ? ` · valid until ${new Date(topupResult.subscriber.expiresAt).toLocaleDateString()}`
                    : ""}
                  . Future orders will be flagged TOP-UP.
                </p>
              ) : (
                <p className="mt-3 text-sm text-warning-foreground">
                  No active eSIM found for that MSISDN.
                </p>
              ))}
          </div>
          <div className="rounded-lg border p-4">
            <p className="font-medium">Payment lifecycle</p>
            <p className="text-xs text-muted-foreground">
              Expire abandoned payments that outlived their gateway window.
            </p>
            <Button
              variant="outline"
              className="mt-3"
              disabled={Boolean(busy)}
              onClick={() => {
                setBusy("sweep");
                setError("");
                request<{ expired: number }>("/operations/payments/expire-stale", {
                  method: "POST",
                  headers: { "x-idempotency-key": crypto.randomUUID() },
                })
                  .then((r) => setSweepResult(`${r.expired} stale payment(s) expired`))
                  .catch((e) =>
                    setError(e instanceof Error ? e.message : "Sweep failed"),
                  )
                  .finally(() => setBusy(""));
              }}
            >
              {busy === "sweep" ? <Spinner /> : null}
              Expire stale payments
            </Button>
            {sweepResult ? (
              <p className="mt-3 flex items-center gap-2 text-sm text-success-foreground">
                <CheckCircle2 className="size-4" />
                {sweepResult}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </Panel>
  );
}
