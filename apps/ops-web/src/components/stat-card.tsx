import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

type StatCardProps = {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  hint?: string;
  tone?: "default" | "success" | "warning" | "danger" | "info";
  className?: string;
};

const toneClass: Record<string, string> = {
  default: "ops-tone",
  success: "ops-tone-success",
  warning: "ops-tone-warning",
  danger: "ops-tone-danger",
  info: "ops-tone-info",
};

export function StatCard({
  label,
  value,
  icon,
  hint,
  tone = "default",
  className,
}: StatCardProps) {
  return (
    <div
      className={cn(
        "ops-card ops-tone hoverable flex flex-col overflow-hidden",
        toneClass[tone],
        className,
      )}
    >
      <span className="ops-tone-bar" />
      <div className="flex flex-1 flex-col justify-between gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <span className="text-sm font-medium text-muted-foreground">
            {label}
          </span>
          {icon && <span className="ops-stat-icon">{icon}</span>}
        </div>
        <div>
          <div className="ops-stat-value text-3xl font-semibold tracking-tight tabular-nums">
            {value}
          </div>
          {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
        </div>
      </div>
    </div>
  );
}