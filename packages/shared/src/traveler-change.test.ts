import { describe, expect, it } from "vitest";
import { travelerChangeKind } from "./traveler-change.js";

const saved = {
  title: "MR", firstName: "Resham", middleName: "", surname: "Kumar",
  dateOfBirth: "1983-07-30", nationality: "NP", passportNumber: "PA031964",
  passportExpiryDate: "2032-05-03", city: "Kathmandu",
  countryOfResidence: "NP", employerOrBusinessName: "", email: "a@example.com",
  mobile: "+9779800000000", pointOfSaleCode: "",
} as const;

describe("travelerChangeKind", () => {
  it("treats trimmed and normalized saved values as unchanged", () => {
    expect(travelerChangeKind(saved, { ...saved, firstName: " Resham ", email: "A@EXAMPLE.COM" })).toBe("unchanged");
  });
  it("separates contact edits from passport identity edits", () => {
    expect(travelerChangeKind(saved, { ...saved, mobile: "+9779800000001" })).toBe("contact");
    expect(travelerChangeKind(saved, { ...saved, passportNumber: "PA031965" })).toBe("identity");
  });
  it("identifies first-time entry", () => {
    expect(travelerChangeKind(null, saved)).toBe("new");
  });
});
