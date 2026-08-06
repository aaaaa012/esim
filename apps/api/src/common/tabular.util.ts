import ExcelJS from 'exceljs';
import { csvToRecords } from './csv.util.js';

/**
 * Unified tabular importer for plan catalogue and inventory uploads.
 *
 * Both CSV and Excel (.xlsx/.xls) files are accepted. Excel files arrive as
 * base64 and are decoded in memory; CSV files are passed as raw text. The
 * resulting records share the same `Record<string, string>` shape so the two
 * importers behave identically regardless of the source format.
 */
export type TabularRecord = Record<string, string>;

export async function tabularToRecords(
  content: string,
  requiredHeaders: string[],
  options?: { fileName?: string; maxRows?: number },
): Promise<{ records: TabularRecord[]; errors: string[] }> {
  if (content.length > MAX_CONTENT_CHARS)
    return { records: [], errors: ['The uploaded file is too large'] };
  const fileName = (options?.fileName ?? '').toLowerCase();
  const looksLikeExcel = fileName.endsWith('.xlsx') || fileName.endsWith('.xls');
  if (looksLikeExcel) return recordsFromExcel(content, requiredHeaders, options?.maxRows);
  return csvToRecords(content, requiredHeaders);
}

/** Safety ceiling (decoded characters) for any tabular upload, guarding
 *  against oversized payloads before parsing (CSV) or before base64 decoding
 *  and XML/unzip expansion (Excel). */
const MAX_CONTENT_CHARS = 15 * 1024 * 1024;

async function recordsFromExcel(
  base64: string,
  requiredHeaders: string[],
  maxRows?: number,
): Promise<{ records: TabularRecord[]; errors: string[] }> {
  const errors: string[] = [];
  let buffer: Buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    return { records: [], errors: ['The Excel file could not be decoded'] };
  }
  if (buffer.length === 0) return { records: [], errors: ['The Excel file is empty'] };
  let workbook: ExcelJS.Workbook;
  try {
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    return { records: [], errors: ['The Excel file could not be read. Save it as .xlsx and try again.'] };
  }
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return { records: [], errors: ['The Excel file has no worksheets'] };

  const headerRow = worksheet.getRow(1);
  const header = Array.isArray(headerRow.values)
    ? (headerRow.values.slice(1) as unknown[]).map((cell) => cellText(cell).trim().toLowerCase())
    : [];
  const missing = requiredHeaders.filter((required) => !header.includes(required));
  if (missing.length) return { records: [], errors: [`Missing required columns: ${missing.join(', ')}`] };

  const records: TabularRecord[] = [];
  const rowCount = Math.min(worksheet.rowCount, (maxRows ?? 5000) + 1);
  for (let rowIndex = 2; rowIndex <= rowCount; rowIndex++) {
    const row = worksheet.getRow(rowIndex);
    const record: TabularRecord = {};
    let empty = true;
    for (let columnIndex = 0; columnIndex < header.length; columnIndex++) {
      const key = header[columnIndex];
      if (key === undefined) continue;
      const value = cellText(row.getCell(columnIndex + 1).value).trim();
      if (value) empty = false;
      record[key] = value;
    }
    if (!empty) records.push(record);
  }
  return { records, errors };
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const rich = value as { text?: unknown; hyperlink?: unknown; result?: unknown };
    if (rich.hyperlink) return String(rich.text ?? rich.hyperlink ?? '');
    if (rich.text !== undefined) return String(rich.text);
    if (rich.result !== undefined) return String(rich.result);
    return '';
  }
  return String(value);
}
