import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmationProvider, useConfirmation } from "./confirmation-provider";
import ErrorDialog from "./error-dialog";
import { PaginationBar } from "./pagination-bar";
import { SearchInput } from "./search-input";
import { StatusBadge, humane } from "./status-badge";

function ConfirmationHarness({
  destructive = false,
}: {
  destructive?: boolean;
}) {
  const confirm = useConfirmation();
  const [result, setResult] = useState("pending");
  return (
    <>
      <button
        onClick={() =>
          void confirm({
            title: "Apply operation?",
            description: "This changes production data.",
            confirmLabel: "Apply",
            cancelLabel: "Keep current",
            destructive,
          }).then((confirmed) =>
            setResult(confirmed ? "confirmed" : "cancelled"),
          )
        }
      >
        Open confirmation
      </button>
      <output data-testid="confirmation-result">{result}</output>
    </>
  );
}

describe("shared Ops interactions", () => {
  it("resolves an explicit confirmation only after the primary action", async () => {
    render(
      <ConfirmationProvider>
        <ConfirmationHarness />
      </ConfirmationProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open confirmation" }));
    expect(screen.getByRole("dialog").textContent).toContain(
      "Apply operation?",
    );
    expect(screen.getByTestId("confirmation-result").textContent).toBe(
      "pending",
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(screen.getByTestId("confirmation-result").textContent).toBe(
        "confirmed",
      ),
    );
  });

  it("resolves cancellation without applying the operation", async () => {
    render(
      <ConfirmationProvider>
        <ConfirmationHarness destructive />
      </ConfirmationProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open confirmation" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep current" }));
    await waitFor(() =>
      expect(screen.getByTestId("confirmation-result").textContent).toBe(
        "cancelled",
      ),
    );
  });

  it("rejects confirmation usage outside the provider", () => {
    const Probe = () => {
      useConfirmation();
      return null;
    };
    expect(() => render(<Probe />)).toThrow(
      "useConfirmation must be used within ConfirmationProvider",
    );
  });

  it("shows global errors in an accessible dialog and closes them", () => {
    const close = vi.fn();
    render(
      <ErrorDialog
        title="Operation failed"
        error="The provider did not accept the request."
        onClose={close}
      />,
    );
    expect(screen.getByRole("dialog").textContent).toContain(
      "Operation failed",
    );
    expect(screen.getByRole("dialog").textContent).toContain(
      "The provider did not accept the request.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps pagination within valid boundaries", () => {
    const change = vi.fn();
    const { rerender } = render(
      <PaginationBar page={1} pageSize={25} total={51} onPageChange={change} />,
    );
    expect(screen.getByText(/of 51/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Previous/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(change).toHaveBeenCalledWith(2);

    rerender(
      <PaginationBar page={3} pageSize={25} total={51} onPageChange={change} />,
    );
    expect(screen.getByText("Page 3 of 3")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Next/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("reports an empty paginated result without invalid ranges", () => {
    render(
      <PaginationBar page={1} pageSize={25} total={0} onPageChange={vi.fn()} />,
    );
    expect(screen.getByText("No results")).toBeTruthy();
    expect(screen.getByText("Page 1 of 1")).toBeTruthy();
  });

  it("provides an accessible controlled search input", () => {
    const change = vi.fn();
    render(
      <SearchInput
        value="order"
        onChange={change}
        placeholder="Search orders"
      />,
    );
    const input = screen.getByRole("searchbox", { name: "Search orders" });
    expect((input as HTMLInputElement).value).toBe("order");
    fireEvent.change(input, { target: { value: "VC-2026" } });
    expect(change).toHaveBeenCalledWith("VC-2026");
  });

  it("uses human-readable status labels consistently", () => {
    render(<StatusBadge label="REACTIVATION_PENDING" />);
    expect(screen.getByText("Reactivation in progress")).toBeTruthy();
    expect(humane("PARTNER_HOSTED")).toBe("Checkout link");
  });
});
