"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type ConfirmationOptions = {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

type Confirm = (options: ConfirmationOptions) => Promise<boolean>;

const ConfirmationContext = createContext<Confirm | null>(null);

export function ConfirmationProvider({ children }: { children: React.ReactNode }) {
  const [options, setOptions] = useState<ConfirmationOptions | null>(null);
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);

  const finish = useCallback((confirmed: boolean) => {
    resolver.current?.(confirmed);
    resolver.current = null;
    setOptions(null);
  }, []);

  const confirm = useCallback<Confirm>((next) => {
    resolver.current?.(false);
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  return (
    <ConfirmationContext.Provider value={confirm}>
      {children}
      <Dialog open={Boolean(options)} onOpenChange={(open) => !open && finish(false)}>
        <DialogContent className="max-w-md" showCloseButton={false}>
          <DialogHeader>
            <span className={`mb-2 flex size-10 items-center justify-center rounded-lg ${options?.destructive ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-warning"}`}>
              <AlertTriangle className="size-5" aria-hidden="true" />
            </span>
            <DialogTitle>{options?.title}</DialogTitle>
            <DialogDescription className="leading-6">
              {options?.description}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-2 gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => finish(false)}>
              {options?.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              type="button"
              variant={options?.destructive ? "destructive" : "default"}
              onClick={() => finish(true)}
            >
              {options?.confirmLabel ?? "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmationContext.Provider>
  );
}

export function useConfirmation() {
  const confirm = useContext(ConfirmationContext);
  if (!confirm)
    throw new Error("useConfirmation must be used within ConfirmationProvider");
  return confirm;
}
