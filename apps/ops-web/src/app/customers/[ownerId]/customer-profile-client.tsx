"use client";
import { useAuthenticatedFetch } from "../../authenticated-api-provider";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Mail, RefreshCcw, UserRound } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { StatusBadge, humane } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { Spinner } from "@/components/spinner";
import ErrorDialog from "@/components/error-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LifecycleActions } from "../../transatel/lifecycle-actions";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const headers = { "content-type": "application/json" };
type Esim = {
  iccid: string;
  status: string;
  providerStatus?: string | null;
  activatedAt?: string;
  expiresAt?: string;
  usage?: {
    usedMb: number;
    totalMb: number;
    remainingMb: number;
    lastCheckedAt: string;
  };
};
type Order = {
  id: string;
  orderNumber: string;
  status: string;
  createdAt: string;
  totalAmountNpr: number;
  purchaseType: "INITIAL_PURCHASE" | "TOPUP";
  channel: string;
  topUpMobile?: string | null;
  plan: {
    id: string;
    name: string;
    dataAllowance: string;
    validityDays: number;
    countryCode: string;
    countryName: string;
  };
  traveler?: {
    firstName: string;
    surname: string;
    mobile?: string;
    email?: string;
  };
  esim?: Esim;
};
type Profile = {
  ownerId: string;
  customerCode?: string;
  email?: string;
  name?: string;
  orders: Order[];
  esimGroups?: Array<{
    esim: { id: string; iccid: string; msisdn: string | null; status: string };
    completeness: string;
    freshness: string;
    summary: {
      remainingMb: number;
      confirmedPackageCount: number;
      unconfirmedPackageCount: number;
      packageCount: number;
    };
    packages: Array<{
      id: string;
      orderId: string;
      orderNumber: string;
      purchaseType: string;
      channel: string;
      status: string;
      balanceStatus: string;
      remainingMb: number;
      providerSubscriptionId: string;
      plan: { name: string; dataAllowance: string; countryCode: string };
    }>;
  }>;
  identity?: {
    customer: {
      id: string;
      customerCode: string;
      email: string;
      phone?: string | null;
      source: string;
      status: string;
      createdAt: string;
    };
    loginAccount?: {
      id: string;
      email: string;
      status: string;
      accountType: string;
      createdAt: string;
    } | null;
    partnerCustomer?: {
      id: string;
      externalCustomerId: string;
      partner: { id: string; code: string; name: string };
    } | null;
  };
  profileUpdates?: Array<{
    id: string;
    action: string;
    previousValue?: { email?: string } | null;
    newValue?: { email?: string; reason?: string } | null;
    performedBy: string;
    createdAt: string;
  }>;
};

const usageTone = (used?: number, total?: number) =>
  used != null && total ? Math.min(100, Math.round((used / total) * 100)) : 0;

export default function CustomerProfile({ ownerId }: { ownerId: string }) {
  const authFetch = useAuthenticatedFetch();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [canTerminate, setCanTerminate] = useState(false);
  const [email, setEmail] = useState("");
  const [emailReason, setEmailReason] = useState("");
  const [emailConfirmation, setEmailConfirmation] = useState("");
  const [emailUpdateResult, setEmailUpdateResult] = useState("");
  const load = useCallback(() => {
    setError("");
    return authFetch(`${API}/operations/customers/${ownerId}`, { headers })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok)
          throw new Error(
            value.error?.message ?? "Profile could not be loaded",
          );
        setProfile(value.data);
        setEmail(value.data.identity?.customer.email ?? value.data.email ?? "");
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Load failed"),
      );
  }, [authFetch, ownerId]);
  useEffect(() => {
    void load();
    void authFetch(`${API}/auth/me`, { headers })
      .then((response) => response.json())
      .then((value) =>
        setCanTerminate(value.data?.accountType === "SUPER_ADMIN"),
      );
  }, [load]);
  const refreshUsage = async (orderId: string) => {
    setBusy(orderId);
    setError("");
    try {
      const response = await authFetch(
        `${API}/operations/orders/${orderId}/usage/refresh`,
        {
          method: "POST",
          headers: { ...headers, "x-idempotency-key": crypto.randomUUID() },
        },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error?.message ?? "Usage could not be refreshed");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Refresh failed");
    } finally {
      setBusy("");
    }
  };
  const correctEmail = async () => {
    setBusy("email");
    setError("");
    setEmailUpdateResult("");
    try {
      const response = await authFetch(
        `${API}/operations/customers/${ownerId}/email`,
        {
          method: "PATCH",
          headers: { ...headers, "x-idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({
            email,
            reason: emailReason,
            confirmation: normalizedEmailConfirmation,
          }),
        },
      );
      const value = (await response.json()) as {
        data?: {
          changed?: boolean;
          sessionsRevoked?: number;
          sessionsFound?: number;
        };
        error?: { message?: string };
      };
      if (!response.ok)
        throw new Error(value.error?.message ?? "Email could not be updated");
      const sessionsFound = value.data?.sessionsFound ?? 0;
      const sessionsRevoked = value.data?.sessionsRevoked ?? 0;
      setEmailUpdateResult(
        value.data?.changed
          ? sessionsRevoked === sessionsFound
            ? `Email updated. ${sessionsRevoked} active session${sessionsRevoked === 1 ? "" : "s"} ended.`
            : `Email updated, but only ${sessionsRevoked} of ${sessionsFound} active sessions ended. Review the identity-service logs.`
          : "No change was needed because this is already the customer's sign-in email.",
      );
      setEmailReason("");
      setEmailConfirmation("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Email update failed");
    } finally {
      setBusy("");
    }
  };
  const orderSummary = useMemo(() => {
    const orders = profile?.orders ?? [];
    return {
      firstPurchases: orders.filter(
        (order) => order.purchaseType === "INITIAL_PURCHASE",
      ).length,
      topUps: orders.filter((order) => order.purchaseType === "TOPUP").length,
    };
  }, [profile]);
  const normalizedEmailConfirmation = emailConfirmation
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
  const originalEmail = (
    profile?.identity?.customer.email ??
    profile?.email ??
    ""
  )
    .trim()
    .toLowerCase();
  const normalizedEmail = email.trim().toLowerCase();
  const emailIsValid = /^\S+@\S+\.\S+$/.test(normalizedEmail);
  const emailUpdateReady =
    emailIsValid &&
    normalizedEmail !== originalEmail &&
    emailReason.trim().length >= 10 &&
    normalizedEmailConfirmation === "CHANGE EMAIL";

  return (
    <>
      <PageHeader
        title={profile ? (profile.name ?? "Customer profile") : "Loading…"}
        description={
          profile
            ? `${profile.customerCode ?? "Customer"}${profile.email ? ` · ${profile.email}` : ""}`
            : "Identity and order history"
        }
        badge={
          <span className="inline-flex items-center gap-2 rounded-full bg-success-soft px-3 py-1 text-xs font-semibold text-success-foreground">
            <UserRound className="size-3.5" />
            {profile?.orders?.length ?? "—"} orders · {orderSummary.firstPurchases}{" "}
            eSIM{orderSummary.firstPurchases === 1 ? "" : "s"} · {orderSummary.topUps}{" "}
            top-up{orderSummary.topUps === 1 ? "" : "s"}
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
      <ErrorDialog error={error} onClose={() => setError("")} />
      {!profile && !error ? (
        <div className="flex h-40 items-center justify-center">
          <Spinner />
        </div>
      ) : null}
      {profile ? (
        <Panel
          title="Physical eSIM usage"
          description="Confirmed aggregate balances with every initial package and top-up"
        >
          {profile.esimGroups?.length ? (
            <div className="space-y-3">
              {profile.esimGroups.map((group) => (
                <details
                  key={group.esim.id}
                  className="rounded-lg border bg-card"
                  open={profile.esimGroups?.length === 1}
                >
                  <summary className="flex cursor-pointer items-center justify-between gap-4 p-4">
                    <span>
                      <span className="block font-medium">
                        ICCID / SIM serial: {group.esim.iccid}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        MSISDN: {group.esim.msisdn ?? "Not assigned"} ·{" "}
                        {group.summary.confirmedPackageCount} of{" "}
                        {group.summary.packageCount} packages confirmed ·{" "}
                        {humane(group.freshness)}
                      </span>
                    </span>
                    <span className="font-semibold tabular-nums">
                      {group.summary.remainingMb.toLocaleString()} MB available
                    </span>
                  </summary>
                  <div className="border-t px-4 py-2">
                    {group.packages.map((item) => (
                      <div
                        key={item.id}
                        className="grid gap-2 border-b py-3 last:border-0 sm:grid-cols-[1fr_auto_auto]"
                      >
                        <div>
                          <Link
                            href={`/orders/${item.orderId}`}
                            className="font-medium text-primary hover:underline"
                          >
                            {item.orderNumber} · {item.plan.name}
                          </Link>
                          <p className="text-xs text-muted-foreground">
                            {humane(item.purchaseType)} · {humane(item.channel)}{" "}
                            · Subscription ID: {item.providerSubscriptionId}
                          </p>
                        </div>
                        <StatusBadge label={item.balanceStatus} />
                        <span className="text-sm font-medium tabular-nums">
                          {item.balanceStatus === "CONFIRMED" ||
                          item.balanceStatus === "LAST_KNOWN"
                            ? `${item.remainingMb.toLocaleString()} MB remaining`
                            : item.balanceStatus === "WAITING_FOR_FIRST_USE"
                              ? "Waiting for provider balance"
                              : "Balance not confirmed"}
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No provisioned eSIM"
              description="Usage appears after an eSIM package is provisioned."
            />
          )}
        </Panel>
      ) : null}
      {profile ? (
        <Panel
          title="Customer identity"
          description="Customer, login account, and partner relationship"
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <p className="text-xs text-muted-foreground">Customer</p>
              <p className="font-medium">
                {profile.identity?.customer.customerCode ??
                  profile.customerCode}
              </p>
              <p className="text-sm text-muted-foreground">
                {profile.identity?.customer.email ?? profile.email}
              </p>
              {profile.identity?.loginAccount ? (
                <Button asChild variant="outline" size="sm" className="mt-2">
                  <Link href={`/users/${profile.identity.loginAccount.id}`}>
                    View login account
                  </Link>
                </Button>
              ) : null}
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Login account</p>
              <p className="font-medium">
                {profile.identity?.loginAccount
                  ? profile.identity.loginAccount.email
                  : "Guest / no login account"}
              </p>
              <p className="text-sm text-muted-foreground">
                {profile.identity?.loginAccount
                  ? `${humane(profile.identity.loginAccount.accountType)} · ${humane(profile.identity.loginAccount.status)}`
                  : "No signed-in user is linked"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Partner</p>
              {profile.identity?.partnerCustomer ? (
                <>
                  <Link
                    href={`/admin/partners/${profile.identity.partnerCustomer.partner.id}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {profile.identity.partnerCustomer.partner.name}
                  </Link>
                  <p className="text-sm text-muted-foreground">
                    External customer:{" "}
                    {profile.identity.partnerCustomer.externalCustomerId}
                  </p>
                </>
              ) : (
                <p className="font-medium">Direct customer</p>
              )}
            </div>
          </div>
        </Panel>
      ) : null}
      {profile ? (
        <Panel
          title="Personal detail updates"
          description="Auditable corrections to customer identity data. Order and traveller records remain unchanged."
        >
          {canTerminate && profile.identity?.loginAccount ? (
            <section className="mb-6 rounded-lg border bg-muted/20 p-4">
              <div className="flex items-start gap-3">
                <Mail className="mt-0.5 size-4 text-primary" />
                <div className="w-full max-w-2xl space-y-4">
                  <div>
                    <h3 className="font-medium">Correct sign-in email</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Super Admin only. This updates Clerk and the customer
                      record, notifies the customer, signs out existing
                      sessions, and records the reason below.
                    </p>
                  </div>
                  <label className="block text-sm font-medium">
                    New email
                    <input
                      className="mt-1 h-10 w-full rounded-md border bg-background px-3 font-normal"
                      type="email"
                      autoComplete="off"
                      value={email}
                      onChange={(event) => {
                        setEmail(event.target.value);
                        setEmailUpdateResult("");
                      }}
                    />
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Must be a valid address different from the current email.
                    </span>
                  </label>
                  <label className="block text-sm font-medium">
                    Reason for correction
                    <textarea
                      className="mt-1 min-h-24 w-full rounded-md border bg-background px-3 py-2 font-normal"
                      maxLength={500}
                      value={emailReason}
                      onChange={(event) => {
                        setEmailReason(event.target.value);
                        setEmailUpdateResult("");
                      }}
                      placeholder="Describe how the corrected email was verified."
                    />
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {emailReason.trim().length}/500 characters. Minimum 10.
                    </span>
                  </label>
                  <label className="block text-sm font-medium">
                    Type CHANGE EMAIL to confirm
                    <input
                      className="mt-1 h-10 w-full rounded-md border bg-background px-3 font-normal"
                      value={emailConfirmation}
                      onChange={(event) => {
                        setEmailConfirmation(event.target.value);
                        setEmailUpdateResult("");
                      }}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="CHANGE EMAIL"
                    />
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Capitalization and extra spaces are accepted.
                    </span>
                  </label>
                  {!emailUpdateReady ? (
                    <p className="text-xs text-muted-foreground" role="status">
                      Complete all three requirements to enable this action.
                    </p>
                  ) : null}
                  <Button
                    type="button"
                    disabled={
                      busy === "email" ||
                      !emailUpdateReady
                    }
                    onClick={() => void correctEmail()}
                  >
                    {busy === "email" ? <Spinner /> : null}
                    Update email and end active sessions
                  </Button>
                  {emailUpdateResult ? (
                    <p
                      className={`text-sm ${emailUpdateResult.includes("only") ? "text-destructive" : "text-emerald-700"}`}
                      role="status"
                    >
                      {emailUpdateResult}
                    </p>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}
          {profile.profileUpdates?.length ? (
            <div className="space-y-3">
              {profile.profileUpdates.map((update) => (
                <article key={update.id} className="rounded-lg border p-4">
                  <div className="flex flex-wrap justify-between gap-2">
                    <strong className="text-sm">Sign-in email corrected</strong>
                    <time className="text-xs text-muted-foreground">
                      {new Date(update.createdAt).toLocaleString()}
                    </time>
                  </div>
                  <p className="mt-2 text-sm">
                    {update.previousValue?.email ??
                      "Previous email unavailable"}
                    {" -> "}
                    {update.newValue?.email ?? "Updated email unavailable"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {update.newValue?.reason ?? "No reason recorded"} |
                    Performed by {update.performedBy}
                  </p>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No personal detail changes"
              description="Verified changes to customer details will appear here."
            />
          )}
        </Panel>
      ) : null}
      {profile ? (
        <Panel
          title="Order history"
          description={`${profile.orders.length} orders`}
          noPadding
        >
          {!profile.orders.length ? (
            <EmptyState
              title="No orders yet"
              description="This customer has no orders."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Traveller</TableHead>
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
                        <Link
                          className="font-medium text-primary underline-offset-4 hover:underline"
                          href={`/orders/${order.id}`}
                        >
                          {order.orderNumber}
                        </Link>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          <StatusBadge
                            label={order.purchaseType}
                            tone={
                              order.purchaseType === "TOPUP"
                                ? "info"
                                : "default"
                            }
                          />
                          <StatusBadge label={order.channel} />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {new Date(order.createdAt).toLocaleString()}
                        </p>
                        {order.purchaseType === "TOPUP" && order.topUpMobile ? (
                          <p className="text-xs text-muted-foreground">
                            Top-up for {order.topUpMobile}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <span className="font-medium">
                          {order.plan.countryCode}
                        </span>{" "}
                        · {order.plan.name}
                        <p className="text-xs text-muted-foreground">
                          {order.plan.dataAllowance} · {order.plan.validityDays}{" "}
                          days
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
                                    style={{
                                      width: `${usageTone(used, total)}%`,
                                    }}
                                  />
                                </div>
                                <p className="text-xs text-muted-foreground">
                                  {used?.toLocaleString() ?? 0} /{" "}
                                  {total?.toLocaleString() ?? "?"} MB
                                </p>
                                <p className="text-xs font-medium text-foreground">
                                  {usage.remainingMb.toLocaleString()} MB
                                  remaining
                                </p>
                              </div>
                            ) : (
                              <p className="text-xs text-muted-foreground">
                                Status: {humane(order.esim.status)}
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
                        <div className="space-y-2">
                          {order.esim ? (
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
                              )}{" "}
                              Update data
                            </Button>
                          ) : null}
                          {order.esim ? (
                            <LifecycleActions
                              orderId={order.id}
                              iccid={order.esim.iccid}
                              providerStatus={
                                order.esim.providerStatus ?? order.esim.status
                              }
                              canTerminate={canTerminate}
                              onCompleted={() => void load()}
                            />
                          ) : (
                            "—"
                          )}
                          <Button asChild variant="outline" size="sm">
                            <Link href={`/orders/${order.id}`}>Open order</Link>
                          </Button>
                        </div>
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
