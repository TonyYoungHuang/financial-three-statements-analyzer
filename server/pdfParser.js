import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PYTHON_PARSER_SCRIPT = join(__dirname, "python_pdf_parser.py");
const DEFAULT_PYTHON_PARSER_TIMEOUT_MS = 90000;

export const STATEMENT_SCHEMAS = {
  balance_sheet: [
    item("cash", "货币资金", ["货币资金", "现金及现金等价物", "cash and cash equivalents", "cash"]),
    item("accounts_receivable", "应收账款", ["应收账款", "accounts receivable", "trade receivables"]),
    item("inventory", "存货", ["存货", "inventories", "inventory"]),
    item("total_current_assets", "流动资产合计", ["流动资产合计", "total current assets"]),
    item("total_assets", "资产总计", ["资产总计", "总资产", "total assets"]),
    item("short_term_borrowings", "短期借款", ["短期借款", "short-term borrowings", "short term borrowings"]),
    item("accounts_payable", "应付账款", ["应付账款", "accounts payable", "trade payables"]),
    item("total_current_liabilities", "流动负债合计", ["流动负债合计", "total current liabilities", "current liabilities"]),
    item("total_liabilities", "负债合计", ["负债合计", "总负债", "total liabilities"]),
    item("total_equity", "所有者权益合计", ["所有者权益合计", "股东权益合计", "total equity", "shareholders' equity"]),
    item("liabilities_and_equity_total", "负债和所有者权益总计", [
      "负债和所有者权益总计",
      "负债及所有者权益总计",
      "total liabilities and equity",
    ]),
  ],
  income_statement: [
    item("revenue", "营业收入", ["营业收入", "主营业务收入", "revenue", "operating revenue", "sales"]),
    item("cost_of_sales", "营业成本", ["营业成本", "主营业务成本", "cost of sales", "cost of revenue"]),
    item("gross_profit", "毛利", ["毛利", "gross profit"]),
    item("selling_expenses", "销售费用", ["销售费用", "selling expenses", "distribution expenses"]),
    item("administrative_expenses", "管理费用", ["管理费用", "administrative expenses", "general and administrative"]),
    item("finance_expenses", "财务费用", ["财务费用", "finance expenses", "finance costs"]),
    item("operating_profit", "营业利润", ["营业利润", "operating profit", "profit from operations"]),
    item("total_profit", "利润总额", ["利润总额", "profit before tax", "income before tax"]),
    item("income_tax", "所得税费用", ["所得税费用", "income tax expense"]),
    item("net_profit", "净利润", ["净利润", "net profit", "net income", "profit for the year"]),
  ],
  cash_flow: [
    item("net_operating_cash_flow", "经营活动产生的现金流量净额", [
      "经营活动产生的现金流量净额",
      "经营活动现金流量净额",
      "net cash flows from operating activities",
      "net cash generated from operating activities",
    ]),
    item("net_investing_cash_flow", "投资活动产生的现金流量净额", [
      "投资活动产生的现金流量净额",
      "投资活动现金流量净额",
      "net cash flows from investing activities",
    ]),
    item("net_financing_cash_flow", "筹资活动产生的现金流量净额", [
      "筹资活动产生的现金流量净额",
      "筹资活动现金流量净额",
      "net cash flows from financing activities",
    ]),
    item("cash_net_increase", "现金及现金等价物净增加额", [
      "现金及现金等价物净增加额",
      "cash and cash equivalents net increase",
      "net increase in cash and cash equivalents",
    ]),
    item("beginning_cash", "期初现金及现金等价物余额", [
      "期初现金及现金等价物余额",
      "cash and cash equivalents at beginning",
      "cash and cash equivalents at the beginning",
    ]),
    item("ending_cash", "期末现金及现金等价物余额", [
      "期末现金及现金等价物余额",
      "cash and cash equivalents at end",
      "cash and cash equivalents at the end",
    ]),
  ],
};

function item(key, name, synonyms) {
  return { key, name, synonyms };
}

export async function parseStatementPdf(filePath, statementType, parserSettings = {}) {
  const schema = STATEMENT_SCHEMAS[statementType];
  if (!schema) {
    throw new Error(`Unsupported statement type: ${statementType}`);
  }

  const pythonResult = await extractWithPythonParser(filePath, parserSettings);
  if (pythonResult?.lines?.length) {
    const items = mapLinesToStatementItems(pythonResult.lines, schema, pythonResult.engine || "python-parser");
    attachParseMetadata(items, pythonResult);
    return items;
  }

  const lines = await extractPdfLines(filePath);
  const items = mapLinesToStatementItems(lines, schema, "pdfjs");
  attachParseMetadata(items, {
    engine: "pdfjs",
    layoutAudit: { engine: "pdfjs", textChars: lines.join(" ").length, warnings: [] },
    structuredTables: [],
    errors: [],
  });
  return items;
}

export async function extractPdfLines(filePath) {
  const data = new Uint8Array(readFileSync(filePath));
  const pdf = await getDocument({ data, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true }).promise;
  const lines = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent({ disableCombineTextItems: false });
    const grouped = new Map();

    for (const textItem of content.items) {
      const text = normalizeWhitespace(textItem.str);
      if (!text) continue;

      const x = Number(textItem.transform?.[4] || 0);
      const y = Number(textItem.transform?.[5] || 0);
      const bucket = Math.round(y / 3) * 3;
      const row = grouped.get(bucket) || [];
      row.push({ x, text });
      grouped.set(bucket, row);
    }

    const pageLines = [...grouped.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, row]) =>
        row
          .sort((a, b) => a.x - b.x)
          .map((part) => part.text)
          .join(" "),
      )
      .map(normalizeWhitespace)
      .filter(Boolean);

    lines.push(...pageLines);
  }

  return lines;
}

function mapLinesToStatementItems(lines, schema, engine = "pdfjs") {
  return schema.map((schemaItem) => {
    const match = findBestLine(schemaItem, lines);
    if (!match) {
      return {
        itemKey: schemaItem.key,
        itemName: schemaItem.name,
        value: null,
        sourceLabel: "",
        confidence: 0,
        status: "missing",
        note: "未在 PDF 文本中匹配到该标准科目，可在确认页补录。",
      };
    }

    return {
      itemKey: schemaItem.key,
      itemName: schemaItem.name,
      value: match.value,
      sourceLabel: match.line,
      confidence: match.confidence,
      status: match.value === null ? "needs_review" : "parsed",
      note:
        match.value === null
          ? `已由 ${engine} 匹配科目，但未识别到金额。`
          : `由 ${engine} 自动识别，用户确认后再进入评分。`,
    };
  });
}

function extractWithPythonParser(filePath, parserSettings = {}) {
  if (parserSettings?.usePython === false) return Promise.resolve(null);

  const pythonPath = parserSettings.pythonPath || process.env.PYTHON_PARSER_BIN || process.env.PYTHON || "python";
  const timeoutMs = Number(parserSettings.timeoutMs || DEFAULT_PYTHON_PARSER_TIMEOUT_MS);
  const env = {
    ...process.env,
    PARSER_OCR_ENABLED: parserSettings.ocrEnabled ? "1" : "0",
    PARSER_DEEP_LAYOUT: parserSettings.deepLayoutValidation ? "1" : "0",
    PARSER_DOCLING_MODE: parserSettings.doclingMode || "auto",
    PARSER_SCAN_MIN_TEXT_CHARS: String(parserSettings.scanBenchmarkMinTextChars ?? 80),
    PARSER_TABLE_CONFIDENCE: String(parserSettings.tableConfidenceThreshold ?? 0.75),
    PARSER_CAMELOT_FLAVORS: normalizeParserList(parserSettings.camelotFlavors, "lattice;stream"),
    PARSER_CAMELOT_TABLE_AREAS: normalizeParserList(parserSettings.camelotTableAreas, ""),
    PARSER_CAMELOT_TABLE_REGIONS: normalizeParserList(parserSettings.camelotTableRegions, ""),
    PARSER_CAMELOT_MIN_ACCURACY: String(parserSettings.camelotMinAccuracy ?? 75),
    PARSER_CAMELOT_RETRY_LOW_ACCURACY: parserSettings.camelotRetryLowAccuracy === false ? "0" : "1",
    PARSER_PDFPLUMBER_TABLE_SETTINGS: JSON.stringify(parserSettings.pdfplumberTableSettings || {}),
    PARSER_SAVE_VISUAL_DEBUG_IMAGES: parserSettings.saveVisualDebugImages ? "1" : "0",
    PARSER_VISUAL_DEBUG_LIMIT: String(parserSettings.visualDebugLimit ?? 3),
    PARSER_COORDINATE_TRACE_LIMIT: String(parserSettings.coordinateTraceLimit ?? 160),
  };

  return new Promise((resolve) => {
    const child = spawn(pythonPath, [PYTHON_PARSER_SCRIPT, filePath], {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout.trim()) {
        if (stderr.trim()) console.warn(`Python parser skipped: ${stderr.trim().slice(0, 500)}`);
        resolve(null);
        return;
      }
      try {
        const text = stdout.trim();
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          const match = text.match(/\{[\s\S]*\}/);
          payload = match ? JSON.parse(match[0]) : null;
        }
        resolve(payload.ok ? payload : null);
      } catch (error) {
        console.warn(`Python parser returned invalid JSON: ${error.message}`);
        resolve(null);
      }
    });
  });
}

function normalizeParserList(value, fallback) {
  if (Array.isArray(value)) return value.filter(Boolean).join(";");
  if (typeof value === "string") return value;
  return fallback;
}

function attachParseMetadata(items, result) {
  const metadata = {
    engine: result.engine || "unknown",
    layoutAudit: result.layoutAudit || {},
    structuredTables: result.structuredTables || result.tables || [],
    errors: result.errors || [],
  };
  for (const item of items) {
    item.parseMetadata = metadata;
  }
}

function findBestLine(schemaItem, lines) {
  const candidates = [];
  for (const line of lines) {
    const normalizedLine = normalizeComparable(line);
    for (const synonym of schemaItem.synonyms) {
      const normalizedSynonym = normalizeComparable(synonym);
      if (normalizedLine.includes(normalizedSynonym)) {
        const numbers = extractNumbers(line);
        candidates.push({
          line,
          value: numbers[0] ?? null,
          confidence: Math.min(0.98, 0.82 + normalizedSynonym.length / Math.max(normalizedLine.length, 20)),
          synonymLength: normalizedSynonym.length,
        });
      }
    }
  }

  candidates.sort((a, b) => b.synonymLength - a.synonymLength || b.confidence - a.confidence);
  return candidates[0] || null;
}

function extractNumbers(line) {
  const matches = line.match(/(?:\(|-)?\d{1,3}(?:,\d{3})*(?:\.\d+)?\)?|(?:\(|-)?\d+(?:\.\d+)?\)?/g) || [];
  return matches
    .map((raw) => raw.trim())
    .filter((raw) => !/^20\d{2}$/.test(raw) && !/^19\d{2}$/.test(raw))
    .map((raw) => {
      const negative = raw.startsWith("(") || raw.startsWith("-");
      const numeric = Number(raw.replace(/[(),]/g, "").replace(/^-/, ""));
      return Number.isFinite(numeric) ? (negative ? -numeric : numeric) : null;
    })
    .filter((value) => value !== null);
}

function normalizeComparable(value) {
  return String(value)
    .toLowerCase()
    .replace(/[：:()（）"'’‘“”，,.;；、\s\-_/]/g, "");
}

function normalizeWhitespace(value) {
  return String(value).replace(/\s+/g, " ").trim();
}
