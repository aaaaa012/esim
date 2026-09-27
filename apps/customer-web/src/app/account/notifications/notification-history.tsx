"use client";
import { useAuthenticatedFetch } from "../../authenticated-api-provider";
import ErrorModal from "../../../components/error-modal";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell, LoaderCircle } from "lucide-react";
import {
  apiErrorMessage,
  notificationChannelLabel,
  notificationStatusLabel,
  notificationTemplateLabel,
} from "@visa-compass/shared";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type Item = {
  id: string;
  orderId?: string;
  channel: string;
  template: string;
  status: string;
  createdAt: string;
  sentAt?: string;
};
const NOTIFICATION_DESCRIPTIONS: Record<string, string> = {
  DOCUMENT_APPROVED:
    "Your documents were approved. You can continue the order.",
  DOCUMENT_REUPLOAD:
    "A replacement document is required before the order can continue.",
  QR_READY: "Your eSIM is ready to install.",
  PLAN_EXHAUSTED: "The plan's data allowance has been used.",
  PLAN_EXPIRED: "The plan validity period has ended.",
  ORDER_STATUS: "The order status changed.",
};
const notificationDescription = (template: string) =>
  NOTIFICATION_DESCRIPTIONS[template] ?? "There is an update to your order.";
export default function NotificationHistory() {
  const authFetch = useAuthenticatedFetch();
  const [items, setItems] = useState<Item[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  useEffect(() => {
    authFetch(`${API}/customer/notifications`, { headers: {} })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok)
          throw new Error(
            apiErrorMessage(
              value.error?.code ?? "",
              "Notifications could not be loaded.",
            ),
          );
        setItems(value.data);
      })
      .catch((cause) => setError(cause.message))
      .finally(() => setLoading(false));
  }, []);
  if (loading)
    return (
      <div className="account-empty compact">
        <LoaderCircle className="spin" />
        Loading notifications…
      </div>
    );
  if (error) return <ErrorModal error={error} onClose={() => setError("")} />;
  if (!items.length)
    return (
      <div className="account-empty">
        <Bell size={34} />
        <h2>No notifications yet</h2>
        <p>Order review and QR-ready updates will appear here.</p>
      </div>
    );
  return (
    <div className="customer-notification-list">
      {items.map((item) => (
        <article key={item.id}>
          <Bell size={17} />
          <span>
            <b>{notificationTemplateLabel(item.template)}</b>
            <p>{notificationDescription(item.template)}</p>
            <small>
              {notificationChannelLabel(item.channel)} · Created{" "}
              <time dateTime={item.createdAt}>
                {new Date(item.createdAt).toLocaleString()}
              </time>
              {item.sentAt && (
                <>
                  {" "}· Delivered{" "}
                  <time dateTime={item.sentAt}>
                    {new Date(item.sentAt).toLocaleString()}
                  </time>
                </>
              )}
            </small>
          </span>
          <em>{notificationStatusLabel(item.status)}</em>
          {item.orderId && (
            <Link href={`/account/orders/${item.orderId}`}>View order</Link>
          )}
        </article>
      ))}
    </div>
  );
}
