import { describe, expect, it } from "vitest";
import {
  initialCatalogDestination,
  rankCatalogPlans,
  type Plan,
} from "./catalog-plans.js";

const countries = [
  { code: "AU", name: "Australia" },
  { code: "JP", name: "Japan", popular: true },
  { code: "SG", name: "Singapore", popular: true },
];

describe("customer catalog initial destination", () => {
  it("uses a valid destination from the URL", () => {
    expect(initialCatalogDestination(countries, "sg")).toBe("SG");
  });

  it("falls back to the first popular destination", () => {
    expect(initialCatalogDestination(countries)).toBe("JP");
  });

  it("falls back to the first available destination when none is popular", () => {
    expect(
      initialCatalogDestination([
        { code: "AU", name: "Australia" },
        { code: "DE", name: "Germany" },
      ]),
    ).toBe("AU");
  });

  it("returns an empty selection only when the catalog has no countries", () => {
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
