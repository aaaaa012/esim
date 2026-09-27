"use client";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { useEffect, useState } from "react";
import { Panel } from "@/components/panel";
import { StatusBadge, humane } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { Spinner } from "@/components/spinner";
import ErrorDialog from "@/components/error-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Download, RefreshCcw } from "lucide-react";
import { downloadCsv } from "@/lib/csv";
import { useConfirmation } from "@/components/confirmation-provider";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const headers = {};
type Event = {
  id: string;
  source: string;
  eventId: string;
  signatureValid: boolean;
  processedAt?: string;
  errorMessage?: string;
  deadLetteredAt?: string;
  createdAt: string;
};

export default function IntegrationEventsClient() {
  const authFetch = useAuthenticatedFetch();
  const confirm = useConfirmation();
  const [items, setItems] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const load = () =>
    authFetch(`${API}/operations/integration-events`, { headers }).then(
      async (response) => {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error?.message);
        setItems(value.data);
      },
    );
  useEffect(() => {
    load()
      .catch((cause) => setError(cause.message))
      .finally(() => setLoading(false));
  }, []);
  const replay = async (id: string) => {
    setBusy(id);
    setError("");
    try {
      const response = await authFetch(
        `${API}/operations/integration-events/${id}/replay`,
        {
          method: "POST",
          headers: { "x-idempotency-key": crypto.randomUUID() },
        },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error?.message ?? "Replay failed");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Replay failed");
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <ErrorDialog error={error} onClose={() => setError("")} />
      <Panel
        title="Incoming updates"
        description={`${items.length} updates received from our payment and network providers`}
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={!items.length}
            onClick={() =>
              downloadCsv(
                `provider-events-${new Date().toISOString().slice(0, 10)}.csv`,
                [
                  "Received",
                  "Provider",
                  "Event ID",
                  "Signature verified",
                  "Processed",
                  "Dead lettered",
                  "Error",
                ],
                items.map((item) => [
                  item.createdAt,
                  item.source,
                  item.eventId,
                  item.signatureValid,
                  item.processedAt,
                  item.deadLetteredAt,
                  item.errorMessage,
                ]),
              )
            }
          >
            <Download className="size-4" />
            Export CSV
          </Button>
        }
        noPadding
      >
        {loading ? (
          <EmptyState loading>
            <span className="text-sm text-muted-foreground">
              Loading updates…
            </span>
          </EmptyState>
        ) : !items.length ? (
          <EmptyState
            title="No updates received yet"
            description="Messages from payment and network providers will appear here."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Received</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Security</TableHead>
                <TableHead>Processing</TableHead>
                <TableHead className="text-right">Recovery</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="text-muted-foreground">
                    {new Date(item.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="font-medium">
                    {humane(item.source)}
                  </TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {item.eventId}
                    </code>
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      label={
                        item.signatureValid ? "VERIFIED" : "LOOKUP VERIFIED"
                      }
                      tone={item.signatureValid ? "success" : "warning"}
                    />
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      label={
                        item.errorMessage
                          ? "FAILED"
                          : item.processedAt
                            ? "PROCESSED"
                            : "QUEUED"
                      }
                    />
                    {item.errorMessage && (
                      <p className="mt-1 text-xs text-destructive">
                        {item.errorMessage}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {item.deadLetteredAt ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === item.id}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: "Replay provider update?",
                              description:
                                "Send this update through the system again only when the order did not update automatically.",
                              confirmLabel: "Replay update",
                            })
                          )
                            void replay(item.id);
                        }}
                      >
                        <RefreshCcw className="size-3.5" /> Replay
                      </Button>
                    ) : (
                      "—"
                    )}
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
