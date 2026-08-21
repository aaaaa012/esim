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
  const [items, setItems] = useState<Case[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    setError("");
    const response = await authFetch(
      `${API}/operations/attention?status=OPEN&limit=100`,
    );
    const value = await response.json();
    if (!response.ok)
      throw new Error(
        value.error?.message ?? "Attention queue could not be loaded",
      );
    setItems(value.data.items);
  }, [authFetch]);
  useEffect(() => {
    void load().catch((cause) =>
      setError(cause instanceof Error ? cause.message : "Load failed"),
    );
  }, [load]);
  const action = async (item: Case, actionName: string) => {
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
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed");
    } finally {
      setBusy("");
    }
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
                        {item.category} ·{" "}
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
                  <StatusBadge label={item.order?.status ?? item.status} />
                </TableCell>
                <TableCell>
                  {item.failureCategory ?? "Not recorded"}
                  <div className="text-xs text-muted-foreground">
                    Retries: {item.retryCount}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-2">
                    {item.availableActions.map((name) => (
                      <Button
                        key={name}
                        size="sm"
                        variant="outline"
                        disabled={busy === item.id}
                        onClick={() => void action(item, name)}
                      >
                        {name.toLowerCase().replaceAll("_", " ")}
                      </Button>
                    ))}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
    </div>
  );
}
