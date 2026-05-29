import assert from "node:assert/strict";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import PDFDocument from "pdfkit";

const outDir = join(process.cwd(), "data", "tmp", "parser-samples");
mkdirSync(outDir, { recursive: true });

const electronicPdf = join(outDir, "sample-electronic-table.pdf");
const scannedPdf = join(outDir, "sample-scanned-image.pdf");

await createElectronicPdf(electronicPdf);
createScannedPdf(scannedPdf);

const electronic = runPythonParser(electronicPdf, {
  PARSER_OCR_ENABLED: "0",
  PARSER_DEEP_LAYOUT: "0",
  PARSER_DOCLING_MODE: "never",
  PARSER_SAVE_VISUAL_DEBUG_IMAGES: "1",
});
assert.equal(electronic.ok, true, "electronic table sample should parse");
assert.ok(electronic.engine.includes("pdfplumber") || electronic.engine.includes("camelot"), "electronic sample should use table parser");
assert.ok(electronic.structuredTables?.length >= 1, "electronic sample should return structured tables");
assert.ok(electronic.layoutAudit?.parserAudits?.length >= 1, "electronic sample should return parser audits");

let scanned = null;
if (process.env.PARSER_SAMPLE_SKIP_OCR === "1") {
  scanned = { skipped: true };
} else {
  scanned = runPythonParser(scannedPdf, {
    PARSER_OCR_ENABLED: "1",
    PARSER_DEEP_LAYOUT: "1",
    PARSER_DOCLING_MODE: "always",
    PARSER_SAVE_VISUAL_DEBUG_IMAGES: "0",
    PARSER_FORCE_FULL_PAGE_OCR: "1",
  });
  assert.equal(scanned.ok, true, "scanned image sample should parse through OCR/deep layout path");
  assert.ok(scanned.engine.includes("docling"), "scanned sample should exercise Docling/OCR");
}

console.log(
  JSON.stringify(
    {
      ok: true,
      electronic: {
        engine: electronic.engine,
        structuredTables: electronic.structuredTables.length,
        visualPreviews: electronic.layoutAudit?.visualPreviews?.length || 0,
      },
      scanned: scanned?.skipped
        ? { skipped: true }
        : {
            engine: scanned.engine,
            lines: scanned.lines.length,
            warnings: scanned.layoutAudit?.warnings || [],
          },
    },
    null,
    2,
  ),
);

async function createElectronicPdf(filePath) {
  const doc = new PDFDocument({ size: "A4", margin: 48 });
  const stream = createWriteStream(filePath);
  doc.pipe(stream);
  doc.fontSize(14).text("Realistic Financial Statement Sample");
  const rows = [
    ["Item", "Current", "Previous"],
    ["revenue", "1280", "1100"],
    ["cost of sales", "760", "690"],
    ["gross profit", "520", "410"],
    ["net profit", "180", "135"],
    ["net cash flows from operating activities", "210", "150"],
  ];
  let y = 90;
  for (const row of rows) {
    let x = 48;
    for (const [index, cell] of row.entries()) {
      const width = index === 0 ? 285 : 105;
      doc.rect(x, y, width, 26).stroke();
      doc.fontSize(8.5).text(cell, x + 6, y + 8, { width: width - 12 });
      x += width;
    }
    y += 26;
  }
  doc.end();
  await once(stream, "finish");
}

function createScannedPdf(filePath) {
  const script = `
from PIL import Image, ImageDraw
img = Image.new("RGB", (1240, 1754), "white")
draw = ImageDraw.Draw(img)
y = 120
for line in [
    "Scanned Financial Statement Sample",
    "revenue 1280 1100",
    "cost of sales 760 690",
    "gross profit 520 410",
    "net profit 180 135",
    "net cash flows from operating activities 210 150",
]:
    draw.text((120, y), line, fill="black")
    y += 70
img.save(r"${filePath.replaceAll("\\", "\\\\")}", "PDF", resolution=180.0)
`;
  const result = spawnSync("python", ["-c", script], { encoding: "utf8" });
  if (result.status !== 0) {
    writeFileSync(join(outDir, "scanned-create-error.log"), `${result.stdout}\n${result.stderr}`);
    throw new Error(`failed to create scanned PDF sample: ${result.stderr}`);
  }
}

function runPythonParser(filePath, env) {
  const result = spawnSync("python", ["server/python_pdf_parser.py", filePath], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: Number(process.env.PARSER_SAMPLE_TIMEOUT_MS || 240000),
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`parser failed for ${filePath}: ${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(`parser returned invalid JSON for ${filePath}: ${error.message}\n${result.stdout}\n${result.stderr}`);
  }
}
