"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCcw } from "lucide-react";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import ErrorDialog from "@/components/error-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/status-badge";
import { attentionActionLabel, isAttentionAction } from "@visa-compass/shared";
import { toast } from "sonner";
import { useConfirmation } from "@/components/confirmation-provider";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type Case = {
  id: string;
  orderId?: string;
  category: string;
  severity: string;
  status: string;
  summary: string;
  detail?: string;
  entityType: string;
  entityId: string;
  failureCategory?: string;
  retryCount: number;
  availableActions: string[];
  createdAt: string;
  order?: { orderNumber: string; status: string } | null;
};
export default function AttentionClient() {
  const authFetch = useAuthenticatedFetch();
  const confirm = useConfirmation();
  const [items, setItems] = useState<Case[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const response = await authFetch(
        `${API}/operations/attention?status=OPEN&limit=100`,
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(
          value.error?.message ?? "Attention queue could not be loaded",
        );
      setItems(value.data.items);
    } finally {
      setLoading(false);
    }
  }, [authFetch]);
  useEffect(() => {
    void load().catch((cause) =>
      setError(cause instanceof Error ? cause.message : "Load failed"),
    );
  }, [load]);
  const action = async (item: Case, actionName: string) => {
    if (!isAttentionAction(actionName)) return;
    const label = attentionActionLabel(actionName);
    const descriptions: Record<string, string> = {
      RECHECK_PAYMENT:
        "Checks the payment provider for the latest result. It does not create a new charge.",
      RECHECK_INVENTORY:
        "Reads the eSIM's current network state and may quarantine stock that is not safe to sell.",
      RECHECK_ORDER_PROVIDER:
        "Reads Transatel's current eSIM and package state and reconciles the order. It does not submit another activation.",
      RECONCILE_RESERVATION:
        "Compares the local stock reservation with provider and order evidence before changing it.",
      RECONCILE_PROVISIONING:
        "Recovers this activation from provider evidence without blindly submitting another request.",
      RECONCILE_ORDER_PROVISIONING:
        "Finds this order's activation operation and safely reconciles its current provider result.",
      RETRY_PROVISIONING:
        "Starts another activation attempt only if the order is in a state where retry is safe.",
      RETRY_NOTIFICATION:
        "Queues the stored message again for its original recipient.",
      REPLAY_WEBHOOK:
        "Queues the stored provider update for processing again. The original event remains in the audit history.",
    };
    if (
      !(await confirm({
        title: `${label}?`,
        description:
          descriptions[actionName] ??
          "Open the related operational record and review its current state.",
        confirmLabel: label,
      }))
    )
      return;
    setBusy(item.id);
    setError("");
    try {
      const response = await authFetch(
        `${API}/operations/attention/${item.id}/action`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify({ action: actionName }),
        },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error?.message ?? "Action failed");
      toast.success(`${label} completed`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed");
    } finally {
      setBusy("");
    }
  };
  const reviewHref = (item: Case, actionName: string) => {
    if (actionName === "REVIEW_MANUAL_REFUND") return "/manual-refunds";
    if (actionName === "REVIEW_FINANCIAL_DISPUTE" && item.orderId)
      return `/orders/${item.orderId}`;
    return null;
  };
  return (
    <div className="space-y-6">
      <PageHeader
        title="Attention queue"
        description="Recoverable technical and integration cases that need safe operational action."
        actions={
          <Button variant="outline" onClick={() => void load()}>
            <RefreshCcw className="size-4" />
            Refresh
          </Button>
        }
      />
      <ErrorDialog error={error} onClose={() => setError("")} />
      <Panel
        title="Open cases"
        description={`${items.length} case(s) need attention`}
      >
        {loading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            Loading open cases...
          </div>
        ) : !items.length ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            No open attention cases.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Case</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Failure</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 size-4 text-amber-600" />
                      <div>
                        <div className="font-medium">{item.summary}</div>
                        <div className="text-xs text-muted-foreground">
                          {item.category} |{" "}
                          {new Date(item.createdAt).toLocaleString()}
                        </div>
                        {item.detail && (
                          <div className="mt-1 max-w-xl text-xs text-muted-foreground">
                            {item.detail}
                          </div>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    {item.order ? (
                      <Link
                        className="underline"
                        href={`/orders/${item.orderId}`}
                      >
                        {item.order.orderNumber}
                      </Link>
                    ) : (
                      item.entityId
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge label={item.status} />
                  </TableCell>
                  <TableCell>
                    {item.failureCategory ?? "-"}
                    <div className="text-xs text-muted-foreground">
                      Retries: {item.retryCount}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      {item.availableActions
                        .filter(isAttentionAction)
                        .map((name) => {
                          const href = reviewHref(item, name);
                          return href ? (
                            <Button
                              key={name}
                              size="sm"
                              variant="outline"
                              asChild
                            >
                              <Link href={href}>
                                {attentionActionLabel(name)}
                              </Link>
                            </Button>
                          ) : (
                            <Button
                              key={name}
                              size="sm"
                              variant="outline"
                              disabled={busy === item.id}
                              onClick={() => void action(item, name)}
                            >
                              {attentionActionLabel(name)}
                            </Button>
                          );
                        })}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </div>
  );
}
