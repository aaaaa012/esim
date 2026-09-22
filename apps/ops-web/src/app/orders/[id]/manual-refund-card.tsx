"use client";
import { useEffect, useState } from "react";
import { useAuthenticatedFetch } from "../../authenticated-api-provider";
import { Button } from "@/components/ui/button";
import ErrorDialog from "@/components/error-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge, humane } from "@/components/status-badge";
import {
  REFUND_REASONS,
  type ManualRefund,
} from "../../manual-refunds/manual-refunds-client";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

const apiError = (value: unknown, fallback: string) => {
  const body = value as { error?: { message?: string } } | null;
  return body?.error?.message ?? fallback;
};

export function ManualRefundCard({
  orderId,
  hasPaymentAttempt,
  alreadyRefunded = false,
  paymentProvider,
}: {
  orderId: string;
  hasPaymentAttempt: boolean;
  alreadyRefunded?: boolean;
  paymentProvider?: string;
}) {
  const authFetch = useAuthenticatedFetch();
  const [refund, setRefund] = useState<ManualRefund | null>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<(typeof REFUND_REASONS)[number]>(
    "PROVISIONING_FAILURE",
  );
  const [explanation, setExplanation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);

  const load = async () => {
    setStatusLoading(true);
    try {
      const response = await authFetch(
        `${API}/operations/manual-refunds?orderId=${orderId}`,
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(
          apiError(value, "Manual refund status could not be loaded"),
        );
      setRefund(value.data?.items?.[0] ?? null);
    } finally {
      setStatusLoading(false);
    }
  };

  useEffect(() => {
    void load().catch((cause) =>
      setError(
        cause instanceof Error
          ? cause.message
          : "Manual refund status could not be loaded",
      ),
    );
  }, [orderId]);

  const activeRefund =
    refund && ["REQUESTED", "APPROVED"].includes(refund.status);
  const requestDisabled =
    statusLoading ||
    !hasPaymentAttempt ||
    alreadyRefunded ||
    Boolean(activeRefund);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await authFetch(
        `${API}/operations/manual-refunds/orders/${orderId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason, explanation }),
        },
      );
      const value = await response.json();
      if (!response.ok) throw new Error(apiError(value, "Request failed"));
      setOpen(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <ErrorDialog error={error} onClose={() => setError("")} />
      {refund ? (
        <div className="rounded-lg border p-3 text-sm">
          <div className="flex items-center justify-between">
            <b>Manual refund</b>
            <StatusBadge label={refund.status} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {humane(refund.reason)} · {refund.explanation}
          </p>
          {refund.status === "APPROVED" ? (
            <p className="mt-2 text-xs font-medium">
              Complete the refund in{" "}
              {paymentProvider === "FONEPAY" ? "Fonepay" : "Khalti"}, then mark
              it done from Manual Refunds.
            </p>
          ) : null}
        </div>
      ) : null}
      <Button
        className="w-full"
        variant="outline"
        disabled={requestDisabled}
        onClick={() => {
          setError("");
          setOpen(true);
        }}
      >
        Request manual refund
      </Button>
      {activeRefund ? (
        <p className="text-xs text-muted-foreground">
          This order already has a refund awaiting review or completion.
        </p>
      ) : !hasPaymentAttempt ? (
        <p className="text-xs text-muted-foreground">
          Available after at least one payment attempt has been created.
        </p>
      ) : alreadyRefunded ? (
        <p className="text-xs text-muted-foreground">
          This order has already been refunded.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Use this even when the customer paid but the gateway never confirmed
          it. A Super Admin must review the evidence before completion.
        </p>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request manual refund</DialogTitle>
            <DialogDescription>
              This records an exception for review. It does not send money or
              change the order. If payment was not confirmed in Visa Compass,
              include the customer&apos;s bank or wallet evidence and
              transaction reference below.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>What went wrong?</Label>
              <Select
                value={reason}
                onValueChange={(value) => setReason(value as typeof reason)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REFUND_REASONS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {humane(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Detailed explanation</Label>
              <textarea
                className="mt-1 min-h-28 w-full rounded-md border bg-background p-3 text-sm"
                value={explanation}
                onChange={(event) => setExplanation(event.target.value)}
                autoComplete="off"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || explanation.trim().length < 10}
              onClick={() => void submit()}
            >
              Submit request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
