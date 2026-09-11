"use client";

import { useRef, useState } from "react";
import { FileUp, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/spinner";

type FileUploaderProps = {
  accept?: string;
  hint?: string;
  onFileSelected: (file: File | null) => void;
  value?: File | null;
  busy?: boolean;
  className?: string;
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export function FileUploader({
  accept,
  hint,
  onFileSelected,
  value,
  busy,
  className,
}: FileUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const active = value ?? null;

  return (
    <div className={cn("space-y-2", className)}>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        disabled={busy}
        className="hidden"
        onChange={(e) => onFileSelected(e.target.files?.[0] ?? null)}
      />
      {active ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
              <FileUp className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{active.name}</p>
              <p className="text-xs text-muted-foreground">
                {formatBytes(active.size)}
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${active.name}`}
            disabled={busy}
            onClick={() => {
              onFileSelected(null);
              if (inputRef.current) inputRef.current.value = "";
            }}
          >
            <X className="size-4" />
          </Button>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (!busy) onFileSelected(e.dataTransfer.files?.[0] ?? null);
          }}
          className={cn(
            "flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors",
            dragOver
              ? "border-primary bg-accent/40"
              : "border-border hover:border-primary/50 hover:bg-muted/40",
          )}
        >
          {busy ? (
            <Spinner />
          ) : (
            <span className="flex size-10 items-center justify-center rounded-full bg-accent text-accent-foreground">
              <FileUp className="size-5" />
            </span>
          )}
          <span className="text-sm font-medium">
            {busy ? "Uploading file…" : "Click to choose a file or drag & drop"}
          </span>
          {hint && (
            <span className="text-xs text-muted-foreground">{hint}</span>
          )}
        </button>
      )}
    </div>
  );
}
