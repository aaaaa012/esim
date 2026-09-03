import { describe, expect, it } from "vitest";
import { initialCatalogDestination } from "./catalog-plans.js";

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
