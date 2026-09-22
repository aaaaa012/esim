import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createWorker, PSM, type Worker } from "tesseract.js";
import sharp from "sharp";
import { DocumentType, type TravelerInput } from "@visa-compass/shared";
import {
  passportOcrMaxPages,
  S3StorageService,
} from "../../infrastructure/s3-storage.service.js";
import {
  confusableNormalize,
  editDistance,
  mrzDateToIso,
  parseMrz,
  type MrzField,
  type ParsedMrz,
} from "./mrz-parser.js";
import type { DemoOrder } from "./orders.service.js";
import { ISO3_TO_ISO2 } from "../integration/transatel.provider.js";

export type PassportVerificationStatus =
  "VERIFIED" | "PARTIAL" | "FAILED" | "NOT_READY" | "SKIPPED";
export type PassportField =
  | "passportNumber"
  | "surname"
  | "givenNames"
  | "middleName"
  | "nationality"
  | "dateOfBirth"
  | "passportExpiryDate";
export type PassportVerificationResult = {
  status: PassportVerificationStatus;
  matchedFields: PassportField[];
  confidence?: number;
  checkedAt: string;
  method:
    | "tesseract-ocr"
    | "stored-extraction"
    | "simulator"
    | "pdf-unreadable"
    | "ocr-error"
    | "policy";
  detail?: string;
  failureCode?: string;
  reasonCode?: "IDENTITY_FIELDS_MISMATCH" | "PASSPORT_EXPIRED";
  mismatchedFields?: Array<
    | "firstName"
    | "middleName"
    | "surname"
    | "dateOfBirth"
    | "nationality"
    | "passportNumber"
    | "passportExpiryDate"
  >;
};
export type PassportExtractedFields = Partial<
  Pick<
    TravelerInput,
    | "firstName"
    | "middleName"
    | "surname"
    | "dateOfBirth"
    | "passportNumber"
    | "passportExpiryDate"
    | "nationality"
  >
>;
export type PassportExtractionResult = {
  status: "READY" | "PARTIAL" | "MANUAL_ENTRY_REQUIRED" | "SKIPPED";
  fields: PassportExtractedFields;
  fieldsRequiringInput: Array<keyof PassportExtractedFields | "nationality">;
  confidence?: number;
  method: PassportVerificationResult["method"];
  checkedAt: string;
  failureCode?: string;
};

export type TravelTicketInspection = {
  status: "VALID" | "WRONG_DOCUMENT" | "UNREADABLE" | "TECHNICAL_FAILURE";
  detail: string;
};

/** Uppercases and strips every non-alphanumeric character so OCR noise like
 *  spaces, dashes and slashes cannot break exact-match comparison. */
export const normalizeText = (value: string) =>
  value.toUpperCase().replace(/[^A-Z0-9]/g, "");

const normalizeUnicode = (value?: string | null) =>
  (value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");

export const canonicalName = (value?: string | null) =>
  normalizeUnicode(value).toLocaleUpperCase("en-US");

export const canonicalPassportNumber = (value?: string | null) =>
  normalizeUnicode(value).replace(/\s+/gu, "").toLocaleUpperCase("en-US");

export const canonicalDate = (value?: string | null): string => {
  const input = normalizeUnicode(value);
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(input);
  if (match) {
    const year = match[1]!;
    const month = match[2]!;
    const day = match[3]!;
    const candidate = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    const parsed = new Date(`${candidate}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === candidate
      ? candidate
      : "";
  }
  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(input);
  if (!match) return "";
  const day = match[1]!;
  const month = match[2]!;
  const year = match[3]!;
  const candidate = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === candidate
    ? candidate
    : "";
};

export const canonicalNationality = (value?: string | null) => {
  const code = normalizeUnicode(value).toUpperCase();
  return code.length === 3 ? (ISO3_TO_ISO2[code] ?? code) : code;
};

export const canonicalIdentity = (traveler: PassportComparisonTraveler) => ({
  firstName: canonicalName(traveler.firstName),
  middleName: canonicalName(traveler.middleName),
  surname: canonicalName(traveler.surname),
  dateOfBirth: canonicalDate(traveler.dateOfBirth),
  nationality: canonicalNationality(traveler.nationality),
  passportNumber: canonicalPassportNumber(traveler.passportNumber),
  passportExpiryDate: canonicalDate(traveler.passportExpiryDate),
});

/** Tesseract routinely reads the OCR-B MRZ '<' fillers as a run of identical
 *  letters (L, I, or on noisier scans K or others). Such runs are never part
 *  of a real name, so split around them and drop whole filler tokens; real
 *  names with one or two repeated letters survive. */
export const cleanNameTokens = (tokens: string[]): string[] =>
  tokens
    .map((token) => token.replace(/([A-Z])\1{2,}/g, " ").trim())
    .filter(Boolean)
    .filter((token) => token.length < 2 || !/^([A-Z])\1+$/.test(token))
    .flatMap((token) => token.split(/\s+/));

/** Canonical form used for name comparison: strips OCR filler noise so strict
 *  equality still holds for genuinely matching names while a real mismatch
 *  keeps failing. */
export const normalizeName = (value: string) =>
  cleanNameTokens(value.split(/\s+/).filter(Boolean)).join(" ");

/** Re-applies OCR name cleanup when persisted extraction payloads are read.
 * This keeps historical filler noise out of every checkout channel without
 * changing the immutable OCR evidence stored for audit. */
export const sanitizePassportExtractedFields = (
  fields: PassportExtractedFields,
): PassportExtractedFields => {
  const sanitized = { ...fields };
  for (const field of ["firstName", "middleName", "surname"] as const) {
    const value = sanitized[field];
    if (!value) continue;
    const cleaned = normalizeName(value);
    if (cleaned) sanitized[field] = cleaned;
    else delete sanitized[field];
  }
  return sanitized;
};

const MONTHS: Record<string, string> = {
  JAN: "01",
  FEB: "02",
  MAR: "03",
  APR: "04",
  MAY: "05",
  JUN: "06",
  JUL: "07",
  AUG: "08",
  SEP: "09",
  OCT: "10",
  NOV: "11",
  DEC: "12",
};

/** Replaces written month names ("15 AUG 1990") with their numbers so OCR
 *  dates can be compared against the traveller form regardless of the format
 *  the passport prints them in. */
const monthNamesToNumbers = (value: string) =>
  value
    .toUpperCase()
    .replace(
      /\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/g,
      (month) => MONTHS[month] ?? month,
    );

/** Common ways the same calendar date appears on a passport: ISO digits,
 *  DDMMYYYY, the MRZ YYMMDD and DDMMYY forms. All returned without separators
 *  so they can be searched inside the normalized OCR text. */
export const dateVariants = (iso: string): string[] => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) return [];
  const [, y, m, d] = match;
  const yy = String(Number(y) % 100).padStart(2, "0");
  return [`${y}${m}${d}`, `${d}${m}${y}`, `${yy}${m}${d}`, `${d}${m}${yy}`];
};

export const comparePassport = (
  ocrText: string,
  traveler: TravelerInput,
): { matchedFields: PassportField[] } => {
  const text = normalizeText(ocrText);
  const textNumeric = normalizeText(monthNamesToNumbers(ocrText));
  const matchesAny = (candidate: string) =>
    text.includes(candidate) || textNumeric.includes(candidate);

  const mrz = parseMrz(ocrText);
  const mrzPassportNumber = mrz?.passportNumber;
  const mrzNumberCandidates = mrzPassportNumber
    ? [mrzPassportNumber.value, ...(mrzPassportNumber.corrections ?? [])]
    : [];

  // A name on a passport only counts when it is really the traveller's name,
  // so the machine-readable zone is authoritative whenever it can be read.
  // Falling back to raw substring search over the whole page lets unrelated
  // OCR words (cities, issuing authority, addresses) satisfy a name and is the
  // source of the "any name is accepted" false positives. The MRZ name zone
  // also carries the canonical spelling, so comparisons use its components.
  const rawTokens = new Set<string>();
  for (const token of ocrText.toUpperCase().split(/[^A-Z0-9]+/)) {
    if (token) rawTokens.add(confusableNormalize(token));
  }
  const hasMrzNameZone = Boolean(mrz && (mrz.surname || mrz.givenNames));
  const mrzNameTokens = (zone: string) => {
    if (!zone) return new Set<string>();
    const tokens = new Set<string>();
    // The zone is space-separated (the parser replaced '<' filler with spaces),
    // so tokenize first and confusable-normalize each component afterwards.
    for (const token of zone.toUpperCase().split(/[^A-Z0-9]+/)) {
      if (token) tokens.add(confusableNormalize(token));
    }
    return tokens;
  };
  const mrzSurnameTokens = mrzNameTokens(mrz?.surname ?? "");
  const mrzGivenTokens = mrzNameTokens(mrz?.givenNames ?? "");
  // OCR frequently drops the '<' after the issuing country code and glues it
  // to the surname (e.g. "USATRAVELER"). Recover that form by splitting the
  // token at the nationality code, so the name still counts only when it sits
  // against a recognised MRZ component instead of anywhere in the page.
  const matchesNationalityGlue = (candidate: string) => {
    if (!mrz?.nationality || !candidate) return false;
    const code = confusableNormalize(mrz.nationality);
    if (!code) return false;
    const prefixForm = code + candidate;
    const suffixForm = candidate + code;
    return rawTokens.has(prefixForm) || rawTokens.has(suffixForm);
  };
  const matchesMrzNameZone = (
    candidate: string,
    zoneTokens: Set<string>,
    zone: string,
  ) => {
    const normalized = confusableNormalize(candidate);
    if (!normalized) return false;
    return (
      zoneTokens.has(normalized) || confusableNormalize(zone) === normalized
    );
  };
  const matchesName = (
    candidate: string,
    zoneTokens: Set<string>,
    zone: string,
    allowGlue = true,
  ) => {
    const normalized = confusableNormalize(candidate);
    if (!normalized) return false;
    // A readable MRZ name zone is the only acceptable source. The whole-page
    // token search below is only for passports whose MRZ name zone could not
    // be OCR'd, so unrelated words can never satisfy a name when the zone is
    // available.
    if (hasMrzNameZone) return matchesMrzNameZone(candidate, zoneTokens, zone);
    if (rawTokens.has(normalized)) return true;
    return allowGlue && matchesNationalityGlue(normalized);
  };

  const matchesPassportNumber = (candidate: string) => {
    const normalized = normalizeText(candidate);
    if (!normalized) return false;
    // MRZ-first: a check-digit-validated passport number is authoritative, and
    // a mis-read field is corrected by choosing the candidate that matches the
    // entered number (the check digit guarantees only that *some* reading was
    // printed; the entered value picks which one).
    if (
      mrzNumberCandidates.some(
        (mrzNumber) =>
          confusableNormalize(mrzNumber) === confusableNormalize(normalized),
      )
    )
      return true;
    // No usable MRZ: fall back to a confusable + single-character-tolerant
    // search across the whole OCR text.
    if (matchesAny(confusableNormalize(normalized))) return true;
    const fuzzy = confusableNormalize(text);
    return (
      fuzzy.includes(confusableNormalize(normalized)) ||
      normalized.split("").every((char, i) => {
        const window = fuzzy.slice(i, i + normalized.length);
        return window && editDistance(window, normalized) <= 1;
      })
    );
  };

  const matchedFields: PassportField[] = [];
  if (
    normalizeText(traveler.passportNumber) &&
    matchesPassportNumber(traveler.passportNumber)
  )
    matchedFields.push("passportNumber");
  if (
    traveler.surname &&
    matchesName(traveler.surname, mrzSurnameTokens, mrz?.surname ?? "")
  )
    matchedFields.push("surname");
  // The first name is the stable identity signal. An optional middle name must
  // not make the entire given-name comparison fail when OCR omits or joins it.
  if (
    traveler.firstName &&
    matchesName(traveler.firstName, mrzGivenTokens, mrz?.givenNames ?? "")
  )
    matchedFields.push("givenNames");
  if (
    traveler.middleName?.trim() &&
    matchesName(
      traveler.middleName,
      mrzGivenTokens,
      mrz?.givenNames ?? "",
      false,
    )
  )
    matchedFields.push("middleName");
  const mrzNationality = mrz?.nationality
    ? ISO3_TO_ISO2[mrz.nationality.toUpperCase()]
    : undefined;
  if (
    mrzNationality &&
    mrzNationality === traveler.nationality.trim().toUpperCase()
  )
    matchedFields.push("nationality");
  if (dateVariants(traveler.dateOfBirth).some((variant) => matchesAny(variant)))
    matchedFields.push("dateOfBirth");
  if (
    dateVariants(traveler.passportExpiryDate).some((variant) =>
      matchesAny(variant),
    )
  )
    matchedFields.push("passportExpiryDate");
  return { matchedFields };
};
type PassportComparisonTraveler = Pick<
  TravelerInput,
  | "firstName"
  | "middleName"
  | "surname"
  | "dateOfBirth"
  | "nationality"
  | "passportNumber"
  | "passportExpiryDate"
>;

export const compareExtractedPassport = (
  fields: PassportExtractedFields,
  traveler: PassportComparisonTraveler,
): { matchedFields: PassportField[] } => {
  const matchedFields: PassportField[] = [];
  const sameName = (left?: string, right?: string) =>
    Boolean(left && right && canonicalName(left) === canonicalName(right));
  if (
    fields.passportNumber &&
    traveler.passportNumber &&
    canonicalPassportNumber(fields.passportNumber) ===
      canonicalPassportNumber(traveler.passportNumber)
  )
    matchedFields.push("passportNumber");
  if (sameName(fields.surname, traveler.surname)) matchedFields.push("surname");
  if (sameName(fields.firstName, traveler.firstName))
    matchedFields.push("givenNames");
  // Middle names are optional. Record positive evidence when both sides carry
  // one, without weakening an otherwise valid passport when either omits it.
  if (sameName(fields.middleName, traveler.middleName))
    matchedFields.push("middleName");
  if (
    canonicalDate(fields.dateOfBirth) &&
    canonicalDate(fields.dateOfBirth) === canonicalDate(traveler.dateOfBirth)
  )
    matchedFields.push("dateOfBirth");
  if (
    canonicalDate(fields.passportExpiryDate) &&
    canonicalDate(fields.passportExpiryDate) ===
      canonicalDate(traveler.passportExpiryDate)
  )
    matchedFields.push("passportExpiryDate");
  if (
    canonicalNationality(fields.nationality) &&
    canonicalNationality(fields.nationality) ===
      canonicalNationality(traveler.nationality)
  )
    matchedFields.push("nationality");
  return { matchedFields };
};

const requiredComparisonFields: Array<{
  passport: PassportField;
  traveler: NonNullable<PassportVerificationResult["mismatchedFields"]>[number];
}> = [
  { passport: "passportNumber", traveler: "passportNumber" },
  { passport: "surname", traveler: "surname" },
  { passport: "givenNames", traveler: "firstName" },
  { passport: "dateOfBirth", traveler: "dateOfBirth" },
  { passport: "passportExpiryDate", traveler: "passportExpiryDate" },
  { passport: "nationality", traveler: "nationality" },
];

export const mismatchedIdentityFields = (
  fields: PassportExtractedFields,
  traveler: PassportComparisonTraveler,
  matchedFields: PassportField[],
) => {
  const hasExtractedEvidence: Record<PassportField, boolean> = {
    passportNumber: Boolean(canonicalPassportNumber(fields.passportNumber)),
    surname: Boolean(canonicalName(fields.surname)),
    givenNames: Boolean(canonicalName(fields.firstName)),
    middleName: Boolean(canonicalName(fields.middleName)),
    dateOfBirth: Boolean(canonicalDate(fields.dateOfBirth)),
    passportExpiryDate: Boolean(canonicalDate(fields.passportExpiryDate)),
    nationality: Boolean(canonicalNationality(fields.nationality)),
  };
  const mismatches = requiredComparisonFields
    .filter(
      ({ passport }) =>
        hasExtractedEvidence[passport] && !matchedFields.includes(passport),
    )
    .map(({ traveler: field }) => field);
  if (
    canonicalName(fields.middleName) &&
    canonicalName(traveler.middleName) &&
    !matchedFields.includes("middleName")
  )
    mismatches.push("middleName");
  return mismatches;
};

export const passportComparisonDiagnostics = (
  fields: PassportExtractedFields,
  traveler: PassportComparisonTraveler,
  matchedFields: PassportField[],
) => {
  const checks = [
    ["firstName", fields.firstName, traveler.firstName, canonicalName, "givenNames"],
    ["middleName", fields.middleName, traveler.middleName, canonicalName, "middleName"],
    ["surname", fields.surname, traveler.surname, canonicalName, "surname"],
    ["dateOfBirth", fields.dateOfBirth, traveler.dateOfBirth, canonicalDate, "dateOfBirth"],
    ["nationality", fields.nationality, traveler.nationality, canonicalNationality, "nationality"],
    ["passportNumber", fields.passportNumber, traveler.passportNumber, canonicalPassportNumber, "passportNumber"],
    ["passportExpiryDate", fields.passportExpiryDate, traveler.passportExpiryDate, canonicalDate, "passportExpiryDate"],
  ] as const;
  return checks.map(([field, extracted, submitted, normalize, matchField]) => {
    const extractedText = extracted ?? "";
    const submittedText = submitted ?? "";
    return {
      field,
      source: "stored-extraction",
      extractionNormalizationChanged: normalize(extractedText) !== extractedText,
      submittedNormalizationChanged: normalize(submittedText) !== submittedText,
      matched: matchedFields.includes(matchField),
      checksumSupported: null,
    };
  });
};

export const verifyStoredExtraction = (
  fields: PassportExtractedFields,
  traveler: PassportComparisonTraveler,
  confidence?: number | null,
): PassportVerificationResult => {
  const { matchedFields } = compareExtractedPassport(fields, traveler);
  const mismatchedFields = mismatchedIdentityFields(
    fields,
    traveler,
    matchedFields,
  );
  if (isPassportExpired(fields.passportExpiryDate))
    return {
      status: "FAILED",
      matchedFields,
      ...(confidence != null ? { confidence } : {}),
      checkedAt: new Date().toISOString(),
      method: "stored-extraction",
      detail: "The uploaded passport has expired",
      failureCode: "PASSPORT_EXPIRED",
      reasonCode: "PASSPORT_EXPIRED",
      mismatchedFields,
    };
  const nationalityEvidence = Boolean(
    canonicalNationality(fields.nationality),
  );
  const validSubmittedNationality = Boolean(
    canonicalNationality(traveler.nationality),
  );
  const coreIdentityMatched = [
    "passportNumber",
    "surname",
    "givenNames",
    "dateOfBirth",
    "passportExpiryDate",
  ].every((field) => matchedFields.includes(field as PassportField));
  // Nationality remains required customer data. When OCR did not extract it,
  // validate the submitted ISO value but do not invent a passport mismatch.
  // If the passport did provide nationality evidence, the values must match.
  const structuralVerdict =
    !nationalityEvidence && validSubmittedNationality && coreIdentityMatched
      ? "VERIFIED"
      : verdictFor(matchedFields);
  const mandatoryMismatches = mismatchedFields.filter(
    (field) => field !== "middleName",
  );
  return {
    status:
      mandatoryMismatches.length === 0
        ? structuralVerdict
        : structuralVerdict === "VERIFIED"
          ? "PARTIAL"
          : structuralVerdict,
    matchedFields,
    ...(confidence != null ? { confidence } : {}),
    checkedAt: new Date().toISOString(),
    method: "stored-extraction",
    ...(mismatchedFields.length
      ? { reasonCode: "IDENTITY_FIELDS_MISMATCH" as const, mismatchedFields }
      : {}),
  };
};

export const isPassportExpired = (expiry?: string): boolean => {
  if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return false;
  return expiry < new Date().toISOString().slice(0, 10);
};

/** Automated approval requires every mandatory identity value extracted from
 * the passport MRZ to agree with the traveller submission. Missing or
 * conflicting evidence remains reviewable, but it is never called verified. */
export const verdictFor = (
  matchedFields: PassportField[],
): PassportVerificationStatus => {
  const mandatory: PassportField[] = [
    "passportNumber",
    "surname",
    "givenNames",
    "dateOfBirth",
    "passportExpiryDate",
    "nationality",
  ];
  if (mandatory.every((field) => matchedFields.includes(field)))
    return "VERIFIED";
  if (matchedFields.includes("passportNumber")) return "PARTIAL";
  const nameMatch =
    matchedFields.includes("surname") || matchedFields.includes("givenNames");
  const strongIdentityPair =
    nameMatch &&
    (matchedFields.includes("passportNumber") ||
      matchedFields.includes("dateOfBirth"));
  return strongIdentityPair ? "PARTIAL" : "FAILED";
};

/** Reads JPEG (SOF marker) or PNG (IHDR) pixel dimensions without pulling in
 *  an image dependency; used to aim the MRZ second pass at the bottom band of
 *  the document photo. Returns null for anything it cannot parse. */
export const imageDimensions = (
  bytes: Buffer,
): { width: number; height: number } | null => {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47)
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      if (
        marker !== undefined &&
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      )
        return {
          height: bytes.readUInt16BE(offset + 5),
          width: bytes.readUInt16BE(offset + 7),
        };
      const length = bytes.readUInt16BE(offset + 2);
      if (!length) return null;
      offset += 2 + length;
    }
  }
  return null;
};

export const looksLikePassport = (text: string): boolean => {
  const normalized = text.toUpperCase();
  return (
    /\bPASSPORT\b/.test(normalized) ||
    /P<[A-Z0-9<]{3}/.test(normalized.replace(/\s+/g, ""))
  );
};

/** Higher scores represent MRZ evidence that is structurally stronger. The
 * fully validated composite checksum dominates every partial candidate. */
export const mrzCandidateScore = (mrz: ParsedMrz | null): number => {
  if (!mrz) return 0;
  let score = mrz.valid ? 100 : 10;
  for (const field of [mrz.passportNumber, mrz.dateOfBirth, mrz.expiryDate]) {
    if (field.valid) score += 12;
    else if (field.corrections?.length === 1) score += 6;
  }
  if (mrz.surname) score += 5;
  if (mrz.givenNames) score += 5;
  return score;
};

/**
 * Server-side passport verification used to gate checkout before payment.
 *
 * Documents are auto-approved after payment today, so a mismatch between the
 * traveller form and the uploaded passport would otherwise never be caught.
 * This service downloads the uploaded passport (rasterizing PDFs to their
 * first page from S3), runs Tesseract OCR, and compares the extracted
 * text against the traveller details. The passport number is the primary
 * signal; the order only reaches "VERIFIED" when at least one more field
 * (name, date of birth or expiry) also matches.
 *
 * Uses a single reused worker (the recommended usage pattern). Concurrent
 * callers share one initialisation promise, so the worker is created once and
 * reused until the module is destroyed.
 */
@Injectable()
export class PassportVerificationService implements OnModuleDestroy {
  private readonly logger = new Logger(PassportVerificationService.name);
  private worker: Worker | null = null;
  private workerPromise: Promise<Worker> | null = null;
  private recognizing = false;
  private readonly language = process.env.TESSERACT_LANG ?? "eng";
  private readonly timeoutMs = Number(
    process.env.PASSPORT_OCR_TIMEOUT_MS ?? 30_000,
  );
  /** Fraction of the image height re-OCR'd when hunting for the MRZ band.
   *  Generous enough to keep TD3 line 1 (which sits at the top of the MRZ)
   *  inside the crop even on tilted or loosely framed passport photos; the
   *  whitelisted alphabet keeps stray edges from polluting the read. */
  private static readonly MRZ_BAND_RATIOS = [0.5, 0.35] as const;
  /** ICAO MRZ alphabet; also used as the second-pass Tesseract whitelist. */
  private static readonly MRZ_ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<";
  private static readonly RECOVERY_ROTATIONS = [0, 90, 180, 270] as const;
  private static readonly RECOVERY_BAND_RATIOS = [0.28, 0.42] as const;

  constructor(private readonly storage: S3StorageService) {}

  async extract(order: DemoOrder): Promise<PassportExtractionResult> {
    const checkedAt = new Date().toISOString();
    const required: PassportExtractionResult["fieldsRequiringInput"] = [
      "firstName",
      "surname",
      "dateOfBirth",
      "passportNumber",
      "passportExpiryDate",
      "nationality",
    ];
    const passport = order.documents.find(
      (document) =>
        document.type === DocumentType.PASSPORT && document.uploadVerified,
    );
    if (!passport)
      return {
        status: "MANUAL_ENTRY_REQUIRED",
        fields: {},
        fieldsRequiringInput: required,
        method: "ocr-error",
        checkedAt,
        failureCode: "PASSPORT_NOT_READY",
      };
    if (!this.storage.isConfigured())
      return {
        status: "SKIPPED",
        fields: {},
        fieldsRequiringInput: required,
        method: "simulator",
        checkedAt,
        failureCode: "OCR_SIMULATOR",
      };
    try {
      const recognized = await this.recognizePassportDocument(
        passport.privateAssetId,
      );
      // The band pass runs with the MRZ alphabet whitelisted, so when Tesseract
      // managed to read both MRZ lines in the crop, its name zone is trusted
      // over the unfiltered full-page copy.
      const parsedBand = recognized.bandText
        ? parseMrz(recognized.bandText)
        : null;
      const parsedFull = parseMrz(recognized.text);
      const mrz =
        parsedBand &&
        parsedBand.passportNumber.value &&
        (parsedBand.surname || parsedBand.givenNames)
          ? parsedBand
          : parsedFull;
      if (!mrz)
        return {
          status: "MANUAL_ENTRY_REQUIRED",
          fields: {},
          fieldsRequiringInput: required,
          ...(recognized.confidence !== undefined
            ? { confidence: recognized.confidence }
            : {}),
          method: "tesseract-ocr",
          checkedAt,
          failureCode: looksLikePassport(recognized.text)
            ? "MRZ_REVIEW_REQUIRED"
            : "PASSPORT_BIODATA_NOT_DETECTED",
        };

      const fieldValue = (field: MrzField) =>
        field.valid
          ? field.value
          : field.corrections?.length === 1
            ? field.corrections[0]
            : undefined;
      const cleanNames = cleanNameTokens(
        mrz.givenNames.split(/\s+/).filter(Boolean),
      );
      const [firstName, ...rest] = cleanNames;
      const middleName = rest.length ? rest.join(" ") : undefined;
      const surname = cleanNameTokens(
        mrz.surname.split(/\s+/).filter(Boolean),
      )[0];
      const passportNumber = fieldValue(mrz.passportNumber)?.replace(
        /<+$/g,
        "",
      );
      const dateOfBirthRaw = fieldValue(mrz.dateOfBirth);
      const expiryRaw = fieldValue(mrz.expiryDate);
      const nationality = ISO3_TO_ISO2[mrz.nationality.toUpperCase()];
      const fields = sanitizePassportExtractedFields({
        ...(firstName ? { firstName } : {}),
        ...(middleName ? { middleName } : {}),
        ...(surname ? { surname } : {}),
        ...(dateOfBirthRaw && mrzDateToIso(dateOfBirthRaw)
          ? { dateOfBirth: mrzDateToIso(dateOfBirthRaw)! }
          : {}),
        ...(passportNumber ? { passportNumber } : {}),
        ...(expiryRaw && mrzDateToIso(expiryRaw)
          ? { passportExpiryDate: mrzDateToIso(expiryRaw)! }
          : {}),
        ...(nationality ? { nationality } : {}),
      });
      const fieldsRequiringInput = required.filter((field) => !fields[field]);
      if (isPassportExpired(fields.passportExpiryDate))
        return {
          status: "MANUAL_ENTRY_REQUIRED",
          fields,
          fieldsRequiringInput,
          ...(recognized.confidence !== undefined
            ? { confidence: recognized.confidence }
            : {}),
          method: "tesseract-ocr",
          checkedAt,
          failureCode: "PASSPORT_EXPIRED",
        };
      return {
        status: fieldsRequiringInput.length === 0 ? "READY" : "PARTIAL",
        fields,
        fieldsRequiringInput,
        ...(recognized.confidence !== undefined
          ? { confidence: recognized.confidence }
          : {}),
        method: "tesseract-ocr",
        checkedAt,
      };
    } catch (error) {
      this.logger.error(
        `Passport extraction failed for order ${order.id}: ${error instanceof Error ? error.message : "unknown"}`,
      );
      return {
        status: "MANUAL_ENTRY_REQUIRED",
        fields: {},
        fieldsRequiringInput: required,
        method: "ocr-error",
        checkedAt,
        failureCode: "OCR_UNAVAILABLE",
      };
    }
  }

  async inspectTravelTicket(
    privateAssetId: string,
  ): Promise<TravelTicketInspection> {
    if (!this.storage.isConfigured())
      return {
        status: "VALID",
        detail: "Document validation is disabled in this environment",
      };
    try {
      const image = await this.storage.downloadDocumentImage(privateAssetId);
      const recognized = await this.recognize(image.bytes);
      if (parseMrz(recognized.text))
        return {
          status: "WRONG_DOCUMENT",
          detail: "The travel-ticket upload appears to be a passport",
        };
      const text = recognized.text.toUpperCase();
      const strongSignal =
        /\b(E-?TICKET|BOARDING\s*PASS|FLIGHT\s+ITINERARY|ITINERARY\s+RECEIPT|AIRLINE\s+TICKET)\b/.test(
          text,
        );
      const supportingSignals = [
        /\b(FLIGHT|AIRLINE|BOOKING|RESERVATION|PNR)\b/,
        /\b(PASSENGER|TRAVELL?ER)\b/,
        /\b(DEPARTURE|ARRIVAL|BOARDING|GATE)\b/,
        /\b[A-Z]{2}\s?\d{2,4}\b/,
        /\b[A-Z]{3}\s*(?:-|TO|>)\s*[A-Z]{3}\b/,
      ].filter((pattern) => pattern.test(text)).length;
      if (strongSignal || supportingSignals >= 2)
        return { status: "VALID", detail: "Travel-ticket evidence detected" };
      return {
        status: "UNREADABLE",
        detail: "The upload does not contain readable travel-ticket evidence",
      };
    } catch (error) {
      this.logger.error(
        `Travel-ticket inspection failed: ${error instanceof Error ? error.message : "unknown"}`,
      );
      return {
        status: "TECHNICAL_FAILURE",
        detail: "Travel-ticket validation is temporarily unavailable",
      };
    }
  }

  async verify(order: DemoOrder): Promise<PassportVerificationResult> {
    if (order.purchaseType === "TOPUP") {
      return {
        status: "SKIPPED",
        matchedFields: [],
        checkedAt: new Date().toISOString(),
        method: "simulator",
        detail: "Top-up orders do not require passport verification",
      };
    }
    const passport = order.documents.find(
      (document) => document.type === DocumentType.PASSPORT,
    );
    if (!passport || !passport.uploadVerified) {
      return {
        status: "NOT_READY",
        matchedFields: [],
        checkedAt: new Date().toISOString(),
        method: "ocr-error",
        detail: "Upload a passport before verification",
      };
    }
    if (!order.traveler) {
      return {
        status: "NOT_READY",
        matchedFields: [],
        checkedAt: new Date().toISOString(),
        method: "ocr-error",
        detail: "Traveller details are required before verification",
      };
    }
    if (isPassportExpired(order.traveler.passportExpiryDate))
      return {
        status: "FAILED",
        matchedFields: [],
        checkedAt: new Date().toISOString(),
        method: "stored-extraction",
        detail: "The uploaded passport has expired",
        failureCode: "PASSPORT_EXPIRED",
      };
    if (process.env.PASSPORT_VERIFY_OVERRIDE === "SKIP") {
      return {
        status: "SKIPPED",
        matchedFields: [],
        checkedAt: new Date().toISOString(),
        method: "simulator",
        detail: "Passport verification bypassed by ops override",
      };
    }
    if (!this.storage.isConfigured()) {
      return {
        status: "SKIPPED",
        matchedFields: [],
        checkedAt: new Date().toISOString(),
        method: "simulator",
        detail: "Document storage is not configured (local simulator)",
      };
    }

    let images: Array<{ bytes: Buffer; contentType: string }>;
    try {
      images = await this.loadPassportImages(passport.privateAssetId);
    } catch (error) {
      this.logger.warn(
        `Passport image download failed for order ${order.id}: ${error instanceof Error ? error.message : "unknown"}`,
      );
      return {
        status: "FAILED",
        matchedFields: [],
        checkedAt: new Date().toISOString(),
        method: "pdf-unreadable",
        detail: "Passport could not be read as an image",
      };
    }

    let confidence: number | undefined;
    try {
      const result = await this.recognizePassportDocument(
        passport.privateAssetId,
        images,
      );
      confidence = result.confidence;
      const { matchedFields } = comparePassport(result.text, order.traveler);
      this.logger.log(
        `Passport OCR for order ${order.id}: verdict=${verdictFor(matchedFields)} matched=[${matchedFields.join(",")}] confidence=${confidence}`,
      );
      return {
        status: verdictFor(matchedFields),
        matchedFields,
        ...(confidence !== undefined ? { confidence } : {}),
        checkedAt: new Date().toISOString(),
        method: "tesseract-ocr",
      };
    } catch (error) {
      this.logger.error(
        `Passport OCR failed for order ${order.id}: ${error instanceof Error ? error.message : "unknown"}`,
      );
      return {
        status: "FAILED",
        matchedFields: [],
        checkedAt: new Date().toISOString(),
        method: "ocr-error",
        detail: "Passport could not be read — try a clearer photo",
      };
    }
  }

  private async recognize(image: Buffer) {
    // A shared worker is CPU-heavy. Reject excess work instead of allowing an
    // unbounded FIFO backlog to monopolize the API process.
    if (this.recognizing)
      throw new ServiceUnavailableException(
        "Passport verification is busy; try again shortly",
      );
    this.recognizing = true;
    try {
      const worker = await this.workerFor();
      let timeout: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        worker.recognize(image, { rotateAuto: true }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Passport OCR timed out")),
            this.timeoutMs,
          );
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      const { data } = result;
      let text = data.text ?? "";
      let bandText = "";
      try {
        bandText = await this.mrzBandPass(worker, image);
        if (bandText.trim()) text += `\n${bandText}`;
      } catch (bandError) {
        // The band pass is best effort. A wedged restricted pass would poison
        // every later request sharing this worker, so discard it — but keep
        // the successful full-page reading for comparison.
        this.logger.warn(
          `MRZ band OCR failed (continuing with full-page text): ${bandError instanceof Error ? bandError.message : "unknown"}`,
        );
        await worker.terminate().catch(() => undefined);
        this.worker = null;
        this.workerPromise = null;
      }
      if (!parseMrz(bandText) && !parseMrz(text)) {
        try {
          const recovered = await this.recoverMrz(worker, image);
          if (recovered.text) {
            bandText = [bandText, recovered.text].filter(Boolean).join("\n");
            text += `\n${recovered.text}`;
          }
        } catch (recoveryError) {
          // Recovery is deliberately best effort. Preserve the original OCR
          // result so a processing-library issue cannot break documents that
          // the established path already handled.
          this.logger.warn(
            `Enhanced MRZ recovery failed (continuing with original OCR): ${recoveryError instanceof Error ? recoveryError.message : "unknown"}`,
          );
          await worker.terminate().catch(() => undefined);
          this.worker = null;
          this.workerPromise = null;
        }
      }
      return {
        text,
        ...(bandText.trim() ? { bandText } : {}),
        confidence:
          typeof data.confidence === "number" ? data.confidence : undefined,
      };
    } catch (error) {
      // A timed-out worker may remain wedged; discard it before accepting a
      // subsequent request rather than serializing all later requests behind it.
      if (this.worker) await this.worker.terminate().catch(() => undefined);
      this.worker = null;
      this.workerPromise = null;
      throw error;
    } finally {
      this.recognizing = false;
    }
  }

  /**
   * Second recognition pass over the bottom band of the document where the
   * ICAO machine-readable zone lives. Full-page OCR routinely mangles the MRZ
   * ('<' fillers read as stray letters, digits merged together), which breaks
   * check-digit parsing; restricting the page-segmentation mode and whitelisting
   * the MRZ alphabet recovers clean 44-character lines. Best effort: any
   * failure simply leaves the full-page text in place.
   */
  private async mrzBandPass(worker: Worker, image: Buffer): Promise<string> {
    const dimensions = imageDimensions(image);
    if (!dimensions || dimensions.height < 60) return "";
    try {
      await worker.setParameters({
        tessedit_char_whitelist: PassportVerificationService.MRZ_ALPHABET,
        preserve_interword_spaces: "1",
      });
      const reads: string[] = [];
      for (const ratio of PassportVerificationService.MRZ_BAND_RATIOS) {
        const bandHeight = Math.max(40, Math.round(dimensions.height * ratio));
        let timeout: NodeJS.Timeout | undefined;
        const result = await Promise.race([
          worker.recognize(image, {
            rectangle: {
              left: 0,
              top: Math.max(0, dimensions.height - bandHeight),
              width: dimensions.width,
              height: bandHeight,
            },
          }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("MRZ band OCR timed out")),
              this.timeoutMs,
            );
          }),
        ]).finally(() => {
          if (timeout) clearTimeout(timeout);
        });
        const text = result.data.text ?? "";
        if (text.trim()) reads.push(text);
        if (parseMrz(text)) break;
      }
      return reads.join("\n");
    } finally {
      await worker
        .setParameters({ tessedit_char_whitelist: "" })
        .catch(() => undefined);
    }
  }

  /**
   * Recovery path for rotated, compressed and loosely framed passport photos.
   * It runs only when the established full-page and fixed-band passes fail.
   * Every accepted result still flows through parseMrz and its ICAO check-digit
   * validation; image enhancement never weakens the identity decision.
   */
  private async recoverMrz(worker: Worker, image: Buffer) {
    const deadline = Date.now() + Math.max(
      10_000,
      Number(process.env.PASSPORT_OCR_RECOVERY_TIMEOUT_MS ?? 45_000),
    );
    let best = { text: "", score: -1 };
    await worker.setParameters({
      tessedit_char_whitelist: PassportVerificationService.MRZ_ALPHABET,
      preserve_interword_spaces: "1",
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    });
    try {
      for (const rotation of PassportVerificationService.RECOVERY_ROTATIONS) {
        if (Date.now() >= deadline) break;
        const oriented = sharp(image, { failOn: "none" })
          .rotate()
          .rotate(rotation)
          .flatten({ background: "white" });
        const metadata = await oriented.clone().metadata();
        const width = metadata.width ?? 0;
        const height = metadata.height ?? 0;
        if (width < 120 || height < 120) continue;
        const scale = width < 1800 ? 1800 / width : 1;
        const normalized = await oriented
          .clone()
          .resize({
            width: Math.min(2600, Math.max(width, Math.round(width * scale))),
            withoutEnlargement: false,
          })
          .grayscale()
          .normalize()
          .sharpen({ sigma: 1 })
          .png()
          .toBuffer();
        const normalizedMeta = await sharp(normalized).metadata();
        const normalizedWidth = normalizedMeta.width ?? 0;
        const normalizedHeight = normalizedMeta.height ?? 0;
        for (const ratio of PassportVerificationService.RECOVERY_BAND_RATIOS) {
          if (Date.now() >= deadline) break;
          const bandHeight = Math.max(
            80,
            Math.round(normalizedHeight * ratio),
          );
          const band = sharp(normalized).extract({
            left: 0,
            top: Math.max(0, normalizedHeight - bandHeight),
            width: normalizedWidth,
            height: Math.min(bandHeight, normalizedHeight),
          });
          const variants = [
            await band.clone().png().toBuffer(),
            await band.clone().threshold(165).png().toBuffer(),
          ];
          for (const candidate of variants) {
            if (Date.now() >= deadline) break;
            const remaining = Math.max(
              1,
              Math.min(8_000, deadline - Date.now()),
            );
            let timeout: NodeJS.Timeout | undefined;
            const result = await Promise.race([
              worker.recognize(candidate),
              new Promise<never>((_, reject) => {
                timeout = setTimeout(
                  () => reject(new Error("Enhanced MRZ OCR timed out")),
                  remaining,
                );
              }),
            ]).finally(() => {
              if (timeout) clearTimeout(timeout);
            });
            const candidateText = result.data.text ?? "";
            const parsed = parseMrz(candidateText);
            const score = mrzCandidateScore(parsed);
            if (score > best.score) best = { text: candidateText, score };
            if (parsed?.valid && parsed.surname && parsed.givenNames)
              return best;
          }
        }
      }
      return best;
    } finally {
      await worker
        .setParameters({
          tessedit_char_whitelist: "",
          tessedit_pageseg_mode: PSM.AUTO,
        })
        .catch(() => undefined);
    }
  }

  private async recognizePassportDocument(
    assetId: string,
    loadedImages?: Array<{ bytes: Buffer; contentType: string }>,
  ) {
    const images = loadedImages ?? (await this.loadPassportImages(assetId));
    let best: Awaited<
      ReturnType<PassportVerificationService["recognize"]>
    > | null = null;
    for (const image of images.slice(0, passportOcrMaxPages())) {
      const recognized = await this.recognize(image.bytes);
      best ??= recognized;
      const parsedBand = recognized.bandText
        ? parseMrz(recognized.bandText)
        : null;
      const parsedFull = parseMrz(recognized.text);
      if (
        (parsedBand?.passportNumber.value &&
          (parsedBand.surname || parsedBand.givenNames)) ||
        (parsedFull?.passportNumber.value &&
          (parsedFull.surname || parsedFull.givenNames))
      )
        return recognized;
    }
    return best!;
  }

  private async loadPassportImages(assetId: string) {
    const storage = this.storage as S3StorageService & {
      downloadDocumentImages?: (
        id: string,
      ) => Promise<Array<{ bytes: Buffer; contentType: string }>>;
    };
    return storage.downloadDocumentImages
      ? await storage.downloadDocumentImages(assetId)
      : [await this.storage.downloadDocumentImage(assetId)];
  }

  private workerFor(): Promise<Worker> {
    if (this.worker) return Promise.resolve(this.worker);
    if (!this.workerPromise) {
      this.workerPromise = (async () => {
        try {
          const options: { langPath?: string; cachePath?: string } = {};
          if (process.env.TESSERACT_LANG_PATH)
            options.langPath = process.env.TESSERACT_LANG_PATH;
          if (process.env.TESSERACT_CACHE_PATH)
            options.cachePath = process.env.TESSERACT_CACHE_PATH;
          this.worker = await createWorker(this.language, 1, options);
          this.logger.log("Tesseract worker initialised");
          return this.worker;
        } catch (error) {
          this.workerPromise = null;
          throw new ServiceUnavailableException(
            `Passport OCR is not available: ${error instanceof Error ? error.message : "unknown"}`,
          );
        }
      })();
    }
    return this.workerPromise;
  }

  async onModuleDestroy() {
    if (!this.worker) return;
    await this.worker.terminate().catch(() => undefined);
    this.worker = null;
    this.workerPromise = null;
  }
}
