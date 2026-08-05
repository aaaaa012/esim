"use client";
import { useAuthenticatedFetch } from "../../authenticated-api-provider";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ChevronLeft,
  LoaderCircle,
  RefreshCcw,
  UserRound,
} from "lucide-react";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const headers = { "content-type": "application/json" };
type Esim = {
  iccid: string;
  status: string;
  activatedAt?: string;
  expiresAt?: string;
  usage?: { usedMb: number; totalMb: number; lastCheckedAt: string };
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
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Load failed"));
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
        throw new Error(
          value.error?.message ?? "Usage could not be refreshed",
        );
      setProfile((previous) =>
        previous
          ? {
              ...previous,
              orders: previous.orders.map((order) =>
                order.id === orderId && order.esim
                  ? {
                      ...order,
                      esim: {
                        ...order.esim,
                        usage: value.data,
                      },
                    }
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
      <div className="top">
        <div>
          <Link className="back-link" href="/customers">
            <ChevronLeft size={16} /> Customers
          </Link>
          <h1>{profile ? (profile.name ?? "Customer profile") : "Loading…"}</h1>
          <p>
            {profile
              ? `${profile.customerCode ?? profile.ownerId}${
                  profile.email ? ` · ${profile.email}` : ""
                }`
              : "Identity and order history"}
          </p>
        </div>
        <span className="profile-identity">
          <UserRound size={16} />
          {profile?.orders?.length ?? 0} orders · {completed.length} completed{" "}
          {completed.length === 1 ? "eSIM" : "eSIMs"}
        </span>
      </div>
      {error && <div className="form-error">{error}</div>}
      {!profile && !error ? (
        <div className="panel">
          <div className="empty-table">
            <LoaderCircle className="spin" />
            Loading customer profile…
          </div>
        </div>
      ) : null}
      {profile ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Order history</h2>
            <span>{profile.orders.length} orders</span>
          </div>
          {!profile.orders.length ? (
            <div className="empty-table">No orders for this customer.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Plan</th>
                    <th>Status</th>
                    <th>Traveler</th>
                    <th>eSIM / Usage</th>
                    <th>Total</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {profile.orders.map((order) => {
                    const usage = order.esim?.usage;
                    return (
                      <tr key={order.id}>
                        <td>
                          <b>{order.orderNumber}</b>
                          <small>
                            {new Date(order.createdAt).toLocaleDateString()}
                          </small>
                        </td>
                        <td>
                          {order.plan.countryCode} · {order.plan.name}
                          <small>
                            {order.plan.dataAllowance} · {order.plan.validityDays}
                            {" "}days
                          </small>
                        </td>
                        <td>
                          <span
                            className={`health-badge ${
                              order.status === "COMPLETED" ? "healthy" : "warning"
                            }`}
                          >
                            {order.status.replaceAll("_", " ")}
                          </span>
                        </td>
                        <td>
                          {order.traveler
                            ? `${order.traveler.firstName} ${order.traveler.surname}`
                            : "—"}
                          {order.traveler?.mobile ? (
                            <small>{order.traveler.mobile}</small>
                          ) : null}
                        </td>
                        <td>
                          {order.esim ? (
                            <>
                              <code>{order.esim.iccid}</code>
                              {usage ? (
                                <small>
                                  {usage.usedMb.toLocaleString()} /{" "}
                                  {usage.totalMb.toLocaleString()} MB ·{" "}
                                  {new Date(
                                    usage.lastCheckedAt,
                                  ).toLocaleDateString()}
                                </small>
                              ) : (
                                <small>Status: {order.esim.status}</small>
                              )}
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>NPR {order.totalAmountNpr.toLocaleString()}</td>
                        <td>
                          {order.esim?.usage ? (
                            <button
                              className="admin-action"
                              disabled={busy === order.id}
                              onClick={() => refreshUsage(order.id)}
                            >
                              {busy === order.id ? (
                                <LoaderCircle className="spin" size={14} />
                              ) : (
                                <RefreshCcw size={14} />
                              )}
                              Refresh usage
                            </button>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}