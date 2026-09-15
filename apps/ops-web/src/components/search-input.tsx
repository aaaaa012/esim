"use client";

import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

type SearchInputProps = {
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
};

export function SearchInput({
  placeholder = "Search…",
  value,
  onChange,
  className,
}: SearchInputProps) {
  return (
    <div className={cn("relative min-w-0", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full min-w-0 pl-9"
      />
    </div>
  );
}
