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
import { StatusBadge } from "@/components/status-badge";
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
      hint: "Orders awaiting an operations decision",
    },
    {
      label: "Awaiting customer",
      value: data.counts.awaitingCustomer,
      icon: <RotateCcw className="size-4" />,
      tone: "warning" as const,
      hint: "Waiting on customer documents",
    },
    {
      label: "Provisioning failed",
      value: data.counts.provisioningFailed,
      icon: <ServerCrash className="size-4" />,
      tone: "danger" as const,
      hint: "Require attention",
    },
    {
      label: "QR sent — awaiting activation",
      value: data.counts.qrReady,
      icon: <QrCode className="size-4" />,
      tone: "info" as const,
      hint: "Provisioned, waiting for the device to activate",
    },
    {
      label: "Activated today",
      value: data.counts.activatedToday,
      icon: <CheckCircle2 className="size-4" />,
      tone: "success" as const,
      hint: "eSIMs truly activated since midnight",
    },
    {
      label: "Expired",
      value: data.counts.expired,
      icon: <Clock3 className="size-4" />,
      tone: "warning" as const,
      hint: "Completed plans past their validity window",
    },
  ];

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
          <StatCard key={metric.label} {...metric} />
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
                      {item.status.replaceAll("_", " ")}
                    </p>
                  </div>
                </div>
                <StatusBadge
                  label={item.status}
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
            <EmptyState title="No orders yet" description="New orders will appear here." />
          ) : (
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
                    <TableCell>
                      {order.traveler
                        ? `${order.traveler.firstName} ${order.traveler.surname}`
                        : order.ownerId}
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
          )}
        </Panel>
      </div>
    </>
  );
}