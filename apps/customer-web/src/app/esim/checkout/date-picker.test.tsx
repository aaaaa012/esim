import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import DatePicker from "./date-picker";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

it("opens the mobile calendar in a viewport-level bottom panel", () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
  const onChange = vi.fn();
  render(
    <DatePicker
      name="date of birth"
      value="1983-07-30"
      onChange={onChange}
      min="1900-01-01"
      max="2026-09-25"
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /Jul 30, 1983/i }));

  const dialog = screen.getByRole("dialog", { name: "Choose date of birth" });
  expect(dialog.closest(".date-picker-backdrop")?.parentElement).toBe(
    document.body,
  );
  expect(dialog.closest(".date-picker-mobile-panel")).not.toBeNull();
  expect(document.body.style.overflow).toBe("hidden");
  fireEvent.click(screen.getByRole("button", { name: "Close calendar" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.style.overflow).toBe("");
});

it("keeps the desktop calendar anchored to its field", () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
  const { container } = render(
    <DatePicker name="passport expiry" value="2032-05-03" onChange={vi.fn()} />,
  );

  fireEvent.click(screen.getByRole("button", { name: /May 3, 2032/i }));

  expect(
    container.querySelector(".date-picker > .date-picker-popover"),
  ).not.toBeNull();
  expect(document.querySelector(".date-picker-backdrop")).toBeNull();
});
