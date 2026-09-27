const escape = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value);
  // Neutralize spreadsheet formula injection (= + - @ leading cells) by
  // prefixing an apostrophe; the sanitizer handles both quoted and bare cells.
  const sanitized = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(sanitized)
    ? `"${sanitized.replaceAll('"', '""')}"`
    : sanitized;
};

export function downloadCsv(
  filename: string,
  headers: string[],
  rows: (string | number | boolean | null | undefined)[][],
) {
  const lines = [headers, ...rows].map((row) => row.map(escape).join(","));
  const blob = new Blob([`\uFEFF${lines.join("\n")}`], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
