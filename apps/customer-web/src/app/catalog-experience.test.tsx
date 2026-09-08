import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Catalog from "./catalog-plans";
const route = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => route,
  usePathname: () => "/destinations",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}));
const ok = (data: unknown) => ({ ok: true, json: async () => ({ data }) });
const countries = [{ code: "IN", name: "India" }];
const plans = [
  {
    id: "india",
    countryCode: "IN",
    countryName: "India",
    name: "India 500 MB",
    dataAllowance: "500 MB",
    validityDays: 1,
    sellingPriceNpr: 2,
    coverage: ["IN"],
    popular: false,
  },
];
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  route.push.mockReset();
  route.replace.mockReset();
});
it("shows loading before the destination catalog has arrived", () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
  render(<Catalog />);
  expect(
    screen.getByRole("status", { name: "Loading available plans" }),
  ).toBeDefined();
  expect(screen.queryByText(/No plans available/)).toBeNull();
});
it("retries a failed catalog request inline", async () => {
  let fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("popular=true")) return ok([]);
      if (url.endsWith("/countries")) {
        if (fail) {
          fail = false;
          throw new Error("offline");
        }
        return ok(countries);
      }
      return ok(plans);
    }),
  );
  render(<Catalog />);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("link", { name: "Choose" });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});
