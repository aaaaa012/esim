import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import EsimDashboard from "./esim-dashboard";

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
