import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(__dirname);
const dataDir = join(rootDir, "data");
const dbPath = join(dataDir, "app.sqlite");

mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA journal_mode = WAL;");

export function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS activation_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      valid_until TEXT NOT NULL,
      max_sessions INTEGER NOT NULL DEFAULT 2,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activation_code_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      ip TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_active TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (activation_code_id) REFERENCES activation_codes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_sessions_activation_last_active ON sessions(activation_code_id, last_active);

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activation_code_id INTEGER NOT NULL,
      company_name TEXT NOT NULL,
      industry TEXT NOT NULL,
      reporting_period TEXT NOT NULL,
      standard TEXT NOT NULL,
      currency TEXT NOT NULL,
      score INTEGER NOT NULL,
      rating TEXT NOT NULL,
      main_risks TEXT NOT NULL,
      generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (activation_code_id) REFERENCES activation_codes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_projects_activation_generated ON projects(activation_code_id, generated_at DESC);

    CREATE TABLE IF NOT EXISTS system_configs (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS analysis_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activation_code_id INTEGER NOT NULL,
      analysis_type TEXT NOT NULL,
      language TEXT NOT NULL,
      accounting_standard TEXT NOT NULL,
      industry TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount_unit TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'created',
      error_message TEXT,
      confirmed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (activation_code_id) REFERENCES activation_codes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_analysis_jobs_activation_created
      ON analysis_jobs(activation_code_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS analysis_uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      statement_type TEXT NOT NULL,
      period TEXT NOT NULL DEFAULT 'current',
      original_filename TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'uploaded',
      parse_audit TEXT NOT NULL DEFAULT '{}',
      structured_tables TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES analysis_jobs(id) ON DELETE CASCADE,
      UNIQUE(job_id, statement_type, period)
    );

    CREATE INDEX IF NOT EXISTS idx_analysis_uploads_job ON analysis_uploads(job_id);

    CREATE TABLE IF NOT EXISTS analysis_statement_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      statement_type TEXT NOT NULL,
      item_key TEXT NOT NULL,
      item_name TEXT NOT NULL,
      current_amount REAL,
      previous_amount REAL,
      source_label TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'missing',
      note TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES analysis_jobs(id) ON DELETE CASCADE,
      UNIQUE(job_id, statement_type, item_key)
    );

    CREATE INDEX IF NOT EXISTS idx_analysis_statement_items_job
      ON analysis_statement_items(job_id, statement_type);

    CREATE TABLE IF NOT EXISTS analysis_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL UNIQUE,
      base_score INTEGER NOT NULL,
      rating TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      summary TEXT NOT NULL,
      profitability_analysis TEXT NOT NULL,
      cash_flow_analysis TEXT NOT NULL,
      dimension_scores TEXT NOT NULL,
      metrics TEXT NOT NULL,
      period_comparisons TEXT NOT NULL DEFAULT '[]',
      ai_analysis TEXT NOT NULL DEFAULT '{}',
      ai_status TEXT NOT NULL DEFAULT 'disabled',
      deductions TEXT NOT NULL,
      report_exported_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES analysis_jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_analysis_results_job
      ON analysis_results(job_id);
  `);

  seedActivationCodes();
  seedProjects();
  seedSystemConfigs();
  runLightweightMigrations();
}

function runLightweightMigrations() {
  const jobColumns = db.prepare("PRAGMA table_info(analysis_jobs)").all().map((column) => column.name);
  if (!jobColumns.includes("confirmed_at")) {
    db.exec("ALTER TABLE analysis_jobs ADD COLUMN confirmed_at TEXT;");
  }

  const uploadColumns = db.prepare("PRAGMA table_info(analysis_uploads)").all().map((column) => column.name);
  if (!uploadColumns.includes("parse_audit")) {
    db.exec("ALTER TABLE analysis_uploads ADD COLUMN parse_audit TEXT NOT NULL DEFAULT '{}';");
  }
  if (!uploadColumns.includes("structured_tables")) {
    db.exec("ALTER TABLE analysis_uploads ADD COLUMN structured_tables TEXT NOT NULL DEFAULT '[]';");
  }

  const resultColumns = db.prepare("PRAGMA table_info(analysis_results)").all().map((column) => column.name);
  if (!resultColumns.includes("report_exported_at")) {
    db.exec("ALTER TABLE analysis_results ADD COLUMN report_exported_at TEXT;");
  }
  if (!resultColumns.includes("period_comparisons")) {
    db.exec("ALTER TABLE analysis_results ADD COLUMN period_comparisons TEXT NOT NULL DEFAULT '[]';");
  }
  if (!resultColumns.includes("ai_analysis")) {
    db.exec("ALTER TABLE analysis_results ADD COLUMN ai_analysis TEXT NOT NULL DEFAULT '{}';");
  }
  if (!resultColumns.includes("ai_status")) {
    db.exec("ALTER TABLE analysis_results ADD COLUMN ai_status TEXT NOT NULL DEFAULT 'disabled';");
  }
  mergeSystemConfig("parser_settings", {
    usePython: true,
    strategy: "python_pdfplumber_camelot_docling_then_pdfjs",
    pythonPath: process.env.PYTHON_PARSER_BIN || process.env.PYTHON || "python",
    engines: ["pdfplumber", "camelot", "docling"],
    keepSourceTrace: true,
    tableConfidenceThreshold: 0.75,
    camelotFlavors: ["lattice", "stream"],
    camelotMinAccuracy: 75,
    camelotRetryLowAccuracy: true,
    camelotTableAreas: [],
    camelotTableRegions: [],
    pdfplumberTableSettings: {
      vertical_strategy: "lines",
      horizontal_strategy: "lines",
      snap_tolerance: 3,
      join_tolerance: 3,
      intersection_tolerance: 3,
    },
    saveVisualDebugImages: true,
    visualDebugLimit: 3,
    coordinateTraceLimit: 160,
    ocrEnabled: true,
    deepLayoutValidation: true,
    doclingMode: "auto",
    scanBenchmarkMinTextChars: 80,
    timeoutMs: 90000,
    note:
      "Production parser tries pdfplumber and Camelot for electronic PDFs, routes scanned or low-text PDFs to Docling/OCR, and falls back to Node pdfjs.",
  });
  mergeSystemConfig("ai_settings", {
    enabled: false,
    provider: "deepseek",
    apiKey: "",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    temperature: 0.2,
    maxTokens: 2000,
    timeoutMs: 60000,
    structuredJson: true,
  });
  mergeSystemConfig("unified_activation", {
    enabled: true,
    baseUrl: "https://api.pindoupicture.cn",
    productKey: "financial-three-statements",
    channel: "financial-pwa",
    maxSessions: 2,
    timeoutMs: 8000,
    note:
      "Financial PWA can redeem activation codes issued from the shared Pindou operator console at https://pindoupicture.cn/admin/.",
  });
}

function mergeSystemConfig(key, defaults, preferDefaults = false) {
  const row = db.prepare("SELECT value FROM system_configs WHERE key = ?").get(key);
  if (!row) return;
  try {
    const current = JSON.parse(row.value);
    const merged = preferDefaults ? { ...current, ...defaults } : { ...defaults, ...current };
    db.prepare("UPDATE system_configs SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?").run(
      JSON.stringify(merged),
      key,
    );
  } catch {
    db.prepare("UPDATE system_configs SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?").run(
      JSON.stringify(defaults),
      key,
    );
  }
}

function seedActivationCodes() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM activation_codes").get().count;
  if (count > 0) return;

  const insert = db.prepare(`
    INSERT INTO activation_codes (code, status, valid_until, max_sessions)
    VALUES (?, ?, ?, ?)
  `);

  insert.run("FIN-2026-A8K2-MPWA", "active", "2026-06-12T23:59:59+08:00", 2);
  insert.run("FIN-2026-R7Q1-TRIAL", "inactive", "2026-05-20T23:59:59+08:00", 2);
  insert.run("FIN-2026-X9P5-EXPRD", "active", "2026-05-01T23:59:59+08:00", 2);
}

function seedProjects() {
  const activeCode = db.prepare("SELECT id FROM activation_codes WHERE code = ?").get("FIN-2026-A8K2-MPWA");
  if (!activeCode) return;

  const count = db
    .prepare("SELECT COUNT(*) AS count FROM projects WHERE activation_code_id = ?")
    .get(activeCode.id).count;
  if (count > 0) return;

  const insert = db.prepare(`
    INSERT INTO projects (
      activation_code_id,
      company_name,
      industry,
      reporting_period,
      standard,
      currency,
      score,
      rating,
      main_risks,
      generated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insert.run(
    activeCode.id,
    "某科技股份有限公司",
    "互联网/软件",
    "2025 年度",
    "CAS",
    "CNY",
    82,
    "A",
    JSON.stringify(["利润现金含量偏弱", "收入增长稳健"]),
    "2026-05-13T19:40:00+08:00",
  );
  insert.run(
    activeCode.id,
    "全球制造贸易集团",
    "制造业",
    "2024 年度",
    "IFRS",
    "USD",
    47,
    "C",
    JSON.stringify(["经营现金流为负", "毛利率下滑"]),
    "2026-05-12T14:22:00+08:00",
  );
}

function seedSystemConfigs() {
  const configs = [
    [
      "public_options",
      {
        industries: ["制造业", "零售业", "房地产", "互联网/软件", "金融", "建筑", "医药", "能源", "其他"],
        currencies: ["CNY", "USD", "HKD", "EUR", "GBP", "JPY", "SGD", "AUD", "KRW", "TWD"],
        units: ["元", "千元", "万元", "百万元"],
        standards: ["CAS", "IFRS"],
        languages: ["中文", "英文"],
      },
    ],
    [
      "disclaimer",
      {
        text:
          "本报告仅基于用户上传并确认的财务报表数据、系统计算指标及风险识别规则生成，用于辅助理解企业财务状况、盈利质量、现金流表现和潜在风险，不构成投资建议、买卖建议、授信建议、审计意见或任何形式的决策结论。原始 PDF 仅用于解析和校对，服务器临时保留 1 天，到期自动清理。",
      },
    ],
    [
      "scoring_weights",
      {
        profitability: 30,
        cashFlowQuality: 30,
        solvency: 15,
        operatingEfficiency: 10,
        growth: 10,
        financialStructure: 5,
      },
    ],
    [
      "industry_benchmarks",
      {
        "互联网/软件": {
          grossMargin: [30, 55],
          netMargin: [8, 22],
          operatingCashFlowToNetProfit: [0.8, 1.5],
          returnOnAssets: [0.04, 0.1],
          returnOnEquity: [0.08, 0.18],
          currentRatio: [1.5, 3],
          quickRatio: [1.1, 2.2],
          receivablesTurnover: [5, 10],
          inventoryTurnover: [8, 16],
          interestCoverage: [3, 8],
        },
        制造业: {
          grossMargin: [18, 35],
          netMargin: [4, 12],
          operatingCashFlowToNetProfit: [0.7, 1.3],
          returnOnAssets: [0.03, 0.08],
          returnOnEquity: [0.06, 0.15],
          currentRatio: [1.2, 2],
          quickRatio: [0.8, 1.2],
          receivablesTurnover: [4, 8],
          inventoryTurnover: [3, 6],
          interestCoverage: [2, 5],
        },
      },
    ],
    [
      "parser_settings",
      {
        usePython: true,
        strategy: "python_pdfplumber_camelot_docling_then_pdfjs",
        pythonPath: "python",
        engines: ["pdfplumber", "camelot", "docling"],
        keepSourceTrace: true,
        tableConfidenceThreshold: 0.75,
        camelotFlavors: ["lattice", "stream"],
        camelotMinAccuracy: 75,
        camelotRetryLowAccuracy: true,
        camelotTableAreas: [],
        camelotTableRegions: [],
        pdfplumberTableSettings: {
          vertical_strategy: "lines",
          horizontal_strategy: "lines",
          snap_tolerance: 3,
          join_tolerance: 3,
          intersection_tolerance: 3,
        },
        saveVisualDebugImages: true,
        visualDebugLimit: 3,
        coordinateTraceLimit: 160,
        ocrEnabled: true,
        deepLayoutValidation: true,
        doclingMode: "auto",
        scanBenchmarkMinTextChars: 80,
        timeoutMs: 90000,
        note:
          "Production parser tries pdfplumber and Camelot for electronic PDFs, routes scanned or low-text PDFs to Docling/OCR, and falls back to Node pdfjs.",
      },
    ],
    [
      "ai_settings",
      {
        enabled: false,
        provider: "deepseek",
        apiKey: "",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
        temperature: 0.2,
        maxTokens: 2000,
        timeoutMs: 60000,
        structuredJson: true,
      },
    ],
    [
      "unified_activation",
      {
        enabled: true,
        baseUrl: "https://api.pindoupicture.cn",
        productKey: "financial-three-statements",
        channel: "financial-pwa",
        maxSessions: 2,
        timeoutMs: 8000,
        note:
          "Financial PWA can redeem activation codes issued from the shared Pindou operator console at https://pindoupicture.cn/admin/.",
      },
    ],
    [
      "ai_prompt",
      {
        system:
          "你是面向非财务用户的企业财务三表分析助手。请基于结构化报表数据、关键指标和行业基准，输出投资分析视角的评分解释、盈利质量、现金流质量、风险清单和下一步核查建议。不要声称构成证券投资建议。",
        scoreAdjustmentLimit: 10,
      },
    ],
  ];

  const insert = db.prepare(`
    INSERT INTO system_configs (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO NOTHING
  `);

  for (const [key, value] of configs) {
    insert.run(key, JSON.stringify(value));
  }
}

export function getDatabasePath() {
  return dbPath;
}
