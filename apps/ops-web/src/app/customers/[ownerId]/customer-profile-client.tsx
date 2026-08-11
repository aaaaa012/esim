"use client";
import { useAuthenticatedFetch } from "../../authenticated-api-provider";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, RefreshCcw, UserRound } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { Spinner } from "@/components/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const headers = { "content-type": "application/json" };
type Esim = {
  iccid: string;
  status: string;
  activatedAt?: string;
  expiresAt?: string;
  usage?: { usedMb: number; totalMb: number; remainingMb: number; lastCheckedAt: string };
};
type Order = {
  id: string;
  orderNumber: string;
  status: string;
  createdAt: string;
  totalAmountNpr: number;
  plan: {
    id: string;
    name: string;
    dataAllowance: string;
    validityDays: number;
    countryCode: string;
    countryName: string;
  };
  traveler?: { firstName: string; surname: string; mobile?: string; email?: string };
  esim?: Esim;
};
type Profile = {
  ownerId: string;
  customerCode?: string;
  email?: string;
  name?: string;
  orders: Order[];
};

const usageTone = (used?: number, total?: number) =>
  used != null && total ? Math.min(100, Math.round((used / total) * 100)) : 0;

export default function CustomerProfile({ ownerId }: { ownerId: string }) {
  const authFetch = useAuthenticatedFetch();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(() => {
    setError("");
    return authFetch(`${API}/operations/customers/${ownerId}`, { headers })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok)
          throw new Error(value.error?.message ?? "Profile could not be loaded");
        setProfile(value.data);
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Load failed"),
      );
  }, [authFetch, ownerId]);
  useEffect(() => {
    void load();
  }, [load]);
  const refreshUsage = async (orderId: string) => {
    setBusy(orderId);
    setError("");
    try {
      const response = await authFetch(
        `${API}/operations/orders/${orderId}/usage/refresh`,
        { method: "POST", headers },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error?.message ?? "Usage could not be refreshed");
      setProfile((previous) =>
        previous
          ? {
              ...previous,
              orders: previous.orders.map((order) =>
                order.id === orderId && order.esim
                  ? { ...order, esim: { ...order.esim, usage: value.data } }
                  : order,
              ),
            }
          : previous,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Refresh failed");
    } finally {
      setBusy("");
    }
  };
  const completed = useMemo(
    () => profile?.orders.filter((order) => order.status === "COMPLETED") ?? [],
    [profile],
  );

  return (
    <>
      <PageHeader
        title={profile ? (profile.name ?? "Customer profile") : "Loading…"}
        description={
          profile
            ? `${profile.customerCode ?? profile.ownerId}${profile.email ? ` · ${profile.email}` : ""}`
            : "Identity and order history"
        }
        badge={
          <span className="inline-flex items-center gap-2 rounded-full bg-success-soft px-3 py-1 text-xs font-semibold text-success-foreground">
            <UserRound className="size-3.5" />
            {profile?.orders?.length ?? "—"} orders · {completed.length} completed eSIM
            {completed.length === 1 ? "" : "s"}
          </span>
        }
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/customers">
              <ArrowLeft className="size-4" /> Customers
            </Link>
          </Button>
        }
      />
      {error && (
        <div className="mb-6 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {!profile && !error ? (
        <div className="flex h-40 items-center justify-center">
          <Spinner />
        </div>
      ) : null}
      {profile ? (
        <Panel
          title="Order history"
          description={`${profile.orders.length} orders`}
          noPadding
        >
          {!profile.orders.length ? (
            <EmptyState title="No orders yet" description="This customer has no orders." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Traveler</TableHead>
                  <TableHead>eSIM / Usage</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {profile.orders.map((order) => {
                  const usage = order.esim?.usage;
                  const used = usage?.usedMb;
                  const total = usage?.totalMb;
                  return (
                    <TableRow key={order.id}>
                      <TableCell>
                        <p className="font-medium">{order.orderNumber}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(order.createdAt).toLocaleDateString()}
                        </p>
                      </TableCell>
                      <TableCell>
                        <span className="font-medium">{order.plan.countryCode}</span> ·{" "}
                        {order.plan.name}
                        <p className="text-xs text-muted-foreground">
                          {order.plan.dataAllowance} · {order.plan.validityDays} days
                        </p>
                      </TableCell>
                      <TableCell>
                        <StatusBadge label={order.status} />
                      </TableCell>
                      <TableCell>
                        {order.traveler
                          ? `${order.traveler.firstName} ${order.traveler.surname}`
                          : "—"}
                        {order.traveler?.mobile ? (
                          <p className="text-xs text-muted-foreground">
                            {order.traveler.mobile}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {order.esim ? (
                          <>
                            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                              {order.esim.iccid}
                            </code>
                            {usage ? (
                              <div className="mt-1.5 space-y-1">
                                <div className="h-1.5 w-28 overflow-hidden rounded-full bg-muted">
                                  <div
                                    className="h-full rounded-full bg-primary"
                                    style={{ width: `${usageTone(used, total)}%` }}
                                  />
                                </div>
                                <p className="text-xs text-muted-foreground">
                                  {used?.toLocaleString() ?? 0} / {total?.toLocaleString() ?? "?"} MB
                                </p>
                                <p className="text-xs font-medium text-foreground">
                                  {usage.remainingMb.toLocaleString()} MB remaining
                                </p>
                              </div>
                            ) : (
                              <p className="text-xs text-muted-foreground">
                                Status: {order.esim.status}
                              </p>
                            )}
                          </>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        NPR {order.totalAmountNpr.toLocaleString()}
                      </TableCell>
                      <TableCell>
                        {order.esim?.usage ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy === order.id}
                            onClick={() => refreshUsage(order.id)}
                          >
                            {busy === order.id ? (
                              <Spinner />
                            ) : (
                              <RefreshCcw className="size-3.5" />
                            )}
                            Refresh usage
                          </Button>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Panel>
      ) : null}
    </>
  );
}
