import { Injectable, Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { createWorker, type Worker } from 'tesseract.js';
import { DocumentType, type TravelerInput } from '@visa-compass/shared';
import { CloudinaryStorageService } from '../../infrastructure/cloudinary-storage.service.js';
import type { DemoOrder } from './orders.service.js';

export type PassportVerificationStatus = 'VERIFIED' | 'PARTIAL' | 'FAILED' | 'NOT_READY' | 'SKIPPED';
export type PassportField = 'passportNumber' | 'surname' | 'givenNames' | 'dateOfBirth' | 'passportExpiryDate';
export type PassportVerificationResult = {
  status: PassportVerificationStatus;
  matchedFields: PassportField[];
  confidence?: number;
  checkedAt: string;
  method: 'tesseract-ocr' | 'simulator' | 'pdf-unreadable' | 'ocr-error';
  detail?: string;
};

/** Uppercases and strips every non-alphanumeric character so OCR noise like
 *  spaces, dashes and slashes cannot break exact-match comparison. */
export const normalizeText = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');

const MONTHS: Record<string, string> = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };

/** Replaces written month names ("15 AUG 1990") with their numbers so OCR
 *  dates can be compared against the traveller form regardless of the format
 *  the passport prints them in. */
const monthNamesToNumbers = (value: string) =>
  value.toUpperCase().replace(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/g, (month) => MONTHS[month] ?? month);

/** Common ways the same calendar date appears on a passport: ISO digits,
 *  DDMMYYYY, the MRZ YYMMDD and DDMMYY forms. All returned without separators
 *  so they can be searched inside the normalized OCR text. */
export const dateVariants = (iso: string): string[] => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) return [];
  const [, y, m, d] = match;
  const yy = String(Number(y) % 100).padStart(2, '0');
  return [`${y}${m}${d}`, `${d}${m}${y}`, `${yy}${m}${d}`, `${d}${m}${yy}`];
};

export const comparePassport = (ocrText: string, traveler: TravelerInput): { matchedFields: PassportField[] } => {
  const text = normalizeText(ocrText);
  const textNumeric = normalizeText(monthNamesToNumbers(ocrText));
  const matchesAny = (candidate: string) => text.includes(candidate) || textNumeric.includes(candidate);
  const matchedFields: PassportField[] = [];
  if (normalizeText(traveler.passportNumber) && matchesAny(normalizeText(traveler.passportNumber))) matchedFields.push('passportNumber');
  if (traveler.surname && matchesAny(normalizeText(traveler.surname))) matchedFields.push('surname');
  const given = [traveler.firstName, traveler.middleName].filter(Boolean).join(' ');
  if (given && matchesAny(normalizeText(given))) matchedFields.push('givenNames');
  if (dateVariants(traveler.dateOfBirth).some((variant) => matchesAny(variant))) matchedFields.push('dateOfBirth');
  if (dateVariants(traveler.passportExpiryDate).some((variant) => matchesAny(variant))) matchedFields.push('passportExpiryDate');
  return { matchedFields };
};

/** The passport number is the primary signal; the order only passes when at
 *  least one more field (name, date of birth or expiry) also matches. */
export const verdictFor = (matchedFields: PassportField[]): PassportVerificationStatus =>
  matchedFields.includes('passportNumber')
    ? matchedFields.length >= 2
      ? 'VERIFIED'
      : 'PARTIAL'
    : 'FAILED';

/**
 * Server-side passport verification used to gate checkout before payment.
 *
 * Documents are auto-approved after payment today, so a mismatch between the
 * traveller form and the uploaded passport would otherwise never be caught.
 * This service downloads the uploaded passport (rasterizing PDFs to their
 * first page via Cloudinary), runs Tesseract OCR, and compares the extracted
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
  private readonly language = process.env.TESSERACT_LANG ?? 'eng';

  constructor(private readonly storage: CloudinaryStorageService) {}

  async verify(order: DemoOrder): Promise<PassportVerificationResult> {
    if (order.purchaseType === 'TOPUP') {
      return { status: 'SKIPPED', matchedFields: [], checkedAt: new Date().toISOString(), method: 'simulator', detail: 'Top-up orders do not require passport verification' };
    }
    const passport = order.documents.find((document) => document.type === DocumentType.PASSPORT);
    if (!passport || !passport.uploadVerified) {
      return { status: 'NOT_READY', matchedFields: [], checkedAt: new Date().toISOString(), method: 'ocr-error', detail: 'Upload a passport before verification' };
    }
    if (!order.traveler) {
      return { status: 'NOT_READY', matchedFields: [], checkedAt: new Date().toISOString(), method: 'ocr-error', detail: 'Traveller details are required before verification' };
    }
    if (process.env.PASSPORT_VERIFY_OVERRIDE === 'SKIP') {
      return { status: 'SKIPPED', matchedFields: [], checkedAt: new Date().toISOString(), method: 'simulator', detail: 'Passport verification bypassed by ops override' };
    }
    if (!this.storage.isConfigured()) {
      return { status: 'SKIPPED', matchedFields: [], checkedAt: new Date().toISOString(), method: 'simulator', detail: 'Document storage is not configured (local simulator)' };
    }

    let image: { bytes: Buffer; contentType: string };
    try {
      image = await this.storage.downloadDocumentImage(passport.privateAssetId);
    } catch (error) {
      this.logger.warn(`Passport image download failed for order ${order.id}: ${error instanceof Error ? error.message : 'unknown'}`);
      return { status: 'FAILED', matchedFields: [], checkedAt: new Date().toISOString(), method: 'pdf-unreadable', detail: 'Passport could not be read as an image' };
    }

    let confidence: number | undefined;
    try {
      const result = await this.recognize(image.bytes);
      confidence = result.confidence;
      const { matchedFields } = comparePassport(result.text, order.traveler);
      return { status: verdictFor(matchedFields), matchedFields, ...(confidence !== undefined ? { confidence } : {}), checkedAt: new Date().toISOString(), method: 'tesseract-ocr' };
    } catch (error) {
      this.logger.error(`Passport OCR failed for order ${order.id}: ${error instanceof Error ? error.message : 'unknown'}`);
      return { status: 'FAILED', matchedFields: [], checkedAt: new Date().toISOString(), method: 'ocr-error', detail: 'Passport could not be read — try a clearer photo' };
    }
  }

  private async recognize(image: Buffer) {
    const worker = await this.workerFor();
    const { data } = await worker.recognize(image);
    return { text: data.text ?? '', confidence: typeof data.confidence === 'number' ? data.confidence : undefined };
  }

  private workerFor(): Promise<Worker> {
    if (this.worker) return Promise.resolve(this.worker);
    if (!this.workerPromise) {
      this.workerPromise = (async () => {
        try {
          const options: { langPath?: string; cachePath?: string } = {};
          if (process.env.TESSERACT_LANG_PATH) options.langPath = process.env.TESSERACT_LANG_PATH;
          if (process.env.TESSERACT_CACHE_PATH) options.cachePath = process.env.TESSERACT_CACHE_PATH;
          this.worker = await createWorker(this.language, 1, options);
          this.logger.log('Tesseract worker initialised');
          return this.worker;
        } catch (error) {
          this.workerPromise = null;
          throw new ServiceUnavailableException(`Passport OCR is not available: ${error instanceof Error ? error.message : 'unknown'}`);
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
