import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  DocumentProgress,
  VerifiedDocumentsSummary,
} from "./document-progress";
afterEach(() => {
  cleanup();
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
});
it("restores the progress card while OCR runs and closes it after verification", () => {
  const view = render(<DocumentProgress status="OCR_PENDING" />);
  expect(
    screen.getByRole("dialog", {
      name: "Your verification is still in progress",
    }),
  ).toBeDefined();
  expect(
    screen.getAllByText("Documents securely saved").length,
  ).toBeGreaterThan(0);
  expect(screen.getByText("Checking your passport")).toBeDefined();
  expect(screen.getAllByText("Ready for payment").length).toBeGreaterThan(0);
  expect(view.container.textContent).not.toMatch(/\d+%/);
  fireEvent.click(screen.getByRole("button", { name: "Keep waiting" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "View verification progress" }),
  );
  expect(screen.getByRole("dialog")).toBeDefined();
  view.rerender(<DocumentProgress status="VERIFIED" />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("Passport verified")).toBeDefined();
});
it("does not show automated verification for manual review or re-upload requests", () => {
  const view = render(<DocumentProgress status="MANUAL_REVIEW" />);
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(<DocumentProgress status="REUPLOAD_REQUIRED" />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    screen.getByText("Passport and traveller details need checking"),
  ).toBeDefined();
});
it("uses accurate labels for each accepted review outcome", () => {
  const view = render(<DocumentProgress status="VERIFIED" />);
  expect(screen.getByText("Passport verified")).toBeDefined();
  view.rerender(<DocumentProgress status="MANUALLY_APPROVED" />);
  expect(screen.getByText("Documents approved")).toBeDefined();
  view.rerender(<DocumentProgress status="SKIPPED" />);
  expect(screen.getByText("Documents accepted")).toBeDefined();
});
it("pauses decorative verification motion while the page is hidden", () => {
  const view = render(<DocumentProgress status="OCR_PENDING" />);
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: true,
  });
  fireEvent(document, new Event("visibilitychange"));
  expect(
    view.container.querySelector(".verification-animation-paused"),
  ).not.toBeNull();
});
it("renders a compact summary without claiming an optional visa was uploaded", () => {
  render(
    <VerifiedDocumentsSummary
      reviewStatus="VERIFIED"
      documents={[
        {
          type: "PASSPORT",
          status: "APPROVED",
          fileName: "passport.jpg",
          uploadVerified: true,
        },
        {
          type: "TICKET",
          status: "PENDING",
          fileName: "ticket.pdf",
          uploadVerified: true,
        },
      ]}
    />,
  );
  const summary = screen.getByRole("list", { name: "Document summary" });
  expect(summary.textContent).toContain("Passportpassport.jpgVerified");
  expect(summary.textContent).toContain(
    "Travel ticketticket.pdfSecurely saved",
  );
  expect(summary.textContent).toContain("VisaNot addedOptional");
});
