import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DocumentProgress } from "./document-progress";
afterEach(() => cleanup());
it("restores the progress card while OCR runs and closes it after verification", () => {
  const view = render(<DocumentProgress status="OCR_PENDING" />);
  expect(
    screen.getByRole("dialog", {
      name: "Your verification is still in progress",
    }),
  ).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Keep waiting" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "View verification progress" }),
  );
  expect(screen.getByRole("dialog")).toBeDefined();
  view.rerender(<DocumentProgress status="VERIFIED" />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("Documents verified")).toBeDefined();
});
it("does not show automated verification for manual review or re-upload requests", () => {
  const view = render(<DocumentProgress status="MANUAL_REVIEW" />);
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(<DocumentProgress status="REUPLOAD_REQUIRED" />);
  expect(screen.queryByRole("dialog")).toBeNull();
});
