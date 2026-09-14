import { describe, expect, it } from "vitest";
import type { TravelerInput } from "@visa-compass/shared";
import {
  comparePassport,
  compareExtractedPassport,
  dateVariants,
  imageDimensions,
  normalizeText,
  verifyStoredExtraction,
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

describe("stored passport extraction comparison", () => {
  it("deterministically compares customer corrections without another OCR pass", () => {
    const evidence = {
      firstName: "ASHA",
      middleName: "KUMARI",
      surname: "SHRESTHA",
      dateOfBirth: "1990-08-15",
      nationality: "NP",
      passportNumber: "PA1234567",
      passportExpiryDate: "2030-01-01",
    };
    expect(compareExtractedPassport(evidence, traveler).matchedFields).toEqual(
      expect.arrayContaining([
        "passportNumber",
        "surname",
        "givenNames",
        "middleName",
        "dateOfBirth",
        "nationality",
        "passportExpiryDate",
      ]),
    );
    expect(verifyStoredExtraction(evidence, traveler, 91)).toMatchObject({
      status: "VERIFIED",
      method: "stored-extraction",
      confidence: 91,
    });
  });

  it("routes a corrected value that conflicts with stored evidence for review", () => {
    const result = verifyStoredExtraction(
      {
        firstName: "ASHA",
        surname: "SHRESTHA",
        dateOfBirth: "1990-08-15",
        nationality: "NP",
        passportNumber: "PA7654321",
        passportExpiryDate: "2030-01-01",
      },
      traveler,
    );
    expect(result.status).toBe("PARTIAL");
    expect(result.matchedFields).not.toContain("passportNumber");
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
    expect(matchedFields).toContain("givenNames");
    expect(matchedFields).toContain("middleName");
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

  it("does not accept a name that only appears outside the MRZ name zone", () => {
    // The MRZ name zone declares SHRESTHA / ASHA KUMARI, but "NEPAL" is on the
    // page (human-readable country/issuer text). Before the MRZ-first fix the
    // whole-page substring search let a traveller with a wrong name pass when
    // that word happened to appear anywhere in the OCR.
    const line1 = `P<NPLSHRESTHA<<ASHA<<<KUMARI`.padEnd(44, "<");
    const line2 = `PA12345677NPL9008150F30010100000000000000000`;
    expect(line1).toHaveLength(44);
    expect(line2).toHaveLength(44);
    const ocr = [
      "EMBASSY OF NEPAL",
      "PASSPORT",
      "No PA1234567",
      "Date of birth 15 AUG 1990",
      line1,
      line2,
    ].join("\n");
    const wrongName: TravelerInput = {
      ...traveler,
      surname: "Nepal",
      firstName: "Bharat",
      middleName: "Das",
      dateOfBirth: "1988-03-02",
      passportExpiryDate: "2032-05-06",
    };
    const { matchedFields } = comparePassport(ocr, wrongName);
    expect(matchedFields).not.toContain("surname");
    expect(matchedFields).not.toContain("givenNames");
    expect(verdictFor(matchedFields)).not.toBe("VERIFIED");
  });

  it("matches names against the MRZ name zone when it is readable", () => {
    const line1 = `P<NPLSHRESTHA<<ASHA<<<KUMARI`.padEnd(44, "<");
    const line2 = `PA12345677NPL9008150F30010100000000000000000`;
    const ocr = [
      "REPUBLIC OF NEPAL",
      "PASSPORT",
      "No PA1234567",
      "SHRI AShA KUMARI SHRESTHA",
      "Date of birth 15 AUG 1990",
      "EXPIRY 30/01/2030",
      line1,
      line2,
    ].join("\n");
    const { matchedFields } = comparePassport(ocr, traveler);
    expect(matchedFields).toContain("passportNumber");
    expect(matchedFields).toContain("surname");
    expect(matchedFields).toContain("givenNames");
    expect(matchedFields).toContain("middleName");
    expect(verdictFor(matchedFields)).toBe("VERIFIED");
  });

  it("rejects a first name that is only a substring of an MRZ word", () => {
    // "Shre" is a substring of the MRZ surname "SHRESTHA". The old whole-text
    // substring search treated that as a matching given name; the MRZ-first
    // logic must not.
    const line1 = `P<NPLSHRESTHA<<ASHA<<<KUMARI`.padEnd(44, "<");
    const line2 = `PA12345677NPL9008150F30010100000000000000000`;
    const ocr = [line1, line2].join("\n");
    const wrongName: TravelerInput = {
      ...traveler,
      firstName: "Shre",
    };
    const { matchedFields } = comparePassport(ocr, wrongName);
    expect(matchedFields).not.toContain("givenNames");
  });

  it("composes a multi-part MRZ surname from its zone", () => {
    const line1 = `P<NPLVAN<DER<BERG<<JOHN`.padEnd(44, "<");
    const line2 = `PJ12345672NPL8501010M31010100000000000000000`;
    expect(line1).toHaveLength(44);
    expect(line2).toHaveLength(44);
    const ocr = [line1, line2].join("\n");
    const multiPart: TravelerInput = {
      ...traveler,
      surname: "Van Der Berg",
      firstName: "John",
      middleName: "",
      dateOfBirth: "1985-01-01",
      passportNumber: "PJ1234567",
      nationality: "NP",
      passportExpiryDate: "2031-01-01",
    };
    const { matchedFields } = comparePassport(ocr, multiPart);
    expect(matchedFields).toContain("surname");
    expect(matchedFields).toContain("givenNames");
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
      nationality: "US",
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
    expect(matchedFields).toContain("nationality");
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
  it("does not treat nationality alone as corroborating identity evidence", () => {
    expect(verdictFor(["passportNumber", "nationality"])).toBe("PARTIAL");
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
