"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCcw } from "lucide-react";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { StatusBadge, humane } from "@/components/status-badge";
import ErrorDialog from "@/components/error-dialog";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { useConfirmation } from "@/components/confirmation-provider";
import { operationalIssue } from "@/lib/operational-issue";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type Operation = {
  id: string;
  orderId: string;
  state: string;
  iccid: string;
  providerSubscriptionId?: string | null;
  lastErrorCategory?: string | null;
  lastErrorMessage?: string | null;
  updatedAt: string;
  order: { orderNumber: string; status: string; orderType: string };
};

function shortError(item: Operation): string {
  return operationalIssue(item.lastErrorMessage, item.lastErrorCategory).title;
}

export default function ProvisioningOperationsClient() {
  const authFetch = useAuthenticatedFetch();
  const confirm = useConfirmation();
  const [items, setItems] = useState<Operation[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [viewError, setViewError] = useState<string | null>(null);
  const load = async () => {
    const response = await authFetch(
      `${API}/operations/provisioning-operations`,
      { headers: {} },
    );
    const value = await response.json();
    if (!response.ok)
      throw new Error(value.error?.message ?? "Could not load set-up recovery");
    setItems(value.data ?? []);
  };
  useEffect(() => {
    void load().catch((cause) =>
      setError(cause instanceof Error ? cause.message : "Load failed"),
    );
  }, []);
  const checkProvider = async (item: Operation) => {
    if (!(await confirm({
      title: "Check provider status?",
      description: "This reads the current Transatel state and will not create another activation.",
      confirmLabel: "Check status",
    }))) return;
    setBusy(item.id);
    setError("");
    try {
      const response = await authFetch(
        `${API}/operations/orders/${item.orderId}/provider-status-check`,
        {
          method: "POST",
          headers: { "x-idempotency-key": crypto.randomUUID() },
        },
      );
      const value = await response.json();
      if (!response.ok) throw new Error(value.error?.message ?? "Check failed");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Check failed");
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      <PageHeader
        title="Pending activations"
        description="Orders where the network set-up is stuck or uncertain. Use Check again to safely continue without creating a duplicate."
        actions={
          <Button variant="outline" onClick={() => void load()}>
            <RefreshCcw className="size-4" />
            Refresh
          </Button>
        }
      />
      <ErrorDialog error={error} onClose={() => setError("")} />
      <ErrorDialog
        error={viewError}
        title="What happened and what to do"
        onClose={() => setViewError(null)}
      />
      <Panel
        title="Orders needing attention"
        description="Set-ups that are delayed, uncertain, or waiting for review"
        noPadding
      >
        {!items.length ? (
          <EmptyState
            title="Nothing is stuck"
            description="All network set-ups are moving normally. This screen is for rare recovery cases."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>eSIM</TableHead>
                <TableHead>Last problem</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <Link
                      href={`/orders/${item.orderId}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {item.order.orderNumber}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {humane(item.order.orderType)} ·{" "}
                      {humane(item.order.status)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge label={item.state} />
                  </TableCell>
                  <TableCell>
                    <code className="text-xs">{item.iccid}</code>
                  </TableCell>
                  <TableCell className="max-w-56">
                    <span
                      className="truncate text-xs text-muted-foreground"
                      title={shortError(item)}
                    >
                      {shortError(item)}
                    </span>
                    {item.lastErrorMessage && (
                      <button
                        type="button"
                        className="ml-2 text-xs font-medium text-primary hover:underline"
                        onClick={() => {
                          const issue = operationalIssue(
                            item.lastErrorMessage,
                            item.lastErrorCategory,
                          );
                          setViewError(
                            `${issue.summary}\n\nRecommended action\n${issue.action}\n\nReference: ${issue.code}`,
                          );
                        }}
                      >
                        Explain
                      </button>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(item.updatedAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" asChild>
                        <Link href={`/orders/${item.orderId}`}>Open order</Link>
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === item.id}
                        onClick={() => void checkProvider(item)}
                      >
                        <RefreshCcw className="size-3.5" />
                        Check provider status
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </>
  );
}
