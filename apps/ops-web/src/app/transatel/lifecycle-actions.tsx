"use client";

import { useState } from "react";
import { MoreHorizontal, PauseCircle, RefreshCcw, Trash2 } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
        profileStatus?: string | null;
        subscriberStatus?: string | null;
        subscriptionStatus?: string | null;
        providerStatus?: string | null;
      };
      const profileStatus = result.profileStatus ?? null;
      const statuses = [
        profileStatus ? `Profile: ${profileStatus}` : null,
        result.subscriberStatus ? `Network: ${result.subscriberStatus}` : null,
        result.subscriptionStatus ? `Plan: ${result.subscriptionStatus}` : null,
      ].filter((status): status is string => Boolean(status));
      toast.success(
        statuses.length
          ? statuses.join(" / ")
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
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="h-8 whitespace-nowrap"
            disabled={busy}
            aria-label={`Actions for eSIM ${iccid}`}
          >
            <MoreHorizontal className="size-4" />
            Actions
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>Plan actions</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => void reconcile()}>
            <RefreshCcw className="size-4" />
            <span>
              Check network status
              <small className="block text-xs text-muted-foreground">
                Reads the latest status only
              </small>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={pending || !suspendable}
            onSelect={() => setAction("suspend")}
          >
            <PauseCircle className="size-4" />
            <span>
              Pause mobile data
              <small className="block text-xs text-muted-foreground">
                Temporarily stops service
              </small>
            </span>
          </DropdownMenuItem>
          {canTerminate ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={
                  providerStatus === "TERMINATED" ||
                  providerStatus === "TERMINATION_PENDING"
                }
                onSelect={() => setAction("terminate")}
              >
                <Trash2 className="size-4" />
                <span>
                  Permanently end eSIM
                  <small className="block text-xs text-muted-foreground">
                    Cannot be undone
                  </small>
                </span>
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
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
