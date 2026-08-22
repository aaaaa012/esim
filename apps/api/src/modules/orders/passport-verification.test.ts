import { describe, expect, it } from "vitest";
import type { TravelerInput } from "@visa-compass/shared";
import {
  comparePassport,
  dateVariants,
  imageDimensions,
  normalizeText,
  verdictFor,
} from "./passport-verification.service.js";

const traveler: TravelerInput = {
  title: "MR",
  firstName: "Asha",
  middleName: "Kumari",
  surname: "Shrestha",
  dateOfBirth: "1990-08-15",
  nationality: "NP",
  city: "Kathmandu",
  countryOfResidence: "NP",
  email: "asha@example.com",
  mobile: "+9779812345678",
  passportNumber: "PA1234567",
  passportExpiryDate: "2030-01-01",
};

describe("normalizeText", () => {
  it("uppercases and strips every non-alphanumeric character", () => {
    expect(normalizeText("P A 123-4567 / abc")).toBe("PA1234567ABC");
  });
});

describe("dateVariants", () => {
  it("returns ISO, DDMMYYYY and MRZ YYMMDD / DDMMYY forms", () => {
    expect(dateVariants("1990-08-15")).toEqual([
      "19900815",
      "15081990",
      "900815",
      "150890",
    ]);
    expect(dateVariants("2030-01-01")).toEqual([
      "20300101",
      "01012030",
      "300101",
      "010130",
    ]);
  });
  it("returns an empty array for malformed input", () => {
    expect(dateVariants("15/08/1990")).toEqual([]);
  });
});

describe("comparePassport", () => {
  it("matches all fields on a realistic OCR read of the MRZ", () => {
    const ocr = [
      "REPUBLIC OF NEPAL",
      "PASSPORT",
      "No PA1234567",
      "SHRI AShA KUMARI SHRESTHA",
      "Date of birth 15 AUG 1990",
      "EXPIRY 01/01/2030",
    ].join("\n");
    const { matchedFields } = comparePassport(ocr, traveler);
    expect(matchedFields).toContain("passportNumber");
    expect(matchedFields).toContain("surname");
    expect(matchedFields).toContain("dateOfBirth");
    expect(matchedFields).toContain("passportExpiryDate");
  });

  it("survives OCR noise (spaces and split characters) around the passport number", () => {
    const { matchedFields } = comparePassport(
      "PASSPORT N0. PA 123 4567 SHRESTHA",
      traveler,
    );
    expect(matchedFields).toContain("passportNumber");
  });

  it("does not match when the passport number differs", () => {
    const { matchedFields } = comparePassport(
      "PASSPORT N0. SX 987 6543 SHRESTHA 15081990",
      traveler,
    );
    expect(matchedFields).not.toContain("passportNumber");
  });

  it("matches the MRZ date form (DDMMYY) without separators", () => {
    const { matchedFields } = comparePassport(
      "PA1234567<<SHRESTHA<<ASHA<<<KUMARI 900815 7 010130",
      traveler,
    );
    expect(matchedFields).toContain("passportNumber");
    expect(matchedFields).toContain("surname");
    expect(matchedFields).toContain("dateOfBirth");
    expect(matchedFields).toContain("passportExpiryDate");
  });

  it("verifies a real low-resolution US passport whose MRZ number has a 0/O OCR mis-read", () => {
    const usTraveler: TravelerInput = {
      ...traveler,
      firstName: "Happy",
      surname: "Traveler",
      dateOfBirth: "1965-02-05",
      passportNumber: "E00007730",
      passportExpiryDate: "2030-10-14",
    };
    const ocr = [
      "UNITED STATES OF AMERICA",
      "Date of birth 05 FEB 1965",
      "Date of expiration 14 OCT 2030",
      "P<USATRAVELER<K<KHAPPY<<K<K<KKLKLKLKLKLKLKLLLLKLLLLLLKKLKLKKL",
      "EO00077303USA6502056F3010149500101920<091824",
    ].join("\n");
    const { matchedFields } = comparePassport(ocr, usTraveler);
    expect(matchedFields).toContain("passportNumber");
    expect(matchedFields).toContain("surname");
    expect(matchedFields).toContain("dateOfBirth");
    expect(matchedFields).toContain("passportExpiryDate");
    expect(verdictFor(matchedFields)).toBe("VERIFIED");
  });
});

describe("imageDimensions", () => {
  it("reads PNG dimensions from the IHDR header", () => {
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(480, 20);
    expect(imageDimensions(png)).toEqual({ width: 640, height: 480 });
  });

  it("returns null for buffers it cannot parse", () => {
    expect(imageDimensions(Buffer.from("not an image"))).toBeNull();
    expect(imageDimensions(Buffer.alloc(0))).toBeNull();
  });
});

describe("verdictFor", () => {
  it("verifies when the passport number and another field match", () => {
    expect(verdictFor(["passportNumber", "surname"])).toBe("VERIFIED");
  });
  it("is partial when only the passport number matches", () => {
    expect(verdictFor(["passportNumber"])).toBe("PARTIAL");
  });
  it("is partial when a name plus the date of birth match but the number is unreadable", () => {
    expect(verdictFor(["surname", "givenNames", "dateOfBirth"])).toBe(
      "PARTIAL",
    );
    expect(verdictFor(["givenNames", "dateOfBirth"])).toBe("PARTIAL");
  });
  it("fails when no strong identity pair matches", () => {
    expect(verdictFor(["surname"])).toBe("FAILED");
    expect(verdictFor(["surname", "givenNames"])).toBe("FAILED");
    expect(verdictFor([])).toBe("FAILED");
  });
});
