import { describe, expect, it } from "vitest";
import {
  catalogDestinationHref,
  initialCatalogDestination,
  rankCatalogPlans,
  type Plan,
} from "./catalog-plans.js";

describe("customer catalog destination navigation", () => {
  it("routes selections from the homepage to the destination catalog", () => {
    expect(catalogDestinationHref("/", "", "AU")).toBe(
      "/destinations?country=AU",
    );
  });

  it("preserves a targeted eSIM while clearing stale plan filters", () => {
    expect(
      catalogDestinationHref(
        "/destinations",
        "esim=sim-1&country=JP&data=1024&days=7",
        "SG",
      ),
    ).toBe("/destinations?esim=sim-1&country=SG");
  });
});

const countries = [
  { code: "AU", name: "Australia" },
  { code: "JP", name: "Japan", popular: true },
  { code: "SG", name: "Singapore", popular: true },
];

describe("customer catalog initial destination", () => {
  it("uses a valid destination from the URL", () => {
    expect(initialCatalogDestination(countries, "sg")).toBe("SG");
  });

  it("does not force a popular destination without an explicit selection", () => {
    expect(initialCatalogDestination(countries)).toBe("");
  });

  it("does not force the first available destination", () => {
    expect(
      initialCatalogDestination([
        { code: "AU", name: "Australia" },
        { code: "DE", name: "Germany" },
      ]),
    ).toBe("");
  });

  it("returns an empty selection when the catalog has no countries", () => {
    expect(initialCatalogDestination([], "JP")).toBe("");
  });
});

const plan = (
  id: string,
  allowanceMb: number,
  validityDays: number,
  sellingPriceNpr: number,
): Plan => ({
  id,
  countryCode: "JP",
  countryName: "Japan",
  name: id,
  dataAllowance: `${allowanceMb} MB`,
  allowanceMb,
  validityDays,
  sellingPriceNpr,
  coverage: ["JP"],
  popular: false,
});

describe("customer catalog ordering", () => {
  it("shows popular plans first, then orders by price without filtering packages", () => {
    const small = plan("small", 1024, 7, 500);
    const large = plan("large", 4096, 30, 1200);
    const popular = { ...plan("popular", 2048, 15, 900), popular: true };
    expect(
      rankCatalogPlans([large, small, popular]).map((item) => item.id),
    ).toEqual(["popular", "small", "large"]);
  });
});
