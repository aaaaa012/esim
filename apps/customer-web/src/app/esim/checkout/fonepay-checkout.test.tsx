import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ActiveFonepayPaymentMethods,
  FonepayCheckout,
} from "./fonepay-checkout";

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
    onBackToMethods: vi.fn(),
    ...overrides,
  };
}

describe("FonepayCheckout", () => {
  it("opens in bank selection view by default when banks are available", () => {
    const { container } = render(<FonepayCheckout {...baseProps()} />);

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
    const bankCard = container.querySelector(".fonepay-bank-card");
    expect(bankCard).toBeInTheDocument();
    expect(bankCard).toContainElement(
      screen.getByRole("button", { name: /laxmi sunrise bank/i }),
    );
    expect(bankCard?.querySelector(".fonepay-qr-expiry")).toBeNull();
    expect(bankCard?.querySelector(".fonepay-checkout-title")).toBeNull();
    expect(bankCard?.querySelector(".fonepay-qr-prompt")).toBeNull();
  });

  it("navigates to the centered QR view and back", () => {
    render(<FonepayCheckout {...baseProps()} />);

    fireEvent.click(screen.getByRole("button", { name: /scan the qr code/i }));

    expect(
      screen.getByRole("heading", {
        name: /scan to pay with any banking app/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /qr code/i })).toBeInTheDocument();
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

  it("can return to payment methods from both bank and QR views", () => {
    const onBackToMethods = vi.fn();
    render(<FonepayCheckout {...baseProps({ onBackToMethods })} />);

    fireEvent.click(
      screen.getByRole("button", { name: /back to payment methods/i }),
    );
    expect(onBackToMethods).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /scan the qr code/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /back to payment methods/i }),
    );
    expect(onBackToMethods).toHaveBeenCalledTimes(2);
  });

  it("renders the QR view directly when no banks are available", () => {
    render(<FonepayCheckout {...baseProps()} banks={undefined} />);

    expect(
      screen.getByRole("heading", {
        name: /scan to pay with any banking app/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /qr code/i })).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: /scan the qr code/i }));

    const card = container.querySelector(".fonepay-qr-card");
    expect(card).toBeInTheDocument();
    // The card holds only the brand, QR (or fallback), and merchant identity,
    // never the timer, instructions, or navigation.
    expect(card?.querySelector(".fonepay-checkout-logo")).toBeInTheDocument();
    expect(card?.querySelector(".fonepay-qr")).toBeInTheDocument();
    expect(card?.querySelector(".fonepay-terminal-name")).toHaveTextContent(
      "Visa Compass Services",
    );
    expect(card?.querySelector(".fonepay-qr-expiry")).not.toBeInTheDocument();
    expect(card?.querySelector(".fonepay-qr-steps")).not.toBeInTheDocument();
    expect(card?.querySelector(".fonepay-qr-back")).not.toBeInTheDocument();
    expect(container.querySelector(".fonepay-qr-expiry")).toBeInTheDocument();
    expect(container.querySelector(".fonepay-qr-steps")).toBeInTheDocument();
    expect(container.querySelector(".fonepay-qr-back")).toBeInTheDocument();
  });
});

describe("ActiveFonepayPaymentMethods", () => {
  it("keeps provider switching disabled until the server permits it", () => {
    const onResume = vi.fn();
    const onCheck = vi.fn();
    const onChooseKhalti = vi.fn();
    const { rerender } = render(
      <ActiveFonepayPaymentMethods
        canChangeProvider={false}
        busy={false}
        onResume={onResume}
        onCheck={onCheck}
        onChooseKhalti={onChooseKhalti}
      />,
    );

    expect(
      screen.getByRole("button", { name: /khalti wallet/i }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: /check fonepay status/i }),
    );
    expect(onCheck).toHaveBeenCalledTimes(1);

    rerender(
      <ActiveFonepayPaymentMethods
        canChangeProvider
        busy={false}
        onResume={onResume}
        onCheck={onCheck}
        onChooseKhalti={onChooseKhalti}
      />,
    );
    const khalti = screen.getByRole("button", { name: /khalti wallet/i });
    expect(khalti).toBeEnabled();
    fireEvent.click(khalti);
    expect(onChooseKhalti).toHaveBeenCalledTimes(1);
  });
});
