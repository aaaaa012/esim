import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FonepayCheckout } from "./fonepay-checkout";

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

function baseProps(overrides?: Partial<Parameters<typeof FonepayCheckout>[0]>) {
  return {
    titleId: "test-title",
    banks,
    qrPayload: "payload",
    qrDataUrl: "data:image/png;base64,AAAA",
    socketReady: true,
    onError: vi.fn(),
    onTelemetry: vi.fn(),
    hint: "",
    busy: false,
    checkLabel: "Check payment status",
    onCheck: vi.fn(),
    ...overrides,
  };
}

describe("FonepayCheckout", () => {
  it("opens in bank selection view by default when banks are available", () => {
    render(<FonepayCheckout {...baseProps()} />);

    expect(
      screen.getByRole("heading", { name: /pay with your banking app/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /laxmi sunrise bank/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: /qr code/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /scan the qr code/i }),
    ).toBeInTheDocument();
  });

  it("navigates to the centered QR view and back", () => {
    render(<FonepayCheckout {...baseProps()} />);

    fireEvent.click(
      screen.getByRole("button", { name: /scan the qr code/i }),
    );

    expect(
      screen.getByRole("heading", {
        name: /scan to pay with any banking app/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /qr code/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /laxmi sunrise bank/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /back to banking apps/i }),
    );

    expect(
      screen.getByRole("button", { name: /laxmi sunrise bank/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: /qr code/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the QR view directly when no banks are available", () => {
    render(<FonepayCheckout {...baseProps()} banks={undefined} />);

    expect(
      screen.getByRole("heading", {
        name: /scan to pay with any banking app/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /qr code/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /back to banking apps/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps the QR alone in its card with timer, steps and navigation outside it", () => {
    const { container } = render(
      <FonepayCheckout
        {...baseProps()}
        expiresAt={new Date(Date.now() + 60_000).toISOString()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /scan the qr code/i }),
    );

    const card = container.querySelector(".fonepay-qr-card");
    expect(card).toBeInTheDocument();
    // The card holds only the QR image (or its fallback) — never the timer,
    // the instruction steps, or the back link.
    expect(card?.querySelector(".fonepay-qr")).toBeInTheDocument();
    expect(card?.querySelector(".fonepay-qr-expiry")).not.toBeInTheDocument();
    expect(card?.querySelector(".fonepay-qr-steps")).not.toBeInTheDocument();
    expect(card?.querySelector(".fonepay-qr-back")).not.toBeInTheDocument();
    expect(
      container.querySelector(".fonepay-qr-expiry"),
    ).toBeInTheDocument();
    expect(container.querySelector(".fonepay-qr-steps")).toBeInTheDocument();
    expect(
      container.querySelector(".fonepay-qr-back"),
    ).toBeInTheDocument();
  });
});