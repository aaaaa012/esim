import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  CompatibilityConfirmation,
  PurchaseConsent,
} from "./checkout-confirmation";

afterEach(cleanup);

describe("checkout confirmation", () => {
  it("toggles from the full selection row and exposes the selected state", () => {
    const onChange = vi.fn();
    const { container } = render(
      <CompatibilityConfirmation checked={false} onChange={onChange} />,
    );
    fireEvent.click(screen.getByText("I confirm my device is eSIM compatible"));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(
      container
        .querySelector(".confirmation-choice")
        ?.classList.contains("selected"),
    ).toBe(false);
  });

  it("opens compatibility guidance safely without changing selection", () => {
    const onChange = vi.fn();
    render(<CompatibilityConfirmation checked={false} onChange={onChange} />);
    const link = screen.getByRole("link", {
      name: /Check device compatibility/,
    });
    expect(link.getAttribute("href")).toBe("/compatibility");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    fireEvent.click(link);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps policy links independent and connects invalid input guidance", () => {
    const onChange = vi.fn();
    render(
      <>
        <PurchaseConsent
          checked={false}
          onChange={onChange}
          invalid
          errorId="consent-error"
        />
        <p id="consent-error">Accept the terms to continue</p>
      </>,
    );
    const input = screen.getByRole("checkbox", {
      name: /I agree to the purchase terms/,
    });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain("consent-error");
    fireEvent.click(screen.getByRole("link", { name: "Terms" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
