"use client";

import { useState } from "react";
import { PauseCircle, RefreshCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type Action = "suspend" | "terminate";

export function LifecycleActions({
  orderId,
  iccid,
  providerStatus,
  canTerminate,
  onCompleted,
}: {
  orderId: string;
  iccid: string;
  providerStatus?: string | null | undefined;
  canTerminate: boolean;
  onCompleted?: () => void;
}) {
  const authFetch = useAuthenticatedFetch();
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const pending =
    providerStatus === "SUSPENDED" ||
    providerStatus === "SUSPEND_PENDING" ||
    providerStatus === "TERMINATION_PENDING" ||
    providerStatus === "TERMINATED";
  const suspendable =
    providerStatus === "ACTIVE" || providerStatus === "ACTIVATED";
  const required = action === "terminate" ? iccid : "SUSPEND";
  const close = () => {
    if (!busy) {
      setAction(null);
      setReason("");
      setConfirmation("");
    }
  };
  const submit = async () => {
    if (!action || reason.trim().length < 5 || confirmation !== required)
      return;
    setBusy(true);
    try {
      const response = await authFetch(
        `${API}/operations/transatel/orders/${orderId}/${action}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            reason: reason.trim(),
            idempotencyKey: `ops:${action}:${crypto.randomUUID()}`,
          }),
        },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(
          value.error?.message ?? value.message ?? `Could not ${action} eSIM`,
        );
      toast.success(
        action === "suspend"
          ? "Suspension sent to the network"
          : "Termination sent to the network",
      );
      setAction(null);
      setReason("");
      setConfirmation("");
      onCompleted?.();
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : `Could not ${action} eSIM`,
      );
    } finally {
      setBusy(false);
    }
  };
  const reconcile = async () => {
    setBusy(true);
    try {
      const response = await authFetch(
        `${API}/operations/transatel/orders/${orderId}/reconcile`,
        { method: "POST", headers: {} },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error?.message ?? "Live status check failed");
      const result = value.data as {
        esimProfileStatus?: string | null;
        subscriptionStatus?: string | null;
        providerStatus?: string | null;
      };
      const profileStatus =
        result.esimProfileStatus ?? result.providerStatus ?? null;
      const statuses = [
        profileStatus ? `eSIM: ${profileStatus}` : null,
        result.subscriptionStatus
          ? `Subscription: ${result.subscriptionStatus}`
          : null,
      ].filter((status): status is string => Boolean(status));
      toast.success(
        statuses.length
          ? statuses.join(" · ")
          : "Provider status refreshed successfully",
      );
      onCompleted?.();
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "Live status check failed",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-md border bg-muted/20 p-2">
          <Button
            className="w-full"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void reconcile()}
          >
            <RefreshCcw className="size-3.5" /> Refresh network status
          </Button>
          <p className="mt-1 px-1 text-xs text-muted-foreground">
            Reads the latest Transatel status. Makes no service change.
          </p>
        </div>
        <div className="rounded-md border bg-muted/20 p-2">
          <Button
            className="w-full"
            size="sm"
            variant="outline"
            disabled={pending || !suspendable}
            onClick={() => setAction("suspend")}
          >
            <PauseCircle className="size-3.5" /> Pause mobile data
          </Button>
          <p className="mt-1 px-1 text-xs text-muted-foreground">
            Temporarily stops data. The eSIM can be reconnected later.
          </p>
        </div>
        {canTerminate ? (
          <div className="rounded-md border border-destructive/25 bg-destructive/5 p-2">
            <Button
              className="w-full"
              size="sm"
              variant="destructive"
              disabled={
                providerStatus === "TERMINATED" ||
                providerStatus === "TERMINATION_PENDING"
              }
              onClick={() => setAction("terminate")}
            >
              <Trash2 className="size-3.5" /> Permanently end eSIM
            </Button>
            <p className="mt-1 px-1 text-xs text-muted-foreground">
              Removes it from the network forever. Remaining data is lost.
            </p>
          </div>
        ) : null}
      </div>
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {action === "terminate"
                ? "Permanently terminate eSIM"
                : "Pause this eSIM's mobile data"}
            </DialogTitle>
            <DialogDescription>
              {action === "terminate"
                ? "This permanently removes the eSIM from the network and cannot be undone. Any remaining data will be lost."
                : "This asks Transatel to temporarily stop mobile data on this eSIM. The eSIM remains registered and can be reconnected later."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <label className="block space-y-1.5 text-sm font-medium">
              Reason
              <textarea
                className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={reason}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Reason (required)"
              />
            </label>
            <label className="block space-y-1.5 text-sm font-medium">
              {action === "terminate" ? (
                <>Type the eSIM number to confirm</>
              ) : (
                <>
                  Type <code>SUSPEND</code> to confirm
                </>
              )}
              <Input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
              />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button
              variant={action === "terminate" ? "destructive" : "default"}
              disabled={
                busy || reason.trim().length < 5 || confirmation !== required
              }
              onClick={() => void submit()}
            >
              {busy
                ? "Submitting…"
                : action === "terminate"
                  ? "Terminate permanently"
                  : "Confirm data pause"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
