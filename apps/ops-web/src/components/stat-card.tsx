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

const toneStyles: Record<string, string> = {
  default: "bg-accent text-accent-foreground",
  success: "bg-success-soft text-success-foreground",
  warning: "bg-warning-soft text-warning-foreground",
  danger: "bg-destructive/10 text-destructive",
  info: "bg-primary/10 text-primary",
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
        "flex flex-col justify-between gap-4 rounded-xl border bg-card p-5 shadow-card",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm font-medium text-muted-foreground">
          {label}
        </span>
        {icon && (
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-lg",
              toneStyles[tone],
            )}
          >
            {icon}
          </span>
        )}
      </div>
      <div>
        <div className="text-3xl font-semibold tracking-tight tabular-nums">
          {value}
        </div>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}