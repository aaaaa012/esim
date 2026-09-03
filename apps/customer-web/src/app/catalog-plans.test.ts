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

describe("customer catalog preference ranking", () => {
  const plans = [
    plan("small", 1024, 7, 500),
    plan("exact", 2048, 15, 900),
    plan("larger", 4096, 30, 1200),
  ];

  it("puts an exact data and duration match first", () => {
    expect(rankCatalogPlans(plans, 2048, 15)[0]?.id).toBe("exact");
  });

  it("prefers the smallest sufficient package over an undersized one", () => {
    expect(rankCatalogPlans(plans, 1500, 10)[0]?.id).toBe("exact");
  });

  it("uses price to break equivalent matches", () => {
    const expensive = plan("expensive", 2048, 15, 1100);
    expect(rankCatalogPlans([expensive, plans[1]!], 2048, 15)[0]?.id).toBe(
      "exact",
    );
  });

  it("keeps manually curated plans first when no preference is selected", () => {
    const popular = { ...plans[2]!, popular: true };
    expect(rankCatalogPlans([plans[0]!, popular])[0]?.id).toBe("larger");
  });

  it("supports the previous API shape during a rolling deployment", () => {
    const { allowanceMb: _allowanceMb, ...legacy } = plans[1]!;
    expect(rankCatalogPlans([plans[0]!, legacy], 2048, 15)[0]?.id).toBe(
      "exact",
    );
  });
});
