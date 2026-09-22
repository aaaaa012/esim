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
    const delay = () => (manual ? 5_000 : 3_000);
    const poll = async () => {
      if (document.visibilityState === "hidden") {
        timer = setTimeout(() => void poll(), delay());
        return;
      }
      try {
        await callbacks.current.refresh(() => !cancelled);
      } catch {
        if (!cancelled) callbacks.current.onError();
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), delay());
      }
    };
    const resume = () => {
      if (document.visibilityState !== "visible" || cancelled) return;
      clearTimeout(timer);
      timer = setTimeout(() => void poll(), 0);
    };
    document.addEventListener("visibilitychange", resume);
    timer = setTimeout(() => void poll(), manual ? 0 : delay());
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [enabled, manual]);
}
