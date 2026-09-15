/** Uppercases and strips every non-alphanumeric character so OCR noise like
 *  spaces, dashes and slashes cannot break comparison. Defined locally to keep
 *  this module dependency-free (the service imports from here). */
const normalizeText = (value: string) =>
  value.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * ICAO 9303 machine-readable zone (TD3 passport) parser with check-digit
 * validation and single-character correction.
 *
 * The MRZ is the two 44-column lines printed at the bottom of every passport
 * information page. Unlike the human-readable zone above it, the MRZ uses the
 * OCR-B font (designed for machines) and every numeric field carries a check
 * digit computed with the ICAO weights 7-3-1. That check digit lets us not only
 * detect a mis-read character but, because the sum is linear, infer the correct
 * one — turning a single OCR error into a provably corrected value.
 */

export type MrzField = {
  /** Raw characters read from the MRZ (may contain an OCR error). */
  value: string;
  /** The stored check digit as printed (single character). */
  checkDigit: string;
  /** True when the stored check digit validates the raw value. */
  valid: boolean;
  /** Every single-homoglyph correction whose check digit validates. */
  corrections?: string[];
};

export type ParsedMrz = {
  line1: string;
  line2: string;
  documentType: string;
  issuingCountry: string;
  surname: string;
  givenNames: string;
  passportNumber: MrzField;
  nationality: string;
  dateOfBirth: MrzField;
  sex: string;
  expiryDate: MrzField;
  personalNumber: string;
  /** True when every field that carries a check digit validates. */
  valid: boolean;
};

/** ICAO character values: A-Z -> 10..35, 0-9 -> 0..9, '<' -> 0. */
export const mrzCharValue = (char: string): number => {
  if (char === "<") return 0;
  if (char >= "0" && char <= "9") return char.charCodeAt(0) - 48;
  if (char >= "A" && char <= "Z") return char.charCodeAt(0) - 55;
  return 0;
};

/** Check digit for an ICAO 9303 field using the repeating 7-3-1 weights. */
export const mrzCheckDigit = (field: string): number => {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < field.length; i += 1) {
    const char = field[i];
    const weight = weights[i % 3];
    if (char !== undefined && weight !== undefined)
      sum += mrzCharValue(char) * weight;
  }
  return sum % 10;
};

const MRZ_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<";

/** Converts an MRZ YYMMDD field to an ISO YYYY-MM-DD date (0-50 -> 20xx). */
export const mrzDateToIso = (value: string): string | null => {
  if (!/^\d{6}$/.test(value)) return null;
  const year = Number(value.slice(0, 2));
  const yy = year <= 50 ? 2000 + year : 1900 + year;
  const month = value.slice(2, 4);
  const day = value.slice(4, 6);
  if (Number(month) < 1 || Number(month) > 12) return null;
  if (Number(day) < 1 || Number(day) > 31) return null;
  return `${yy}-${month}-${day}`;
};

/** Returns every single-homoglyph substitution (e.g. O->0) that makes the
 *  field's check digit validate. The raw value and each returned candidate are
 *  all plausible readings; the caller picks among them using the value it
 *  expects (the traveller-entered passport number). */
export const correctMrzField = (
  value: string,
  checkDigit: string,
): string[] => {
  if (value.length < 2 || !/^\d$/.test(checkDigit)) return [];
  const target = Number(checkDigit);
  const candidates = new Set<string>();
  for (let i = 0; i < value.length; i += 1) {
    const original = value[i];
    if (original === undefined) continue;
    const lookalike =
      CONFUSABLES[original] ??
      Object.keys(CONFUSABLES).find((k) => CONFUSABLES[k] === original);
    if (!lookalike) continue;
    const trial = value.slice(0, i) + lookalike + value.slice(i + 1);
    if (mrzCheckDigit(trial) === target) candidates.add(trial);
  }
  return [...candidates];
};

const isMrzLine = (line: string) =>
  line.length === 44 && /^[A-Z0-9<]+$/.test(line);

/** Tries every strategy that can prove a name line is TD3 line 1 so the names
 *  survive even when OCR tears it. Line 2 is anchored by its check-digit
 *  fields, so the zones above it are free to be imperfect. */
const recoverLine1 = (zone: string[]): string | undefined => {
  const embeddedMrzAnchor = /P<[A-Z0-9]{3}[A-Z0-9<]{2,}<</;

  const fromText = (text: string): string | undefined => {
    if (isMrzLine(text)) return text;
    const embedded = text.match(embeddedMrzAnchor);
    if (embedded) {
      const start = embedded.index ?? 0;
      return text.slice(start, start + 44).padEnd(44, "<");
    }
    // OCR commonly drops a few trailing '<' fillers from line 1 even when its
    // name zone is readable, and the second-pass rectangle sometimes crops the
    // top of the line. Recover only an unmistakable TD3 passport line.
    const short = text.replace(/<+$/g, "");
    if (
      short.length >= 12 &&
      /^P[A-Z0-9<]/.test(short) &&
      short.includes("<<")
    )
      return short.padEnd(44, "<");
    return undefined;
  };

  for (const line of zone) {
    const recovered = fromText(line);
    if (recovered) return recovered;
  }
  // When Tesseract splits one line 1 across two text lines neither fragment
  // matches alone (e.g. "P<UTOERIKSSON" + "<<ANNA<MARIA<..."). A name polluted
  // by one stray voxel is still far better than a missing one: comparison uses
  // edit-distance tolerance and would route a bad name to review, not to a
  // false VERIFIED.
  return fromText(zone.join(""));
};

/** The TD3 line 2 is the one that carries the check digits we can validate.
 *  It is far more reliable than line 1, which OCR often mangles (the name
 *  zone's '<' filler gets read as stray letters). Returns the line 2 raw text
 *  plus a recovered line 1 when one exists anywhere in the lines above. */
export const extractMrz = (
  ocrText: string,
): { line1?: string; line2: string } | null => {
  const lines = ocrText
    .split(/\r?\n/)
    .map((line) => line.toUpperCase().replace(/[^A-Z0-9<]/g, ""))
    .filter(Boolean);
  const index = lines.findIndex(
    (line) => isMrzLine(line) && line[9] !== undefined && /^\d$/.test(line[9]),
  );
  if (index < 0) return null;
  const line2 = lines[index] as string;
  const line1 = recoverLine1(lines.slice(Math.max(0, index - 3), index));
  return { ...(line1 ? { line1 } : {}), line2 };
};

/** Parses a TD3 passport MRZ. Returns null when no line 2 is present. Names
 *  come from line 1 when available; everything else is read from line 2. */
export const parseMrz = (ocrText: string): ParsedMrz | null => {
  const extracted = extractMrz(ocrText);
  if (!extracted) return null;
  const { line1, line2 } = extracted;
  if (line2.length !== 44) return null;

  const field = (
    start: number,
    length: number,
    checkDigitAt?: number,
  ): MrzField => {
    const value = line2.slice(start - 1, start - 1 + length);
    const checkDigitRaw =
      checkDigitAt !== undefined ? line2[checkDigitAt - 1] : undefined;
    const checkDigit =
      checkDigitRaw !== undefined && /^\d$/.test(checkDigitRaw)
        ? checkDigitRaw
        : "";
    const rawValid =
      checkDigit !== "" && mrzCheckDigit(value) === Number(checkDigit);
    const corrections = rawValid
      ? undefined
      : correctMrzField(value, checkDigit);
    return {
      value,
      checkDigit,
      valid: rawValid,
      ...(corrections && corrections.length ? { corrections } : {}),
    };
  };

  const splitName = (zone: string): { surname: string; givenNames: string } => {
    const separator = zone.indexOf("<<");
    if (separator < 0)
      return { surname: zone.replace(/<+$/g, "").trim(), givenNames: "" };
    // ICAO fillers between name components stand for spaces; trailing fillers
    // are padding only.
    const clean = (value: string) => value.replace(/<+/g, " ").trim();
    return {
      surname: clean(zone.slice(0, separator)),
      givenNames: clean(zone.slice(separator + 2)),
    };
  };

  const documentType = line1 ? line1.slice(0, 2) : line2.slice(0, 2);
  const passportNumber = field(1, 9, 10);
  const dateOfBirth = field(14, 6, 20);
  const expiryDate = field(22, 6, 28);
  // ICAO 9303 part 4 section 4.3.2: the TD3 composite check digit in position
  // 44 validates ONLY positions 1-10, 14-20 and 22-43 — nationality (11-13)
  // and sex (21) are excluded. Concatenating those three runs keeps the 7-3-1
  // weighting continuous across the joins.
  const compositeSource =
    line2.slice(0, 10) + line2.slice(13, 20) + line2.slice(21, 43);
  const compositeValid =
    line2[43] !== undefined &&
    /^\d$/.test(line2[43]) &&
    mrzCheckDigit(compositeSource) === Number(line2[43]);

  return {
    line1: line1 ?? "",
    line2,
    documentType,
    issuingCountry: line1 ? line1.slice(2, 5) : line2.slice(11, 14),
    ...(line1 ? splitName(line1.slice(5)) : { surname: "", givenNames: "" }),
    passportNumber,
    nationality: line2.slice(10, 13),
    dateOfBirth,
    sex: line2[20] ?? "",
    expiryDate,
    personalNumber: line2.slice(28, 42).replace(/</g, ""),
    valid:
      compositeValid &&
      passportNumber.valid &&
      dateOfBirth.valid &&
      expiryDate.valid,
  };
};

/** Confusable characters Tesseract commonly swaps on low-resolution scans.
 *  Maps both the OCR text and the entered value to one canonical form before
 *  comparison, so a single glyph mis-read no longer breaks the match. */
export const CONFUSABLES: Record<string, string> = {
  O: "0",
  I: "1",
  S: "5",
  B: "8",
  Z: "2",
};

export const confusableNormalize = (value: string) =>
  normalizeText(value)
    .split("")
    .map((char) => CONFUSABLES[char] ?? char)
    .join("");

/** Levenshtein distance; used as a tolerance for a single OCR character error
 *  after confusable normalization. */
export const editDistance = (a: string, b: string): number => {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = new Array<number>(cols).fill(0).map((_, i) => i);
  for (let i = 1; i < rows; i += 1) {
    const curr = new Array<number>(cols).fill(0);
    curr[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const delAbove = prev[j];
      const insLeft = curr[j - 1];
      const subDiag = prev[j - 1];
      const del = delAbove === undefined ? Infinity : delAbove + 1;
      const ins = insLeft === undefined ? Infinity : insLeft + 1;
      const sub = subDiag === undefined ? Infinity : subDiag + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    prev = curr;
  }
  return prev[cols - 1] ?? 0;
};
