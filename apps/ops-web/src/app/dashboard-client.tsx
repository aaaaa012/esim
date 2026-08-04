"use client";
import { useAuthenticatedFetch } from "./authenticated-api-provider";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";
type Order = {
  id: string;
  orderNumber: string;
  ownerId: string;
  status: string;
  createdAt: string;
  plan: { name: string; countryCode: string };
  traveler?: { firstName: string; surname: string };
};
type Dashboard = {
  counts: {
    reviewPending: number;
    awaitingCustomer: number;
    provisioningFailed: number;
    completedToday: number;
  };
  integrations: { name: string; status: string }[];
  recentOrders: Order[];
};
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1",
  headers = {};
export default function DashboardClient() {
  const authFetch = useAuthenticatedFetch();
  const [data, setData] = useState<Dashboard | null>(null);
  useEffect(() => {
    void authFetch(`${API}/operations/dashboard`, { headers })
      .then((r) => r.json())
      .then((v) => setData(v.data));
  }, []);
  if (!data)
    return (
      <div className="empty-table">
        <LoaderCircle className="spin" />
        Loading live overview…
      </div>
    );
  const metrics = [
    ["Pending reviews", data.counts.reviewPending, ClipboardCheck],
    ["Awaiting customer", data.counts.awaitingCustomer, RotateCcw],
    ["Provisioning failed", data.counts.provisioningFailed, AlertTriangle],
    ["Completed today", data.counts.completedToday, CheckCircle2],
  ] as const;
  return (
    <>
      <div className="top">
        <div>
          <h1>Operations overview</h1>
          <p>
            {new Intl.DateTimeFormat("en-NP", {
              dateStyle: "full",
              timeZone: "Asia/Kathmandu",
            }).format(new Date())}{" "}
            · Asia/Kathmandu
          </p>
        </div>
        <Link className="primary-action" href="/work-queue">
          Open work queue
        </Link>
      </div>
      <section className="grid">
        {metrics.map(([label, value, Icon]) => (
          <article className="metric" key={label}>
            <span className="metric-label">{label}</span>
            <div className="metric-row">
              <strong>{value}</strong>
              <span className="icon">
                <Icon size={18} />
              </span>
            </div>
          </article>
        ))}
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Integration health</h2>
          <Link href="/integration-events">View events</Link>
        </div>
        <div className="health">
          {data.integrations.map((item) => (
            <div className="health-item" key={item.name}>
              <span className={`dot ${item.status === "UP" ? "" : "amber"}`} />
              {item.name}
              <small>{item.status.replaceAll("_", " ")}</small>
            </div>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Recent orders</h2>
          <Link href="/orders">View all orders</Link>
        </div>
        {data.recentOrders.length === 0 ? (
          <div className="empty-table">No orders yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Destination</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {data.recentOrders.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <Link href={`/orders/${order.id}`}>
                        <b>{order.orderNumber}</b>
                      </Link>
                    </td>
                    <td>
                      {order.traveler
                        ? `${order.traveler.firstName} ${order.traveler.surname}`
                        : order.ownerId}
                    </td>
                    <td>
                      {order.plan.countryCode} · {order.plan.name}
                    </td>
                    <td>
                      <span
                        className={`pill ${order.status === "REVIEW_PENDING" || order.status === "COMPLETED" ? "green" : ""}`}
                      >
                        {order.status.replaceAll("_", " ")}
                      </span>
                    </td>
                    <td>{new Date(order.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
