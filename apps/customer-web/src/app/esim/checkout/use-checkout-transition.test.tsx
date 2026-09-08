import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useCheckoutTransition } from "./use-checkout-transition";
function Wizard({ step, ready = true }: { step: string; ready?: boolean }) {
  const ref = useCheckoutTransition(step, ready);
  return (
    <section ref={ref}>
      <div className="form-section">
        <h2>{step}</h2>
        <input aria-label="Traveller name" />
      </div>
    </section>
  );
}
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("focuses the destination step after a successful transition", () => {
  const view = render(<Wizard step="Traveller" />);
  view.rerender(<Wizard step="Documents" />);
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { name: "Documents" }),
  );
});
it("does not steal focus during background updates or unfinished saves", () => {
  const view = render(<Wizard step="Traveller" />);
  const input = screen.getByRole("textbox");
  input.focus();
  view.rerender(<Wizard step="Traveller" ready={false} />);
  view.rerender(<Wizard step="Traveller" />);
  expect(document.activeElement).toBe(input);
  view.rerender(<Wizard step="Documents" ready={false} />);
  expect(document.activeElement).toBe(input);
  view.rerender(<Wizard step="Documents" />);
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { name: "Documents" }),
  );
});
