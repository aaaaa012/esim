import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FonepayBankPicker } from "./fonepay-bank-picker";

const banks = [
  {
    bankName: "Laxmi Sunrise Bank",
    bankCode: "LXBLNPKA",
    intentScheme: "LXBLNPKA",
  },
  {
    bankName: "Nabil Bank",
    bankCode: "NARBNPKA",
    intentScheme: "NARBNPKA",
  },
];

describe("FonepayBankPicker", () => {
  it("keeps the full provider directory behind an accessible selector", () => {
    render(
      <FonepayBankPicker
        banks={banks}
        qrPayload="payload"
        socketReady
        onError={vi.fn()}
      />,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /choose banking app/i }),
    );

    const dialog = screen.getByRole("dialog", { name: /choose banking app/i });
    expect(within(dialog).getByText("Laxmi Sunrise Bank")).toBeInTheDocument();
    expect(within(dialog).getByText("Nabil Bank")).toBeInTheDocument();
  });

  it("filters by provider bank name without dropping the original directory", () => {
    render(
      <FonepayBankPicker
        banks={banks}
        qrPayload="payload"
        socketReady
        onError={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /choose banking app/i }),
    );
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "nabil" },
    });

    expect(screen.getByText("Nabil Bank")).toBeInTheDocument();
    expect(screen.queryByText("Laxmi Sunrise Bank")).not.toBeInTheDocument();
  });

  it("directs desktop customers to scan the QR instead of launching a scheme", () => {
    const onError = vi.fn();
    render(
      <FonepayBankPicker
        banks={banks}
        qrPayload="payload"
        socketReady
        onError={onError}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /choose banking app/i }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /laxmi sunrise bank/i }),
    );

    expect(onError).toHaveBeenCalledWith(
      expect.stringMatching(/mobile device.*scan the QR/i),
    );
  });

  it("allows a bank launch even when the provider socket is not ready", () => {
    const onError = vi.fn();
    const onTelemetry = vi.fn();
    let assignedUrl = "";
    const originalAssign = window.location.assign;
    Object.defineProperty(window, "location", {
      value: new URL("https://example.com"),
      writable: true,
      configurable: true,
    });
    window.location.assign = ((url: string) => {
      assignedUrl = url;
    }) as Location["assign"];
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: "iPhone",
    });
    render(
      <FonepayBankPicker
        banks={banks}
        qrPayload="payload"
        socketReady={false}
        onError={onError}
        onTelemetry={onTelemetry}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /choose banking app/i }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /laxmi sunrise bank/i }),
    );
    expect(assignedUrl).toContain("LXBLNPKA://payment/");
    expect(onTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ event: "BANK_LAUNCH_ATTEMPTED" }),
    );
    expect(onError).not.toHaveBeenCalledWith(
      expect.stringMatching(/not ready/i),
    );
    window.location.assign = originalAssign;
  });
});
