import { describe, expect, it } from "vitest";
import { isIsoAlpha2CountryCode } from "./countries.js";

describe("isIsoAlpha2CountryCode", () => {
  it("accepts assigned country codes case-insensitively", () => {
    expect(isIsoAlpha2CountryCode("PL")).toBe(true);
    expect(isIsoAlpha2CountryCode(" np ")).toBe(true);
  });

  it("rejects arbitrary two-letter values", () => {
    expect(isIsoAlpha2CountryCode("PO")).toBe(false);
    expect(isIsoAlpha2CountryCode("XX")).toBe(false);
  });
});
