import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ManualRefundCard } from "./manual-refund-card";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("../../authenticated-api-provider", () => ({
  useAuthenticatedFetch: () => mocks.fetch,
}));

const ok = (items: unknown[] = []) => ({
  ok: true,
  json: async () => ({ data: { items } }),
});

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValue(ok());
});

afterEach(cleanup);

describe("ManualRefundCard", () => {
  it("keeps the refund action visible when no payment attempt exists", async () => {
    render(<ManualRefundCard orderId="order-1" hasPaymentAttempt={false} />);

    const button = await screen.findByRole("button", {
      name: "Request manual refund",
    });
    expect(button).toHaveProperty("disabled", true);
    expect(
      screen.getByText(/after at least one payment attempt/i),
    ).toBeDefined();
  });

  it("enables the refund action for an unconfirmed payment attempt", async () => {
    render(
      <ManualRefundCard
        orderId="order-2"
        hasPaymentAttempt
        paymentProvider="FONEPAY"
      />,
    );

    const button = await screen.findByRole("button", {
      name: "Request manual refund",
    });
    expect(button).toHaveProperty("disabled", false);
  });

  it("keeps the action visible but prevents a duplicate active request", async () => {
    mocks.fetch.mockResolvedValue(
      ok([
        {
          id: "refund-1",
          orderId: "order-3",
          paymentId: "payment-1",
          status: "REQUESTED",
          reason: "PROVISIONING_FAILURE",
          explanation: "Provisioning failed after payment.",
          amount: 100,
          createdAt: "2026-09-18T00:00:00.000Z",
          order: { orderNumber: "VC-ORDER", status: "COMPLETED" },
          payment: { provider: "FONEPAY" },
          requestedBy: { email: "ops@example.com" },
        },
      ]),
    );

    render(<ManualRefundCard orderId="order-3" hasPaymentAttempt />);

    const button = await screen.findByRole("button", {
      name: "Request manual refund",
    });
    expect(button).toHaveProperty("disabled", true);
    expect(screen.getByText(/already has a refund awaiting/i)).toBeDefined();
  });
});
