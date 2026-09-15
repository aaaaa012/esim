import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import EsimDashboard, { activityStatusLabel } from "./esim-dashboard";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("../../authenticated-api-provider", () => ({
  useAuthenticatedFetch: () => mocks.fetch,
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}));

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({ data: [] }),
  });
});
afterEach(() => cleanup());

it("translates lifecycle statuses into clear customer next steps", () => {
  expect(activityStatusLabel("DRAFT")).toBe("Purchase started");
  expect(activityStatusLabel("AWAITING_CUSTOMER")).toBe("Action required");
  expect(activityStatusLabel("PAYMENT_FAILED")).toBe("Payment needs attention");
  expect(activityStatusLabel("PROVISIONING_FAILED")).toBe(
    "eSIM preparation needs attention",
  );
  expect(activityStatusLabel("QR_READY")).toBe("Ready to install");
  expect(activityStatusLabel("COMPLETED")).toBe("Purchase completed");
});

it("keeps orders reachable when the signed-in customer has no eSIM", async () => {
  render(<EsimDashboard />);

  expect(
    await screen.findByRole("heading", { name: "Your eSIM will appear here" }),
  ).toBeTruthy();
  expect(screen.getByRole("link", { name: "Browse plans" }).getAttribute("href"))
    .toBe("/destinations");
  expect(screen.getByRole("link", { name: "View my orders" }).getAttribute("href"))
    .toBe("/account/orders");
  expect(screen.getByText(/recharged another person’s existing eSIM/i)).toBeTruthy();
  expect(screen.queryByText(/buy.*for.*friend/i)).toBeNull();
});
