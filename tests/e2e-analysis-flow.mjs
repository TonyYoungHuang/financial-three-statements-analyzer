import assert from "node:assert/strict";
import { createWriteStream, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import PDFDocument from "pdfkit";

const BASE_URL = process.env.E2E_BASE_URL || "http://127.0.0.1:4173";
const ACTIVATION_CODE = process.env.E2E_ACTIVATION_CODE || "FIN-2026-A8K2-MPWA";
const outDir = join(process.cwd(), "data", "tmp", "e2e");
mkdirSync(outDir, { recursive: true });

const statementValues = {
  balance_sheet: {
    cash: 220,
    accounts_receivable: 180,
    inventory: 120,
    total_current_assets: 600,
    total_assets: 1200,
    short_term_borrowings: 80,
    accounts_payable: 130,
    total_current_liabilities: 360,
    total_liabilities: 620,
    total_equity: 580,
    liabilities_and_equity_total: 1200,
  },
  income_statement: {
    revenue: 1000,
    cost_of_sales: 620,
    gross_profit: 380,
    selling_expenses: 80,
    administrative_expenses: 70,
    finance_expenses: 15,
    operating_profit: 215,
    total_profit: 210,
    income_tax: 42,
    net_profit: 168,
  },
  cash_flow: {
    net_operating_cash_flow: 190,
    net_investing_cash_flow: -90,
    net_financing_cash_flow: -40,
    cash_net_increase: 60,
    beginning_cash: 160,
    ending_cash: 220,
  },
};

const pdfRows = {
  balance_sheet: [
    ["Item", "2025", "2024"],
    ["cash", "220", "160"],
    ["accounts receivable", "180", "150"],
    ["inventory", "120", "115"],
    ["total current assets", "600", "520"],
    ["total assets", "1200", "1050"],
    ["short-term borrowings", "80", "90"],
    ["accounts payable", "130", "120"],
    ["total current liabilities", "360", "340"],
    ["total liabilities", "620", "590"],
    ["total equity", "580", "460"],
    ["total liabilities and equity", "1200", "1050"],
  ],
  income_statement: [
    ["Item", "2025", "2024"],
    ["revenue", "1000", "880"],
    ["cost of sales", "620", "560"],
    ["gross profit", "380", "320"],
    ["selling expenses", "80", "70"],
    ["administrative expenses", "70", "64"],
    ["finance expenses", "15", "18"],
    ["operating profit", "215", "168"],
    ["profit before tax", "210", "160"],
    ["income tax expense", "42", "32"],
    ["net profit", "168", "128"],
  ],
  cash_flow: [
    ["Item", "2025", "2024"],
    ["net cash flows from operating activities", "190", "150"],
    ["net cash flows from investing activities", "-90", "-120"],
    ["net cash flows from financing activities", "-40", "10"],
    ["net increase in cash and cash equivalents", "60", "40"],
    ["cash and cash equivalents at beginning", "160", "120"],
    ["cash and cash equivalents at end", "220", "160"],
  ],
};

for (const [statementType, rows] of Object.entries(pdfRows)) {
  await createTablePdf(join(outDir, `${statementType}.pdf`), statementType, rows);
}

let token = "";
let jobId = 0;

try {
  const activation = await post("/api/activation/verify", { code: ACTIVATION_CODE });
  token = activation.token;
  assert.ok(token, "activation should return a session token");

  const config = await get("/api/config/public");
  const options = config.config.public_options;
  const job = await post(
    "/api/analysis/jobs",
    {
      analysisType: "single",
      language: options.languages[0],
      accountingStandard: "CAS",
      industry: options.industries[0],
      currency: "CNY",
      amountUnit: options.units[0],
    },
    token,
  );
  jobId = job.job.id;
  assert.ok(jobId, "analysis job should be created");

  for (const statementType of Object.keys(pdfRows)) {
    const filePath = join(outDir, `${statementType}.pdf`);
    await post(
      `/api/analysis/jobs/${jobId}/upload`,
      {
        statementType,
        period: "current",
        fileName: `${statementType}.pdf`,
        mimeType: "application/pdf",
        dataBase64: readFileSync(filePath).toString("base64"),
      },
      token,
    );
  }

  const parsed = await post(`/api/analysis/jobs/${jobId}/parse`, {}, token);
  assert.equal(parsed.job.status, "parsed", "job should parse");

  const statements = await get(`/api/analysis/jobs/${jobId}/statements`, token);
  const editedItems = statements.statements.items.map((item) => {
    const value = statementValues[item.statementType]?.[item.itemKey];
    return {
      statementType: item.statementType,
      itemKey: item.itemKey,
      currentAmount: value ?? item.currentAmount ?? null,
      previousAmount: item.previousAmount ?? null,
    };
  });
  await put(`/api/analysis/jobs/${jobId}/statements`, { items: editedItems }, token);
  await post(`/api/analysis/jobs/${jobId}/confirm`, {}, token);

  const calculated = await post(`/api/analysis/jobs/${jobId}/calculate`, {}, token);
  const analysis = calculated.analysis;
  assert.ok(analysis.score >= 0 && analysis.score <= 100, "analysis score should be bounded");
  assert.ok(analysis.metrics.length >= 40, "analysis should include the expanded metric set");
  assert.ok(analysis.aiAnalysis?.factChecks?.length, "analysis should include fact consistency checks");
  assert.ok(analysis.aiAnalysis?.validationRounds?.length >= 3, "analysis should include validation rounds");
  assert.ok(analysis.aiAnalysis?.chartData?.profitability?.length, "analysis should include chart data");

  const reportResponse = await fetch(`${BASE_URL}/api/analysis/jobs/${jobId}/report.pdf`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(reportResponse.status, 200, "PDF report should export");
  const report = Buffer.from(await reportResponse.arrayBuffer());
  assert.ok(report.length > 1000, "PDF report should not be empty");
  writeFileSync(join(outDir, `financial-report-${jobId}.pdf`), report);

  console.log(
    JSON.stringify(
      {
        ok: true,
        jobId,
        score: analysis.score,
        metrics: analysis.metrics.length,
        aiStatus: analysis.aiStatus,
        factChecks: analysis.aiAnalysis.factChecks.length,
        reportBytes: report.length,
      },
      null,
      2,
    ),
  );
} finally {
  if (token) {
    await post("/api/activation/logout", {}, token).catch(() => {});
  }
}

async function get(path, bearer = "") {
  return request(path, { method: "GET", bearer });
}

async function post(path, body, bearer = "") {
  return request(path, { method: "POST", body, bearer });
}

async function put(path, body, bearer = "") {
  return request(path, { method: "PUT", body, bearer });
}

async function request(path, { method, body, bearer = "" }) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) {
    const payload = contentType.includes("application/json") ? await response.json().catch(() => ({})) : {};
    throw new Error(`${method} ${path} failed: ${response.status} ${payload.error?.message || ""}`);
  }
  return contentType.includes("application/json") ? response.json() : response;
}

async function createTablePdf(filePath, title, rows) {
  const doc = new PDFDocument({ size: "A4", margin: 42 });
  const stream = createWriteStream(filePath);
  doc.pipe(stream);
  doc.fontSize(14).text(title.replace(/_/g, " ").toUpperCase());
  let y = 82;
  for (const row of rows) {
    let x = 42;
    const heights = row[0].length > 34 ? 34 : 24;
    for (const [index, cell] of row.entries()) {
      const width = index === 0 ? 285 : 110;
      doc.rect(x, y, width, heights).stroke();
      doc.fontSize(8.5).text(cell, x + 5, y + 7, { width: width - 10 });
      x += width;
    }
    y += heights;
  }
  doc.end();
  await once(stream, "finish");
}
