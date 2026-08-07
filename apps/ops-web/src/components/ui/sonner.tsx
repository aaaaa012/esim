"use client";

import { Toaster as Sonner } from "sonner";
import { cn } from "@/lib/utils";

export function Toaster() {
  return (
    <Sonner
      className="toaster group"
      position="top-right"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-card group-[.toaster]:text-card-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg group-[.toaster]:rounded-xl",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
          success:
            "group-[.toaster]:[&_[data-icon]]:text-success group-[.toaster]:[&_svg[data-icon]]:text-success",
          error:
            "group-[.toaster]:[&_[data-icon]]:text-destructive group-[.toaster]:[&_svg[data-icon]]:text-destructive",
        },
      }}
    />
  );
}