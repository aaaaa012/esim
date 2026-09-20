import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HeroDestinationSearch,
  HomepageExplorerProvider,
  PopularRightNow,
} from "./homepage-explorer";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));
vi.mock("next/link", () => ({
  default: ({
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
}));

const countries = [
  { code: "IN", name: "India", popular: true },
  { code: "AU", name: "Australia", popular: true },
];
const plans = [
  {
    id: "in-1",
    countryCode: "IN",
    countryName: "India",
    name: "India Essential",
    dataAllowance: "1 GB",
    validityDays: 7,
    sellingPriceNpr: 999,
    popular: true,
  },
];
const ok = (data: unknown) => ({ ok: true, json: async () => ({ data }) });

beforeEach(() => {
  navigation.push.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(
        ok(
          url.includes("countries")
            ? countries
            : plans.map((plan) => ({ id: `feature-${plan.id}`, plan })),
        ),
      ),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderExplorer() {
  return render(
    <HomepageExplorerProvider>
      <HeroDestinationSearch />
      <PopularRightNow />
    </HomepageExplorerProvider>,
  );
}

describe("homepage destination discovery", () => {
  it("keeps Explore generic until a destination is selected", async () => {
    renderExplorer();
    const explore = await screen.findByRole("link", {
      name: /Explore eSIM plans/i,
    });
    expect(explore.getAttribute("href")).toBe("/destinations");

    fireEvent.click(
      screen.getByRole("button", { name: /Search destination/i }),
    );
    fireEvent.change(screen.getByPlaceholderText("Search destinations…"), {
      target: { value: "Australia" },
    });
    fireEvent.click(screen.getByRole("option", { name: /Australia/i }));
    expect(explore.getAttribute("href")).toBe("/destinations?country=AU");
  });

  it("routes quick destinations and renders live popular-plan data", async () => {
    renderExplorer();
    fireEvent.click(await screen.findByRole("button", { name: /India/i }));
    expect(navigation.push).toHaveBeenCalledWith("/destinations?country=IN");
    expect(await screen.findByRole("heading", { name: "India" })).toBeTruthy();
    expect(screen.getByText("NPR 999")).toBeTruthy();
  });

  it("keeps evergreen destinations available when the catalog is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    renderExplorer();
    fireEvent.click(await screen.findByRole("button", { name: /Australia/i }));
    expect(navigation.push).toHaveBeenCalledWith("/destinations?country=AU");
    expect(screen.queryByText(/Destinations unavailable/i)).toBeNull();
  });

  it("keeps recharge and compatibility as tertiary paths", async () => {
    renderExplorer();
    expect(
      (await screen.findByRole("link", { name: "Recharge" })).getAttribute(
        "href",
      ),
    ).toBe("/recharge");
    expect(
      screen
        .getByRole("link", { name: "Check compatibility" })
        .getAttribute("href"),
    ).toBe("/compatibility");
  });
});
