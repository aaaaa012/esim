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
};

function toneFor(label: string, tone?: StatusTone): StatusTone {
  if (tone) return tone;
  return toneMap[label.toLowerCase()] ?? "default";
}

export function StatusBadge({ label, tone, className, children }: StatusBadgeProps) {
  const resolved = toneFor(label, tone);
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
      className={cn("capitalize", className)}
    >
      {children}
      {label.replaceAll("_", " ")}
    </Badge>
  );
}