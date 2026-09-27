import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DocumentRecoveryFields,
  replacementReasonsFromTimeline,
} from "./document-recovery";

afterEach(cleanup);

describe("document replacement guidance", () => {
  it("shows a specific passport reason and a way to recover", () => {
    render(
      <DocumentRecoveryFields
        documents={[{ type: "PASSPORT", status: "REUPLOAD_REQUIRED", fileName: "passport.png", uploadVerified: true }]}
        types={["PASSPORT"]}
        files={{}}
        onChange={vi.fn()}
        passportFailureCode="MRZ_NOT_READABLE"
      />,
    );
    expect(screen.getByText("Passport details could not be read")).toBeDefined();
    expect(screen.getByText(/two machine-readable lines fully visible/)).toBeDefined();
    expect(screen.getByText("Replace passport")).toBeDefined();
  });
  it("shows only the rejected ticket as editable with the ops comment", () => {
    render(
      <DocumentRecoveryFields
        documents={[
          { type: "PASSPORT", status: "APPROVED", fileName: "passport.png", uploadVerified: true },
          { type: "TICKET", status: "REUPLOAD_REQUIRED", fileName: "ticket.png", uploadVerified: true },
        ]}
        types={["PASSPORT", "TICKET"]}
        files={{}}
        onChange={vi.fn()}
        replacementReasons={{ TICKET: "The travel date is cropped." }}
      />,
    );
    expect(screen.getByText("Travel ticket needs a new upload")).toBeDefined();
    expect(screen.getByText("The travel date is cropped.")).toBeDefined();
    expect(screen.getByLabelText("Travel ticket")).toBeDefined();
    expect(screen.queryByLabelText("Passport", { exact: true })).toBeNull();
    expect(screen.getByText("Kept on file")).toBeDefined();
  });

  it("uses the latest review comment and removes internal reviewer identity", () => {
    expect(
      replacementReasonsFromTimeline([
        { reason: "TICKET: Previous comment (requested by old-reviewer)" },
        { reason: "TICKET: Show the complete flight date (requested by staff-1)" },
      ]),
    ).toMatchObject({ TICKET: "Show the complete flight date" });
    expect(
      replacementReasonsFromTimeline([
        { reason: "Documents requested again: Both pages are cropped" },
      ]),
    ).toMatchObject({ PASSPORT: "Both pages are cropped", TICKET: "Both pages are cropped" });
  });
});
