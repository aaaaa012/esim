import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export type StatusTone = "default" | "success" | "warning" | "danger" | "info" | "destructive";

type StatusBadgeProps = {
  label: string;
  tone?: StatusTone;
  className?: string;
  children?: ReactNode;
};

const toneMap: Record<string, "success" | "warning" | "danger" | "info" | "destructive"> = {
  success: "success",
  green: "success",
  healthy: "success",
  up: "success",
  sent: "success",
  approved: "success",
  processed: "success",
  completed: "success",
  active: "success",
  verified: "success",
  qr_ready: "info",
  warning: "warning",
  pending: "warning",
  queued: "warning",
  review_pending: "warning",
  awaiting_customer: "warning",
  provisioning_failed: "danger",
  failed: "danger",
  rejected: "danger",
  red: "danger",
  danger: "danger",
  draft: "info",
  quarantined: "destructive",
};

const dotMap: Record<StatusTone, string> = {
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
  destructive: "bg-red-500",
  info: "bg-sky-500",
  default: "bg-muted-foreground/60",
};

function toneFor(label: string, tone?: StatusTone): StatusTone {
  if (tone) return tone;
  return toneMap[label.toLowerCase()] ?? "default";
}

export function StatusBadge({ label, tone, className, children }: StatusBadgeProps) {
  const text = label == null ? "" : String(label);
  const resolved = toneFor(text, tone);
  return (
    <Badge
      variant={
        resolved === "success"
          ? "success"
          : resolved === "warning"
            ? "warning"
            : resolved === "danger"
              ? "destructive"
              : resolved === "info"
                ? "info"
                : "secondary"
      }
      className={cn("gap-1.5 pl-2 capitalize", className)}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dotMap[resolved])} />
      {children}
      {text.replaceAll("_", " ")}
    </Badge>
  );
}