/** Minimal RFC-4180-style CSV parser (supports quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += char;
    } else if (char === '"') inQuotes = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += char;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Maps header row to column indices, ignoring empty lines. */
export function csvToRecords(
  text: string,
  requiredHeaders: string[],
): { records: Record<string, string>[]; errors: string[] } {
  const rows = parseCsv(text).filter((row) =>
    row.some((cell) => cell.trim() !== ""),
  );
  const errors: string[] = [];
  if (rows.length === 0)
    return { records: [], errors: ["The CSV file is empty"] };
  const header = (rows[0] ?? []).map((cell) => cell.trim().toLowerCase());
  const missing = requiredHeaders.filter(
    (required) => !header.includes(required),
  );
  if (missing.length)
    return {
      records: [],
      errors: [`Missing required columns: ${missing.join(", ")}`],
    };
  const records: Record<string, string>[] = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i] ?? [];
    const record: Record<string, string> = {};
    let empty = true;
    for (let j = 0; j < header.length; j++) {
      const key = header[j];
      if (key === undefined) continue;
      const value = (cells[j] ?? "").trim();
      if (value) empty = false;
      record[key] = value;
    }
    if (!empty) records.push(record);
  }
  return { records, errors };
}
