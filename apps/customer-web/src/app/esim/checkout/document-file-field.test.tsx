import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocumentFileField } from "./document-file-field";

describe("DocumentFileField", () => {
  it("does not duplicate the page-level securely-saved status", () => {
    const { container } = render(
      <DocumentFileField
        label="Passport"
        file={undefined}
        savedName="passport.pdf"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText("passport.pdf")).toBeDefined();
    expect(screen.getByText("Passport")).toBeDefined();
    expect(screen.queryByText(/securely saved/i)).toBeNull();
    expect(
      container
        .querySelector('input[type="file"]')
        ?.classList.contains("native-document-input"),
    ).toBe(true);
  });
});
