"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  Building2,
  Copy,
  Download,
  KeyRound,
  Landmark,
  PackageSearch,
  Plus,
  RefreshCcw,
  RotateCcw,
  ShieldAlert,
  Webhook,
} from "lucide-react";
import { toast } from "sonner";
import { useAuthenticatedFetch } from "../../../authenticated-api-provider";
import { downloadCsv } from "@/lib/csv";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { Spinner } from "@/components/spinner";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useConfirmation } from "@/components/confirmation-provider";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const TABS = [
  "overview",
  "orders",
  "ledger",
  "refunds",
  "credentials",
  "webhooks",
  "settings",
] as const;
const SCOPES = [
  "catalog:read",
  "orders:read",
  "orders:write",
  "documents:write",
  "refunds:write",
  "usage:read",
  "esims:read",
];
const EVENTS = [
  "order.accepted",
  "order.provisioning",
  "order.qr_ready",
  "order.completed",
  "order.failed",
  "order.refunded",
];

type PartnerStatus = "PENDING" | "ACTIVE" | "SUSPENDED" | "DISABLED";
type Credential = {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  status: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
};
type WebhookEndpoint = {
  id: string;
  url: string;
  eventTypes: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
  _count?: { deliveries: number };
};
type Partner = {
  id: string;
  code: string;
  name: string;
  status: PartnerStatus;
  rateLimitPerMinute: number;
  createdAt: string;
  account: { balancePaisa: number; reservedPaisa: number } | null;
  credentials: Credential[];
  webhooks: WebhookEndpoint[];
  _count: {
    orders: number;
    customers: number;
    refundRequests: number;
    credentials: number;
  };
};
type Summary = {
  currentBalancePaisa: number;
  reservedBalancePaisa: number;
  availableBalancePaisa: number;
  ordersCreated: number;
  fulfilledOrders: number;
  failedOrders: number;
  totalOrderValuePaisa: number;
  totalCreditedPaisa: number;
  totalDebitedPaisa: number;
  totalRefundedPaisa: number;
  averageOrderValuePaisa: number;
  ordersByStatus: Record<string, number>;
};
type Order = {
  id: string;
  orderNumber: string;
  externalOrderId: string | null;
  status: string;
  totalAmount: string | number;
  createdAt: string;
  plan: { name: string; country: { isoCode: string } };
  traveler?: { firstName: string; surname: string; email: string } | null;
};
type Ledger = {
  id: string;
  type: string;
  amountPaisa: number;
  balanceAfterPaisa: number;
  reference: string;
  createdAt: string;
  order?: {
    id: string;
    orderNumber: string;
    externalOrderId: string | null;
  } | null;
};
type Refund = {
  id: string;
  amountPaisa: number;
  reason: string;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  order: {
    id: string;
    orderNumber: string;
    externalOrderId: string | null;
    status: string;
  };
};
type Delivery = {
  id: string;
  status: string;
  attempt: number;
  responseStatus: number | null;
  latencyMs: number | null;
  errorMessage: string | null;
  createdAt: string;
  deliveredAt: string | null;
  event: { type: string; resourceId: string; occurredAt: string };
  endpoint: { id: string; url: string };
};

type ConfirmState = {
  title: string;
  description: string;
  expected: string;
  reasonRequired?: boolean;
  actionLabel: string;
  destructive?: boolean;
  run: (reason: string) => Promise<void>;
};

const npr = (paisa: number) => `NPR ${(paisa / 100).toLocaleString()}`;
const dateTime = (value?: string | null) =>
  value ? new Date(value).toLocaleString() : "Never";

export default function PartnerWorkspace({ id }: { id: string }) {
  const requestConfirmation = useConfirmation();
  const authFetch = useAuthenticatedFetch();
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialTab = TABS.includes(
    searchParams.get("tab") as (typeof TABS)[number],
  )
    ? searchParams.get("tab")!
    : "overview";
  const [tab, setTab] = useState(initialTab);
  const [partner, setPartner] = useState<Partner | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [ledger, setLedger] = useState<Ledger[]>([]);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookEndpoint[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [from, setFrom] = useState(searchParams.get("from") ?? "");
  const [to, setTo] = useState(searchParams.get("to") ?? "");
  const [orderQuery, setOrderQuery] = useState(searchParams.get("q") ?? "");
  const [orderStatus, setOrderStatus] = useState(
    searchParams.get("status") ?? "ALL",
  );
  const [ledgerType, setLedgerType] = useState(
    searchParams.get("type") ?? "ALL",
  );
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [confirmReason, setConfirmReason] = useState("");
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(
    null,
  );
  const [adjustment, setAdjustment] = useState({
    amountNpr: "",
    reference: "",
    reason: "",
  });
  const [credential, setCredential] = useState({
    name: "",
    expiresAt: "",
    scopes: [...SCOPES],
  });
  const [webhookForm, setWebhookForm] = useState({
    url: "",
    eventTypes: [...EVENTS],
  });
  const [settings, setSettings] = useState({
    name: "",
    rateLimitPerMinute: "120",
    status: "PENDING" as PartnerStatus,
  });

  const request = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const response = await authFetch(`${API}${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...init?.headers },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(body.error?.message ?? "Request failed");
      return body.data as T;
    },
    [authFetch],
  );

  const querySuffix = useMemo(() => {
    const params = new URLSearchParams();
    if (from)
      params.set("from", new Date(`${from}T00:00:00.000Z`).toISOString());
    if (to) params.set("to", new Date(`${to}T23:59:59.999Z`).toISOString());
    return params.size ? `?${params}` : "";
  }, [from, to]);

  const load = useCallback(
    async (quiet = false) => {
      quiet ? setRefreshing(true) : setLoading(true);
      setError("");
      try {
        const orderParams = new URLSearchParams(querySuffix.slice(1));
        if (orderQuery.trim()) orderParams.set("q", orderQuery.trim());
        if (orderStatus !== "ALL") orderParams.set("status", orderStatus);
        const ledgerParams = new URLSearchParams(querySuffix.slice(1));
        if (orderQuery.trim()) ledgerParams.set("q", orderQuery.trim());
        if (ledgerType !== "ALL") ledgerParams.set("type", ledgerType);
        const [
          partnerValue,
          summaryValue,
          orderValue,
          ledgerValue,
          refundValue,
          webhookValue,
          deliveryValue,
        ] = await Promise.all([
          request<Partner>(`/admin/partners/${id}`),
          request<Summary>(`/admin/partners/${id}/summary${querySuffix}`),
          request<Order[]>(
            `/admin/partners/${id}/orders${orderParams.size ? `?${orderParams}` : ""}`,
          ),
          request<Ledger[]>(
            `/admin/partners/${id}/ledger${ledgerParams.size ? `?${ledgerParams}` : ""}`,
          ),
          request<Refund[]>(`/admin/partners/${id}/refunds`),
          request<WebhookEndpoint[]>(`/admin/partners/${id}/webhooks`),
          request<Delivery[]>(`/admin/partners/${id}/webhook-deliveries`),
        ]);
        setPartner(partnerValue);
        setSummary(summaryValue);
        setOrders(orderValue);
        setLedger(ledgerValue);
        setRefunds(refundValue);
        setWebhooks(webhookValue);
        setDeliveries(deliveryValue);
        setSettings({
          name: partnerValue.name,
          rateLimitPerMinute: String(partnerValue.rateLimitPerMinute),
          status: partnerValue.status,
        });
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not load partner workspace",
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [id, ledgerType, orderQuery, orderStatus, querySuffix, request],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const params = new URLSearchParams();
    if (tab !== "overview") params.set("tab", tab);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (orderQuery) params.set("q", orderQuery);
    if (orderStatus !== "ALL") params.set("status", orderStatus);
    if (ledgerType !== "ALL") params.set("type", ledgerType);
    router.replace(`?${params}`, { scroll: false });
  }, [from, ledgerType, orderQuery, orderStatus, router, tab, to]);

  const mutate = async (
    key: string,
    path: string,
    init: RequestInit,
    success: string,
  ) => {
    setBusy(key);
    try {
      await request(path, init);
      toast.success(success);
      await load(true);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Action failed");
      throw caught;
    } finally {
      setBusy("");
    }
  };

  const showConfirm = (value: ConfirmState) => {
    setConfirm(value);
    setConfirmText("");
    setConfirmReason("");
  };
  const runConfirmed = async () => {
    if (
      !confirm ||
      confirmText !== confirm.expected ||
      (confirm.reasonRequired && confirmReason.trim().length < 4)
    )
      return;
    try {
      await confirm.run(confirmReason.trim());
      setConfirm(null);
    } catch {
      /* toast handled by mutate */
    }
  };

  if (loading)
    return (
      <EmptyState
        loading
        className="min-h-[60vh]"
        description="Loading partner operations…"
      />
    );
  if (error || !partner || !summary)
    return (
      <EmptyState
        icon={<ShieldAlert className="size-5" />}
        title="Partner workspace unavailable"
        description={error || "Partner not found"}
      >
        <Button variant="outline" onClick={() => void load()}>
          <RefreshCcw className="size-4" />
          Retry
        </Button>
      </EmptyState>
    );

  const activeCredentials = partner.credentials.filter(
    (item) => item.status === "ACTIVE",
  ).length;
  const failedDeliveries = deliveries.filter(
    (item) => item.status === "FAILED",
  ).length;
  const pendingRefunds = refunds.filter(
    (item) => item.status === "REQUESTED",
  ).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/admin">
            <ArrowLeft />
            Administration
          </Link>
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={refreshing}
          onClick={() => void load(true)}
        >
          {refreshing ? <Spinner /> : <RefreshCcw />}Refresh
        </Button>
      </div>
      <PageHeader
        title={partner.name}
        description={`${partner.code} · Partner since ${new Date(partner.createdAt).toLocaleDateString()}`}
        badge={<StatusBadge label={partner.status} />}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard
          label="Available balance"
          value={npr(summary.availableBalancePaisa)}
          hint={`${npr(summary.reservedBalancePaisa)} reserved`}
          icon={<Landmark />}
        />
        <StatCard
          label="Orders in range"
          value={summary.ordersCreated}
          hint={`${summary.fulfilledOrders} fulfilled`}
          icon={<PackageSearch />}
        />
        <StatCard
          label="Order value"
          value={npr(summary.totalOrderValuePaisa)}
          hint={`Average ${npr(summary.averageOrderValuePaisa)}`}
          icon={<Activity />}
        />
        <StatCard
          label="API access"
          value={activeCredentials}
          hint={`${partner.rateLimitPerMinute} requests/min`}
          icon={<KeyRound />}
          tone={activeCredentials ? "success" : "warning"}
        />
        <StatCard
          label="Webhook health"
          value={failedDeliveries ? `${failedDeliveries} failed` : "Healthy"}
          hint={`${webhooks.filter((item) => item.active).length} active endpoints`}
          icon={<Webhook />}
          tone={failedDeliveries ? "danger" : "success"}
        />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex h-auto w-full justify-start overflow-x-auto p-1">
          {TABS.map((item) => (
            <TabsTrigger key={item} value={item} className="capitalize">
              {item}
              {item === "refunds" && pendingRefunds > 0 ? (
                <Badge className="ml-1">{pendingRefunds}</Badge>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Performance in selected period">
              <div className="grid gap-4 sm:grid-cols-2">
                <Metric label="Fulfilled" value={summary.fulfilledOrders} />
                <Metric label="Failed" value={summary.failedOrders} />
                <Metric
                  label="Credits"
                  value={npr(summary.totalCreditedPaisa)}
                />
                <Metric label="Debits" value={npr(summary.totalDebitedPaisa)} />
                <Metric
                  label="Refunded"
                  value={npr(summary.totalRefundedPaisa)}
                />
                <Metric label="Customers" value={partner._count.customers} />
              </div>
            </Panel>
            <Panel title="Order status mix">
              {Object.keys(summary.ordersByStatus).length ? (
                <div className="space-y-3">
                  {Object.entries(summary.ordersByStatus).map(
                    ([status, count]) => (
                      <div
                        key={status}
                        className="flex items-center justify-between"
                      >
                        <StatusBadge label={status} />
                        <span className="font-medium tabular-nums">
                          {count}
                        </span>
                      </div>
                    ),
                  )}
                </div>
              ) : (
                <EmptyState title="No orders in this period" />
              )}
            </Panel>
          </div>
        </TabsContent>

        <TabsContent value="orders" className="space-y-4">
          <Filters
            from={from}
            to={to}
            query={orderQuery}
            onFrom={setFrom}
            onTo={setTo}
            onQuery={setOrderQuery}
            status={orderStatus}
            onStatus={setOrderStatus}
          />
          <Panel
            title="Partner orders"
            description={`${orders.length} matching order(s)`}
            action={
              <Button
                variant="outline"
                size="sm"
                disabled={!orders.length}
                onClick={() =>
                  downloadCsv(
                    "partner-orders.csv",
                    [
                      "orderNumber",
                      "externalOrderId",
                      "status",
                      "traveler",
                      "plan",
                      "amountNpr",
                      "createdAt",
                    ],
                    orders.map((order) => [
                      order.orderNumber,
                      order.externalOrderId ?? "",
                      order.status,
                      order.traveler
                        ? `${order.traveler.firstName} ${order.traveler.surname}`
                        : "",
                      `${order.plan.country.isoCode} ${order.plan.name}`,
                      Number(order.totalAmount),
                      order.createdAt,
                    ]),
                  )
                }
              >
                <Download />
                Export CSV
              </Button>
            }
            noPadding
          >
            {!orders.length ? (
              <EmptyState
                title="No matching orders"
                description="Adjust the search, status, or date filters."
              />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Order</TableHead>
                      <TableHead>Traveller</TableHead>
                      <TableHead>Plan</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orders.map((order) => (
                      <TableRow key={order.id}>
                        <TableCell>
                          <Link
                            className="font-medium hover:underline"
                            href={`/orders/${order.id}`}
                          >
                            {order.orderNumber}
                          </Link>
                          <p className="text-xs text-muted-foreground">
                            {order.externalOrderId ?? "—"}
                          </p>
                        </TableCell>
                        <TableCell>
                          {order.traveler ? (
                            <>
                              {order.traveler.firstName}{" "}
                              {order.traveler.surname}
                              <p className="text-xs text-muted-foreground">
                                {order.traveler.email}
                              </p>
                            </>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell>
                          {order.plan.country.isoCode} · {order.plan.name}
                        </TableCell>
                        <TableCell>
                          NPR {Number(order.totalAmount).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          <StatusBadge label={order.status} />
                        </TableCell>
                        <TableCell>{dateTime(order.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="ledger" className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <Input
              type="date"
              aria-label="From date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-44"
            />
            <Input
              type="date"
              aria-label="To date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-44"
            />
            <Input
              aria-label="Ledger search"
              placeholder="Reference or order"
              value={orderQuery}
              onChange={(e) => setOrderQuery(e.target.value)}
              className="min-w-52 flex-1"
            />
            <Select value={ledgerType} onValueChange={setLedgerType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  "ALL",
                  "CREDIT",
                  "DEBIT",
                  "RESERVATION",
                  "CAPTURE",
                  "RELEASE",
                  "REFUND",
                  "ADJUSTMENT",
                ].map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Panel
            title="Financial ledger"
            description={`${ledger.length} matching entry(s)`}
            actions={
              <>
                <Button
                  size="sm"
                  onClick={() =>
                    setAdjustment({ amountNpr: "", reference: "", reason: "" })
                  }
                >
                  <Plus />
                  Adjustment
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!ledger.length}
                  onClick={() =>
                    downloadCsv(
                      "partner-ledger.csv",
                      [
                        "type",
                        "amountNpr",
                        "balanceAfterNpr",
                        "reference",
                        "orderNumber",
                        "createdAt",
                      ],
                      ledger.map((entry) => [
                        entry.type,
                        entry.amountPaisa / 100,
                        entry.balanceAfterPaisa / 100,
                        entry.reference,
                        entry.order?.orderNumber ?? "",
                        entry.createdAt,
                      ]),
                    )
                  }
                >
                  <Download />
                  Export
                </Button>
              </>
            }
            noPadding
          >
            <AdjustmentForm
              value={adjustment}
              onChange={setAdjustment}
              onSubmit={() =>
                showConfirm({
                  title: "Confirm balance adjustment",
                  description: `${Number(adjustment.amountNpr) >= 0 ? "Credit" : "Correct"} ${npr(Math.abs(Math.round(Number(adjustment.amountNpr) * 100)))}. This creates an audited ledger entry.`,
                  expected: "ADJUST",
                  reasonRequired: true,
                  actionLabel: "Apply adjustment",
                  destructive: Number(adjustment.amountNpr) < 0,
                  run: async (reason) => {
                    await mutate(
                      "adjust",
                      `/admin/partners/${id}/ledger-adjustments`,
                      {
                        method: "POST",
                        body: JSON.stringify({
                          amountPaisa: Math.round(
                            Number(adjustment.amountNpr) * 100,
                          ),
                          reference: adjustment.reference.trim(),
                          reason,
                        }),
                      },
                      "Partner balance updated",
                    );
                    setAdjustment({ amountNpr: "", reference: "", reason: "" });
                  },
                })
              }
            />
            {!ledger.length ? (
              <EmptyState title="No matching ledger entries" />
            ) : (
              <div className="overflow-x-auto border-t">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Order/reference</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Balance after</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ledger.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell>{dateTime(entry.createdAt)}</TableCell>
                        <TableCell>
                          <StatusBadge label={entry.type} />
                        </TableCell>
                        <TableCell>
                          {entry.order?.orderNumber ?? entry.reference}
                          <p className="text-xs text-muted-foreground">
                            {entry.reference}
                          </p>
                        </TableCell>
                        <TableCell>{npr(entry.amountPaisa)}</TableCell>
                        <TableCell>{npr(entry.balanceAfterPaisa)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="refunds">
          <Panel
            title="Refund requests"
            description={`${pendingRefunds} awaiting decision`}
            noPadding
          >
            {!refunds.length ? (
              <EmptyState title="No refund requests" />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Order</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Timeline</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {refunds.map((refund) => (
                      <TableRow key={refund.id}>
                        <TableCell>
                          <Link
                            href={`/orders/${refund.order.id}`}
                            className="font-medium hover:underline"
                          >
                            {refund.order.orderNumber}
                          </Link>
                          <p className="text-xs text-muted-foreground">
                            {refund.order.externalOrderId ?? "—"}
                          </p>
                        </TableCell>
                        <TableCell className="max-w-sm whitespace-normal">
                          {refund.reason}
                        </TableCell>
                        <TableCell>{npr(refund.amountPaisa)}</TableCell>
                        <TableCell>
                          <StatusBadge label={refund.status} />
                        </TableCell>
                        <TableCell>
                          <p>{dateTime(refund.createdAt)}</p>
                          {refund.decidedAt && (
                            <p className="text-xs text-muted-foreground">
                              Decided {dateTime(refund.decidedAt)}
                            </p>
                          )}
                        </TableCell>
                        <TableCell>
                          {refund.status === "REQUESTED" && (
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant="success"
                                onClick={() =>
                                  showConfirm({
                                    title: "Approve refund",
                                    description: `Approve ${npr(refund.amountPaisa)} for ${refund.order.orderNumber}. Funds will return to the prepaid balance.`,
                                    expected: "APPROVE",
                                    reasonRequired: true,
                                    actionLabel: "Approve refund",
                                    run: (reason) =>
                                      mutate(
                                        `refund-${refund.id}`,
                                        `/admin/partners/refunds/${refund.id}`,
                                        {
                                          method: "PATCH",
                                          body: JSON.stringify({
                                            status: "APPROVED",
                                            reason,
                                          }),
                                        },
                                        "Refund approved",
                                      ),
                                  })
                                }
                              >
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  showConfirm({
                                    title: "Reject refund",
                                    description: `Reject the request for ${refund.order.orderNumber}.`,
                                    expected: "REJECT",
                                    reasonRequired: true,
                                    actionLabel: "Reject refund",
                                    destructive: true,
                                    run: (reason) =>
                                      mutate(
                                        `refund-${refund.id}`,
                                        `/admin/partners/refunds/${refund.id}`,
                                        {
                                          method: "PATCH",
                                          body: JSON.stringify({
                                            status: "REJECTED",
                                            reason,
                                          }),
                                        },
                                        "Refund rejected",
                                      ),
                                  })
                                }
                              >
                                Reject
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="credentials" className="space-y-6">
          <Panel
            title="Issue API credential"
            description="The secret is displayed once and is never stored in recoverable form."
          >
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Key name">
                <Input
                  value={credential.name}
                  onChange={(e) =>
                    setCredential({ ...credential, name: e.target.value })
                  }
                  placeholder="Production integration"
                />
              </Field>
              <Field label="Expires on (optional)">
                <Input
                  type="date"
                  value={credential.expiresAt}
                  onChange={(e) =>
                    setCredential({ ...credential, expiresAt: e.target.value })
                  }
                />
              </Field>
              <div className="md:col-span-3">
                <Label>Scopes</Label>
                <div className="mt-2 flex flex-wrap gap-2">
                  {SCOPES.map((scope) => (
                    <label
                      key={scope}
                      className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={credential.scopes.includes(scope)}
                        onChange={() =>
                          setCredential({
                            ...credential,
                            scopes: credential.scopes.includes(scope)
                              ? credential.scopes.filter(
                                  (item) => item !== scope,
                                )
                              : [...credential.scopes, scope],
                          })
                        }
                      />
                      {scope}
                    </label>
                  ))}
                </div>
              </div>
              <Button
                disabled={
                  !credential.name.trim() ||
                  !credential.scopes.length ||
                  busy === "credential"
                }
                onClick={async () => {
                  setBusy("credential");
                  try {
                    const result = await request<{ apiKey: string }>(
                      `/admin/partners/${id}/credentials`,
                      {
                        method: "POST",
                        body: JSON.stringify({
                          name: credential.name.trim(),
                          scopes: credential.scopes,
                          ...(credential.expiresAt
                            ? {
                                expiresAt: new Date(
                                  `${credential.expiresAt}T23:59:59.999Z`,
                                ).toISOString(),
                              }
                            : {}),
                        }),
                      },
                    );
                    setSecret({ label: "API key", value: result.apiKey });
                    setCredential({
                      name: "",
                      expiresAt: "",
                      scopes: [...SCOPES],
                    });
                    toast.success("Credential issued");
                    await load(true);
                  } catch (caught) {
                    toast.error(
                      caught instanceof Error
                        ? caught.message
                        : "Credential issue failed",
                    );
                  } finally {
                    setBusy("");
                  }
                }}
              >
                {busy === "credential" ? <Spinner /> : <KeyRound />}Issue
                credential
              </Button>
            </div>
          </Panel>
          <Panel
            title="API credentials"
            description="A partner is created once. Issue separate credentials for each application or environment, rotate by issuing a replacement first, then revoke the old key after deployment. Only the identifying prefix is retained here; the secret is shown once."
            noPadding
          >
            {!partner.credentials.length ? (
              <EmptyState title="No credentials issued" />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name / prefix</TableHead>
                      <TableHead>Scopes</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Expiry</TableHead>
                      <TableHead>Last used</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {partner.credentials.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="min-w-44">
                          <p className="font-medium">{item.name}</p>
                          <code className="text-xs text-muted-foreground">
                            {item.keyPrefix}
                          </code>
                        </TableCell>
                        <TableCell className="min-w-56">
                          <div className="flex max-w-md flex-wrap gap-1">
                            {item.scopes.map((scope) => (
                              <Badge key={scope} variant="outline">
                                {scope}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusBadge label={item.status} />
                        </TableCell>
                        <TableCell className="min-w-36 tabular-nums">
                          {dateTime(item.expiresAt)}
                        </TableCell>
                        <TableCell className="min-w-36 tabular-nums">
                          {dateTime(item.lastUsedAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          {item.status === "ACTIVE" && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                showConfirm({
                                  title: "Revoke API credential",
                                  description: `${item.name} will stop working immediately.`,
                                  expected: partner.code,
                                  actionLabel: "Revoke credential",
                                  destructive: true,
                                  run: () =>
                                    mutate(
                                      `revoke-${item.id}`,
                                      `/admin/partners/${id}/credentials/${item.id}`,
                                      { method: "DELETE" },
                                      "Credential revoked",
                                    ),
                                })
                              }
                            >
                              Revoke
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="webhooks" className="space-y-6">
          <Panel
            title="Create webhook endpoint"
            description="Signing secrets are shown once after creation."
          >
            <div className="space-y-4">
              <Field label="HTTPS endpoint URL">
                <Input
                  value={webhookForm.url}
                  onChange={(e) =>
                    setWebhookForm({ ...webhookForm, url: e.target.value })
                  }
                  placeholder="https://partner.example/webhooks/visa-compass"
                />
              </Field>
              <div>
                <Label>Events</Label>
                <div className="mt-2 flex flex-wrap gap-2">
                  {EVENTS.map((event) => (
                    <label
                      key={event}
                      className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={webhookForm.eventTypes.includes(event)}
                        onChange={() =>
                          setWebhookForm({
                            ...webhookForm,
                            eventTypes: webhookForm.eventTypes.includes(event)
                              ? webhookForm.eventTypes.filter(
                                  (item) => item !== event,
                                )
                              : [...webhookForm.eventTypes, event],
                          })
                        }
                      />
                      {event}
                    </label>
                  ))}
                </div>
              </div>
              <Button
                disabled={
                  !webhookForm.url.trim() ||
                  !webhookForm.eventTypes.length ||
                  busy === "webhook-create"
                }
                onClick={async () => {
                  setBusy("webhook-create");
                  try {
                    const result = await request<{ signingSecret: string }>(
                      `/admin/partners/${id}/webhooks`,
                      { method: "POST", body: JSON.stringify(webhookForm) },
                    );
                    setSecret({
                      label: "Webhook signing secret",
                      value: result.signingSecret,
                    });
                    setWebhookForm({ url: "", eventTypes: [...EVENTS] });
                    toast.success("Webhook endpoint created");
                    await load(true);
                  } catch (caught) {
                    toast.error(
                      caught instanceof Error
                        ? caught.message
                        : "Webhook creation failed",
                    );
                  } finally {
                    setBusy("");
                  }
                }}
              >
                <Webhook />
                Create endpoint
              </Button>
            </div>
          </Panel>
          <Panel title="Endpoints" noPadding>
            {!webhooks.length ? (
              <EmptyState title="No webhook endpoints" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>URL</TableHead>
                    <TableHead>Events</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Active</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {webhooks.map((endpoint) => (
                    <TableRow key={endpoint.id}>
                      <TableCell className="max-w-sm break-all font-medium">
                        {endpoint.url}
                      </TableCell>
                      <TableCell>
                        {endpoint.eventTypes.length} event(s)
                      </TableCell>
                      <TableCell>{dateTime(endpoint.createdAt)}</TableCell>
                      <TableCell>
                        <Switch
                          checked={endpoint.active}
                          disabled={busy === `webhook-${endpoint.id}`}
                          onCheckedChange={(active) =>
                            void mutate(
                              `webhook-${endpoint.id}`,
                              `/admin/partners/${id}/webhooks/${endpoint.id}`,
                              {
                                method: "PATCH",
                                body: JSON.stringify({ active }),
                              },
                              `Webhook ${active ? "enabled" : "disabled"}`,
                            )
                          }
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Panel>
          <Panel
            title="Recent deliveries"
            description={`${failedDeliveries} failed delivery(s)`}
            noPadding
          >
            {!deliveries.length ? (
              <EmptyState title="No webhook deliveries yet" />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Event</TableHead>
                      <TableHead>Endpoint</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Response</TableHead>
                      <TableHead>Attempt</TableHead>
                      <TableHead>Occurred</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {deliveries.map((delivery) => (
                      <TableRow key={delivery.id}>
                        <TableCell>
                          <p className="font-medium">{delivery.event.type}</p>
                          <code className="text-xs text-muted-foreground">
                            {delivery.event.resourceId}
                          </code>
                        </TableCell>
                        <TableCell className="max-w-xs truncate">
                          {delivery.endpoint.url}
                        </TableCell>
                        <TableCell>
                          <StatusBadge label={delivery.status} />
                        </TableCell>
                        <TableCell>
                          {delivery.responseStatus ?? "—"}
                          {delivery.latencyMs != null && (
                            <p className="text-xs text-muted-foreground">
                              {delivery.latencyMs} ms
                            </p>
                          )}
                          {delivery.errorMessage && (
                            <p className="max-w-xs whitespace-normal text-xs text-destructive">
                              {delivery.errorMessage}
                            </p>
                          )}
                        </TableCell>
                        <TableCell>{delivery.attempt}</TableCell>
                        <TableCell>
                          {dateTime(delivery.event.occurredAt)}
                        </TableCell>
                        <TableCell>
                          {delivery.status === "FAILED" && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy === `replay-${delivery.id}`}
                              onClick={async () => {
                                if (
                                  await requestConfirmation({
                                    title: "Replay partner update?",
                                    description:
                                      "This sends the same update to the partner endpoint again.",
                                    confirmLabel: "Replay update",
                                  })
                                )
                                  void mutate(
                                    `replay-${delivery.id}`,
                                    `/admin/partners/${id}/webhook-deliveries/${delivery.id}/replay`,
                                    { method: "POST" },
                                    "Update sent to the partner again",
                                  );
                              }}
                            >
                              <RotateCcw />
                              Replay
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="settings">
          <Panel
            title="Partner settings"
            description="Changes are audited and apply to future API requests."
          >
            <div className="max-w-2xl space-y-5">
              <Field label="Partner code">
                <Input value={partner.code} disabled />
              </Field>
              <Field label="Display/legal name">
                <Input
                  value={settings.name}
                  onChange={(e) =>
                    setSettings({ ...settings, name: e.target.value })
                  }
                />
              </Field>
              <Field label="API rate limit per minute">
                <Input
                  type="number"
                  min={1}
                  max={10000}
                  value={settings.rateLimitPerMinute}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      rateLimitPerMinute: e.target.value,
                    })
                  }
                />
              </Field>
              <div className="flex justify-end">
                <Button
                  disabled={!settings.name.trim() || busy === "settings"}
                  onClick={() =>
                    void mutate(
                      "settings",
                      `/admin/partners/${id}`,
                      {
                        method: "PATCH",
                        body: JSON.stringify({
                          name: settings.name.trim(),
                          rateLimitPerMinute: Number(
                            settings.rateLimitPerMinute,
                          ),
                        }),
                      },
                      "Partner settings saved",
                    )
                  }
                >
                  Save settings
                </Button>
              </div>
              <div className="border-t pt-5">
                <Field label="Lifecycle status">
                  <Select
                    value={settings.status}
                    onValueChange={(value) =>
                      setSettings({
                        ...settings,
                        status: value as PartnerStatus,
                      })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {["PENDING", "ACTIVE", "SUSPENDED", "DISABLED"].map(
                        (value) => (
                          <SelectItem key={value} value={value}>
                            {value}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </Field>
                <p className="mt-2 text-xs text-muted-foreground">
                  Suspended partners retain read access but cannot mutate.
                  Disabled partners cannot authenticate.
                </p>
                <Button
                  className="mt-4"
                  variant={
                    settings.status === "DISABLED" ? "destructive" : "outline"
                  }
                  disabled={
                    settings.status === partner.status || busy === "status"
                  }
                  onClick={() => {
                    const run = () =>
                      mutate(
                        "status",
                        `/admin/partners/${id}`,
                        {
                          method: "PATCH",
                          body: JSON.stringify({ status: settings.status }),
                        },
                        `Partner status changed to ${settings.status}`,
                      );
                    if (["SUSPENDED", "DISABLED"].includes(settings.status))
                      showConfirm({
                        title: `Change status to ${settings.status}`,
                        description:
                          settings.status === "DISABLED"
                            ? "All partner API authentication will stop immediately."
                            : "Partner mutations will be blocked until reactivated.",
                        expected: partner.code,
                        actionLabel: `Set ${settings.status}`,
                        destructive: true,
                        run,
                      });
                    else void run();
                  }}
                >
                  Apply status
                </Button>
              </div>
            </div>
          </Panel>
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        state={confirm}
        typed={confirmText}
        reason={confirmReason}
        busy={Boolean(busy)}
        onTyped={setConfirmText}
        onReason={setConfirmReason}
        onClose={() => setConfirm(null)}
        onConfirm={() => void runConfirmed()}
      />
      <SecretDialog secret={secret} onClose={() => setSecret(null)} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
function Field({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
function Filters({
  from,
  to,
  query,
  status,
  onFrom,
  onTo,
  onQuery,
  onStatus,
}: {
  from: string;
  to: string;
  query: string;
  status: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  onQuery: (v: string) => void;
  onStatus: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-3">
      <Input
        type="date"
        aria-label="From date"
        value={from}
        onChange={(e) => onFrom(e.target.value)}
        className="w-44"
      />
      <Input
        type="date"
        aria-label="To date"
        value={to}
        onChange={(e) => onTo(e.target.value)}
        className="w-44"
      />
      <Input
        aria-label="Order search"
        placeholder="Order or external ID"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        className="min-w-52 flex-1"
      />
      <Select value={status} onValueChange={onStatus}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {[
            "ALL",
            "CREATED",
            "APPROVED",
            "PROVISIONING",
            "QR_READY",
            "COMPLETED",
            "PROVISIONING_FAILED",
            "CANCELLED",
            "REFUNDED",
          ].map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
function AdjustmentForm({
  value,
  onChange,
  onSubmit,
}: {
  value: { amountNpr: string; reference: string; reason: string };
  onChange: (value: {
    amountNpr: string;
    reference: string;
    reason: string;
  }) => void;
  onSubmit: () => void;
}) {
  const valid =
    Number.isFinite(Number(value.amountNpr)) &&
    Number(value.amountNpr) !== 0 &&
    value.reference.trim().length >= 4 &&
    value.reason.trim().length >= 4;
  return (
    <div className="grid gap-3 border-b p-5 md:grid-cols-[1fr_1.5fr_2fr_auto]">
      <Field label="Amount (NPR, negative corrects)">
        <Input
          type="number"
          step="0.01"
          value={value.amountNpr}
          onChange={(e) => onChange({ ...value, amountNpr: e.target.value })}
          placeholder="5000"
        />
      </Field>
      <Field label="Unique reference">
        <Input
          value={value.reference}
          onChange={(e) => onChange({ ...value, reference: e.target.value })}
          placeholder="bank-deposit-2026-001"
        />
      </Field>
      <Field label="Reason">
        <Input
          value={value.reason}
          onChange={(e) => onChange({ ...value, reason: e.target.value })}
          placeholder="Offline settlement received"
        />
      </Field>
      <Button className="self-end" disabled={!valid} onClick={onSubmit}>
        Review
      </Button>
    </div>
  );
}
function ConfirmDialog({
  state,
  typed,
  reason,
  busy,
  onTyped,
  onReason,
  onClose,
  onConfirm,
}: {
  state: ConfirmState | null;
  typed: string;
  reason: string;
  busy: boolean;
  onTyped: (v: string) => void;
  onReason: (v: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const enabled =
    !!state &&
    typed === state.expected &&
    (!state.reasonRequired || reason.trim().length >= 4);
  return (
    <Dialog open={Boolean(state)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{state?.title}</DialogTitle>
          <DialogDescription>{state?.description}</DialogDescription>
        </DialogHeader>
        {state?.reasonRequired && (
          <Field label="Decision reason">
            <Input
              aria-label="Decision reason"
              value={reason}
              onChange={(e) => onReason(e.target.value)}
              placeholder="Required for the audit log"
            />
          </Field>
        )}
        <Field
          label={
            <>
              Type <code>{state?.expected}</code> to confirm
            </>
          }
        >
          <Input
            aria-label={`Type ${state?.expected ?? "confirmation"} to confirm`}
            value={typed}
            onChange={(e) => onTyped(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={state?.destructive ? "destructive" : "default"}
            disabled={!enabled || busy}
            onClick={onConfirm}
          >
            {busy ? <Spinner /> : null}
            {state?.actionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
function SecretDialog({
  secret,
  onClose,
}: {
  secret: { label: string; value: string } | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={Boolean(secret)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{secret?.label}</DialogTitle>
          <DialogDescription>
            This value is shown once. Store it securely before closing.
          </DialogDescription>
        </DialogHeader>
        <code className="break-all rounded-lg bg-muted p-3 text-xs">
          {secret?.value}
        </code>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={async () => {
              if (!secret) return;
              try {
                await navigator.clipboard.writeText(secret.value);
                toast.success("Secret copied");
              } catch {
                toast.error("Clipboard access was denied");
              }
            }}
          >
            <Copy />
            Copy
          </Button>
          <Button onClick={onClose}>I have stored it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
