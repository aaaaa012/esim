"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { formatPlanDataText } from "../../../lib/format-data";
import {
  ArrowRight,
  Clock3,
  Plus,
  QrCode,
  RefreshCcw,
} from "lucide-react";
import { OrderRowsLoading } from "./order-loading";
import type { OrderSummary } from "@visa-compass/shared";
import { apiErrorMessage, orderStatusLabel } from "@visa-compass/shared";
import { useAuthenticatedFetch } from "../../authenticated-api-provider";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type Order = OrderSummary & {
  purchaseType?: "INITIAL_PURCHASE" | "TOPUP";
  purchaseContext?: "TOPUP" | "NEW_DESTINATION" | "FIRST_PURCHASE";
  rechargeFor?: "OWN" | "OTHER";
  targetSuffix?: string;
};
const processing = [
  "PAYMENT_PENDING",
  "PAYMENT_CONFIRMED",
  "REVIEW_PENDING",
  "APPROVED",
  "PROVISIONING",
];
const ready = ["QR_READY"];
const action = [
  "DRAFT",
  "AWAITING_CUSTOMER",
  "PAYMENT_FAILED",
  "PROVISIONING_FAILED",
  "ACTIVATION_ATTENTION",
];

function countryFlag(countryCode: string) {
  const code = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "🌐";
  return String.fromCodePoint(
    ...[...code].map((letter) => 127397 + letter.charCodeAt(0)),
  );
}
export default function OrderList() {
  const authFetch = useAuthenticatedFetch();
  const [orders, setOrders] = useState<Order[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [filter, setFilter] = useState("ALL");
  const [attempt, setAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setRefreshing(true);
    setError("");
    void authFetch(`${API}/recharges/purchases`, {
      headers: {},
      signal: controller.signal,
    })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok)
          throw new Error(
            apiErrorMessage(
              value.error?.code ?? "",
              "Your eSIMs could not be loaded.",
            ),
          );
        return value.data;
      })
      .then((value) => {
        if (!cancelled) setOrders(value);
      })
      .catch(() => {
        if (!cancelled)
          setError(
            "Your orders could not be refreshed. Check your connection and try again.",
          );
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [authFetch, attempt]);
  useEffect(() => {
    if (
      loading ||
      refreshing ||
      !orders.some((order) => processing.includes(order.status))
    )
      return;
    const timer = setTimeout(() => setAttempt((value) => value + 1), 10_000);
    return () => clearTimeout(timer);
  }, [orders, loading, refreshing]);
  const counts = useMemo(
    () => ({
      complete: orders.filter((order) => order.status === "COMPLETED").length,
      processing: orders.filter((order) => processing.includes(order.status))
        .length,
      ready: orders.filter((order) => ready.includes(order.status)).length,
      action: orders.filter((order) => action.includes(order.status)).length,
    }),
    [orders],
  );
  const visible = orders.filter(
    (order) =>
      filter === "ALL" ||
      (filter === "COMPLETE" && order.status === "COMPLETED") ||
      (filter === "PROCESSING" && processing.includes(order.status)) ||
      (filter === "READY" && ready.includes(order.status)) ||
      (filter === "ACTION" && action.includes(order.status)),
  );
  return (
    <main className="account-page orders-page">
      <div className="shell">
        <div className="account-head orders-head">
          <div>
            <h1>Orders</h1>
            <p>
              Purchases, recharges, and activation events, in one list.
            </p>
          </div>
          <div className="account-head-actions">
            <button
              className="button secondary"
              disabled={refreshing}
              onClick={() => setAttempt((value) => value + 1)}
            >
              <RefreshCcw size={17} className={refreshing ? "spin" : ""} />
              {refreshing ? "Refreshing…" : "Refresh orders"}
            </button>
            <Link className="button" href="/destinations">
              <Plus size={17} />
              Buy a plan
            </Link>
          </div>
        </div>
        {!loading && orders.length > 0 && (
          <>
            <section className="customer-stats">
              <button
                aria-pressed={filter === "COMPLETE"}
                onClick={() => setFilter("COMPLETE")}
              >
                <span>
                  <b>{counts.complete}</b>Completed
                </span>
              </button>
              <button
                aria-pressed={filter === "PROCESSING"}
                onClick={() => setFilter("PROCESSING")}
              >
                <span>
                  <b>{counts.processing}</b>Processing
                </span>
              </button>
              <button
                aria-pressed={filter === "READY"}
                onClick={() => setFilter("READY")}
              >
                <span>
                  <b>{counts.ready}</b>Ready
                </span>
              </button>
              <button
                aria-pressed={filter === "ACTION"}
                onClick={() => setFilter("ACTION")}
              >
                <span>
                  <b>{counts.action}</b>Needs action
                </span>
              </button>
            </section>
            <div className="customer-filters">
              {["ALL", "ACTION", "READY", "PROCESSING", "COMPLETE"].map(
                (item) => (
                  <button
                    key={item}
                    className={filter === item ? "selected" : ""}
                    aria-label={
                      item === "ALL"
                        ? "All orders"
                        : item === "COMPLETE"
                          ? "Completed"
                          : item === "ACTION"
                            ? "Needs action"
                            : item === "READY"
                              ? "Ready to install"
                              : "Processing"
                    }
                    aria-pressed={filter === item}
                    onClick={() => setFilter(item)}
                  >
                    {item === "ALL"
                      ? `All ${orders.length}`
                      : item === "COMPLETE"
                        ? `Completed ${counts.complete}`
                        : item === "ACTION"
                          ? `Needs action ${counts.action}`
                          : item === "READY"
                            ? `Ready ${counts.ready}`
                            : `Processing ${counts.processing}`}
                  </button>
                ),
              )}
            </div>
          </>
        )}
        {loading || (refreshing && orders.length === 0) ? (
          <OrderRowsLoading />
        ) : null}
        {error && (
          <div className="customer-load-error" role="alert">
            <p>{error}</p>
            <button
              className="button secondary"
              disabled={refreshing}
              onClick={() => setAttempt((value) => value + 1)}
            >
              Try again
            </button>
          </div>
        )}
        {!loading && !refreshing && !error && orders.length === 0 ? (
          <div className="account-empty">
            <QrCode size={35} />
            <h2>No orders yet</h2>
            <p>Your purchases and top-ups will appear here.</p>
            <Link className="button" href="/destinations">
              Browse plans
            </Link>
          </div>
        ) : !loading && !refreshing && !error && visible.length === 0 ? (
          <div className="account-empty compact">
            <p>No orders in this category.</p>
            <button
              className="button secondary"
              onClick={() => setFilter("ALL")}
            >
              Show all orders
            </button>
          </div>
        ) : (
          <div className="esim-list" aria-busy={refreshing}>
            {visible.map((order) => (
              <Link
                href={
                  order.purchaseType === "TOPUP"
                    ? `/esim/checkout?order=${order.id}&recharge=1`
                    : `/account/orders/${order.id}`
                }
                className="esim-row"
                key={order.id}
              >
                <span className="order-country-flag" aria-hidden="true">
                  {countryFlag(order.plan.countryCode)}
                </span>
                <div className="esim-main">
                  <div>
                    <h2>{order.plan.name}</h2>
                    <span>
                      {order.orderNumber} ·{" "}
                      {order.purchaseType === "TOPUP"
                        ? order.rechargeFor === "OTHER"
                          ? `Recharge for another eSIM${order.targetSuffix ? ` · ending ${order.targetSuffix}` : ""}`
                          : "Recharge"
                        : "Plan purchase"}
                    </span>
                  </div>
                  <p className="order-plan-facts">
                    <span>{formatPlanDataText(order.plan.dataAllowance)}</span>
                    <span>
                      {order.plan.validityDays}{" "}
                      {order.plan.validityDays === 1 ? "day" : "days"}
                    </span>
                  </p>
                </div>
                <div className="esim-state">
                  <span className={`status-chip ${order.status.toLowerCase()}`}>
                    {order.purchaseType === "TOPUP" &&
                    order.status === "QR_READY"
                      ? "Package added"
                      : orderStatusLabel(order.status)}
                  </span>
                  <small>
                    <Clock3 size={13} />
                    {new Date(order.createdAt).toLocaleDateString()}
                  </small>
                </div>
                <ArrowRight className="row-arrow" size={18} />
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
