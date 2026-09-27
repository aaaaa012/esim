"use client";

import { AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export default function ErrorDialog({
  error,
  title = "Something went wrong",
  onClose,
}: {
  error: string | null;
  title?: string;
  onClose: () => void;
}) {
  return (
    <Dialog open={Boolean(error)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton
        className="w-[calc(100vw-2rem)] min-w-0 max-w-[480px] border-destructive/40"
      >
        <DialogHeader className="flex-row items-center gap-3 text-left">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
            <AlertTriangle className="size-5" />
          </span>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogDescription className="whitespace-pre-wrap text-sm text-foreground">
          {error}
        </DialogDescription>
      </DialogContent>
    </Dialog>
  );
}
