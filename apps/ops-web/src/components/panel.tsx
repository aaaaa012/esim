import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

type PanelProps = {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  noPadding?: boolean;
  children: ReactNode;
};

export function Panel({
  title,
  description,
  actions,
  className,
  bodyClassName,
  noPadding,
  children,
}: PanelProps) {
  return (
    <Card className={cn("gap-0 overflow-hidden", className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
          <div className="space-y-0.5">
            {title && (
              <h2 className="text-base font-semibold tracking-tight">
                {title}
              </h2>
            )}
            {description && (
              <p className="text-xs text-muted-foreground">{description}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <CardContent
        className={cn(!noPadding && "p-6", bodyClassName, title && "pt-0")}
      >
        {children}
      </CardContent>
    </Card>
  );
}