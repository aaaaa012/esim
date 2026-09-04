import fs from "node:fs";
import path from "node:path";
import {
  AlignmentType, BorderStyle, Document, Footer, HeadingLevel, LevelFormat, Packer,
  PageNumber, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun,
  WidthType,
} from "file:///C:/tmp/visa-compass-docx-runtime/node_modules/docx/dist/index.mjs";

const source = path.resolve("docs/PARTNER-API-v1.md");
const output = path.resolve(".docs/PARTNER-API-v1.docx");
const pageWidth = 9360;
const lines = fs.readFileSync(source, "utf8").split(/\r?\n/);

const borders = { top: { style: BorderStyle.SINGLE, size: 2, color: "D1D5DB" }, bottom: { style: BorderStyle.SINGLE, size: 2, color: "D1D5DB" }, left: { style: BorderStyle.SINGLE, size: 2, color: "D1D5DB" }, right: { style: BorderStyle.SINGLE, size: 2, color: "D1D5DB" }, insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: "D1D5DB" }, insideVertical: { style: BorderStyle.SINGLE, size: 2, color: "D1D5DB" } };

function run(text, options = {}) {
  return new TextRun({ text, font: options.code ? "Consolas" : "Calibri", size: options.size ?? 22, bold: options.bold, italics: options.italics, color: options.color ?? "000000" });
}

function inline(text, size = 22) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);
  return parts.map((part) => {
    if (part.startsWith("`") && part.endsWith("`")) return run(part.slice(1, -1), { size: size - 2, code: true, color: "1F4D78" });
    if (part.startsWith("**") && part.endsWith("**")) return run(part.slice(2, -2), { size, bold: true });
    if (part.startsWith("*") && part.endsWith("*")) return run(part.slice(1, -1), { size, italics: true });
    return run(part, { size });
  });
}

function paragraph(text, options = {}) {
  return new Paragraph({ children: options.inline === false ? [run(text, options)] : inline(text, options.size ?? 22), style: options.style, bullet: options.bullet ? { level: 0 } : undefined, numbering: options.numbering ? { reference: "list", level: 0 } : undefined, spacing: { before: options.before ?? 0, after: options.after ?? 120, line: options.line ?? 300 }, shading: options.shading ? { type: ShadingType.CLEAR, color: "auto", fill: options.shading } : undefined, keepNext: options.keepNext });
}

function parseTableRows(tableLines) {
  return tableLines
    .map((line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()))
    .filter((row) => !row.every((cell) => /^:?-{3,}:?$/.test(cell)));
}

function markdownTable(tableLines) {
  const rows = parseTableRows(tableLines);
  const columns = rows[0].length;
  const lengths = Array.from({ length: columns }, (_, index) => Math.max(...rows.map((row) => (row[index] ?? "").length), 12));
  const total = lengths.reduce((sum, value) => sum + value, 0);
  const widths = lengths.map((value) => Math.max(950, Math.floor((pageWidth * value) / total)));
  widths[widths.length - 1] += pageWidth - widths.reduce((sum, value) => sum + value, 0);
  return new Table({ width: { size: pageWidth, type: WidthType.DXA }, columnWidths: widths, borders, rows: rows.map((values, rowIndex) => new TableRow({ children: values.map((value) => new TableCell({ shading: rowIndex === 0 ? { type: ShadingType.CLEAR, color: "auto", fill: "E8EEF5" } : undefined, margins: { top: 80, bottom: 80, left: 120, right: 120 }, verticalAlign: "center", children: [new Paragraph({ children: inline(value, 18).map((item) => { item.bold = rowIndex === 0; return item; }), spacing: { after: 0, line: 240 } })] })) })) });
}

const children = [];
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  if (line.startsWith("```")) {
    const block = [];
    while (++index < lines.length && !lines[index].startsWith("```")) block.push(lines[index]);
    children.push(new Paragraph({ children: [run(block.join("\n"), { size: 17, code: true, color: "1F2937" })], spacing: { before: 80, after: 120, line: 220 }, shading: { type: ShadingType.CLEAR, color: "auto", fill: "F4F6F9" } }));
    continue;
  }
  if (line.startsWith("|") && line.slice(1).includes("|")) {
    const tableLines = [];
    while (index < lines.length && lines[index].startsWith("|")) tableLines.push(lines[index++]);
    index -= 1;
    children.push(markdownTable(tableLines));
    children.push(paragraph("", { after: 60 }));
    continue;
  }
  const heading = /^(#{1,3})\s+(.*)$/.exec(line);
  if (heading) {
    const level = heading[1].length;
    if (level === 1) children.push(new Paragraph({ children: [run(heading[2], { size: 46, bold: true, color: "0B2545" })], spacing: { after: 240 }, keepNext: true }));
    else children.push(new Paragraph({ children: inline(heading[2], level === 2 ? 32 : 26), heading: level === 2 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2, spacing: { before: level === 2 ? 360 : 280, after: level === 2 ? 200 : 140 }, keepNext: true }));
    continue;
  }
  if (!line.trim()) continue;
  const bullet = /^[-*]\s+(.*)$/.exec(line);
  const numbered = /^\d+\.\s+(.*)$/.exec(line);
  if (bullet || numbered) { children.push(paragraph((bullet ?? numbered)[1], { bullet: Boolean(bullet), numbering: Boolean(numbered), after: 80 })); continue; }
  children.push(paragraph(line.trimEnd()));
}

const doc = new Document({
  creator: "Visa Compass",
  title: "Visa Compass Partner API v1",
  numbering: { config: [{ reference: "list", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] }] },
  sections: [{ properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }, header: 709, footer: 709 } }, footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [run("Page ", { size: 18, color: "666666" }), new TextRun({ children: [PageNumber.CURRENT], font: "Calibri", size: 18, color: "666666" })] })] }) }, children }],
});

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, await Packer.toBuffer(doc));
console.log(output);
