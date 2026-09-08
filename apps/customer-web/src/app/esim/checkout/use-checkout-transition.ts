"use client";
import { useEffect, useRef } from "react";

export function useCheckoutTransition(screen: string, ready: boolean) {
  const container = useRef<HTMLElement>(null);
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !container.current) return;
    if (previous.current === null) {
      previous.current = screen;
      return;
    }
    if (previous.current === screen) return;
    previous.current = screen;
    let animation: Animation | undefined;
    const frame = requestAnimationFrame(() => {
      const panel =
        container.current?.querySelector<HTMLElement>(".form-section");
      const heading = panel?.querySelector<HTMLElement>("h2");
      if (!panel || !heading) return;
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      const reduced = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      heading.scrollIntoView?.({
        behavior: reduced ? "auto" : "smooth",
        block: "start",
      });
      if (!reduced)
        animation = panel.animate?.(
          [
            { opacity: 0.75, transform: "translateY(6px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          { duration: 180, easing: "cubic-bezier(.16,1,.3,1)" },
        );
    });
    return () => {
      cancelAnimationFrame(frame);
      animation?.cancel();
    };
  }, [screen, ready]);
  return container;
}
