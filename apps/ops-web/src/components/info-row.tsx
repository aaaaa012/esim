import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type InfoGridProps = {
  label: string;
  value: ReactNode;
  className?: string;
};

export function InfoRow({ label, value, className }: InfoGridProps) {
  return (
    <div className={cn("space-y-1", className)}>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  );
}
