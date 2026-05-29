import { createReadStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import PDFDocument from "pdfkit";
import { db, getDatabasePath, initializeDatabase } from "./db.js";
import { enrichMetric } from "./metricRegistry.js";
import { parseStatementPdf, STATEMENT_SCHEMAS } from "./pdfParser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(__dirname);
const PORT = Number(process.env.PORT || 4173);
const SESSION_WINDOW_MINUTES = Number(process.env.SESSION_WINDOW_MINUTES || 30);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || (process.env.NODE_ENV === "production" ? "" : "dev-admin-token");
const UPLOAD_ROOT = join(rootDir, "data", "uploads");
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 25 * 1024 * 1024);
const SOURCE_PDF_RETENTION_HOURS = Number(process.env.SOURCE_PDF_RETENTION_HOURS || 24);
const REPORT_FONT_CANDIDATES = [
  process.env.REPORT_FONT_PATH,
  "C:\\Windows\\Fonts\\NotoSansSC-VF.ttf",
  "C:\\Windows\\Fonts\\simhei.ttf",
  "C:\\Windows\\Fonts\\simsunb.ttf",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
].filter(Boolean);
const MODEL_REPORT_NOTE =
  "备注：本报告的自动化解读能力接入 DeepSeek V4 大模型，并结合专业财务分析人员的测试、校准与规则调整生成。报告内容仅基于用户上传并确认的财务报表数据、系统计算指标及风险识别规则，用于辅助理解企业财务状况、盈利质量、现金流表现和潜在风险，不构成投资建议、买卖建议、授信建议、审计意见或任何形式的决策结论。";

initializeDatabase();
mkdirSync(UPLOAD_ROOT, { recursive: true });
cleanupExpiredSourcePdfs();
setInterval(cleanupExpiredSourcePdfs, 60 * 60 * 1000).unref();

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
]);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    serveStatic(url, res);
  } catch (error) {
    console.error(error);
    sendJson(res, error.statusCode || 500, {
      error: {
        code: error.statusCode ? "BAD_REQUEST" : "INTERNAL_ERROR",
        message: error.statusCode ? error.message : "服务器内部错误。",
      },
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Financial Statement Analyzer running at http://127.0.0.1:${PORT}/index.html`);
  console.log(`SQLite database: ${getDatabasePath()}`);
});

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    return;
  }

  if (url.pathname.startsWith("/api/admin/")) {
    await handleAdminApi(req, res, url);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/activation/verify") {
    const body = await readJson(req);
    await verifyActivation(req, res, body);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/activation/heartbeat") {
    const session = authenticate(req, res);
    if (!session) return;

    db.prepare("UPDATE sessions SET last_active = CURRENT_TIMESTAMP WHERE token = ?").run(session.token);
    sendJson(res, 200, {
      ok: true,
      activation: serializeActivation(session),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/activation/logout") {
    const token = readBearerToken(req);
    if (token) {
      db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/projects") {
    const session = authenticate(req, res);
    if (!session) return;

    const projects = db
      .prepare(
        `
          SELECT id, company_name, industry, reporting_period, standard, currency, score, rating, main_risks, generated_at
          FROM projects
          WHERE activation_code_id = ?
          ORDER BY generated_at DESC
        `,
      )
      .all(session.activation_code_id)
      .map(serializeProject);

    sendJson(res, 200, { projects });
    return;
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/(\d+)$/);
  if (req.method === "DELETE" && projectMatch) {
    const session = authenticate(req, res);
    if (!session) return;

    const id = Number(projectMatch[1]);
    const result = db
      .prepare("DELETE FROM projects WHERE id = ? AND activation_code_id = ?")
      .run(id, session.activation_code_id);
    sendJson(res, 200, { ok: true, deleted: result.changes });
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/api/projects") {
    const session = authenticate(req, res);
    if (!session) return;

    const result = db.prepare("DELETE FROM projects WHERE activation_code_id = ?").run(session.activation_code_id);
    sendJson(res, 200, { ok: true, deleted: result.changes });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config/public") {
    const rows = db
      .prepare("SELECT key, value FROM system_configs WHERE key IN ('public_options', 'disclaimer')")
      .all();
    const config = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
    sendJson(res, 200, { config });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/analysis/jobs") {
    const session = authenticate(req, res);
    if (!session) return;

    const body = await readJson(req);
    const job = createAnalysisJob(session.activation_code_id, body);
    sendJson(res, 201, { job });
    return;
  }

  const analysisStatusMatch = url.pathname.match(/^\/api\/analysis\/jobs\/(\d+)\/status$/);
  if (req.method === "GET" && analysisStatusMatch) {
    const session = authenticate(req, res);
    if (!session) return;

    const job = getAnalysisJob(Number(analysisStatusMatch[1]), session.activation_code_id);
    if (!job) {
      sendJson(res, 404, { error: { code: "JOB_NOT_FOUND", message: "分析任务不存在。" } });
      return;
    }
    sendJson(res, 200, { job });
    return;
  }

  const analysisUploadMatch = url.pathname.match(/^\/api\/analysis\/jobs\/(\d+)\/upload$/);
  if (req.method === "POST" && analysisUploadMatch) {
    const session = authenticate(req, res);
    if (!session) return;

    const body = await readJson(req);
    const jobId = Number(analysisUploadMatch[1]);
    const upload = uploadStatementFile(jobId, session.activation_code_id, body);
    const job = getAnalysisJob(jobId, session.activation_code_id);
    sendJson(res, 201, { upload, job });
    return;
  }

  const analysisParseMatch = url.pathname.match(/^\/api\/analysis\/jobs\/(\d+)\/parse$/);
  if (req.method === "POST" && analysisParseMatch) {
    const session = authenticate(req, res);
    if (!session) return;

    const job = await parseAnalysisJob(Number(analysisParseMatch[1]), session.activation_code_id);
    sendJson(res, 200, { job });
    return;
  }

  const analysisStatementsMatch = url.pathname.match(/^\/api\/analysis\/jobs\/(\d+)\/statements$/);
  if (req.method === "GET" && analysisStatementsMatch) {
    const session = authenticate(req, res);
    if (!session) return;

    const statements = getAnalysisStatements(Number(analysisStatementsMatch[1]), session.activation_code_id);
    sendJson(res, 200, { statements });
    return;
  }

  if (req.method === "PUT" && analysisStatementsMatch) {
    const session = authenticate(req, res);
    if (!session) return;

    const body = await readJson(req);
    const statements = updateAnalysisStatements(Number(analysisStatementsMatch[1]), session.activation_code_id, body);
    sendJson(res, 200, { statements });
    return;
  }

  const analysisConfirmMatch = url.pathname.match(/^\/api\/analysis\/jobs\/(\d+)\/confirm$/);
  if (req.method === "POST" && analysisConfirmMatch) {
    const session = authenticate(req, res);
    if (!session) return;

    const job = confirmAnalysisStatements(Number(analysisConfirmMatch[1]), session.activation_code_id);
    sendJson(res, 200, { job });
    return;
  }

  const analysisCalculateMatch = url.pathname.match(/^\/api\/analysis\/jobs\/(\d+)\/calculate$/);
  if (req.method === "POST" && analysisCalculateMatch) {
    const session = authenticate(req, res);
    if (!session) return;

    const analysis = await calculateAnalysisResult(Number(analysisCalculateMatch[1]), session.activation_code_id);
    sendJson(res, 200, { analysis });
    return;
  }

  const analysisResultMatch = url.pathname.match(/^\/api\/analysis\/jobs\/(\d+)\/analysis$/);
  if (req.method === "GET" && analysisResultMatch) {
    const session = authenticate(req, res);
    if (!session) return;

    const analysis = getAnalysisResult(Number(analysisResultMatch[1]), session.activation_code_id);
    if (!analysis) {
      sendJson(res, 404, { error: { code: "ANALYSIS_NOT_FOUND", message: "分析结果尚未生成。" } });
      return;
    }
    sendJson(res, 200, { analysis });
    return;
  }

  const reportExportMatch = url.pathname.match(/^\/api\/analysis\/jobs\/(\d+)\/report\.pdf$/);
  if (req.method === "GET" && reportExportMatch) {
    const session = authenticate(req, res);
    if (!session) return;

    await exportAnalysisPdfReport(Number(reportExportMatch[1]), session.activation_code_id, res);
    return;
  }

  sendJson(res, 404, {
    error: {
      code: "NOT_FOUND",
      message: "接口不存在。",
    },
  });
}

async function handleAdminApi(req, res, url) {
  if (!authenticateAdmin(req, res)) return;

  if (req.method === "GET" && url.pathname === "/api/admin/activation-codes") {
    const rows = db
      .prepare(
        `
          SELECT
            activation_codes.id,
            activation_codes.code,
            activation_codes.status,
            activation_codes.valid_until,
            activation_codes.max_sessions,
            activation_codes.created_at,
            activation_codes.updated_at,
            COUNT(sessions.id) AS active_sessions
          FROM activation_codes
          LEFT JOIN sessions ON sessions.activation_code_id = activation_codes.id
            AND sessions.last_active >= datetime('now', ?)
            AND sessions.expires_at > CURRENT_TIMESTAMP
          GROUP BY activation_codes.id
          ORDER BY activation_codes.created_at DESC, activation_codes.id DESC
        `,
      )
      .all(`-${SESSION_WINDOW_MINUTES} minutes`);

    sendJson(res, 200, { activationCodes: rows.map(serializeAdminActivationCode) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/activation-codes") {
    const body = await readJson(req);
    const activationCode = createActivationCode(body);
    sendJson(res, 201, { activationCode });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/activation-codes/bulk") {
    const body = await readJson(req);
    const activationCodes = bulkCreateActivationCodes(body);
    sendJson(res, 201, { activationCodes });
    return;
  }

  const activationCodeMatch = url.pathname.match(/^\/api\/admin\/activation-codes\/(\d+)$/);
  if (req.method === "PATCH" && activationCodeMatch) {
    const body = await readJson(req);
    const activationCode = updateActivationCode(Number(activationCodeMatch[1]), body);
    sendJson(res, 200, { activationCode });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/configs") {
    sendJson(res, 200, { configs: getConfigs() });
    return;
  }

  const configMatch = url.pathname.match(/^\/api\/admin\/configs\/([a-zA-Z0-9_-]+)$/);
  if (req.method === "PUT" && configMatch) {
    const body = await readJson(req);
    const config = updateConfig(configMatch[1], body.value);
    sendJson(res, 200, { config });
    return;
  }

  sendJson(res, 404, {
    error: {
      code: "NOT_FOUND",
      message: "后台接口不存在。",
    },
  });
}

function authenticateAdmin(req, res) {
  if (req.headers["x-admin-token"] === ADMIN_TOKEN) {
    return true;
  }

  sendJson(res, 401, {
    error: {
      code: "ADMIN_UNAUTHORIZED",
      message: "管理员令牌无效。",
    },
  });
  return false;
}

function createActivationCode(body) {
  const code = normalizeActivationCode(body.code || generateActivationCode("FIN"));
  const status = normalizeStatus(body.status || "active");
  const validUntil = normalizeValidUntil(body.validUntil);
  const maxSessions = normalizeMaxSessions(body.maxSessions);

  try {
    const result = db
      .prepare(
        `
          INSERT INTO activation_codes (code, status, valid_until, max_sessions, updated_at)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        `,
      )
      .run(code, status, validUntil, maxSessions);

    return getAdminActivationCode(result.lastInsertRowid);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      throwHttpError(409, "激活码已存在，请换一个或留空自动生成。");
    }
    throw error;
  }
}

function bulkCreateActivationCodes(body) {
  const count = normalizeBulkCount(body.count);
  const prefix = normalizeActivationPrefix(body.prefix || "FIN");
  const status = normalizeStatus(body.status || "active");
  const validUntil = normalizeValidUntil(body.validUntil);
  const maxSessions = normalizeMaxSessions(body.maxSessions);
  const insert = db.prepare(
    `
      INSERT INTO activation_codes (code, status, valid_until, max_sessions, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `,
  );
  const created = [];

  for (let i = 0; i < count; i += 1) {
    let code = generateActivationCode(prefix);
    while (db.prepare("SELECT id FROM activation_codes WHERE code = ?").get(code)) {
      code = generateActivationCode(prefix);
    }
    const result = insert.run(code, status, validUntil, maxSessions);
    created.push(getAdminActivationCode(result.lastInsertRowid));
  }

  return created;
}

function updateActivationCode(id, body) {
  const existing = getAdminActivationCode(id);
  if (!existing) {
    throwHttpError(404, "激活码不存在。");
  }

  const status = body.status === undefined ? existing.status : normalizeStatus(body.status);
  const validUntil = body.validUntil === undefined ? existing.validUntil : normalizeValidUntil(body.validUntil);
  const maxSessions = body.maxSessions === undefined ? existing.maxSessions : normalizeMaxSessions(body.maxSessions);

  db.prepare(
    `
      UPDATE activation_codes
      SET status = ?, valid_until = ?, max_sessions = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
  ).run(status, validUntil, maxSessions, id);

  if (status !== "active") {
    db.prepare("DELETE FROM sessions WHERE activation_code_id = ?").run(id);
  }

  return getAdminActivationCode(id);
}

function getAdminActivationCode(id) {
  const row = db
    .prepare(
      `
        SELECT
          activation_codes.id,
          activation_codes.code,
          activation_codes.status,
          activation_codes.valid_until,
          activation_codes.max_sessions,
          activation_codes.created_at,
          activation_codes.updated_at,
          COUNT(sessions.id) AS active_sessions
        FROM activation_codes
        LEFT JOIN sessions ON sessions.activation_code_id = activation_codes.id
          AND sessions.last_active >= datetime('now', ?)
          AND sessions.expires_at > CURRENT_TIMESTAMP
        WHERE activation_codes.id = ?
        GROUP BY activation_codes.id
      `,
    )
    .get(`-${SESSION_WINDOW_MINUTES} minutes`, id);

  return row ? serializeAdminActivationCode(row) : null;
}

function getConfigs() {
  const rows = db.prepare("SELECT key, value, updated_at FROM system_configs ORDER BY key").all();
  return rows.map((row) => ({
    key: row.key,
    value: JSON.parse(row.value),
    updatedAt: row.updated_at,
  }));
}

function updateConfig(key, value) {
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
    throwHttpError(400, "配置键名不合法。");
  }

  if (value === undefined) {
    throwHttpError(400, "配置内容不能为空。");
  }

  const serialized = JSON.stringify(value);
  db.prepare(
    `
      INSERT INTO system_configs (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `,
  ).run(key, serialized);

  return db
    .prepare("SELECT key, value, updated_at FROM system_configs WHERE key = ?")
    .all(key)
    .map((row) => ({ key: row.key, value: JSON.parse(row.value), updatedAt: row.updated_at }))[0];
}

async function verifyActivation(req, res, body) {
  const code = String(body.code || "")
    .trim()
    .toUpperCase();
  const existingToken = typeof body.existingToken === "string" ? body.existingToken : "";

  if (!code) {
    sendJson(res, 400, {
      error: { code: "MISSING_CODE", message: "请输入激活码。" },
    });
    return;
  }

  let activation = db.prepare("SELECT * FROM activation_codes WHERE code = ?").get(code);
  if (!activation) {
    const remote = await redeemUnifiedActivation(code);
    if (remote?.record) {
      activation = upsertRemoteActivationMirror(remote.record);
    }
  }
  if (!activation) {
    sendJson(res, 404, {
      error: { code: "INVALID_CODE", message: "激活码不存在或输入有误。" },
    });
    return;
  }

  if (activation.status !== "active") {
    sendJson(res, 403, {
      error: { code: "INACTIVE_CODE", message: "该激活码未启用，请联系售后支持。" },
    });
    return;
  }

  if (isExpired(activation.valid_until)) {
    deleteActivationProjects(activation.id);
    sendJson(res, 403, {
      error: { code: "EXPIRED_CODE", message: "该激活码已过期，历史摘要已按规则删除。" },
    });
    return;
  }

  pruneSessions(activation.id);

  if (existingToken) {
    const existingSession = getValidSession(existingToken);
    if (existingSession && existingSession.activation_code_id === activation.id) {
      db.prepare("UPDATE sessions SET last_active = CURRENT_TIMESTAMP WHERE token = ?").run(existingToken);
      sendJson(res, 200, {
        token: existingToken,
        activation: serializeActivation({ ...existingSession, ...activation, activation_code_id: activation.id }),
      });
      return;
    }
  }

  const activeSessions = db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM sessions
        WHERE activation_code_id = ?
          AND last_active >= datetime('now', ?)
          AND expires_at > CURRENT_TIMESTAMP
      `,
    )
    .get(activation.id, `-${SESSION_WINDOW_MINUTES} minutes`).count;

  if (activeSessions >= activation.max_sessions) {
    sendJson(res, 409, {
      error: {
        code: "SESSION_LIMIT",
        message: `该激活码已达到 ${activation.max_sessions} 个同时在线会话限制。`,
      },
    });
    return;
  }

  const token = randomUUID();
  db.prepare(
    `
      INSERT INTO sessions (activation_code_id, token, ip, user_agent, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `,
  ).run(activation.id, token, clientIp(req), req.headers["user-agent"] || "", activation.valid_until);

  sendJson(res, 200, {
    token,
    activation: serializeActivation({ ...activation, activation_code_id: activation.id }),
  });
}

async function redeemUnifiedActivation(code) {
  const settings = getConfigValue("unified_activation", {
    enabled: false,
    baseUrl: "",
    productKey: "financial-three-statements",
    channel: "financial-pwa",
    timeoutMs: 8000,
  });
  if (!settings.enabled || !settings.baseUrl) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(settings.timeoutMs || 8000));
  try {
    const response = await fetch(`${String(settings.baseUrl).replace(/\/$/, "")}/activation/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        code,
        productKey: settings.productKey || "financial-three-statements",
        channel: settings.channel || "financial-pwa",
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { error: payload.message || payload.detail || "统一激活码服务校验失败" };
    }
    return payload;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function upsertRemoteActivationMirror(record) {
  const settings = getConfigValue("unified_activation", {});
  const code = String(record.code || "").trim().toUpperCase();
  if (!code) return null;
  const status = record.status === "disabled" || record.status === "expired" ? record.status : "active";
  const validUntil = normalizeRemoteValidUntil(record.expiresAt || record.validUntil);
  const maxSessions = Number(settings.maxSessions || 2);
  db.prepare(
    `
      INSERT INTO activation_codes (code, status, valid_until, max_sessions, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(code) DO UPDATE SET
        status = excluded.status,
        valid_until = excluded.valid_until,
        max_sessions = excluded.max_sessions,
        updated_at = CURRENT_TIMESTAMP
    `,
  ).run(code, status, validUntil, maxSessions);
  return db.prepare("SELECT * FROM activation_codes WHERE code = ?").get(code);
}

function normalizeRemoteValidUntil(value) {
  if (!value) return "2099-12-31T23:59:59+08:00";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "2099-12-31T23:59:59+08:00" : date.toISOString();
}

function authenticate(req, res) {
  const token = readBearerToken(req);
  const session = token ? getValidSession(token) : null;

  if (!session) {
    sendJson(res, 401, {
      error: { code: "UNAUTHORIZED", message: "授权会话无效或已过期，请重新输入激活码。" },
    });
    return null;
  }

  if (isExpired(session.valid_until)) {
    deleteActivationProjects(session.activation_code_id);
    db.prepare("DELETE FROM sessions WHERE activation_code_id = ?").run(session.activation_code_id);
    sendJson(res, 401, {
      error: { code: "EXPIRED_CODE", message: "激活码已过期，历史摘要已删除。" },
    });
    return null;
  }

  db.prepare("UPDATE sessions SET last_active = CURRENT_TIMESTAMP WHERE token = ?").run(token);
  return session;
}

function getValidSession(token) {
  const session = db
    .prepare(
      `
        SELECT
          sessions.token,
          sessions.activation_code_id,
          sessions.last_active,
          activation_codes.code,
          activation_codes.status,
          activation_codes.valid_until,
          activation_codes.max_sessions
        FROM sessions
        JOIN activation_codes ON activation_codes.id = sessions.activation_code_id
        WHERE sessions.token = ?
          AND sessions.last_active >= datetime('now', ?)
          AND sessions.expires_at > CURRENT_TIMESTAMP
          AND activation_codes.status = 'active'
      `,
    )
    .get(token, `-${SESSION_WINDOW_MINUTES} minutes`);

  return session || null;
}

function pruneSessions(activationCodeId) {
  db.prepare(
    `
      DELETE FROM sessions
      WHERE activation_code_id = ?
        AND (last_active < datetime('now', ?) OR expires_at <= CURRENT_TIMESTAMP)
    `,
  ).run(activationCodeId, `-${SESSION_WINDOW_MINUTES} minutes`);
}

function deleteActivationProjects(activationCodeId) {
  db.prepare("DELETE FROM projects WHERE activation_code_id = ?").run(activationCodeId);
}

function serializeActivation(row) {
  return {
    code: row.code,
    status: row.status,
    validUntil: row.valid_until,
    maxSessions: row.max_sessions,
  };
}

function serializeAdminActivationCode(row) {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    validUntil: row.valid_until,
    maxSessions: row.max_sessions,
    activeSessions: row.active_sessions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeProject(row) {
  return {
    id: row.id,
    companyName: row.company_name,
    industry: row.industry,
    reportingPeriod: row.reporting_period,
    standard: row.standard,
    currency: row.currency,
    score: row.score,
    rating: row.rating,
    mainRisks: JSON.parse(row.main_risks),
    generatedAt: row.generated_at,
  };
}

function createAnalysisJob(activationCodeId, body) {
  const analysisType = normalizeAnalysisType(body.analysisType);
  const language = normalizeOneOf(body.language, ["中文", "英文"], "报表语言");
  const accountingStandard = normalizeOneOf(body.accountingStandard, ["CAS", "IFRS"], "会计准则");
  const industry = normalizeText(body.industry, "行业");
  const currency = normalizeOneOf(
    body.currency,
    ["CNY", "USD", "HKD", "EUR", "GBP", "JPY", "SGD", "AUD", "KRW", "TWD"],
    "币种",
  );
  const amountUnit = normalizeOneOf(body.amountUnit, ["元", "千元", "万元", "百万元"], "金额单位");

  const result = db
    .prepare(
      `
        INSERT INTO analysis_jobs (
          activation_code_id,
          analysis_type,
          language,
          accounting_standard,
          industry,
          currency,
          amount_unit,
          status,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'created', CURRENT_TIMESTAMP)
      `,
    )
    .run(activationCodeId, analysisType, language, accountingStandard, industry, currency, amountUnit);

  return getAnalysisJob(result.lastInsertRowid, activationCodeId);
}

function uploadStatementFile(jobId, activationCodeId, body) {
  const job = getAnalysisJob(jobId, activationCodeId);
  if (!job) {
    throwHttpError(404, "分析任务不存在。");
  }

  const statementType = normalizeOneOf(
    body.statementType,
    ["balance_sheet", "income_statement", "cash_flow"],
    "报表类型",
  );
  const period = normalizeOneOf(body.period || "current", ["current", "previous"], "报表期间");
  const fileName = sanitizeFileName(body.fileName || "");
  const mimeType = String(body.mimeType || "application/pdf").trim();
  const dataBase64 = String(body.dataBase64 || "");

  if (!fileName.toLowerCase().endsWith(".pdf")) {
    throwHttpError(400, "仅支持 PDF 文件。");
  }

  if (mimeType && !["application/pdf", "application/octet-stream"].includes(mimeType)) {
    throwHttpError(400, "文件类型必须是 PDF。");
  }

  const fileBuffer = Buffer.from(dataBase64, "base64");
  if (!fileBuffer.length) {
    throwHttpError(400, "上传文件为空。");
  }

  if (fileBuffer.length > MAX_UPLOAD_BYTES) {
    throwHttpError(413, "单个 PDF 文件不能超过 25MB。");
  }

  const signature = fileBuffer.subarray(0, 4).toString("utf8");
  if (signature !== "%PDF") {
    throwHttpError(400, "文件内容不是有效的电子 PDF。");
  }

  const jobDir = join(UPLOAD_ROOT, `job-${jobId}`);
  mkdirSync(jobDir, { recursive: true });
  const storedFileName = `${statementType}-${period}-${randomUUID()}.pdf`;
  const storedPath = join(jobDir, storedFileName);
  writeFileSync(storedPath, fileBuffer);

  db.prepare(
    `
      INSERT INTO analysis_uploads (
        job_id,
        statement_type,
        period,
        original_filename,
        stored_path,
        mime_type,
        file_size,
        status,
        parse_audit,
        structured_tables,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'uploaded', '{}', '[]', CURRENT_TIMESTAMP)
      ON CONFLICT(job_id, statement_type, period) DO UPDATE SET
        original_filename = excluded.original_filename,
        stored_path = excluded.stored_path,
        mime_type = excluded.mime_type,
        file_size = excluded.file_size,
        status = 'uploaded',
        parse_audit = '{}',
        structured_tables = '[]',
        updated_at = CURRENT_TIMESTAMP
    `,
  ).run(jobId, statementType, period, fileName, storedPath, mimeType || "application/pdf", fileBuffer.length);

  refreshAnalysisJobStatus(jobId, activationCodeId);

  return getAnalysisUpload(jobId, statementType, period);
}

function refreshAnalysisJobStatus(jobId, activationCodeId) {
  const job = db
    .prepare("SELECT analysis_type FROM analysis_jobs WHERE id = ? AND activation_code_id = ?")
    .get(jobId, activationCodeId);
  if (!job) return;

  const requiredCount = job.analysis_type === "two_period" ? 6 : 3;
  const uploadedCount = db
    .prepare("SELECT COUNT(*) AS count FROM analysis_uploads WHERE job_id = ? AND status IN ('uploaded', 'parsed')")
    .get(jobId).count;
  const status = uploadedCount >= requiredCount ? "ready_for_review" : "uploading";

  db.prepare("UPDATE analysis_jobs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, jobId);
}

function getAnalysisJob(jobId, activationCodeId) {
  const row = db
    .prepare(
      `
        SELECT
          id,
          analysis_type,
          language,
          accounting_standard,
          industry,
          currency,
          amount_unit,
          status,
          error_message,
          confirmed_at,
          created_at,
          updated_at
        FROM analysis_jobs
        WHERE id = ? AND activation_code_id = ?
      `,
    )
    .get(jobId, activationCodeId);

  if (!row) return null;

  const uploads = db
    .prepare(
      `
        SELECT id, statement_type, period, original_filename, mime_type, file_size, status, parse_audit, structured_tables, created_at, updated_at
        FROM analysis_uploads
        WHERE job_id = ?
        ORDER BY period, statement_type
      `,
    )
    .all(jobId)
    .map(serializeAnalysisUpload);

  return {
    id: row.id,
    analysisType: row.analysis_type,
    language: row.language,
    accountingStandard: row.accounting_standard,
    industry: row.industry,
    currency: row.currency,
    amountUnit: row.amount_unit,
    status: row.status,
    errorMessage: row.error_message,
    confirmedAt: row.confirmed_at,
    uploads,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getAnalysisUpload(jobId, statementType, period) {
  const row = db
    .prepare(
      `
        SELECT id, statement_type, period, original_filename, mime_type, file_size, status, parse_audit, structured_tables, created_at, updated_at
        FROM analysis_uploads
        WHERE job_id = ? AND statement_type = ? AND period = ?
      `,
    )
    .get(jobId, statementType, period);
  return serializeAnalysisUpload(row);
}

async function parseAnalysisJob(jobId, activationCodeId) {
  const job = getAnalysisJob(jobId, activationCodeId);
  if (!job) {
    throwHttpError(404, "分析任务不存在。");
  }

  if (!["ready_for_review", "parsed", "parse_failed"].includes(job.status)) {
    throwHttpError(409, "请先完成所有必需 PDF 上传。");
  }

  seedMissingStatementItems(jobId);
  db.prepare("UPDATE analysis_jobs SET status = 'parsing', error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
    jobId,
  );

  const uploads = db
    .prepare(
      `
        SELECT id, statement_type, period, stored_path
        FROM analysis_uploads
        WHERE job_id = ?
        ORDER BY period, statement_type
      `,
    )
    .all(jobId);

  let parsedCount = 0;
  try {
    for (const upload of uploads) {
      const parsedItems = await parseStatementPdf(upload.stored_path, upload.statement_type, getParserSettings());
      const parseMetadata = parsedItems.find((item) => item.parseMetadata)?.parseMetadata || {};
      for (const parsedItem of parsedItems) {
        upsertParsedStatementItem(jobId, upload.statement_type, upload.period, parsedItem);
      }
      db.prepare(
        `
          UPDATE analysis_uploads
          SET status = 'parsed',
              parse_audit = ?,
              structured_tables = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
      ).run(JSON.stringify(parseMetadata.layoutAudit || {}), JSON.stringify(parseMetadata.structuredTables || []), upload.id);
      parsedCount += 1;
    }

    const finalStatus = parsedCount > 0 ? "parsed" : "parse_failed";
    db.prepare("UPDATE analysis_jobs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(finalStatus, jobId);
    return getAnalysisJob(jobId, activationCodeId);
  } catch (error) {
    db.prepare(
      "UPDATE analysis_jobs SET status = 'parse_failed', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(error.message, jobId);
    throw error;
  }
}

function seedMissingStatementItems(jobId) {
  const insert = db.prepare(
    `
      INSERT INTO analysis_statement_items (
        job_id,
        statement_type,
        item_key,
        item_name,
        status,
        note,
        updated_at
      )
      VALUES (?, ?, ?, ?, 'missing', '等待 PDF 解析或用户补录。', CURRENT_TIMESTAMP)
      ON CONFLICT(job_id, statement_type, item_key) DO NOTHING
    `,
  );

  for (const [statementType, schema] of Object.entries(STATEMENT_SCHEMAS)) {
    for (const item of schema) {
      insert.run(jobId, statementType, item.key, item.name);
    }
  }
}

function upsertParsedStatementItem(jobId, statementType, period, parsedItem) {
  const existing = db
    .prepare(
      `
        SELECT current_amount, previous_amount, source_label, confidence, status, note
        FROM analysis_statement_items
        WHERE job_id = ? AND statement_type = ? AND item_key = ?
      `,
    )
    .get(jobId, statementType, parsedItem.itemKey);

  const currentAmount = period === "current" ? parsedItem.value : existing?.current_amount ?? null;
  const previousAmount = period === "previous" ? parsedItem.value : existing?.previous_amount ?? null;
  const confidence = Math.max(Number(existing?.confidence || 0), Number(parsedItem.confidence || 0));
  const sourceLabel = mergeSourceLabels(existing?.source_label, period, parsedItem.sourceLabel);
  const status = currentAmount !== null || previousAmount !== null ? "parsed" : parsedItem.status;
  const note = parsedItem.note || existing?.note || "";

  db.prepare(
    `
      INSERT INTO analysis_statement_items (
        job_id,
        statement_type,
        item_key,
        item_name,
        current_amount,
        previous_amount,
        source_label,
        confidence,
        status,
        note,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(job_id, statement_type, item_key) DO UPDATE SET
        item_name = excluded.item_name,
        current_amount = excluded.current_amount,
        previous_amount = excluded.previous_amount,
        source_label = excluded.source_label,
        confidence = excluded.confidence,
        status = excluded.status,
        note = excluded.note,
        updated_at = CURRENT_TIMESTAMP
    `,
  ).run(
    jobId,
    statementType,
    parsedItem.itemKey,
    parsedItem.itemName,
    currentAmount,
    previousAmount,
    sourceLabel,
    confidence,
    status,
    note,
  );
}

function mergeSourceLabels(existingLabel, period, nextLabel) {
  const labels = [];
  if (existingLabel) labels.push(existingLabel);
  if (nextLabel) labels.push(`${period === "previous" ? "上期" : "本期"}: ${nextLabel}`);
  return [...new Set(labels)].join(" | ");
}

function getAnalysisStatements(jobId, activationCodeId) {
  const job = getAnalysisJob(jobId, activationCodeId);
  if (!job) {
    throwHttpError(404, "分析任务不存在。");
  }

  const rows = db
    .prepare(
      `
        SELECT
          statement_type,
          item_key,
          item_name,
          current_amount,
          previous_amount,
          source_label,
          confidence,
          status,
          note,
          updated_at
        FROM analysis_statement_items
        WHERE job_id = ?
        ORDER BY
          CASE statement_type
            WHEN 'balance_sheet' THEN 1
            WHEN 'income_statement' THEN 2
            WHEN 'cash_flow' THEN 3
            ELSE 9
          END,
          id
      `,
    )
    .all(jobId);

  const uploads = db
    .prepare(
      `
        SELECT id, statement_type, period, original_filename, mime_type, file_size, status, parse_audit, structured_tables, created_at, updated_at
        FROM analysis_uploads
        WHERE job_id = ?
        ORDER BY period, statement_type
      `,
    )
    .all(jobId)
    .map(serializeAnalysisUpload);

  return {
    job,
    uploads,
    items: rows.map((row) => ({
      statementType: row.statement_type,
      itemKey: row.item_key,
      itemName: row.item_name,
      currentAmount: row.current_amount,
      previousAmount: row.previous_amount,
      sourceLabel: row.source_label,
      confidence: row.confidence,
      status: row.status,
      note: row.note,
      updatedAt: row.updated_at,
    })),
  };
}

function updateAnalysisStatements(jobId, activationCodeId, body) {
  const job = getAnalysisJob(jobId, activationCodeId);
  if (!job) {
    throwHttpError(404, "分析任务不存在。");
  }
  if (job.status === "confirmed") {
    throwHttpError(409, "该任务已经确认锁定，不能继续编辑。");
  }

  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) {
    throwHttpError(400, "请提交需要保存的标准科目数据。");
  }

  const update = db.prepare(
    `
      UPDATE analysis_statement_items
      SET current_amount = ?,
          previous_amount = ?,
          status = ?,
          note = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ?
        AND statement_type = ?
        AND item_key = ?
    `,
  );

  for (const item of items) {
    const statementType = normalizeOneOf(
      item.statementType,
      ["balance_sheet", "income_statement", "cash_flow"],
      "报表类型",
    );
    const itemKey = normalizeStatementItemKey(item.itemKey);
    const currentAmount = normalizeOptionalAmount(item.currentAmount, "本期金额");
    const previousAmount = normalizeOptionalAmount(item.previousAmount, "上期金额");
    const status = currentAmount !== null || previousAmount !== null ? "user_edited" : "missing";
    const note = status === "user_edited" ? "用户已确认或编辑该科目金额。" : "用户保留为空值。";
    const result = update.run(currentAmount, previousAmount, status, note, jobId, statementType, itemKey);
    if (result.changes === 0) {
      throwHttpError(404, `标准科目不存在：${statementType}/${itemKey}`);
    }
  }

  db.prepare("UPDATE analysis_jobs SET status = 'reviewing', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(jobId);
  return getAnalysisStatements(jobId, activationCodeId);
}

function confirmAnalysisStatements(jobId, activationCodeId) {
  const job = getAnalysisJob(jobId, activationCodeId);
  if (!job) {
    throwHttpError(404, "分析任务不存在。");
  }
  if (!["parsed", "reviewing", "confirmed"].includes(job.status)) {
    throwHttpError(409, "请先完成 PDF 解析和数据保存。");
  }

  const itemCount = db
    .prepare("SELECT COUNT(*) AS count FROM analysis_statement_items WHERE job_id = ?")
    .get(jobId).count;
  if (itemCount === 0) {
    throwHttpError(409, "没有可确认的标准科目数据。");
  }

  db.prepare(
    `
      UPDATE analysis_jobs
      SET status = 'confirmed',
          confirmed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
  ).run(jobId);

  return getAnalysisJob(jobId, activationCodeId);
}

async function calculateAnalysisResult(jobId, activationCodeId) {
  const job = getAnalysisJob(jobId, activationCodeId);
  if (!job) {
    throwHttpError(404, "分析任务不存在。");
  }
  if (job.status !== "confirmed") {
    throwHttpError(409, "请先确认并锁定三表数据，再生成分析结果。");
  }

  const statements = getConfirmedStatementMap(jobId);
  const weights = getConfigValue("scoring_weights", {
    profitability: 30,
    cashFlowQuality: 30,
    solvency: 15,
    operatingEfficiency: 10,
    growth: 10,
    financialStructure: 5,
  });
  const benchmarks = getIndustryBenchmark(job.industry);
  const { metrics } = buildMetrics(statements, benchmarks);
  const periodComparisons = buildPeriodComparisons(statements);
  const dimensionScores = buildDimensionScores(metrics, weights);
  const deductions = buildDeductions(metrics, statements);
  const baseScore = calculateWeightedScore(dimensionScores);
  const rating = ratingFromScore(baseScore);
  const recommendation = recommendationFromScore(baseScore, deductions);
  const summary = buildResultSummary(baseScore, rating, deductions, metrics);
  const profitabilityAnalysis = buildProfitabilityAnalysis(metrics);
  const cashFlowAnalysis = buildCashFlowAnalysis(metrics);
  const chartData = buildAnalysisCharts({ metrics, periodComparisons, dimensionScores, deductions });
  const sourceCatalog = buildSourceCatalog({ statements, metrics, periodComparisons, deductions });
  const aiResult = await buildDeepSeekAnalysis({
    job,
    statements,
    metrics,
    periodComparisons,
    deductions,
    chartData,
    sourceCatalog,
    baseScore,
    rating,
    recommendation,
    summary,
    profitabilityAnalysis,
    cashFlowAnalysis,
  });

  db.prepare(
    `
      INSERT INTO analysis_results (
        job_id,
        base_score,
        rating,
        recommendation,
        summary,
        profitability_analysis,
        cash_flow_analysis,
        dimension_scores,
        metrics,
        period_comparisons,
        ai_analysis,
        ai_status,
        deductions,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(job_id) DO UPDATE SET
        base_score = excluded.base_score,
        rating = excluded.rating,
        recommendation = excluded.recommendation,
        summary = excluded.summary,
        profitability_analysis = excluded.profitability_analysis,
        cash_flow_analysis = excluded.cash_flow_analysis,
        dimension_scores = excluded.dimension_scores,
        metrics = excluded.metrics,
        period_comparisons = excluded.period_comparisons,
        ai_analysis = excluded.ai_analysis,
        ai_status = excluded.ai_status,
        deductions = excluded.deductions,
        updated_at = CURRENT_TIMESTAMP
    `,
  ).run(
    jobId,
    baseScore,
    rating,
    recommendation,
    summary,
    profitabilityAnalysis,
    cashFlowAnalysis,
    JSON.stringify(dimensionScores),
    JSON.stringify(metrics),
    JSON.stringify(periodComparisons),
    JSON.stringify(aiResult.analysis),
    aiResult.status,
    JSON.stringify(deductions),
  );

  return getAnalysisResult(jobId, activationCodeId);
}

function getAnalysisResult(jobId, activationCodeId) {
  const job = getAnalysisJob(jobId, activationCodeId);
  if (!job) {
    throwHttpError(404, "分析任务不存在。");
  }

  const row = db
    .prepare(
      `
        SELECT
          id,
          job_id,
          base_score,
          rating,
          recommendation,
          summary,
          profitability_analysis,
          cash_flow_analysis,
          dimension_scores,
          metrics,
          period_comparisons,
          ai_analysis,
          ai_status,
          deductions,
          report_exported_at,
          created_at,
          updated_at
        FROM analysis_results
        WHERE job_id = ?
      `,
    )
    .get(jobId);

  return row ? serializeAnalysisResult(row, job) : null;
}

function getConfirmedStatementMap(jobId) {
  const rows = db
    .prepare(
      `
        SELECT statement_type, item_key, current_amount, previous_amount, status
        FROM analysis_statement_items
        WHERE job_id = ?
      `,
    )
    .all(jobId);

  const statements = {
    balance_sheet: {},
    income_statement: {},
    cash_flow: {},
  };

  for (const row of rows) {
    statements[row.statement_type][row.item_key] = {
      current: row.current_amount,
      previous: row.previous_amount,
      status: row.status,
    };
  }

  return statements;
}

function buildMetrics(statements, benchmarks) {
  const value = (statementType, itemKey, period = "current") =>
    statements[statementType]?.[itemKey]?.[period] ?? null;
  const bs = (key, period) => value("balance_sheet", key, period);
  const income = (key, period) => value("income_statement", key, period);
  const cf = (key, period) => value("cash_flow", key, period);

  const revenue = income("revenue");
  const previousRevenue = income("revenue", "previous");
  const costOfSales = income("cost_of_sales");
  const grossProfit = coalesce(income("gross_profit"), subtract(revenue, costOfSales));
  const previousGrossProfit = coalesce(
    income("gross_profit", "previous"),
    subtract(previousRevenue, income("cost_of_sales", "previous")),
  );
  const netProfit = income("net_profit");
  const operatingProfit = income("operating_profit");
  const totalProfit = income("total_profit");
  const incomeTax = income("income_tax");
  const sellingExpenses = income("selling_expenses");
  const administrativeExpenses = income("administrative_expenses");
  const financeExpenses = income("finance_expenses");
  const operatingExpenses = sumNullable(sellingExpenses, administrativeExpenses, financeExpenses);
  const operatingCashFlow = cf("net_operating_cash_flow");
  const investingCashFlow = cf("net_investing_cash_flow");
  const financingCashFlow = cf("net_financing_cash_flow");
  const freeCashFlowProxy = addNullable(operatingCashFlow, investingCashFlow);
  const totalAssets = bs("total_assets");
  const averageAssets = averageNullable(totalAssets, bs("total_assets", "previous"));
  const totalLiabilities = bs("total_liabilities");
  const totalEquity = bs("total_equity");
  const averageEquity = averageNullable(totalEquity, bs("total_equity", "previous"));
  const cash = coalesce(bs("cash"), cf("ending_cash"));
  const currentAssets = bs("total_current_assets");
  const currentLiabilities = bs("total_current_liabilities");
  const accountsReceivable = bs("accounts_receivable");
  const averageReceivables = averageNullable(accountsReceivable, bs("accounts_receivable", "previous"));
  const inventory = bs("inventory");
  const averageInventory = averageNullable(inventory, bs("inventory", "previous"));
  const accountsPayable = bs("accounts_payable");
  const receivablesTurnover = ratio(revenue, averageReceivables);
  const inventoryTurnover = ratio(costOfSales, averageInventory);

  const metrics = [
      ratioMetric("gross_margin", "毛利率", grossProfit, revenue, "盈利能力", "毛利 / 营业收入", "percent", higherStatus(ratio(grossProfit, revenue), benchmarks.grossMargin[0], benchmarks.grossMargin[1])),
      ratioMetric("net_margin", "净利率", netProfit, revenue, "盈利能力", "净利润 / 营业收入", "percent", higherStatus(ratio(netProfit, revenue), benchmarks.netMargin[0], benchmarks.netMargin[1])),
      ratioMetric("operating_margin", "营业利润率", operatingProfit, revenue, "盈利能力", "营业利润 / 营业收入", "percent", higherStatus(ratio(operatingProfit, revenue), 0.06, 0.15)),
      ratioMetric("cost_ratio", "成本收入比", costOfSales, revenue, "盈利能力", "营业成本 / 营业收入", "percent", lowerStatus(ratio(costOfSales, revenue), 0.55, 0.75)),
      ratioMetric("return_on_assets", "ROA 总资产回报率", netProfit, averageAssets, "盈利能力", "净利润 / 平均总资产", "percent", higherStatus(ratio(netProfit, averageAssets), benchmarks.returnOnAssets[0], benchmarks.returnOnAssets[1])),
      ratioMetric("return_on_equity", "ROE 净资产回报率", netProfit, averageEquity, "盈利能力", "净利润 / 平均所有者权益", "percent", higherStatus(ratio(netProfit, averageEquity), benchmarks.returnOnEquity[0], benchmarks.returnOnEquity[1])),
      ratioMetric("operating_expense_ratio", "期间费用率", operatingExpenses, revenue, "盈利能力", "销售费用、管理费用和财务费用合计 / 营业收入", "percent", lowerStatus(ratio(operatingExpenses, revenue), 0.18, 0.32)),
      ratioMetric("selling_expense_ratio", "销售费用率", sellingExpenses, revenue, "盈利能力", "销售费用 / 营业收入", "percent", lowerStatus(ratio(sellingExpenses, revenue), 0.08, 0.18)),
      ratioMetric("admin_expense_ratio", "管理费用率", administrativeExpenses, revenue, "盈利能力", "管理费用 / 营业收入", "percent", lowerStatus(ratio(administrativeExpenses, revenue), 0.08, 0.16)),
      ratioMetric("finance_expense_ratio", "财务费用率", financeExpenses, revenue, "偿债能力", "财务费用 / 营业收入", "percent", lowerStatus(ratio(financeExpenses, revenue), 0.02, 0.06)),
      ratioMetric("tax_burden", "所得税负担率", incomeTax, totalProfit, "盈利能力", "所得税费用 / 利润总额", "percent", rangeStatus(ratio(incomeTax, totalProfit), 0.05, 0.35)),
      ratioMetric("ocf_to_net_profit", "经营现金流/净利润", operatingCashFlow, netProfit, "现金流质量", "经营现金流净额 / 净利润", "multiple", higherStatus(ratio(operatingCashFlow, netProfit), benchmarks.operatingCashFlowToNetProfit[0], 1)),
      ratioMetric("cash_conversion_quality", "现金转换质量", operatingCashFlow, operatingProfit, "现金流质量", "经营现金流净额 / 营业利润", "multiple", higherStatus(ratio(operatingCashFlow, operatingProfit), 0.8, 1.1)),
      ratioMetric("ocf_margin", "经营现金流率", operatingCashFlow, revenue, "现金流质量", "经营现金流净额 / 营业收入", "percent", higherStatus(ratio(operatingCashFlow, revenue), 0.06, 0.15)),
      ratioMetric("cash_return_on_assets", "资产现金回报率", operatingCashFlow, averageAssets, "现金流质量", "经营现金流净额 / 平均总资产", "percent", higherStatus(ratio(operatingCashFlow, averageAssets), 0.04, 0.1)),
      ratioMetric("reinvestment_coverage", "投资支出覆盖倍数", operatingCashFlow, absNullable(investingCashFlow), "现金流质量", "经营现金流净额 / 投资现金流净流出绝对值", "multiple", higherStatus(ratio(operatingCashFlow, absNullable(investingCashFlow)), 0.8, 1.5)),
      amountMetric("free_cash_flow_proxy", "自由现金流近似值", freeCashFlowProxy, "现金流质量", "经营现金流净额 + 投资现金流净额", amountStatus(freeCashFlowProxy)),
      amountMetric("financing_cash_flow", "筹资现金流净额", financingCashFlow, "现金流质量", "筹资活动现金流量净额", amountStatus(financingCashFlow)),
      ratioMetric("debt_to_asset", "资产负债率", totalLiabilities, totalAssets, "偿债能力", "负债合计 / 资产总计", "percent", lowerStatus(ratio(totalLiabilities, totalAssets), 0.45, 0.7)),
      ratioMetric("debt_to_equity", "产权比率", totalLiabilities, totalEquity, "偿债能力", "负债合计 / 所有者权益", "multiple", lowerStatus(ratio(totalLiabilities, totalEquity), 0.8, 1.8)),
      ratioMetric("current_ratio", "流动比率", currentAssets, currentLiabilities, "偿债能力", "流动资产合计 / 流动负债合计", "multiple", higherStatus(ratio(currentAssets, currentLiabilities), benchmarks.currentRatio[0], benchmarks.currentRatio[1])),
      ratioMetric("quick_ratio", "速动比率", subtract(currentAssets, inventory), currentLiabilities, "偿债能力", "(流动资产合计 - 存货) / 流动负债合计", "multiple", higherStatus(ratio(subtract(currentAssets, inventory), currentLiabilities), benchmarks.quickRatio[0], benchmarks.quickRatio[1])),
      ratioMetric("cash_ratio", "现金比率", cash, currentLiabilities, "偿债能力", "货币资金 / 流动负债合计", "multiple", higherStatus(ratio(cash, currentLiabilities), 0.2, 0.5)),
      ratioMetric("interest_coverage", "利息保障倍数", operatingProfit, financeExpenses, "偿债能力", "营业利润 / 财务费用", "multiple", higherStatus(ratio(operatingProfit, financeExpenses), benchmarks.interestCoverage[0], benchmarks.interestCoverage[1])),
      ratioMetric("equity_ratio", "权益比率", totalEquity, totalAssets, "财务结构", "所有者权益 / 资产总计", "percent", higherStatus(ratio(totalEquity, totalAssets), 0.3, 0.55)),
      ratioMetric("cash_to_assets", "现金资产比", cash, totalAssets, "偿债能力", "货币资金 / 资产总计", "percent", higherStatus(ratio(cash, totalAssets), 0.08, 0.18)),
      ratioMetric("current_assets_to_assets", "流动资产占比", currentAssets, totalAssets, "财务结构", "流动资产合计 / 资产总计", "percent", rangeStatus(ratio(currentAssets, totalAssets), 0.25, 0.75)),
      ratioMetric("receivables_to_revenue", "应收账款/收入", accountsReceivable, revenue, "运营效率", "应收账款 / 营业收入", "percent", lowerStatus(ratio(accountsReceivable, revenue), 0.2, 0.35)),
      ratioMetric("inventory_to_revenue", "存货/收入", inventory, revenue, "运营效率", "存货 / 营业收入", "percent", lowerStatus(ratio(inventory, revenue), 0.18, 0.35)),
      ratioMetric("asset_turnover", "总资产周转率", revenue, averageAssets, "运营效率", "营业收入 / 平均总资产", "multiple", higherStatus(ratio(revenue, averageAssets), 0.5, 1.2)),
      ratioMetric("receivables_turnover", "应收账款周转率", revenue, averageReceivables, "运营效率", "营业收入 / 平均应收账款", "multiple", higherStatus(receivablesTurnover, benchmarks.receivablesTurnover[0], benchmarks.receivablesTurnover[1])),
      directMetric("receivables_days", "应收账款周转天数", daysFromTurnover(receivablesTurnover), "运营效率", "365 / 应收账款周转率", "days", lowerStatus(daysFromTurnover(receivablesTurnover), 45, 90)),
      ratioMetric("inventory_turnover", "存货周转率", costOfSales, averageInventory, "运营效率", "营业成本 / 平均存货", "multiple", higherStatus(inventoryTurnover, benchmarks.inventoryTurnover[0], benchmarks.inventoryTurnover[1])),
      directMetric("inventory_days", "存货周转天数", daysFromTurnover(inventoryTurnover), "运营效率", "365 / 存货周转率", "days", lowerStatus(daysFromTurnover(inventoryTurnover), 60, 120)),
      ratioMetric("payables_to_cost", "应付账款/成本", accountsPayable, costOfSales, "运营效率", "应付账款 / 营业成本", "percent", rangeStatus(ratio(accountsPayable, costOfSales), 0.08, 0.35)),
      growthMetric("revenue_growth", "收入增长率", revenue, previousRevenue, "成长变化", "本期营业收入 / 上期营业收入 - 1"),
      growthMetric("gross_profit_growth", "毛利增长率", grossProfit, previousGrossProfit, "成长变化", "本期毛利 / 上期毛利 - 1"),
      growthMetric("net_profit_growth", "净利润增长率", netProfit, income("net_profit", "previous"), "成长变化", "本期净利润 / 上期净利润 - 1"),
      growthMetric("ocf_growth", "经营现金流增长率", operatingCashFlow, cf("net_operating_cash_flow", "previous"), "成长变化", "本期经营现金流 / 上期经营现金流 - 1"),
      growthMetric("total_assets_growth", "总资产增长率", totalAssets, bs("total_assets", "previous"), "成长变化", "本期总资产 / 上期总资产 - 1"),
      growthMetric("equity_growth", "所有者权益增长率", totalEquity, bs("total_equity", "previous"), "成长变化", "本期所有者权益 / 上期所有者权益 - 1"),
      growthMetric("liabilities_growth", "负债增长率", totalLiabilities, bs("total_liabilities", "previous"), "成长变化", "本期负债合计 / 上期负债合计 - 1"),
  ].map((metric) => enrichMetric(metric, benchmarks));

  return { metrics };
}

function buildPeriodComparisons(statements) {
  const value = (statementType, itemKey, period = "current") =>
    statements[statementType]?.[itemKey]?.[period] ?? null;
  const items = [
    ["income_statement", "revenue", "营业收入", "profitability"],
    ["income_statement", "gross_profit", "毛利", "profitability"],
    ["income_statement", "operating_profit", "营业利润", "profitability"],
    ["income_statement", "net_profit", "净利润", "profitability"],
    ["cash_flow", "net_operating_cash_flow", "经营现金流净额", "cash_flow"],
    ["cash_flow", "net_investing_cash_flow", "投资现金流净额", "cash_flow"],
    ["balance_sheet", "cash", "货币资金", "balance_sheet"],
    ["balance_sheet", "accounts_receivable", "应收账款", "balance_sheet"],
    ["balance_sheet", "inventory", "存货", "balance_sheet"],
    ["balance_sheet", "total_assets", "资产总计", "balance_sheet"],
    ["balance_sheet", "total_liabilities", "负债合计", "balance_sheet"],
    ["balance_sheet", "total_equity", "所有者权益合计", "balance_sheet"],
  ];

  return items.map(([statementType, itemKey, name, category]) => {
    const current = value(statementType, itemKey, "current");
    const previous = value(statementType, itemKey, "previous");
    const change = subtract(current, previous);
    const changeRate = ratio(change, previous);
    return {
      key: itemKey,
      statementType,
      category,
      name,
      current,
      previous,
      change,
      changeRate,
      displayCurrent: formatMetricValue(current, "amount"),
      displayPrevious: formatMetricValue(previous, "amount"),
      displayChange: formatMetricValue(change, "amount"),
      displayChangeRate: formatMetricValue(changeRate, "percent"),
      status: comparisonStatus(itemKey, changeRate, current, previous),
      explanation: comparisonExplanation(itemKey, name, changeRate, current, previous),
    };
  });
}

function comparisonStatus(itemKey, changeRate, current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined || changeRate === null) {
    return "warning";
  }
  const absRate = Math.abs(changeRate);
  if (["revenue", "gross_profit", "operating_profit", "net_profit", "net_operating_cash_flow"].includes(itemKey)) {
    if (changeRate >= 0.1) return "success";
    if (changeRate < -0.1) return "danger";
    return "info";
  }
  if (["accounts_receivable", "inventory", "total_liabilities"].includes(itemKey)) {
    if (changeRate > 0.2) return "warning";
    if (changeRate < -0.1) return "success";
    return "info";
  }
  return absRate > 0.2 ? "warning" : "info";
}

function comparisonExplanation(itemKey, name, changeRate, current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined || changeRate === null) {
    return `${name}缺少本期或上期数据，无法计算完整变动率。`;
  }
  const direction = changeRate >= 0 ? "上升" : "下降";
  const rateText = formatMetricValue(Math.abs(changeRate), "percent");
  const focus = {
    revenue: "收入变化是判断业务规模变化的第一入口，需要结合毛利和现金流确认增长质量。",
    gross_profit: "毛利变化需要结合收入和成本变化判断，避免只看收入不看利润空间。",
    operating_profit: "营业利润变化更接近主营业务经营结果，适合与费用率一起观察。",
    net_profit: "净利润变化需要结合经营现金流，判断利润是否真正转化为现金。",
    net_operating_cash_flow: "经营现金流变化直接反映回款和经营质量，是本产品的重点维度。",
    accounts_receivable: "应收账款上升过快时，要进一步核查账龄、坏账准备和回款周期。",
    inventory: "存货上升过快时，要关注周转、跌价准备和销售压力。",
    total_liabilities: "负债上升时，要关注偿债安排、利息费用和短期债务压力。",
  }[itemKey] || "该科目的变化需要结合行业特征和报表附注继续判断。";
  return `${name}较上期${direction}${rateText}。${focus}`;
}

function buildDimensionScores(metrics, configuredWeights) {
  const dimensions = [
    ["profitability", "盈利能力", configuredWeights.profitability ?? 30, ["gross_margin", "net_margin", "operating_margin", "cost_ratio", "return_on_assets", "return_on_equity", "operating_expense_ratio"]],
    ["cashFlowQuality", "现金流质量", configuredWeights.cashFlowQuality ?? 30, ["ocf_to_net_profit", "cash_conversion_quality", "ocf_margin", "cash_return_on_assets", "reinvestment_coverage", "free_cash_flow_proxy"]],
    ["solvency", "偿债能力", configuredWeights.solvency ?? 15, ["debt_to_asset", "debt_to_equity", "current_ratio", "quick_ratio", "cash_ratio", "interest_coverage"]],
    ["operatingEfficiency", "运营效率", configuredWeights.operatingEfficiency ?? 10, ["receivables_to_revenue", "inventory_to_revenue", "asset_turnover", "receivables_turnover", "receivables_days", "inventory_turnover", "inventory_days"]],
    ["growth", "成长变化", configuredWeights.growth ?? 10, ["revenue_growth", "gross_profit_growth", "net_profit_growth", "ocf_growth", "total_assets_growth", "equity_growth", "liabilities_growth"]],
    ["financialStructure", "财务结构", configuredWeights.financialStructure ?? 5, ["equity_ratio", "cash_to_assets", "current_assets_to_assets", "finance_expense_ratio"]],
  ];

  return dimensions.map(([key, name, weight, metricKeys]) => {
    const scores = metricKeys
      .map((metricKey) => metrics.find((metric) => metric.key === metricKey)?.score)
      .filter((score) => score !== null && score !== undefined);
    const score = scores.length ? Math.round(scores.reduce((sum, item) => sum + item, 0) / scores.length) : 60;
    return {
      key,
      name,
      weight: Number(weight),
      score,
    };
  });
}

function buildDeductions(metrics, statements) {
  const byKey = Object.fromEntries(metrics.map((metric) => [metric.key, metric]));
  const deductions = [];
  const push = (severity, title, detail, metricKey) => deductions.push({ severity, title, detail, metricKey });

  if ((byKey.ocf_to_net_profit?.value ?? 1) < 0.8) {
    push("high", "利润现金含量不足", "经营现金流对净利润覆盖不足，需重点核查回款质量和收入确认。", "ocf_to_net_profit");
  }
  if ((statements.cash_flow.net_operating_cash_flow?.current ?? 0) < 0) {
    push("high", "经营现金流为负", "主营经营活动尚未产生正向现金流，短期资金压力可能上升。", "ocf_margin");
  }
  if ((byKey.net_margin?.value ?? 0) < 0) {
    push("high", "净利润为负", "公司当前处于亏损状态，需拆解亏损是否来自主营业务。", "net_margin");
  }
  if ((byKey.debt_to_asset?.value ?? 0) > 0.7) {
    push("medium", "杠杆偏高", "资产负债率高于常用警戒线，需要关注偿债安排和融资成本。", "debt_to_asset");
  }
  if ((byKey.current_ratio?.value ?? 2) < 1) {
    push("medium", "短期偿债覆盖不足", "流动资产对流动负债的覆盖低于 1，建议核查短期借款、应付款和可动用现金。", "current_ratio");
  }
  if ((byKey.interest_coverage?.value ?? 5) < 2) {
    push("medium", "利息保障偏弱", "营业利润覆盖财务费用的倍数偏低，融资成本可能正在压缩利润安全垫。", "interest_coverage");
  }
  if ((byKey.receivables_to_revenue?.value ?? 0) > 0.35) {
    push("medium", "应收账款占收入偏高", "收入中尚未回款的比例较高，需要进一步查看账龄和坏账准备。", "receivables_to_revenue");
  }
  if ((byKey.receivables_days?.value ?? 0) > 120) {
    push("medium", "应收周转天数偏长", "应收账款停留时间较长，建议重点核查大客户账期、逾期款和回款计划。", "receivables_days");
  }
  if ((byKey.inventory_days?.value ?? 0) > 180) {
    push("medium", "存货周转偏慢", "存货占用周期较长，建议核查滞销、跌价准备和采购节奏。", "inventory_days");
  }
  if ((byKey.cash_conversion_quality?.value ?? 1) < 0.8) {
    push("medium", "经营利润现金转换不足", "经营现金流对营业利润覆盖不足，利润质量需要结合回款和营运资本变化复核。", "cash_conversion_quality");
  }
  if ((byKey.gross_margin?.value ?? 1) < 0.1) {
    push("low", "毛利空间较薄", "毛利率偏低，后续应结合行业属性判断是否存在价格或成本压力。", "gross_margin");
  }

  const hasCriticalGap = [
    statements.income_statement.revenue?.current,
    statements.income_statement.net_profit?.current,
    statements.cash_flow.net_operating_cash_flow?.current,
    statements.balance_sheet.total_assets?.current,
    statements.balance_sheet.total_liabilities?.current,
  ].some((item) => item === null || item === undefined);
  if (hasCriticalGap) {
    push("low", "关键科目不完整", "部分核心科目为空，系统已保留空值但评分可信度会受影响。", "data_quality");
  }

  return deductions;
}

function calculateWeightedScore(dimensionScores) {
  const totalWeight = dimensionScores.reduce((sum, dimension) => sum + Number(dimension.weight || 0), 0) || 100;
  const weighted = dimensionScores.reduce(
    (sum, dimension) => sum + Number(dimension.score || 0) * Number(dimension.weight || 0),
    0,
  );
  return Math.max(0, Math.min(100, Math.round(weighted / totalWeight)));
}

function ratingFromScore(score) {
  if (score >= 85) return "A";
  if (score >= 75) return "B+";
  if (score >= 65) return "B";
  if (score >= 55) return "C";
  return "D";
}

function recommendationFromScore(score, deductions) {
  const highRiskCount = deductions.filter((item) => item.severity === "high").length;
  if (score >= 75 && highRiskCount === 0) return "值得进一步研究";
  if (score >= 60) return "谨慎关注，补充核查";
  return "暂不建议作为优先对象";
}

function buildResultSummary(score, rating, deductions, metrics) {
  const ocf = metrics.find((metric) => metric.key === "ocf_to_net_profit");
  const netMargin = metrics.find((metric) => metric.key === "net_margin");
  const riskText = deductions.length
    ? `系统识别出 ${deductions.length} 项风险提示，优先查看现金流、应收账款和杠杆相关项目。`
    : "暂未触发高优先级风险提示，但仍建议结合附注和业务背景复核。";
  return `规则模型给出的综合得分为 ${score} 分，评级 ${rating}。盈利表现${statusPhrase(netMargin)}，现金流兑现${statusPhrase(ocf)}。${riskText}`;
}

function buildProfitabilityAnalysis(metrics) {
  const grossMargin = metrics.find((metric) => metric.key === "gross_margin");
  const netMargin = metrics.find((metric) => metric.key === "net_margin");
  const operatingMargin = metrics.find((metric) => metric.key === "operating_margin");
  return `盈利维度重点看毛利率、营业利润率和净利率。当前毛利率为 ${grossMargin?.displayValue ?? "-"}，净利率为 ${netMargin?.displayValue ?? "-"}，营业利润率为 ${operatingMargin?.displayValue ?? "-"}。若净利率明显低于毛利率，需要继续查看费用率、财务费用和非经常性损益。`;
}

function buildCashFlowAnalysis(metrics) {
  const ocfToProfit = metrics.find((metric) => metric.key === "ocf_to_net_profit");
  const ocfMargin = metrics.find((metric) => metric.key === "ocf_margin");
  const freeCashFlow = metrics.find((metric) => metric.key === "free_cash_flow_proxy");
  return `现金流维度重点看经营现金流能否覆盖利润。当前经营现金流/净利润为 ${ocfToProfit?.displayValue ?? "-"}，经营现金流率为 ${ocfMargin?.displayValue ?? "-"}，自由现金流近似值为 ${freeCashFlow?.displayValue ?? "-"}。该结果不替代尽调，应结合回款、账期和资本开支继续核查。`;
}

function buildAnalysisCharts({ metrics, periodComparisons, dimensionScores, deductions }) {
  const metricByKey = Object.fromEntries(metrics.map((metric) => [metric.key, metric]));
  const metricSeries = (keys) =>
    keys
      .map((key) => metricByKey[key])
      .filter(Boolean)
      .map((metric) => ({
        key: metric.key,
        label: metric.name,
        value: metric.value,
        displayValue: metric.displayValue,
        status: metric.status,
        sourceKey: `metric:${metric.key}`,
      }));

  return {
    dimensionScores: dimensionScores.map((item) => ({
      key: item.key,
      label: item.name,
      value: item.score,
      weight: item.weight,
      sourceKey: `dimension:${item.key}`,
    })),
    profitability: metricSeries(["gross_margin", "net_margin", "operating_margin", "return_on_assets", "return_on_equity"]),
    cashFlowQuality: metricSeries(["ocf_to_net_profit", "cash_conversion_quality", "ocf_margin", "cash_return_on_assets"]),
    solvency: metricSeries(["debt_to_asset", "current_ratio", "quick_ratio", "interest_coverage"]),
    periodChanges: periodComparisons.slice(0, 12).map((item) => ({
      key: item.key,
      label: item.name,
      value: item.changeRate,
      displayValue: item.displayChangeRate,
      status: item.status,
      sourceKey: `period:${item.statementType}:${item.key}`,
    })),
    riskSeverity: ["high", "medium", "low"].map((severity) => ({
      key: severity,
      label: severity,
      value: deductions.filter((item) => item.severity === severity).length,
      sourceKey: `risk:${severity}`,
    })),
  };
}

function buildSourceCatalog({ statements, metrics, periodComparisons, deductions }) {
  const statementSources = Object.entries(statements).flatMap(([statementType, items]) =>
    Object.entries(items).flatMap(([itemKey, value]) =>
      ["current", "previous"]
        .filter((period) => value?.[period] !== null && value?.[period] !== undefined)
        .map((period) => ({
          id: `statement:${statementType}:${itemKey}:${period}`,
          type: "statement",
          statementType,
          itemKey,
          period,
          value: value[period],
        })),
    ),
  );
  return [
    ...statementSources,
    ...metrics.map((metric) => ({
      id: `metric:${metric.key}`,
      type: "metric",
      key: metric.key,
      name: metric.name,
      value: metric.value,
      displayValue: metric.displayValue,
      status: metric.status,
      formulaId: metric.formulaId,
    })),
    ...periodComparisons.map((item) => ({
      id: `period:${item.statementType}:${item.key}`,
      type: "periodComparison",
      key: item.key,
      value: item.changeRate,
      displayValue: item.displayChangeRate,
      status: item.status,
    })),
    ...deductions.map((item, index) => ({
      id: `risk:${item.metricKey || index}`,
      type: "risk",
      key: item.metricKey || String(index),
      severity: item.severity,
      title: item.title,
    })),
  ];
}

function validateAiFacts(aiAnalysis, context) {
  const sourceIds = new Set((context.sourceCatalog || []).map((item) => item.id));
  const citations = normalizeAiCitations(aiAnalysis.citations);
  const checks = [];
  const add = (key, status, message, sourceId = "") => checks.push({ key, status, message, sourceId });

  for (const citation of citations) {
    add(
      `citation:${citation.sourceId}`,
      sourceIds.has(citation.sourceId) ? "pass" : "warning",
      sourceIds.has(citation.sourceId) ? "引用来源可追踪" : "引用来源未在结构化证据目录中找到",
      citation.sourceId,
    );
  }
  if (!citations.length && aiAnalysis.summary) {
    add("citation:missing", "warning", "模型解读未提供 citations，报告将只保留规则证据链");
  }

  const metricByKey = Object.fromEntries((context.metrics || []).map((metric) => [metric.key, metric]));
  if (mentionsCashWeak(aiAnalysis) && (metricByKey.ocf_to_net_profit?.value ?? 1) >= 0.8) {
    add("cash_flow_claim", "warning", "模型解读提到现金流偏弱，但经营现金流/净利润未触发规则风险", "metric:ocf_to_net_profit");
  } else {
    add("cash_flow_claim", "pass", "现金流描述与规则指标未发现明显冲突", "metric:ocf_to_net_profit");
  }
  if (mentionsProfitWeak(aiAnalysis) && (metricByKey.net_margin?.value ?? 0) >= 0.04) {
    add("profit_claim", "warning", "模型解读提到盈利偏弱，但净利率未触发规则低位风险", "metric:net_margin");
  } else {
    add("profit_claim", "pass", "盈利描述与规则指标未发现明显冲突", "metric:net_margin");
  }

  const passCount = checks.filter((item) => item.status === "pass").length;
  const score = checks.length ? Math.round((passCount / checks.length) * 100) : 100;
  return { checks, score };
}

function mentionsCashWeak(aiAnalysis) {
  return /现金流.*(弱|差|不足|偏低|压力)|回款.*(弱|慢|不足)/.test(JSON.stringify(aiAnalysis));
}

function mentionsProfitWeak(aiAnalysis) {
  return /盈利.*(弱|差|不足|偏低|下滑)|利润.*(弱|差|不足|偏低|下滑)/.test(JSON.stringify(aiAnalysis));
}

function normalizeAiCitations(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      claim: String(item?.claim || "").slice(0, 180),
      sourceId: String(item?.sourceId || item?.sourceKey || "").slice(0, 120),
    }))
    .filter((item) => item.sourceId)
    .slice(0, 20);
}

async function buildDeepSeekAnalysis(context) {
  const settings = getConfigValue("ai_settings", {});
  const promptConfig = getConfigValue("ai_prompt", {});
  const apiKey = settings.apiKey || process.env.DEEPSEEK_API_KEY || "";
  if (!settings.enabled) {
    return { status: "disabled", analysis: attachAiGovernance(defaultAiAnalysis("模型解读未启用。"), context, "skipped") };
  }
  if (!apiKey) {
    return { status: "unconfigured", analysis: attachAiGovernance(defaultAiAnalysis("后台尚未配置 DeepSeek API Key。"), context, "skipped") };
  }

  const scoreAdjustmentLimit = Number(promptConfig.scoreAdjustmentLimit ?? 10);
  const payload = {
    job: {
      analysisType: context.job.analysisType,
      industry: context.job.industry,
      accountingStandard: context.job.accountingStandard,
      currency: context.job.currency,
      amountUnit: context.job.amountUnit,
    },
    confirmedStatements: context.statements,
    ruleResult: {
      baseScore: context.baseScore,
      rating: context.rating,
      recommendation: context.recommendation,
      summary: context.summary,
      profitabilityAnalysis: context.profitabilityAnalysis,
      cashFlowAnalysis: context.cashFlowAnalysis,
    },
    metrics: context.metrics.map((metric) => ({
      key: metric.key,
      name: metric.name,
      value: metric.value,
      displayValue: metric.displayValue,
      dimension: metric.dimension,
      formula: metric.formula,
      status: metric.status,
      interpretation: metric.interpretation,
    })),
    periodComparisons: context.periodComparisons,
    risks: context.deductions,
    sourceCatalog: (context.sourceCatalog || []).slice(0, 120),
    outputSchema: {
      summary: "string",
      profitabilityAnalysis: "string",
      cashFlowAnalysis: "string",
      periodComparisonAnalysis: "string",
      riskExplanation: ["string"],
      nextCheckSuggestions: ["string"],
      citations: [{ claim: "string", sourceId: "metric:gross_margin or period:income_statement:revenue or risk:ocf_to_net_profit" }],
      scoreAdjustment: `number between -${scoreAdjustmentLimit} and ${scoreAdjustmentLimit}`,
      scoreAdjustmentReason: "string",
    },
    constraints: [
      "只能基于 confirmedStatements、metrics、periodComparisons 和 risks 作答。",
      "不得引用、猜测或要求读取原始 PDF。",
      "每个关键结论尽量提供 citations，sourceId 必须来自 sourceCatalog。",
      "不要输出投资建议、买卖建议、授信结论或审计意见。",
      "必须输出严格 JSON，不要 Markdown。",
    ],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(settings.timeoutMs || 60000));
  try {
    const response = await fetch(`${String(settings.baseUrl || "https://api.deepseek.com").replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: settings.model || "deepseek-chat",
        temperature: Number(settings.temperature ?? 0.2),
        max_tokens: Number(settings.maxTokens || 2000),
        response_format: settings.structuredJson === false ? undefined : { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              promptConfig.system ||
              "你是面向非财务用户的财务三表分析助手。只基于已确认的结构化数据和规则指标输出严格 JSON。",
          },
          {
            role: "user",
            content: JSON.stringify(payload),
          },
        ],
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error?.message || `DeepSeek 请求失败：${response.status}`);
    }
    const content = result.choices?.[0]?.message?.content || "{}";
    const parsed = normalizeAiAnalysis(parseJsonObject(content), scoreAdjustmentLimit, context.baseScore);
    return { status: "success", analysis: attachAiGovernance(parsed, context, "success") };
  } catch (error) {
    return { status: "failed", analysis: attachAiGovernance(defaultAiAnalysis(`模型解读生成失败：${error.message}`), context, "failed") };
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonObject(content) {
  try {
    return JSON.parse(content);
  } catch {
    const match = String(content).match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  }
}

function normalizeAiAnalysis(value, scoreAdjustmentLimit, baseScore) {
  const adjustment = Math.max(
    -scoreAdjustmentLimit,
    Math.min(scoreAdjustmentLimit, Number(value.scoreAdjustment || 0)),
  );
  return {
    summary: String(value.summary || ""),
    profitabilityAnalysis: String(value.profitabilityAnalysis || ""),
    cashFlowAnalysis: String(value.cashFlowAnalysis || ""),
    periodComparisonAnalysis: String(value.periodComparisonAnalysis || ""),
    riskExplanation: Array.isArray(value.riskExplanation) ? value.riskExplanation.map(String).slice(0, 8) : [],
    nextCheckSuggestions: Array.isArray(value.nextCheckSuggestions) ? value.nextCheckSuggestions.map(String).slice(0, 8) : [],
    citations: normalizeAiCitations(value.citations),
    scoreAdjustment: adjustment,
    adjustedScore: Math.max(0, Math.min(100, Math.round(Number(baseScore || 0) + adjustment))),
    scoreAdjustmentReason: String(value.scoreAdjustmentReason || ""),
  };
}

function attachAiGovernance(aiAnalysis, context, aiRoundStatus) {
  const validation = validateAiFacts(aiAnalysis, context);
  return {
    ...aiAnalysis,
    citations: normalizeAiCitations(aiAnalysis.citations),
    chartData: context.chartData || {},
    sourceCatalog: (context.sourceCatalog || []).slice(0, 80),
    factChecks: validation.checks,
    factConsistencyScore: validation.score,
    validationRounds: [
      {
        round: "rule_engine",
        status: "pass",
        detail: "规则引擎已基于用户确认后的结构化三表、指标和风险项生成基础结论。",
      },
      {
        round: "deepseek_json_analysis",
        status: aiRoundStatus,
        detail: "模型只接收确认后的结构化数据、指标、环比和风险项，不接收原始 PDF。",
      },
      {
        round: "fact_consistency",
        status: validation.score >= 80 ? "pass" : "warning",
        detail: `事实一致性评分 ${validation.score}/100，引用与关键财务判断已做规则复核。`,
      },
    ],
  };
}

function defaultAiAnalysis(message) {
  return {
    summary: message,
    profitabilityAnalysis: "",
    cashFlowAnalysis: "",
    periodComparisonAnalysis: "",
    riskExplanation: [],
    nextCheckSuggestions: [],
    citations: [],
    scoreAdjustment: 0,
    adjustedScore: null,
    scoreAdjustmentReason: "",
  };
}

function getIndustryBenchmark(industry) {
  const allBenchmarks = getConfigValue("industry_benchmarks", {});
  const selected = allBenchmarks[industry] || allBenchmarks["其他"] || {};
  return {
    grossMargin: normalizeBenchmarkRange(selected.grossMargin, [0.18, 0.35]),
    netMargin: normalizeBenchmarkRange(selected.netMargin, [0.04, 0.12]),
    operatingCashFlowToNetProfit: normalizeBenchmarkRange(selected.operatingCashFlowToNetProfit, [0.7, 1.2]),
    returnOnAssets: normalizeBenchmarkRange(selected.returnOnAssets, [0.03, 0.08]),
    returnOnEquity: normalizeBenchmarkRange(selected.returnOnEquity, [0.06, 0.15]),
    currentRatio: normalizeBenchmarkRange(selected.currentRatio, [1.2, 2]),
    quickRatio: normalizeBenchmarkRange(selected.quickRatio, [0.8, 1.2]),
    receivablesTurnover: normalizeBenchmarkRange(selected.receivablesTurnover, [4, 8]),
    inventoryTurnover: normalizeBenchmarkRange(selected.inventoryTurnover, [3, 6]),
    interestCoverage: normalizeBenchmarkRange(selected.interestCoverage, [2, 5]),
  };
}

function getConfigValue(key, fallback) {
  const row = db.prepare("SELECT value FROM system_configs WHERE key = ?").get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

function getParserSettings() {
  return getConfigValue("parser_settings", {
    usePython: true,
    strategy: "python_pdfplumber_camelot_docling_then_pdfjs",
    pythonPath: process.env.PYTHON_PARSER_BIN || process.env.PYTHON || "python",
    engines: ["pdfplumber", "camelot", "docling"],
    ocrEnabled: true,
    tableConfidenceThreshold: 0.75,
    timeoutMs: 90000,
  });
}

function normalizeBenchmarkRange(value, fallback) {
  if (!Array.isArray(value) || value.length < 2) return fallback;
  return value.slice(0, 2).map((item) => {
    const numeric = Number(item);
    return Math.abs(numeric) > 1 ? numeric / 100 : numeric;
  });
}

function ratioMetric(key, name, numerator, denominator, dimension, formula, format, status) {
  const value = ratio(numerator, denominator);
  return makeMetric(key, name, value, dimension, formula, format, status);
}

function amountMetric(key, name, value, dimension, formula, status) {
  return makeMetric(key, name, value, dimension, formula, "amount", status);
}

function growthMetric(key, name, current, previous, dimension, formula) {
  const value = ratio(subtract(current, previous), previous);
  return makeMetric(key, name, value, dimension, formula, "percent", growthStatus(value));
}

function directMetric(key, name, value, dimension, formula, format, status) {
  return makeMetric(key, name, value, dimension, formula, format, status);
}

const METRIC_LEARNING_NOTES = {
  gross_margin: "毛利率看产品或服务留下的第一层利润空间，适合判断商业模式和成本压力。",
  net_margin: "净利率看收入最终能沉淀多少利润，费用、税费和非经常性损益都会影响它。",
  operating_margin: "营业利润率更贴近主营经营表现，比净利率更少受到非经营项目扰动。",
  cost_ratio: "成本收入比越高，说明收入中被直接成本吃掉的比例越高。",
  ocf_to_net_profit: "经营现金流/净利润用于判断利润含金量，长期低于 1 要重点核查回款质量。",
  ocf_margin: "经营现金流率看每 1 元收入带来多少经营现金，是现金流质量的核心指标。",
  free_cash_flow_proxy: "自由现金流近似值用经营现金流加投资现金流粗略判断资本开支后的现金留存。",
  debt_to_asset: "资产负债率衡量杠杆水平，过高时偿债压力和融资成本更值得关注。",
  equity_ratio: "权益比率越高，说明资产中由股东资本支撑的比例越高，财务结构通常更稳。",
  cash_to_assets: "现金资产比反映资产中现金类资源占比，可辅助判断短期安全垫。",
  current_assets_to_assets: "流动资产占比需要结合行业判断，过高或过低都可能代表经营结构差异。",
  receivables_to_revenue: "应收账款/收入越高，说明收入里尚未回款的部分越多。",
  inventory_to_revenue: "存货/收入越高，可能意味着库存占用资金或销售周转压力。",
  revenue_growth: "收入增长率是规模变化入口，但需要和利润、现金流同步看。",
  net_profit_growth: "净利润增长率看盈利结果变化，需警惕利润增长但现金流不跟随。",
  ocf_growth: "经营现金流增长率看经营现金回收变化，是判断增长质量的重要补充。",
  return_on_assets: "ROA 衡量资产创造利润的效率，适合看公司是不是用同样资产赚到更多利润。",
  return_on_equity: "ROE 衡量股东权益带来的利润回报，过高时也要同时检查杠杆是否偏高。",
  operating_expense_ratio: "期间费用率用于观察销售、管理和财务费用是否吞噬了毛利空间。",
  current_ratio: "流动比率看短期资产覆盖短期负债的能力，但过高也可能说明资金使用效率不高。",
  quick_ratio: "速动比率剔除了存货，更适合观察短期可变现资产对流动负债的覆盖。",
  cash_ratio: "现金比率直接看货币资金对流动负债的覆盖，是最保守的短期偿债观察口径。",
  debt_to_equity: "产权比率看负债相对股东权益的规模，越高代表财务杠杆越强。",
  interest_coverage: "利息保障倍数用于判断经营利润覆盖融资成本的能力，低于 2 通常要重点关注。",
  asset_turnover: "总资产周转率衡量资产带来收入的效率，适合和 ROA 一起看经营效率。",
  receivables_turnover: "应收账款周转率越高，通常说明回款速度越快、收入现金化更顺。",
  receivables_days: "应收账款周转天数越长，客户欠款停留时间越久，回款风险越需要核查。",
  inventory_turnover: "存货周转率越高，通常说明库存转换为销售的速度越快。",
  inventory_days: "存货周转天数越长，越要关注滞销、跌价准备和资金占用。",
  cash_conversion_quality: "现金转换质量比较经营现金流和营业利润，判断账面经营成果是否真正转成现金。",
  cash_return_on_assets: "资产现金回报率用经营现金流衡量资产质量，比单看利润更保守。",
  reinvestment_coverage: "投资支出覆盖倍数看经营现金流能否支持投资扩张，长期过低会带来融资压力。",
  total_assets_growth: "总资产增长率用于观察公司规模扩张速度，需结合收入和利润是否同步增长。",
  gross_profit_growth: "毛利增长率比收入增长更接近盈利空间变化，适合判断增长质量。",
  equity_growth: "所有者权益增长率反映净资产积累，需结合分红、增资和亏损情况判断。",
  liabilities_growth: "负债增长率过快时，要和资产、收入、现金流一起看杠杆扩张是否健康。",
};

function makeMetric(key, name, value, dimension, formula, format, status) {
  const normalizedStatus = value === null ? { tone: "warning", label: "数据不足", score: null } : status;
  return {
    key,
    name,
    value,
    displayValue: formatMetricValue(value, format),
    format,
    dimension,
    formula,
    learnText: METRIC_LEARNING_NOTES[key] || "该指标需要结合行业、业务模式和报表附注综合判断。",
    status: normalizedStatus.tone,
    interpretation: normalizedStatus.label,
    score: normalizedStatus.score,
  };
}

function higherStatus(value, good, strong) {
  if (value === null) return { tone: "warning", label: "数据不足", score: null };
  if (value >= strong) return { tone: "success", label: "明显较好", score: 92 };
  if (value >= good) return { tone: "success", label: "处于健康区间", score: 80 };
  if (value >= good * 0.65) return { tone: "warning", label: "略低于舒适区间", score: 62 };
  return { tone: "danger", label: "低于常用参考线", score: 42 };
}

function lowerStatus(value, good, caution) {
  if (value === null) return { tone: "warning", label: "数据不足", score: null };
  if (value <= good) return { tone: "success", label: "压力较低", score: 88 };
  if (value <= caution) return { tone: "warning", label: "需要持续观察", score: 66 };
  return { tone: "danger", label: "高于常用警戒线", score: 40 };
}

function rangeStatus(value, low, high) {
  if (value === null) return { tone: "warning", label: "数据不足", score: null };
  if (value >= low && value <= high) return { tone: "success", label: "结构较均衡", score: 78 };
  return { tone: "warning", label: "结构需要结合行业判断", score: 62 };
}

function growthStatus(value) {
  if (value === null) return { tone: "warning", label: "缺少上期数据", score: null };
  if (value >= 0.15) return { tone: "success", label: "增长较快", score: 86 };
  if (value >= 0) return { tone: "success", label: "正向增长", score: 74 };
  if (value >= -0.15) return { tone: "warning", label: "小幅下滑", score: 58 };
  return { tone: "danger", label: "下滑明显", score: 38 };
}

function amountStatus(value) {
  if (value === null) return { tone: "warning", label: "数据不足", score: null };
  if (value > 0) return { tone: "success", label: "现金留存为正", score: 82 };
  if (value === 0) return { tone: "warning", label: "现金留存持平", score: 62 };
  return { tone: "danger", label: "资本开支后现金承压", score: 44 };
}

function statusPhrase(metric) {
  if (!metric) return "数据不足";
  if (metric.status === "success") return "较好";
  if (metric.status === "warning") return "需要观察";
  return "存在压力";
}

function formatMetricValue(value, format) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  if (format === "percent") {
    return `${(value * 100).toFixed(1)}%`;
  }
  if (format === "multiple") {
    return `${value.toFixed(2)}x`;
  }
  if (format === "days") {
    return `${value.toFixed(0)}天`;
  }
  if (format === "amount") {
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
  }
  return String(value);
}

function ratio(numerator, denominator) {
  if (numerator === null || numerator === undefined || denominator === null || denominator === undefined) return null;
  const divisor = Number(denominator);
  if (!Number.isFinite(divisor) || divisor === 0) return null;
  const value = Number(numerator) / divisor;
  return Number.isFinite(value) ? value : null;
}

function coalesce(...values) {
  return values.find((value) => value !== null && value !== undefined) ?? null;
}

function addNullable(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  const value = Number(a) + Number(b);
  return Number.isFinite(value) ? value : null;
}

function sumNullable(...values) {
  const usable = values.filter((value) => value !== null && value !== undefined);
  if (!usable.length) return null;
  const value = usable.reduce((sum, item) => sum + Number(item), 0);
  return Number.isFinite(value) ? value : null;
}

function averageNullable(current, previous) {
  if (current === null || current === undefined) return null;
  if (previous === null || previous === undefined) return Number(current);
  const value = (Number(current) + Number(previous)) / 2;
  return Number.isFinite(value) ? value : null;
}

function absNullable(value) {
  if (value === null || value === undefined) return null;
  const numeric = Math.abs(Number(value));
  return Number.isFinite(numeric) && numeric !== 0 ? numeric : null;
}

function daysFromTurnover(value) {
  if (value === null || value === undefined || Number(value) <= 0) return null;
  const days = 365 / Number(value);
  return Number.isFinite(days) ? days : null;
}

function subtract(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  const value = Number(a) - Number(b);
  return Number.isFinite(value) ? value : null;
}

function serializeAnalysisResult(row, job) {
  return {
    id: row.id,
    job,
    score: row.base_score,
    rating: row.rating,
    recommendation: row.recommendation,
    summary: row.summary,
    profitabilityAnalysis: row.profitability_analysis,
    cashFlowAnalysis: row.cash_flow_analysis,
    dimensionScores: JSON.parse(row.dimension_scores),
    metrics: JSON.parse(row.metrics),
    periodComparisons: JSON.parse(row.period_comparisons || "[]"),
    aiAnalysis: JSON.parse(row.ai_analysis || "{}"),
    aiStatus: row.ai_status || "disabled",
    deductions: JSON.parse(row.deductions),
    reportExportedAt: row.report_exported_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function exportAnalysisPdfReport(jobId, activationCodeId, res) {
  let analysis = getAnalysisResult(jobId, activationCodeId);
  if (!analysis) {
    const job = getAnalysisJob(jobId, activationCodeId);
    if (job?.status === "confirmed") {
      analysis = await calculateAnalysisResult(jobId, activationCodeId);
    }
  }
  if (!analysis) {
    throwHttpError(404, "分析结果尚未生成，无法导出 PDF。");
  }
  if (analysis.reportExportedAt) {
    throwHttpError(410, "该报告已经导出过。系统不保存生成后的 PDF，请重新创建分析任务。");
  }

  const filename = `financial-report-${jobId}.pdf`;
  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "no-store",
  });

  const doc = new PDFDocument({
    size: "A4",
    margin: 48,
    bufferPages: true,
    info: {
      Title: "财务三表分析报告",
      Author: "Financial Statement Analyzer",
      Subject: "Rule-based financial statement analysis",
    },
  });

  registerReportFont(doc);
  doc.pipe(res);
  renderReportPdf(doc, analysis);
  doc.end();

  res.on("finish", () => {
    finalizeReportExport(jobId);
  });
}

function registerReportFont(doc) {
  const fontPath = REPORT_FONT_CANDIDATES.find((candidate) => existsSync(candidate));
  if (fontPath) {
    doc.registerFont("ReportFont", fontPath);
    doc.font("ReportFont");
  }
}

function renderReportPdf(doc, analysis) {
  const job = analysis.job;
  addReportHeader(doc, "财务三表分析报告", "面向非财务用户的企业财务质量与风险分析");
  addReportMeta(doc, [
    ["任务编号", String(job.id)],
    ["分析类型", job.analysisType === "two_period" ? "两期对比" : "单期分析"],
    ["行业", job.industry],
    ["币种", job.currency],
    ["金额单位", job.amountUnit],
    ["会计准则", job.accountingStandard],
    ["生成时间", formatReportDate(new Date())],
  ]);

  addScoreSection(doc, analysis);
  addParagraph(doc, "综合结论", analysis.summary);
  addParagraph(doc, "盈利质量分析", analysis.profitabilityAnalysis);
  addParagraph(doc, "现金流质量分析", analysis.cashFlowAnalysis);
  addAiAnalysisSection(doc, analysis.aiAnalysis, analysis.aiStatus);
  addChartSummarySection(doc, analysis.aiAnalysis?.chartData);
  addPeriodComparisonTable(doc, analysis.periodComparisons || []);
  addDimensionTable(doc, analysis.dimensionScores);
  addRiskList(doc, analysis.deductions);
  addMetricsTable(doc, analysis.metrics);
  addDisclaimer(doc);
  addPageNumbers(doc);
}

function addReportHeader(doc, title, subtitle) {
  doc.fontSize(22).fillColor("#0b1220").text(title, { align: "left" });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor("#475569").text(subtitle);
  doc.moveDown(1);
  doc.moveTo(48, doc.y).lineTo(547, doc.y).strokeColor("#d7dee8").stroke();
  doc.moveDown(1);
}

function addReportMeta(doc, rows) {
  ensureReportSpace(doc, 110);
  doc.fontSize(12).fillColor("#0b1220").text("基础信息");
  doc.moveDown(0.4);
  rows.forEach(([label, value]) => {
    doc.fontSize(9).fillColor("#64748b").text(`${label}: `, { continued: true });
    doc.fillColor("#0f172a").text(value || "-");
  });
  doc.moveDown(1);
}

function addScoreSection(doc, analysis) {
  ensureReportSpace(doc, 92);
  doc.roundedRect(48, doc.y, 499, 74, 8).fillAndStroke("#f8fafc", "#d7dee8");
  const y = doc.y + 16;
  doc.fillColor(scoreColor(analysis.score)).fontSize(28).text(String(analysis.score), 68, y, { width: 72, align: "center" });
  doc.fontSize(10).text(`Grade ${analysis.rating}`, 68, y + 34, { width: 72, align: "center" });
  doc.fillColor("#0b1220").fontSize(15).text(analysis.recommendation, 160, y, { width: 340 });
  doc.fillColor("#475569").fontSize(9).text("该分数来自规则模型，尚未包含模型调校分。", 160, y + 30, { width: 340 });
  doc.y = y + 72;
  doc.moveDown(0.8);
}

function addParagraph(doc, title, text) {
  ensureReportSpace(doc, 86);
  doc.fontSize(13).fillColor("#0b1220").text(title);
  doc.moveDown(0.35);
  doc.fontSize(9.5).fillColor("#334155").text(text || "-", { lineGap: 4 });
  doc.moveDown(0.9);
}

function addAiAnalysisSection(doc, aiAnalysis, aiStatus) {
  ensureReportSpace(doc, 120);
  doc.fontSize(13).fillColor("#0b1220").text("报告解读补充");
  doc.moveDown(0.35);
  if (aiStatus !== "success") {
    doc.fontSize(9.5).fillColor("#64748b").text(`${aiAnalysis?.summary || "模型解读未启用或暂不可用。"}\n\n${MODEL_REPORT_NOTE}`, { lineGap: 4 });
    doc.moveDown(0.9);
    return;
  }

  const lines = [
    ["综合解读", aiAnalysis.summary],
    ["盈利补充", aiAnalysis.profitabilityAnalysis],
    ["现金流补充", aiAnalysis.cashFlowAnalysis],
    ["两期变化", aiAnalysis.periodComparisonAnalysis],
    ["模型调校", `${aiAnalysis.scoreAdjustment || 0} 分；${aiAnalysis.scoreAdjustmentReason || "无调校说明"}`],
  ];
  lines.forEach(([label, value]) => {
    if (!value) return;
    ensureReportSpace(doc, 34);
    doc.fontSize(9).fillColor("#64748b").text(`${label}: `, { continued: true });
    doc.fillColor("#334155").text(value, { lineGap: 3 });
    doc.moveDown(0.25);
  });
  ensureReportSpace(doc, 54);
  doc.fontSize(9).fillColor("#64748b").text(MODEL_REPORT_NOTE, { lineGap: 3 });
  doc.moveDown(0.35);
  if (aiAnalysis.nextCheckSuggestions?.length) {
    doc.fontSize(9).fillColor("#64748b").text("下一步核查建议:");
    aiAnalysis.nextCheckSuggestions.slice(0, 5).forEach((item, index) => {
      doc.fillColor("#334155").text(`${index + 1}. ${item}`, { lineGap: 3 });
    });
  }
  if (aiAnalysis.factChecks?.length) {
    doc.moveDown(0.4);
    doc.fontSize(9).fillColor("#64748b").text(`事实一致性：${aiAnalysis.factConsistencyScore ?? "-"} / 100`);
    aiAnalysis.factChecks.slice(0, 5).forEach((item) => {
      doc.fillColor(item.status === "pass" ? "#166534" : "#b45309").text(`- ${item.message}`, { lineGap: 3 });
    });
  }
  doc.moveDown(0.9);
}

function addChartSummarySection(doc, chartData = {}) {
  const rows = [
    ["Profitability", chartData.profitability],
    ["Cash flow", chartData.cashFlowQuality],
    ["Solvency", chartData.solvency],
    ["Period change", chartData.periodChanges],
  ].filter(([, series]) => Array.isArray(series) && series.length);
  if (!rows.length) return;
  ensureReportSpace(doc, 120);
  doc.fontSize(13).fillColor("#0b1220").text("图表数据摘要");
  doc.moveDown(0.35);
  rows.forEach(([title, series]) => {
    ensureReportSpace(doc, 32);
    const summary = series
      .slice(0, 5)
      .map((item) => `${item.label}: ${item.displayValue ?? item.value ?? "-"}`)
      .join("；");
    doc.fontSize(9).fillColor("#64748b").text(`${title}: `, { continued: true });
    doc.fillColor("#334155").text(summary, { lineGap: 3 });
  });
  doc.moveDown(0.9);
}

function addPeriodComparisonTable(doc, comparisons) {
  ensureReportSpace(doc, 110);
  doc.fontSize(13).fillColor("#0b1220").text("两期核心科目对比");
  doc.moveDown(0.45);
  if (!comparisons.length) {
    doc.fontSize(9).fillColor("#64748b").text("当前任务缺少上期数据，无法展示两期对比。");
    doc.moveDown(0.8);
    return;
  }

  comparisons.slice(0, 12).forEach((item) => {
    ensureReportSpace(doc, 38);
    const y = doc.y;
    doc.fontSize(8.5).fillColor("#0f172a").text(item.name, 48, y, { width: 92 });
    doc.fillColor("#334155").text(item.displayCurrent, 145, y, { width: 70, align: "right" });
    doc.fillColor("#64748b").text(item.displayPrevious, 220, y, { width: 70, align: "right" });
    doc.fillColor(metricToneColor(item.status)).text(item.displayChangeRate, 300, y, { width: 58, align: "right" });
    doc.fillColor("#475569").text(item.explanation, 368, y, { width: 178, lineGap: 2 });
    doc.y = Math.max(doc.y, y + 30);
    doc.moveTo(48, doc.y - 5).lineTo(547, doc.y - 5).strokeColor("#eef2f7").stroke();
  });
  doc.moveDown(0.8);
}

function addDimensionTable(doc, dimensions) {
  ensureReportSpace(doc, 120);
  doc.fontSize(13).fillColor("#0b1220").text("维度得分与权重");
  doc.moveDown(0.5);
  dimensions.forEach((dimension) => {
    ensureReportSpace(doc, 24);
    const y = doc.y;
    doc.fontSize(9).fillColor("#334155").text(`${dimension.name} · ${dimension.weight}%`, 48, y, { width: 160 });
    doc.roundedRect(220, y + 3, 220, 8, 4).fill("#e2e8f0");
    doc.roundedRect(220, y + 3, Math.max(4, 220 * (dimension.score / 100)), 8, 4).fill(scoreColor(dimension.score));
    doc.fillColor("#0f172a").text(String(dimension.score), 458, y, { width: 40, align: "right" });
    doc.y = y + 22;
  });
  doc.moveDown(0.8);
}

function addRiskList(doc, deductions) {
  ensureReportSpace(doc, 90);
  doc.fontSize(13).fillColor("#0b1220").text("主要风险提示");
  doc.moveDown(0.45);
  const risks = deductions.length
    ? deductions
    : [{ title: "未触发高优先级风险", detail: "系统暂未发现明显异常，但仍建议结合附注、审计意见和业务情况核查。" }];
  risks.forEach((risk, index) => {
    ensureReportSpace(doc, 44);
    doc.fontSize(10).fillColor(severityColor(risk.severity)).text(`${index + 1}. ${risk.title}`);
    doc.moveDown(0.15);
    doc.fontSize(9).fillColor("#475569").text(risk.detail, { lineGap: 3 });
    doc.moveDown(0.45);
  });
}

function addMetricsTable(doc, metrics) {
  ensureReportSpace(doc, 90);
  doc.fontSize(13).fillColor("#0b1220").text("关键指标");
  doc.moveDown(0.5);
  metrics.forEach((metric) => {
    ensureReportSpace(doc, 40);
    const y = doc.y;
    doc.fontSize(9).fillColor("#0f172a").text(metric.name, 48, y, { width: 120 });
    doc.fillColor(metricToneColor(metric.status)).text(metric.displayValue, 178, y, { width: 80 });
    doc.fillColor("#475569").text(metric.interpretation, 268, y, { width: 120 });
    doc.fillColor("#64748b").text(metric.formula, 398, y, { width: 150 });
    doc.y = y + 30;
    doc.moveTo(48, doc.y - 8).lineTo(547, doc.y - 8).strokeColor("#eef2f7").stroke();
  });
  doc.moveDown(0.6);
}

function addDisclaimer(doc) {
  ensureReportSpace(doc, 80);
  doc.fontSize(11).fillColor("#0b1220").text("免责声明");
  doc.moveDown(0.3);
  doc.fontSize(8.5).fillColor("#64748b").text(
    `${MODEL_REPORT_NOTE} 系统不保存本次生成的 PDF 报告，请用户及时下载并自行保管。原始 PDF 仅用于解析和校对，服务器临时保留 1 天，到期自动清理。`,
    { lineGap: 3 },
  );
}

function addPageNumbers(doc) {
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    doc.fontSize(8).fillColor("#94a3b8").text(`Page ${index + 1} / ${range.count}`, 48, 806, {
      align: "center",
      width: 499,
    });
  }
}

function ensureReportSpace(doc, height) {
  if (doc.y + height > 760) {
    doc.addPage();
  }
}

function scoreColor(score) {
  if (score >= 75) return "#0f8f63";
  if (score >= 60) return "#b45309";
  return "#b91c1c";
}

function severityColor(severity) {
  if (severity === "high") return "#b91c1c";
  if (severity === "medium") return "#b45309";
  return "#0f6b99";
}

function metricToneColor(status) {
  if (status === "success") return "#0f8f63";
  if (status === "warning") return "#b45309";
  if (status === "danger") return "#b91c1c";
  return "#0f6b99";
}

function formatReportDate(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(date);
}

function finalizeReportExport(jobId) {
  db.prepare("UPDATE analysis_results SET report_exported_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE job_id = ?").run(
    jobId,
  );
  cleanupJobSourceData(jobId);
}

function cleanupJobSourceData(jobId) {
  const jobDir = resolve(UPLOAD_ROOT, `job-${jobId}`);
  const uploadRoot = resolve(UPLOAD_ROOT);
  if (jobDir.startsWith(`${uploadRoot}\\`) || jobDir.startsWith(`${uploadRoot}/`)) {
    rmSync(jobDir, { recursive: true, force: true });
  }
  db.prepare("DELETE FROM analysis_uploads WHERE job_id = ?").run(jobId);
  db.prepare("DELETE FROM analysis_statement_items WHERE job_id = ?").run(jobId);
}

function cleanupExpiredSourcePdfs() {
  try {
    const expired = db
      .prepare(
        `
          SELECT analysis_uploads.job_id, analysis_uploads.stored_path
          FROM analysis_uploads
          JOIN analysis_jobs ON analysis_jobs.id = analysis_uploads.job_id
          WHERE analysis_uploads.created_at < datetime('now', ?)
        `,
      )
      .all(`-${SOURCE_PDF_RETENTION_HOURS} hours`);
    const expiredJobIds = [...new Set(expired.map((row) => row.job_id))];
    for (const jobId of expiredJobIds) {
      cleanupJobSourceData(jobId);
    }
  } catch (error) {
    console.warn(`Source PDF cleanup skipped: ${error.message}`);
  }
}

function serializeAnalysisUpload(row) {
  return {
    id: row.id,
    statementType: row.statement_type,
    period: row.period,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    status: row.status,
    parseAudit: safeJsonParse(row.parse_audit, {}),
    structuredTables: safeJsonParse(row.structured_tables, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeActivationCode(value) {
  const code = String(value || "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9-]{8,40}$/.test(code)) {
    throwHttpError(400, "激活码只能包含大写字母、数字和连字符，长度 8-40 位。");
  }
  return code;
}

function normalizeAnalysisType(value) {
  const normalized = String(value || "single").trim();
  if (!["single", "two_period"].includes(normalized)) {
    throwHttpError(400, "分析类型只能是 single 或 two_period。");
  }
  return normalized;
}

function normalizeOneOf(value, allowedValues, label) {
  const normalized = String(value || "").trim();
  if (!allowedValues.includes(normalized)) {
    throwHttpError(400, `${label}不在支持范围内。`);
  }
  return normalized;
}

function normalizeText(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 80) {
    throwHttpError(400, `${label}不能为空，且不能超过 80 个字符。`);
  }
  return normalized;
}

function normalizeStatementItemKey(value) {
  const normalized = String(value || "").trim();
  if (!/^[a-zA-Z0-9_]+$/.test(normalized)) {
    throwHttpError(400, "标准科目键名不合法。");
  }
  return normalized;
}

function normalizeOptionalAmount(value, label) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "string" && value.trim() === "") {
    return null;
  }
  const numeric = Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(numeric)) {
    throwHttpError(400, `${label}必须是数字、0 或空值。`);
  }
  return numeric;
}

function sanitizeFileName(value) {
  const name = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .slice(0, 180);
  if (!name) {
    throwHttpError(400, "文件名不能为空。");
  }
  return name;
}

function normalizeActivationPrefix(value) {
  const prefix = String(value || "FIN")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!prefix || prefix.length > 10) {
    throwHttpError(400, "批量生成前缀长度需为 1-10 位字母或数字。");
  }
  return prefix;
}

function normalizeStatus(value) {
  const status = String(value || "").trim();
  if (!["active", "inactive"].includes(status)) {
    throwHttpError(400, "状态只能是 active 或 inactive。");
  }
  return status;
}

function normalizeValidUntil(value) {
  if (!value) {
    throwHttpError(400, "请设置有效期。");
  }

  const raw = String(value);
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59+08:00` : raw;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throwHttpError(400, "有效期格式不正确。");
  }
  return iso;
}

function normalizeMaxSessions(value) {
  const maxSessions = Number(value || 2);
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 20) {
    throwHttpError(400, "同时在线会话数必须是 1-20 的整数。");
  }
  return maxSessions;
}

function normalizeBulkCount(value) {
  const count = Number(value || 1);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throwHttpError(400, "批量生成数量必须是 1-100 的整数。");
  }
  return count;
}

function generateActivationCode(prefix) {
  const parts = [prefix, new Date().getFullYear(), randomPart(4), randomPart(4)];
  return parts.join("-");
}

function randomPart(length) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let output = "";
  for (let i = 0; i < length; i += 1) {
    output += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return output;
}

function throwHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function readBearerToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "";
}

function isExpired(isoString) {
  return new Date(isoString).getTime() <= Date.now();
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Invalid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function serveStatic(url, res) {
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const safePath = normalize(pathname).replace(/^[/\\]+/, "").replace(/^(\.\.[/\\])+/, "");
  const absolutePath = join(rootDir, safePath);

  if (!absolutePath.startsWith(rootDir) || !existsSync(absolutePath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  const ext = extname(absolutePath);
  res.writeHead(200, {
    "Content-Type": mimeTypes.get(ext) || "application/octet-stream",
  });
  createReadStream(absolutePath).pipe(res);
}
