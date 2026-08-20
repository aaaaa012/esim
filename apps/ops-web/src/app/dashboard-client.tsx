"use client";
import { useAuthenticatedFetch } from "./authenticated-api-provider";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  QrCode,
  RotateCcw,
  ServerCrash,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Panel } from "@/components/panel";
import { StatusBadge, humane } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Spinner } from "@/components/spinner";
import { cn } from "@/lib/utils";

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
    qrReady: number;
    activatedToday: number;
    completedToday: number;
    expired: number;
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
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Spinner /> Loading live overview…
        </div>
      </div>
    );

  const metrics = [
    {
      label: "Pending reviews",
      value: data.counts.reviewPending,
      icon: <ClipboardCheck className="size-4" />,
      tone: "info" as const,
      hint: "Orders waiting for your review",
      href: "/work-queue?status=REVIEW_PENDING",
    },
    {
      label: "Awaiting customer",
      value: data.counts.awaitingCustomer,
      icon: <RotateCcw className="size-4" />,
      tone: "warning" as const,
      hint: "Waiting on customer documents",
      href: "/work-queue?status=AWAITING_CUSTOMER",
    },
    {
      label: "Provisioning failed",
      value: data.counts.provisioningFailed,
      icon: <ServerCrash className="size-4" />,
      tone: "danger" as const,
      hint: "Set-up failed — needs your attention",
      href: "/work-queue?status=PROVISIONING_FAILED",
    },
    {
      label: "QR sent — awaiting activation",
      value: data.counts.qrReady,
      icon: <QrCode className="size-4" />,
      tone: "info" as const,
      hint: "QR sent; waiting for the customer to install it",
      href: "/orders?status=QR_READY",
    },
    {
      label: "Activated today",
      value: data.counts.activatedToday,
      icon: <CheckCircle2 className="size-4" />,
      tone: "success" as const,
      hint: "eSIMs activated since midnight",
      href: "/orders?status=COMPLETED",
    },
    {
      label: "Expired",
      value: data.counts.expired,
      icon: <Clock3 className="size-4" />,
      tone: "warning" as const,
      hint: "Completed plans past their validity window",
      href: "/orders",
    },
  ];

  const customerLabel = (order: Order) => {
    if (order.traveler)
      return `${order.traveler.firstName} ${order.traveler.surname}`;
    return "Guest customer";
  };

  return (
    <>
      <PageHeader
        title="Operations overview"
        description={`${new Intl.DateTimeFormat("en-NP", {
          dateStyle: "full",
          timeZone: "Asia/Kathmandu",
        }).format(new Date())} · Asia/Kathmandu`}
        actions={
          <Button asChild>
            <Link href="/work-queue">
              Open work queue
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        }
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <Link key={metric.label} href={metric.href} className="group">
            <StatCard
              {...metric}
              className="transition-all group-hover:-translate-y-0.5 group-hover:border-primary/40 group-hover:shadow-md"
            />
          </Link>
        ))}
      </div>
      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Panel
          title="Integration health"
          actions={
            <Link
              href="/integration-events"
              className="text-sm font-medium text-primary hover:underline"
            >
              View events
            </Link>
          }
          className="xl:col-span-1"
        >
          <ul className="space-y-1">
            {data.integrations.map((item) => (
              <li
                key={item.name}
                className="flex items-center justify-between rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/50"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      item.status === "UP" ? "bg-success" : "bg-warning",
                    )}
                  />
                  <div className="leading-tight">
                    <p className="text-sm font-medium">{item.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {humane(item.status)}
                    </p>
                  </div>
                </div>
                <StatusBadge
                  label={humane(item.status)}
                  tone={item.status === "UP" ? "success" : "warning"}
                />
              </li>
            ))}
          </ul>
        </Panel>
        <Panel
          title="Recent orders"
          description="Latest activity across all orders"
          actions={
            <Link
              href="/orders"
              className="text-sm font-medium text-primary hover:underline"
            >
              View all orders
            </Link>
          }
          className="xl:col-span-2"
          noPadding
        >
          {data.recentOrders.length === 0 ? (
            <EmptyState
              title="No orders yet"
              description="New orders will appear here."
            />
          ) : (
            <>
              <div className="divide-y sm:hidden">
                {data.recentOrders.map((order) => (
                  <Link
                    key={order.id}
                    href={`/orders/${order.id}`}
                    className="block space-y-2 px-4 py-4 active:bg-muted/60"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-primary">
                          {order.orderNumber}
                        </p>
                        <p className="truncate text-sm text-muted-foreground">
                          {customerLabel(order)}
                        </p>
                      </div>
                      <StatusBadge label={order.status} />
                    </div>
                    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span className="truncate">
                        <b className="text-foreground">
                          {order.plan.countryCode}
                        </b>{" "}
                        · {order.plan.name}
                      </span>
                      <span className="shrink-0">
                        {new Date(order.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
              <div className="hidden sm:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Order</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Destination</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.recentOrders.map((order) => (
                      <TableRow key={order.id}>
                        <TableCell>
                          <Link
                            href={`/orders/${order.id}`}
                            className="font-medium text-primary hover:underline"
                          >
                            {order.orderNumber}
                          </Link>
                        </TableCell>
                        <TableCell
                          className="max-w-52 truncate"
                          title={order.ownerId}
                        >
                          {customerLabel(order)}
                        </TableCell>
                        <TableCell>
                          <span className="font-medium">
                            {order.plan.countryCode}
                          </span>{" "}
                          · {order.plan.name}
                        </TableCell>
                        <TableCell>
                          <StatusBadge label={order.status} />
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {new Date(order.createdAt).toLocaleDateString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </Panel>
      </div>
    </>
  );
}
