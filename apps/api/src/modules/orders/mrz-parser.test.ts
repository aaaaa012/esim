import { describe, expect, it } from "vitest";
import {
  confusableNormalize,
  correctMrzField,
  editDistance,
  mrzCheckDigit,
  mrzDateToIso,
  parseMrz,
} from "./mrz-parser.js";

const US_MRZ = [
  "P<USATRAVELER<<HAPPY<<<<<<<<<<<<<<<<<<<<<<<<",
  "EO00077303USA6502056F3010149500101920<091824",
].join("\n");

describe("mrzCheckDigit", () => {
  it("computes the ICAO 7-3-1 weighted check digit", () => {
    // E00007730 -> 14*7 + 0*3 + 0*1 + 0*7 + 0*3 + 7*1 + 7*7 + 3*3 + 0*1 = 163 -> 3
    expect(mrzCheckDigit("E00007730")).toBe(3);
    // A12 -> 10*7 + 1*3 + 2*1 = 75 -> 5
    expect(mrzCheckDigit("A12")).toBe(5);
  });
});

describe("correctMrzField", () => {
  it("recovers the true value when a single character is mis-read", () => {
    // OCR read O for 0 at position 1; the check digit proves the correct value.
    expect(correctMrzField("EO0007730", "3")).toContain("E00007730");
  });
  it("returns an empty array when the field already validates", () => {
    expect(correctMrzField("E00007730", "3")).toEqual([]);
  });
});

describe("mrzDateToIso", () => {
  it("maps YYMMDD to ISO with the 2000-2049 cutoff", () => {
    expect(mrzDateToIso("650205")).toBe("1965-02-05");
    expect(mrzDateToIso("301014")).toBe("2030-10-14");
    expect(mrzDateToIso("500101")).toBe("2050-01-01");
  });
  it("returns null for invalid input", () => {
    expect(mrzDateToIso("139999")).toBeNull();
    expect(mrzDateToIso("abc")).toBeNull();
  });
});

describe("parseMrz", () => {
  // The canonical ICAO 9303 part 4 example document (Eriksson, Anna Maria).
  const LINE1 = `P<UTOERIKSSON<<ANNA<MARIA${"<".repeat(19)}`;
  const LINE2 = [
    "L898902C3", // passport number
    "6", // its check digit
    "UTO", // nationality
    "740812", // date of birth
    "2", // dob check digit
    "F", // sex
    "120415", // date of expiry
    "9", // expiry check digit
    "<".repeat(14), // optional personal number (absent)
    "0", // personal number check digit
    "8", // composite check digit (published value)
  ].join("");

  it("fully validates the canonical ICAO 9303 sample, composite included", () => {
    const mrz = parseMrz(`${LINE1}\n${LINE2}`);
    expect(mrz).not.toBeNull();
    expect(mrz!.documentType).toBe("P<");
    expect(mrz!.issuingCountry).toBe("UTO");
    expect(mrz!.surname).toBe("ERIKSSON");
    expect(mrz!.givenNames).toBe("ANNA MARIA");
    expect(mrz!.nationality).toBe("UTO");
    expect(mrz!.sex).toBe("F");
    expect(mrz!.passportNumber.value).toBe("L898902C3");
    expect(mrz!.passportNumber.valid).toBe(true);
    expect(mrz!.dateOfBirth.valid).toBe(true);
    expect(mrzDateToIso(mrz!.dateOfBirth.value)).toBe("1974-08-12");
    expect(mrz!.expiryDate.valid).toBe(true);
    expect(mrzDateToIso(mrz!.expiryDate.value)).toBe("2012-04-15");
    expect(mrz!.valid).toBe(true);
  });

  it("excludes nationality and sex from the composite check digit per ICAO 9303 section 4.3.2", () => {
    // Changing the nationality does not affect the composite digit.
    const altered = LINE2.slice(0, 10) + "UTX" + LINE2.slice(13);
    const mrz = parseMrz(`${LINE1}\n${altered}`);
    expect(mrz).not.toBeNull();
    expect(mrz!.valid).toBe(true);
  });

  it("flags a corrupted date of birth and offers a check-digit correction", () => {
    // A homoglyph mis-read (0 -> O) is provably correctable via the check digit.
    const homoglyph = `${LINE2.slice(0, 15)}O${LINE2.slice(16)}`;
    const mrz = parseMrz(`${LINE1}\n${homoglyph}`);
    expect(mrz).not.toBeNull();
    expect(mrz!.dateOfBirth.valid).toBe(false);
    expect(mrz!.dateOfBirth.corrections).toContain("740812");
    expect(mrz!.valid).toBe(false);
    // A non-homoglyph mis-read (7 -> 0) is detected but not correctable.
    const arbitrary = `${LINE2.slice(0, 13)}0${LINE2.slice(14)}`;
    const mrz2 = parseMrz(`${LINE1}\n${arbitrary}`);
    expect(mrz2!.dateOfBirth.valid).toBe(false);
    expect(mrz2!.dateOfBirth.corrections?.length ?? 0).toBe(0);
  });

  it("parses a US passport MRZ and corrects the mis-read number via its check digit", () => {
    const mrz = parseMrz(US_MRZ);
    expect(mrz).not.toBeNull();
    expect(mrz!.issuingCountry).toBe("USA");
    expect(mrz!.surname).toBe("TRAVELER");
    expect(mrz!.givenNames).toContain("HAPPY");
    expect(mrz!.nationality).toBe("USA");
    expect(mrz!.sex).toBe("F");
    expect(mrz!.passportNumber.value).toBe("EO0007730");
    expect(mrz!.passportNumber.valid).toBe(false);
    expect(mrz!.passportNumber.corrections).toContain("E00007730");
    expect(mrzDateToIso(mrz!.dateOfBirth.value)).toBe("1965-02-05");
    expect(mrzDateToIso(mrz!.expiryDate.value)).toBe("2030-10-14");
  });

  it("returns null for non-passport or garbled input", () => {
    expect(parseMrz("not an MRZ at all, just some words")).toBeNull();
  });

  it("recovers names when OCR drops trailing fillers from passport line 1", () => {
    const shortenedLine1 = LINE1.replace(/<+$/g, "");
    const mrz = parseMrz(`${shortenedLine1}\n${LINE2}`);
    expect(mrz?.surname).toBe("ERIKSSON");
    expect(mrz?.givenNames).toBe("ANNA MARIA");
  });

  it("recovers names when a noise line sits between line 1 and line 2", () => {
    // OCR emitted a stray fragment between the name line and the numeric line.
    const mrz = parseMrz(`P<UTOERIKSSON<<ANNA<MARIA\nQ7\n${LINE2}`);
    expect(mrz?.surname).toBe("ERIKSSON");
    expect(mrz?.givenNames).toBe("ANNA MARIA");
  });

  it("recovers an embedded name line merged with the text above it", () => {
    // Full-page OCR glued the human-readable zone onto line 1; the name zone
    // is still present and the 'P<' anchor locates it.
    const merged = `OMAN SULTANATE P<UTOERIKSSON<<ANNA<MARIA${"<".repeat(30)}`;
    const mrz = parseMrz(`${merged}\n${LINE2}`);
    expect(mrz?.surname).toBe("ERIKSSON");
    expect(mrz?.givenNames).toBe("ANNA MARIA");
  });

  it("recovers names when Tesseract splits line 1 across two text lines", () => {
    const mrz = parseMrz(`P<UTOERIKSSON\n<<ANNA<MARIA${"<".repeat(26)}\n${LINE2}`);
    expect(mrz?.surname).toBe("ERIKSSON");
    expect(mrz?.givenNames).toBe("ANNA MARIA");
  });
});

describe("confusableNormalize", () => {
  it("maps O/I/S/B/Z to their digit lookalikes", () => {
    expect(confusableNormalize("EO00077303USA")).toBe("E000077303U5A");
  });
});

describe("editDistance", () => {
  it("counts single character differences", () => {
    expect(editDistance("E00007730", "EO0007730")).toBe(1);
    expect(editDistance("E00007730", "E00007730")).toBe(0);
    expect(editDistance("E00007730", "E00007730X")).toBe(1);
  });
});
