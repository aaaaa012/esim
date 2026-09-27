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
it("shows non-blocking inline progress while OCR runs and closes it after verification", () => {
  const view = render(<DocumentProgress status="OCR_PENDING" />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("We’re checking your passport")).toBeDefined();
  expect(screen.getByText("Documents securely saved")).toBeDefined();
  expect(screen.getByText("Checking your passport")).toBeDefined();
  expect(screen.getByText("Your next step")).toBeDefined();
  expect(
    screen.getByText(/safely leave while we read the passport/i),
  ).toBeDefined();
  expect(view.container.textContent).not.toMatch(/\d+%/);
  view.rerender(<DocumentProgress status="VERIFIED" />);
  expect(screen.getByText("Documents verified")).toBeDefined();
});
it("shows real save phases without claiming verification or fake percentages", () => {
  const view = render(
    <DocumentProgress
      status="NOT_STARTED"
      busy
      message="Uploading passport.jpg…"
    />,
  );
  expect(screen.getByText("Saving your documents")).toBeDefined();
  expect(screen.getByText("Uploading passport.jpg…")).toBeDefined();
  expect(
    view.container.querySelector(".document-saving-steps .active")?.textContent,
  ).toContain("Upload");
  expect(view.container.textContent).not.toMatch(/\d+%|Documents verified/);
  view.rerender(
    <DocumentProgress
      status="NOT_STARTED"
      busy
      message="Confirming passport.jpg is securely saved…"
    />,
  );
  expect(
    view.container.querySelector(".document-saving-steps .active")?.textContent,
  ).toContain("Secure save");
  view.rerender(
    <DocumentProgress
      status="NOT_STARTED"
      busy
      message="passport.jpg securely saved."
    />,
  );
  expect(screen.getByText("File securely saved")).toBeDefined();
  expect(
    view.container.querySelector(".document-saving-card.is-saved"),
  ).not.toBeNull();
});
it("does not show automated verification for manual review or re-upload requests", () => {
  const view = render(<DocumentProgress status="MANUAL_REVIEW" />);
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(<DocumentProgress status="REUPLOAD_REQUIRED" />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    screen.getByText("One or more documents need replacement"),
  ).toBeDefined();
});
it("asks for traveller details when review starts before any identity was saved", () => {
  render(
    <DocumentProgress
      status="MANUAL_REVIEW"
      needsTravelerDetails
      failureCode="MRZ_REVIEW_REQUIRED"
    />,
  );
  expect(
    screen.getByText("Documents saved — add traveller details"),
  ).toBeDefined();
  expect(
    screen.getByText(/could not reliably read its code lines/i),
  ).toBeDefined();
});
it("uses accurate labels for each accepted review outcome", () => {
  const view = render(<DocumentProgress status="VERIFIED" />);
  expect(screen.getByText("Documents verified")).toBeDefined();
  view.rerender(<DocumentProgress status="MANUALLY_APPROVED" />);
  expect(screen.getByText("Documents verified")).toBeDefined();
  view.rerender(<DocumentProgress status="SKIPPED" />);
  expect(screen.getByText("Document check skipped")).toBeDefined();
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
