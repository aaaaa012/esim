import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/spinner";

type EmptyStateProps = {
  icon?: ReactNode;
  title?: string;
  description?: string;
  loading?: boolean;
  className?: string;
  children?: ReactNode;
};

export function EmptyState({
  icon,
  title = "Nothing here yet",
  description,
  loading,
  className,
  children,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex min-h-40 flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      {loading ? (
        <Spinner className="size-5" />
      ) : icon ? (
        <span className="flex size-11 items-center justify-center rounded-full bg-accent text-accent-foreground">
          {icon}
        </span>
      ) : null}
      <div className="space-y-1">
        <p className="text-sm font-medium">{loading ? "Loading…" : title}</p>
        {description && !loading && (
          <p className="max-w-sm text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}
