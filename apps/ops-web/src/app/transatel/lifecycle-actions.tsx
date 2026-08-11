"use client";

import { useState } from "react";
import { PauseCircle, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type Action = "suspend" | "terminate";

export function LifecycleActions({ orderId, iccid, providerStatus, canTerminate, onCompleted }: { orderId: string; iccid: string; providerStatus?: string | null | undefined; canTerminate: boolean; onCompleted?: () => void }) {
  const authFetch = useAuthenticatedFetch();
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = providerStatus === "SUSPENDED" || providerStatus === "SUSPEND_PENDING" || providerStatus === "TERMINATION_PENDING" || providerStatus === "TERMINATED";
  const suspendable = providerStatus === "ACTIVE" || providerStatus === "ACTIVATED";
  const required = action === "terminate" ? iccid : "SUSPEND";
  const close = () => { if (!busy) { setAction(null); setReason(""); setConfirmation(""); } };
  const submit = async () => {
    if (!action || reason.trim().length < 5 || confirmation !== required) return;
    setBusy(true);
    try {
      const response = await authFetch(`${API}/operations/transatel/orders/${orderId}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason.trim(), idempotencyKey: `ops:${action}:${crypto.randomUUID()}` }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error?.message ?? value.message ?? `Could not ${action} eSIM`);
      toast.success(action === "suspend" ? "Suspension accepted by Transatel" : "Termination accepted by Transatel");
      setAction(null);
      setReason("");
      setConfirmation("");
      onCompleted?.();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : `Could not ${action} eSIM`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={pending || !suspendable} onClick={() => setAction("suspend")}><PauseCircle className="size-3.5" /> Suspend</Button>
        {canTerminate ? <Button size="sm" variant="destructive" disabled={providerStatus === "TERMINATED" || providerStatus === "TERMINATION_PENDING"} onClick={() => setAction("terminate")}><Trash2 className="size-3.5" /> Terminate</Button> : null}
      </div>
      <Dialog open={action !== null} onOpenChange={(open) => { if (!open) close(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{action === "terminate" ? "Permanently terminate eSIM" : "Suspend eSIM connectivity"}</DialogTitle>
            <DialogDescription>{action === "terminate" ? "Termination is irreversible and immediately disables network service. Remaining plan balances may be lost." : "Suspension blocks network service but recurring billing may continue. The provider processes this asynchronously."}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <label className="block space-y-1.5 text-sm font-medium">Reason<textarea className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm" value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder="Operational reason (required)" /></label>
            <label className="block space-y-1.5 text-sm font-medium">Type <code>{required}</code> to confirm<Input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={close}>Cancel</Button>
            <Button variant={action === "terminate" ? "destructive" : "default"} disabled={busy || reason.trim().length < 5 || confirmation !== required} onClick={() => void submit()}>{busy ? "Submitting…" : action === "terminate" ? "Terminate permanently" : "Suspend connectivity"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
