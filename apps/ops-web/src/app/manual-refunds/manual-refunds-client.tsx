"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, ExternalLink, RefreshCcw, XCircle } from "lucide-react";
import { toast } from "sonner";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { StatusBadge, humane } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
export const REFUND_REASONS = ["PROVISIONING_FAILURE", "INCORRECT_FULFILLMENT", "DUPLICATE_CHARGE", "PROVIDER_SERVICE_FAILURE", "INTERNAL_OPERATIONAL_ERROR"] as const;
export type ManualRefund = {
  id: string;
  orderId: string;
  paymentId: string;
  status: "REQUESTED" | "APPROVED" | "COMPLETED" | "REJECTED";
  reason: string;
  explanation: string;
  amount: number | string;
  providerReference?: string | null;
  reviewNote?: string | null;
  createdAt: string;
  order: { orderNumber: string; status: string };
  requestedBy: { email: string };
  reviewedBy?: { email: string } | null;
};

type DialogState = { item: ManualRefund; action: "reject" | "complete" } | null;

const toLocalInput = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export default function ManualRefundsClient() {
  const authFetch = useAuthenticatedFetch();
  const [items, setItems] = useState<ManualRefund[]>([]);
  const [status, setStatus] = useState("ACTIVE");
  const [busy, setBusy] = useState("");
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [note, setNote] = useState("");
  const [providerReference, setProviderReference] = useState("");
  const [completedAt, setCompletedAt] = useState(toLocalInput(new Date()));

  const load = useCallback(async () => {
    const query = status === "ACTIVE" ? "" : "?status=" + status;
    const response = await authFetch(`${API}/operations/manual-refunds${query}`);
    const value = await response.json();
    setItems((value.data?.items ?? []).filter((item: ManualRefund) => status !== "ACTIVE" || ["REQUESTED", "APPROVED"].includes(item.status)));
  }, [authFetch, status]);

  useEffect(() => {
    void load();
    void authFetch(`${API}/auth/me`).then((r) => r.json()).then((v) => setIsSuperAdmin(v.data?.accountType === "SUPER_ADMIN"));
  }, [load, authFetch]);

  const act = async (item: ManualRefund, action: "approve" | "reject" | "complete", body?: Record<string, unknown>) => {
    setBusy(item.id + action);
    try {
      const response = await authFetch(`${API}/operations/manual-refunds/${item.id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error?.message ?? "Action failed");
      toast.success(action === "approve" ? "Manual refund approved" : action === "reject" ? "Manual refund rejected" : "Manual refund marked as done");
      setDialog(null);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed");
    } finally {
      setBusy("");
    }
  };

  const openDialog = (item: ManualRefund, action: "reject" | "complete") => {
    setDialog({ item, action });
    setNote("");
    if (action === "complete") {
      setProviderReference("");
      setCompletedAt(toLocalInput(new Date()));
    }
  };

  const confirmDialog = () => {
    if (!dialog) return;
    const { item, action } = dialog;
    if (action === "reject") {
      if (!note.trim()) {
        toast.error("Please add a note explaining the rejection.");
        return;
      }
      void act(item, "reject", { note: note.trim() });
    } else {
      if (!providerReference.trim()) {
        toast.error("Please add the Khalti payment reference.");
        return;
      }
      void act(item, "complete", {
        providerReference: providerReference.trim(),
        amount: Number(item.amount),
        completedAt: new Date(completedAt).toISOString(),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
    }
  };

  return (
    <>
      <PageHeader
        title="Manual refunds"
        description="Rare refunds for company errors, processed in Khalti and recorded here."
        actions={
          <div className="flex gap-2">
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">Needs attention</SelectItem>
                <SelectItem value="REQUESTED">Requested</SelectItem>
                <SelectItem value="APPROVED">Approved</SelectItem>
                <SelectItem value="COMPLETED">Completed</SelectItem>
                <SelectItem value="REJECTED">Rejected</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={() => void load()}><RefreshCcw className="size-4" />Refresh</Button>
          </div>
        }
      />
      <Dialog open={!!dialog} onOpenChange={(open) => { if (!open) setDialog(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog?.action === "complete" ? "Confirm refund is done" : "Reject refund request"}</DialogTitle>
            <DialogDescription>
              {dialog?.action === "complete"
                ? "Only confirm after you have completed the refund in Khalti. This records the refund as done."
                : "The refund request will be declined. A note is required for the record."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {dialog?.action === "complete" ? (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Khalti payment reference</Label>
                  <Input value={providerReference} onChange={(event) => setProviderReference(event.target.value)} placeholder="The reference Khalti shows for the refund" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Date and time completed</Label>
                  <Input type="datetime-local" value={completedAt} onChange={(event) => setCompletedAt(event.target.value)} />
                </div>
              </>
            ) : null}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{dialog?.action === "complete" ? "Optional note" : "Note"}</Label>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                className="w-full rounded-md border border-input bg-transparent p-3 text-sm outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={!!busy} onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant={dialog?.action === "reject" ? "destructive" : "default"} disabled={!!busy} onClick={confirmDialog}>
              {dialog?.action === "complete" ? "Mark as done" : "Reject request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Panel title="Refund register" description="Submitting or approving never sends money. Complete the refund in Khalti before confirming it here." noPadding>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Order</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Requested by</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id}>
                <TableCell><Link className="font-medium text-primary hover:underline" href={`/orders/${item.orderId}`}>{item.order.orderNumber}</Link></TableCell>
                <TableCell><p>{humane(item.reason)}</p><p className="max-w-72 truncate text-xs text-muted-foreground">{item.explanation}</p></TableCell>
                <TableCell>NPR {Number(item.amount).toLocaleString()}</TableCell>
                <TableCell><StatusBadge label={item.status} /></TableCell>
                <TableCell>{item.requestedBy.email}</TableCell>
                <TableCell>{item.providerReference ?? "—"}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2">
                    {isSuperAdmin && item.status === "REQUESTED" && (
                      <>
                        <Button size="sm" variant="success" disabled={!!busy} onClick={() => { if (window.confirm("Approve this manual refund for completion in Khalti?")) void act(item, "approve"); }}>
                          <CheckCircle2 className="size-4" />Approve
                        </Button>
                        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => openDialog(item, "reject")}>
                          <XCircle className="size-4" />Reject
                        </Button>
                      </>
                    )}
                    {isSuperAdmin && item.status === "APPROVED" && (
                      <Button size="sm" disabled={!!busy} onClick={() => openDialog(item, "complete")}>
                        <ExternalLink className="size-4" />Confirm completed
                      </Button>
                    )}
                    {!isSuperAdmin && ["REQUESTED", "APPROVED"].includes(item.status) ? (
                      <span className="text-xs text-muted-foreground">Super Admin action required</span>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
    </>
  );
}
