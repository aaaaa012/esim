import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createWorker, type Worker } from "tesseract.js";
import { DocumentType, type TravelerInput } from "@visa-compass/shared";
import { S3StorageService } from "../../infrastructure/s3-storage.service.js";
import { confusableNormalize, editDistance, parseMrz } from "./mrz-parser.js";
import type { DemoOrder } from "./orders.service.js";

export type PassportVerificationStatus =
  "VERIFIED" | "PARTIAL" | "FAILED" | "NOT_READY" | "SKIPPED";
export type PassportField =
  | "passportNumber"
  | "surname"
  | "givenNames"
  | "dateOfBirth"
  | "passportExpiryDate";
export type PassportVerificationResult = {
  status: PassportVerificationStatus;
  matchedFields: PassportField[];
  confidence?: number;
  checkedAt: string;
  method:
    "tesseract-ocr" | "simulator" | "pdf-unreadable" | "ocr-error" | "policy";
  detail?: string;
};

/** Uppercases and strips every non-alphanumeric character so OCR noise like
 *  spaces, dashes and slashes cannot break exact-match comparison. */
export const normalizeText = (value: string) =>
  value.toUpperCase().replace(/[^A-Z0-9]/g, "");

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
  if (traveler.surname && matchesAny(normalizeText(traveler.surname)))
    matchedFields.push("surname");
  const given = [traveler.firstName, traveler.middleName]
    .filter(Boolean)
    .join(" ");
  if (given && matchesAny(normalizeText(given)))
    matchedFields.push("givenNames");
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

/** The passport number is the primary signal; the order only passes when at
 *  least one more field (name, date of birth or expiry) also matches. When the
 *  number could not be read but a strong identity pair did match (a name plus
 *  the date of birth), the verdict is PARTIAL so ops can review instead of
 *  trapping the traveller in a reupload loop their details cannot fix. */
export const verdictFor = (
  matchedFields: PassportField[],
): PassportVerificationStatus => {
  if (matchedFields.includes("passportNumber"))
    return matchedFields.length >= 2 ? "VERIFIED" : "PARTIAL";
  const nameMatch =
    matchedFields.includes("surname") || matchedFields.includes("givenNames");
  const strongIdentityPair =
    nameMatch && matchedFields.includes("dateOfBirth");
  return strongIdentityPair && matchedFields.length >= 2
    ? "PARTIAL"
    : "FAILED";
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
  /** Fraction of the image height re-OCR'd when hunting for the MRZ band. */
  private static readonly MRZ_BAND_RATIO = 0.25;
  /** ICAO MRZ alphabet; also used as the second-pass Tesseract whitelist. */
  private static readonly MRZ_ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<";

  constructor(private readonly storage: S3StorageService) {}

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

    let image: { bytes: Buffer; contentType: string };
    try {
      image = await this.storage.downloadDocumentImage(passport.privateAssetId);
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
      const result = await this.recognize(image.bytes);
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
        worker.recognize(image),
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
      try {
        const mrzText = await this.mrzBandPass(worker, image);
        if (mrzText.trim()) text += `\n${mrzText}`;
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
      return {
        text,
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
    const bandHeight = Math.max(
      40,
      Math.round(dimensions.height * PassportVerificationService.MRZ_BAND_RATIO),
    );
    try {
      await worker.setParameters({
        tessedit_char_whitelist: PassportVerificationService.MRZ_ALPHABET,
        preserve_interword_spaces: "1",
      });
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
      return result.data.text ?? "";
    } finally {
      await worker
        .setParameters({ tessedit_char_whitelist: "" })
        .catch(() => undefined);
    }
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
