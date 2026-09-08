"use client";
import { useEffect, useRef } from "react";

export function useDocumentRefresh(
  enabled: boolean,
  refresh: (isCurrent: () => boolean) => Promise<void>,
  onError: () => void,
  manual = false,
) {
  const callbacks = useRef({ refresh, onError });
  callbacks.current = { refresh, onError };
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await callbacks.current.refresh(() => !cancelled);
      } catch {
        if (!cancelled) callbacks.current.onError();
      } finally {
        if (!cancelled)
          timer = setTimeout(() => void poll(), manual ? 10_000 : 3_000);
      }
    };
    timer = setTimeout(() => void poll(), manual ? 10_000 : 3_000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, manual]);
}
