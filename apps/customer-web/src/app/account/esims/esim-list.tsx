"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  Plus,
  QrCode,
  RefreshCcw,
  Wifi,
} from "lucide-react";
import type { OrderSummary } from "@visa-compass/shared";
import { apiErrorMessage, orderStatusLabel } from "@visa-compass/shared";
import { useAuthenticatedFetch } from "../../authenticated-api-provider";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type Order = OrderSummary & {
  purchaseType?: "INITIAL_PURCHASE" | "TOPUP";
  purchaseContext?: "TOPUP" | "NEW_DESTINATION" | "FIRST_PURCHASE";
};
const processing = [
  "PAYMENT_PENDING",
  "REVIEW_PENDING",
  "APPROVED",
  "PROVISIONING",
  "QR_READY",
];
const action = ["DRAFT", "AWAITING_CUSTOMER", "PAYMENT_FAILED"];
export default function OrderList() {
  const authFetch = useAuthenticatedFetch();
  const [orders, setOrders] = useState<Order[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [filter, setFilter] = useState("ALL");
  useEffect(() => {
    void authFetch(`${API}/customer/orders`, { headers: {} })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok)
          throw new Error(
            apiErrorMessage(
              value.error?.code ?? "",
              value.error?.message ?? "Something went wrong",
            ),
          );
        return value.data;
      })
      .then(setOrders)
      .catch((cause) => setError(cause.message))
      .finally(() => setLoading(false));
  }, []);
  const counts = useMemo(
    () => ({
      complete: orders.filter((order) => order.status === "COMPLETED").length,
      processing: orders.filter((order) => processing.includes(order.status))
        .length,
      action: orders.filter((order) => action.includes(order.status)).length,
    }),
    [orders],
  );
  const visible = orders.filter(
    (order) =>
      filter === "ALL" ||
      (filter === "COMPLETE" && order.status === "COMPLETED") ||
      (filter === "PROCESSING" && processing.includes(order.status)) ||
      (filter === "ACTION" && action.includes(order.status)),
  );
  return (
    <main className="account-page">
      <div className="shell">
        <div className="account-head">
          <div>
            <span className="eyebrow">
              <Wifi size={14} />
              Your account
            </span>
            <h1>Orders</h1>
            <p>
              Purchases, top-ups, document reviews, payments, and activation
              events.
            </p>
          </div>
          <Link className="button" href="/#plans">
            <Plus size={17} />
            Buy a plan
          </Link>
        </div>
        {!loading && orders.length > 0 && (
          <>
            <section className="customer-stats">
              <button onClick={() => setFilter("COMPLETE")}>
                <CheckCircle2 />
                <span>
                  <b>{counts.complete}</b>Completed
                </span>
              </button>
              <button onClick={() => setFilter("PROCESSING")}>
                <RefreshCcw />
                <span>
                  <b>{counts.processing}</b>Processing
                </span>
              </button>
              <button onClick={() => setFilter("ACTION")}>
                <Clock3 />
                <span>
                  <b>{counts.action}</b>Needs action
                </span>
              </button>
            </section>
            <div className="customer-filters">
              {["ALL", "COMPLETE", "PROCESSING", "ACTION"].map((item) => (
                <button
                  key={item}
                  className={filter === item ? "selected" : ""}
                  onClick={() => setFilter(item)}
                >
                  {item === "ALL"
                    ? "All orders"
                    : item === "ACTION"
                      ? "Needs action"
                      : item[0] + item.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
          </>
        )}
        {loading ? (
          <div className="account-empty">
            <LoaderCircle className="spin" />
            Loading orders…
          </div>
        ) : error ? (
          <div className="form-error">{error}</div>
        ) : orders.length === 0 ? (
          <div className="account-empty">
            <QrCode size={35} />
            <h2>No orders yet</h2>
            <p>Your purchases and top-ups will appear here.</p>
            <Link className="button" href="/#plans">
              Browse plans
            </Link>
          </div>
        ) : visible.length === 0 ? (
          <div className="account-empty compact">
            No orders in this category.
          </div>
        ) : (
          <div className="esim-list">
            {visible.map((order) => (
              <Link
                href={`/account/orders/${order.id}`}
                className="esim-row"
                key={order.id}
              >
                <span className="esim-icon">
                  <QrCode />
                </span>
                <div className="esim-main">
                  <div>
                    <h2>{order.plan.name}</h2>
                    <span>
                      {order.orderNumber} ·{" "}
                      {order.purchaseType === "TOPUP"
                        ? "Top-up"
                        : "Plan purchase"}
                    </span>
                  </div>
                  <p>
                    {order.plan.countryCode} · {order.plan.dataAllowance} ·{" "}
                    {order.plan.validityDays} days
                  </p>
                </div>
                <div className="esim-state">
                  <span className={`status-chip ${order.status.toLowerCase()}`}>
                    {orderStatusLabel(order.status)}
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
