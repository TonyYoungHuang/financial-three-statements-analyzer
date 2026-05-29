const screenTitles = {
  dashboard: ["Workspace", "项目首页"],
  setup: ["Wizard", "新建分析"],
  confirm: ["Data Review", "确认识别数据"],
  result: ["Analysis", "分析结果"],
};

const SESSION_TOKEN_KEY = "financialAnalyzer.sessionToken";
const ACTIVATION_KEY = "financialAnalyzer.activation";
const API_BASE_PATH = window.location.pathname.startsWith("/financial/") ? "/financial" : "";
const MODEL_REPORT_NOTE =
  "备注：本报告的自动化解读能力接入 DeepSeek V4 大模型，并结合专业财务分析人员的测试、校准与规则调整生成。报告内容仅基于用户上传并确认的财务报表数据、系统计算指标及风险识别规则，用于辅助理解企业财务状况、盈利质量、现金流表现和潜在风险，不构成投资建议、买卖建议、授信建议、审计意见或任何形式的决策结论。";

const shell = document.querySelector("[data-shell]");
const authScreen = document.querySelector('[data-screen="auth"]');
const appScreens = [...document.querySelectorAll(".shell .screen")];
const navItems = [...document.querySelectorAll(".nav-item")];
const pageKicker = document.querySelector("[data-page-kicker]");
const pageTitle = document.querySelector("[data-page-title]");
const authButton = document.querySelector("[data-auth-submit]");
const authInput = document.querySelector("#activationCode");
const authMessage = document.querySelector("[data-auth-message]");
const authStatus = document.querySelector("[data-auth-status]");
const authValidUntil = document.querySelector("[data-auth-valid-until]");
const sessionStatus = document.querySelector("[data-session-status]");
const projectGrid = document.querySelector("[data-project-grid]");
const clearProjectsButton = document.querySelector("[data-clear-projects]");

let heartbeatTimer = null;
let selectedAnalysisType = "single";
let currentAnalysisJob = null;
let currentStatementTab = "balance_sheet";
let parsedStatementItems = [];
let parsedStatementUploads = [];
let currentAnalysisResult = null;

function showScreen(name) {
  if (name !== "auth") {
    authScreen.classList.add("hidden");
    shell.classList.remove("hidden");
  }

  appScreens.forEach((screen) => {
    screen.classList.toggle("active", screen.dataset.screen === name);
  });

  navItems.forEach((item) => {
    item.classList.toggle("active", item.dataset.go === name);
  });

  const title = screenTitles[name] || screenTitles.dashboard;
  if (pageKicker && pageTitle) {
    pageKicker.textContent = title[0];
    pageTitle.textContent = title[1];
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function api(path, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.headers || {}),
  };

  if (options.body) {
    headers["Content-Type"] = "application/json";
  }

  if (options.auth !== false) {
    const token = localStorage.getItem(SESSION_TOKEN_KEY);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  const response = await fetch(apiPath(path), {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || "请求失败。");
    error.code = payload.error?.code || "REQUEST_FAILED";
    error.status = response.status;
    throw error;
  }

  return payload;
}

function apiPath(path) {
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith("/api/")) return `${API_BASE_PATH}${path}`;
  return path;
}

async function createAnalysisJob() {
  const body = getAnalysisFormPayload();
  const result = await api("/api/analysis/jobs", {
    method: "POST",
    body,
  });
  currentAnalysisJob = result.job;
  return result.job;
}

async function startAnalysisUploadFlow() {
  const startButton = document.querySelector("[data-start-analysis]");
  startButton.disabled = true;

  try {
    const files = getSelectedStatementFiles();
    const requiredCount = selectedAnalysisType === "two_period" ? 6 : 3;
    if (files.length < requiredCount) {
      throw new Error(
        selectedAnalysisType === "two_period"
          ? "请先选择本期和上期的资产负债表、损益表、现金流量表共六份 PDF。"
          : "请先选择资产负债表、损益表和现金流量表三份 PDF。",
      );
    }

    setAnalysisStatus("正在创建分析任务", "服务器将保存本次基础信息和上传状态。", "info");
    const job = await createAnalysisJob();

    for (const item of files) {
      markUploadBox(item.statementType, item.period, "parsing", `${item.file.name} · 正在上传`);
      setAnalysisStatus(
        "正在上传 PDF",
        `${statementTypeLabel(item.statementType)} · ${periodLabel(item.period)}：${item.file.name}`,
        "info",
      );
      await uploadStatementFile(job.id, item.statementType, item.period, item.file);
      markUploadBox(item.statementType, item.period, "uploaded", `${item.file.name} · 上传完成`);
    }

    const status = await api(`/api/analysis/jobs/${job.id}/status`);
    currentAnalysisJob = status.job;
    setAnalysisStatus("上传完成，正在解析", "服务器正在抽取 PDF 文本并映射标准科目。", "info");
    setParseStatus("正在解析 PDF", "系统会优先处理电子 PDF 表格，并对基础扫描件尝试 OCR；复杂扫描件可在下一步人工校对和手工修复。", "info");
    const parsedJob = await api(`/api/analysis/jobs/${job.id}/parse`, { method: "POST" });
    currentAnalysisJob = parsedJob.job;
    await loadParsedStatements(job.id);
    setAnalysisStatus("解析完成", "标准科目数据已生成，可进入数据确认。", "success");
    showScreen("confirm");
  } catch (error) {
    setAnalysisStatus("上传流程未完成", error.message, "danger");
    setParseStatus("解析或上传失败", error.message, "danger");
  } finally {
    startButton.disabled = false;
  }
}

async function uploadStatementFile(jobId, statementType, period, file) {
  const dataBase64 = await fileToBase64(file);
  return api(`/api/analysis/jobs/${jobId}/upload`, {
    method: "POST",
    body: {
      statementType,
      period,
      fileName: file.name,
      mimeType: file.type || "application/pdf",
      dataBase64,
    },
  });
}

function getAnalysisFormPayload() {
  return {
    analysisType: selectedAnalysisType,
    language: document.querySelector('[data-analysis-field="language"]').value,
    accountingStandard: document.querySelector('[data-analysis-field="accountingStandard"]').value,
    industry: document.querySelector('[data-analysis-field="industry"]').value,
    currency: document.querySelector('[data-analysis-field="currency"]').value,
    amountUnit: document.querySelector('[data-analysis-field="amountUnit"]').value,
  };
}

function getSelectedStatementFiles() {
  const periods = selectedAnalysisType === "two_period" ? ["current", "previous"] : ["current"];
  return periods
    .flatMap((period) =>
      ["balance_sheet", "income_statement", "cash_flow"].map((statementType) => {
        const input = document.querySelector(`[data-upload-file="${statementType}"][data-upload-period="${period}"]`);
        return {
          statementType,
          period,
          file: input.files[0],
        };
      }),
    )
    .filter((item) => item.file);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("文件读取失败。"));
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.readAsDataURL(file);
  });
}

function setAnalysisStatus(title, body, tone = "info") {
  const status = document.querySelector("[data-analysis-status]");
  if (!status) return;
  status.classList.remove("danger-soft", "info-soft", "success-soft", "warning-soft");
  status.classList.add(`${tone}-soft`);
  status.innerHTML = `
    <span class="material-symbols-outlined">${tone === "success" ? "check_circle" : tone === "danger" ? "error" : "cloud_upload"}</span>
    <div>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(body)}</p>
    </div>
  `;
}

function setParseStatus(title, body, tone = "info") {
  const status = document.querySelector("[data-parse-status]");
  if (!status) return;
  status.classList.remove("danger-soft", "info-soft", "success-soft", "warning-soft");
  status.classList.add(`${tone}-soft`);
  status.innerHTML = `
    <span class="material-symbols-outlined">${tone === "success" ? "check_circle" : tone === "danger" ? "error" : "data_table"}</span>
    <div>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(body)}</p>
    </div>
  `;
}

async function loadParsedStatements(jobId = currentAnalysisJob?.id) {
  if (!jobId) return;
  const { statements } = await api(`/api/analysis/jobs/${jobId}/statements`);
  parsedStatementItems = statements.items;
  parsedStatementUploads = statements.uploads || [];
  currentAnalysisJob = statements.job;
  renderStatementRows();
  const parsedCount = parsedStatementItems.filter((item) => item.status === "parsed").length;
  const missingCount = parsedStatementItems.filter((item) => item.status === "missing").length;
  setParseStatus(
    "PDF 解析结果已加载",
    `已识别 ${parsedCount} 个标准科目，${missingCount} 个科目需要后续补录或确认。${buildParseAuditText(parsedStatementUploads)}`,
    "success",
  );
}

function buildParseAuditText(uploads) {
  if (!uploads.length) return "";
  const tableCount = uploads.reduce(
    (sum, upload) => sum + Number(upload.parseAudit?.tableCount || upload.structuredTables?.length || 0),
    0,
  );
  const warnings = [...new Set(uploads.flatMap((upload) => upload.parseAudit?.warnings || []))];
  const engines = [...new Set(uploads.map((upload) => upload.parseAudit?.engine).filter(Boolean))];
  const parts = [];
  if (engines.length) parts.push(`版面引擎：${engines.join("、")}`);
  parts.push(`结构化表格：${tableCount} 个`);
  if (warnings.length) parts.push(`校验提示：${warnings.join("、")}`);
  return ` ${parts.join("；")}。`;
}

function renderStatementRows() {
  const tbody = document.querySelector("[data-statement-rows]");
  if (!tbody) return;

  const rows = parsedStatementItems.filter((item) => item.statementType === currentStatementTab);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5">暂无解析结果。</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((item) => {
      const tag = statusTag(item);
      return `
        <tr>
          <td>${escapeHtml(item.itemName)}</td>
          <td><input value="${escapeHtml(formatAmountInput(item.currentAmount))}" placeholder="允许空值" data-statement-amount data-statement-type="${item.statementType}" data-item-key="${item.itemKey}" data-period="current" ${currentAnalysisJob?.status === "confirmed" ? "disabled" : ""} /></td>
          <td><input value="${escapeHtml(formatAmountInput(item.previousAmount))}" placeholder="允许空值" data-statement-amount data-statement-type="${item.statementType}" data-item-key="${item.itemKey}" data-period="previous" ${currentAnalysisJob?.status === "confirmed" ? "disabled" : ""} /></td>
          <td><span class="tag ${tag.tone}">${tag.label}</span></td>
          <td title="${escapeHtml(item.sourceLabel || item.note || "")}">${escapeHtml(item.note || item.sourceLabel || "-")}</td>
        </tr>
      `;
    })
    .join("");
}

function statusTag(item) {
  if (item.status === "parsed" && item.confidence >= 0.9) {
    return { tone: "success", label: "高置信度" };
  }
  if (item.status === "parsed") {
    return { tone: "info", label: "已识别" };
  }
  if (item.status === "needs_review") {
    return { tone: "warning", label: "需确认" };
  }
  return { tone: "warning", label: "未识别" };
}

function formatAmountInput(value) {
  if (value === null || value === undefined) return "";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function collectStatementEdits() {
  const byItem = new Map(parsedStatementItems.map((item) => [`${item.statementType}:${item.itemKey}`, { ...item }]));
  document.querySelectorAll("[data-statement-amount]").forEach((input) => {
    const key = `${input.dataset.statementType}:${input.dataset.itemKey}`;
    const item = byItem.get(key);
    if (!item) return;
    const amount = parseAmountInput(input.value);
    if (input.dataset.period === "current") {
      item.currentAmount = amount;
    } else {
      item.previousAmount = amount;
    }
  });
  return [...byItem.values()].map((item) => ({
    statementType: item.statementType,
    itemKey: item.itemKey,
    currentAmount: item.currentAmount,
    previousAmount: item.previousAmount,
  }));
}

function parseAmountInput(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed.replace(/,/g, ""));
  if (!Number.isFinite(numeric)) {
    throw new Error("金额只能填写数字、0 或留空。");
  }
  return numeric;
}

async function saveStatementEdits() {
  if (!currentAnalysisJob?.id) {
    throw new Error("当前没有可保存的分析任务。");
  }
  const items = collectStatementEdits();
  const { statements } = await api(`/api/analysis/jobs/${currentAnalysisJob.id}/statements`, {
    method: "PUT",
    body: { items },
  });
  parsedStatementItems = statements.items;
  currentAnalysisJob = statements.job;
  renderStatementRows();
  setParseStatus("数据已保存", "标准科目金额已保存。空值和 0 值都会按当前输入保留。", "success");
}

async function confirmStatementEdits() {
  const checkbox = document.querySelector("[data-confirm-checkbox]");
  if (!checkbox?.checked) {
    throw new Error("请先勾选确认声明。");
  }
  await saveStatementEdits();
  const { job } = await api(`/api/analysis/jobs/${currentAnalysisJob.id}/confirm`, { method: "POST" });
  currentAnalysisJob = job;
  renderStatementRows();
  setParseStatus("数据已确认锁定", "后续指标计算和报告解读将以这份确认后的三表数据为准。", "success");
  await calculateAnalysisResult(job.id);
  showScreen("result");
}

async function calculateAnalysisResult(jobId = currentAnalysisJob?.id) {
  if (!jobId) return null;
  renderAnalysisLoadingState();
  const { analysis } = await api(`/api/analysis/jobs/${jobId}/calculate`, { method: "POST" });
  currentAnalysisResult = analysis;
  currentAnalysisJob = analysis.job;
  renderAnalysisResult(analysis);
  return analysis;
}

async function loadAnalysisResult(jobId = currentAnalysisJob?.id) {
  if (!jobId) return null;
  try {
    const { analysis } = await api(`/api/analysis/jobs/${jobId}/analysis`);
    currentAnalysisResult = analysis;
    currentAnalysisJob = analysis.job;
    renderAnalysisResult(analysis);
    return analysis;
  } catch (error) {
    if (error.status === 404 && currentAnalysisJob?.status === "confirmed") {
      return calculateAnalysisResult(jobId);
    }
    renderAnalysisPlaceholder(error.message);
    return null;
  }
}

function renderAnalysisLoadingState() {
  const score = document.querySelector("[data-result-score]");
  const rating = document.querySelector("[data-result-rating]");
  const headline = document.querySelector("[data-result-headline]") || document.querySelector(".score-copy h3");
  const summary = document.querySelector("[data-result-summary]") || document.querySelector(".score-copy > p:nth-of-type(2)");
  if (score) score.textContent = "...";
  if (rating) rating.textContent = "Calculating";
  if (headline) headline.textContent = "正在生成规则评分";
  if (summary) summary.textContent = "系统正在根据已确认的三表数据计算关键指标、维度得分和风险提示。";
}

function renderAnalysisPlaceholder(message) {
  const headline = document.querySelector("[data-result-headline]") || document.querySelector(".score-copy h3");
  const summary = document.querySelector("[data-result-summary]") || document.querySelector(".score-copy > p:nth-of-type(2)");
  if (headline) headline.textContent = "还没有可展示的分析结果";
  if (summary) summary.textContent = message || "请先完成上传、识别、确认并锁定三表数据。";
}

function renderAnalysisResult(analysis = currentAnalysisResult) {
  if (!analysis) return;

  const score = document.querySelector("[data-result-score]");
  const rating = document.querySelector("[data-result-rating]");
  const ring = document.querySelector("[data-result-ring]");
  const headline = document.querySelector("[data-result-headline]") || document.querySelector(".score-copy h3");
  const summary = document.querySelector("[data-result-summary]") || document.querySelector(".score-copy > p:nth-of-type(2)");
  const tags = document.querySelector("[data-result-tags]");
  const profitability = document.querySelector("[data-profitability-analysis]") || document.querySelectorAll(".analysis-text")[0];
  const cashFlow = document.querySelector("[data-cash-flow-analysis]") || document.querySelectorAll(".analysis-text")[1];
  const dimensionScores = document.querySelector("[data-dimension-scores]");
  const riskList = document.querySelector("[data-risk-list]");
  const metricsGrid = document.querySelector("[data-metrics]");
  const periodComparison = document.querySelector("[data-period-comparison]");
  const aiStatus = document.querySelector("[data-ai-status]");
  const aiSummary = document.querySelector("[data-ai-summary]");
  const aiProfitability = document.querySelector("[data-ai-profitability]");
  const aiCashFlow = document.querySelector("[data-ai-cash-flow]");
  const aiPeriod = document.querySelector("[data-ai-period]");
  const aiSuggestions = document.querySelector("[data-ai-suggestions]");
  const aiValidation = document.querySelector("[data-ai-validation]");
  const chartData = document.querySelector("[data-chart-data]");

  if (score) score.textContent = analysis.score;
  if (rating) rating.textContent = `Grade ${analysis.rating}`;
  if (ring) {
    ring.classList.remove("result-good", "result-warning", "result-danger");
    ring.classList.add(analysis.score >= 75 ? "result-good" : analysis.score >= 60 ? "result-warning" : "result-danger");
  }
  if (headline) headline.textContent = analysis.recommendation;
  if (summary) summary.textContent = analysis.summary;
  if (profitability) profitability.textContent = analysis.profitabilityAnalysis;
  if (cashFlow) cashFlow.textContent = analysis.cashFlowAnalysis;

  if (tags) {
    const majorDeductions = analysis.deductions.slice(0, 2);
    tags.innerHTML = [
      `<span class="tag ${analysis.score >= 75 ? "success" : analysis.score >= 60 ? "warning" : "danger"}">${escapeHtml(analysis.recommendation)}</span>`,
      `<span class="tag info">规则评分 ${analysis.score}</span>`,
      ...majorDeductions.map((item) => `<span class="tag ${severityTone(item.severity)}">${escapeHtml(item.title)}</span>`),
    ].join("");
  }

  if (dimensionScores) {
    dimensionScores.innerHTML = analysis.dimensionScores
      .map(
        (dimension) => `
          <div>
            <span>${escapeHtml(dimension.name)} · ${dimension.weight}%</span>
            <meter min="0" max="100" value="${dimension.score}"></meter>
            <strong>${dimension.score}</strong>
          </div>
        `,
      )
      .join("");
  }

  if (riskList) {
    const risks = analysis.deductions.length
      ? analysis.deductions
      : [{ title: "未触发高优先级风险", detail: "系统暂未发现明显异常，但仍建议结合附注、审计意见和业务情况核查。" }];
    riskList.innerHTML = risks
      .map((risk) => `<li><strong>${escapeHtml(risk.title)}</strong><span>${escapeHtml(risk.detail)}</span></li>`)
      .join("");
  }

  if (periodComparison) {
    const rows = analysis.periodComparisons || [];
    periodComparison.innerHTML = rows.length
      ? rows
          .map(
            (item) => `
              <tr>
                <td>${escapeHtml(item.name)}</td>
                <td>${escapeHtml(item.displayCurrent)}</td>
                <td>${escapeHtml(item.displayPrevious)}</td>
                <td>${escapeHtml(item.displayChange)}</td>
                <td><span class="tag ${escapeHtml(item.status)}">${escapeHtml(item.displayChangeRate)}</span></td>
                <td>${escapeHtml(item.explanation)}</td>
              </tr>
            `,
          )
          .join("")
      : `<tr><td colspan="6">当前任务缺少上期数据，无法展示两期对比。</td></tr>`;
  }

  if (aiStatus || aiSummary) {
    const ai = analysis.aiAnalysis || {};
    const success = analysis.aiStatus === "success";
    if (aiStatus) {
      aiStatus.className = `status-chip ${success ? "success" : analysis.aiStatus === "failed" ? "danger" : "info"}`;
      aiStatus.textContent = success
        ? `解读已生成${ai.scoreAdjustment ? ` · 调校 ${ai.scoreAdjustment} 分` : ""}`
        : ai.summary || "模型解读未启用";
    }
    if (aiSummary) {
      aiSummary.textContent = success && ai.summary ? `${ai.summary}\n\n${MODEL_REPORT_NOTE}` : MODEL_REPORT_NOTE;
    }
    if (aiProfitability) aiProfitability.textContent = ai.profitabilityAnalysis || "";
    if (aiCashFlow) aiCashFlow.textContent = ai.cashFlowAnalysis || "";
    if (aiPeriod) aiPeriod.textContent = ai.periodComparisonAnalysis || "";
    if (aiSuggestions) {
      aiSuggestions.innerHTML = (ai.nextCheckSuggestions || [])
        .map((item) => `<li><span>${escapeHtml(item)}</span></li>`)
        .join("");
    }
    if (aiValidation) {
      const rounds = (ai.validationRounds || []).slice(0, 3);
      const checks = (ai.factChecks || []).slice(0, 3);
      aiValidation.innerHTML = [
        `<span>事实一致性 ${escapeHtml(String(ai.factConsistencyScore ?? "-"))}/100</span>`,
        ...rounds.map((round) => `<span>${escapeHtml(round.round)} · ${escapeHtml(round.status)}</span>`),
        ...checks.map((check) => `<span>${escapeHtml(check.status)} · ${escapeHtml(check.message)}</span>`),
      ].join("");
    }
    if (chartData) {
      chartData.innerHTML = renderChartStrip(ai.chartData || {});
    }
  }

  if (metricsGrid) {
    metricsGrid.innerHTML = analysis.metrics
      .map(
        (metric) => `
          <article class="metric-${escapeHtml(metric.status)}">
            <span>${escapeHtml(metric.name)}</span>
            <strong>${escapeHtml(metric.displayValue)}</strong>
            <small>${escapeHtml(metric.interpretation)} · ${escapeHtml(metric.dimension)}</small>
            <p class="formula">公式：${escapeHtml(metric.formula)}<br />理解：${escapeHtml(metric.learnText || "")}</p>
          </article>
        `,
      )
      .join("");
  }
}

function renderChartStrip(chartData) {
  const series = [
    ["盈利", chartData.profitability],
    ["现金流", chartData.cashFlowQuality],
    ["偿债", chartData.solvency],
    ["环比", chartData.periodChanges],
  ].filter(([, rows]) => Array.isArray(rows) && rows.length);
  if (!series.length) return "";
  return series
    .map(([title, rows]) => {
      const bars = rows
        .slice(0, 5)
        .map((item) => {
          const percent = chartBarPercent(item.value);
          return `
            <div class="chart-row">
              <span>${escapeHtml(item.label)}</span>
              <meter min="0" max="100" value="${percent}"></meter>
              <strong>${escapeHtml(item.displayValue ?? String(item.value ?? "-"))}</strong>
            </div>
          `;
        })
        .join("");
      return `<article><h4>${escapeHtml(title)}</h4>${bars}</article>`;
    })
    .join("");
}

function chartBarPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (Math.abs(numeric) <= 1) return Math.max(0, Math.min(100, Math.round(Math.abs(numeric) * 100)));
  return Math.max(0, Math.min(100, Math.round(Math.abs(numeric))));
}

function severityTone(severity) {
  if (severity === "high") return "danger";
  if (severity === "medium") return "warning";
  return "info";
}

async function downloadReportPdf() {
  if (!currentAnalysisJob?.id) {
    throw new Error("当前没有可导出的分析任务。");
  }

  if (!currentAnalysisResult) {
    await loadAnalysisResult(currentAnalysisJob.id);
  }

  const response = await fetch(apiPath(`/api/analysis/jobs/${currentAnalysisJob.id}/report.pdf`), {
    headers: {
      Authorization: `Bearer ${localStorage.getItem(SESSION_TOKEN_KEY) || ""}`,
    },
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error?.message || "PDF 报告生成失败。");
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `financial-report-${currentAnalysisJob.id}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  currentAnalysisResult = {
    ...(currentAnalysisResult || {}),
    reportExportedAt: new Date().toISOString(),
  };
}

function setExportMessage(message, tone = "info") {
  const messageEl = document.querySelector("[data-export-message]");
  if (!messageEl) return;
  messageEl.className = `field-hint config-message ${tone}`;
  messageEl.textContent = message;
}

function markUploadBox(statementType, period, state, message) {
  const box = document.querySelector(`[data-upload-box="${statementType}"][data-upload-period="${period}"]`);
  if (!box) return;
  box.classList.remove("uploaded", "parsing");
  if (state) {
    box.classList.add(state);
  }
  box.querySelector("small").textContent = message;
}

function statementTypeLabel(statementType) {
  return {
    balance_sheet: "资产负债表",
    income_statement: "损益表 / 利润表",
    cash_flow: "现金流量表",
  }[statementType] || statementType;
}

function periodLabel(period) {
  return period === "previous" ? "上期" : "本期";
}

function updatePeriodUploadVisibility() {
  const isTwoPeriod = selectedAnalysisType === "two_period";
  document.querySelectorAll('[data-upload-period="previous"]').forEach((element) => {
    const isInput = element.matches("input");
    if (!isInput) {
      element.classList.toggle("hidden", !isTwoPeriod);
    }
  });
}

async function verifyActivation() {
  const code = authInput.value.trim();
  setAuthMessage("正在验证激活码", "请稍候，系统正在检查有效期和同时在线会话数。", "info");
  authButton.disabled = true;

  try {
    const existingToken = localStorage.getItem(SESSION_TOKEN_KEY);
    const result = await api("/api/activation/verify", {
      method: "POST",
      auth: false,
      body: { code, existingToken },
    });

    localStorage.setItem(SESSION_TOKEN_KEY, result.token);
    localStorage.setItem(ACTIVATION_KEY, JSON.stringify(result.activation));
    updateActivationUI(result.activation);
    startHeartbeat();
    await loadProjects();
    showScreen("dashboard");
  } catch (error) {
    localStorage.removeItem(SESSION_TOKEN_KEY);
    setAuthMessage("验证失败", error.message, "danger");
  } finally {
    authButton.disabled = false;
  }
}

function updateActivationUI(activation) {
  if (!activation) return;

  const validDate = formatDate(activation.validUntil);
  authStatus.textContent = activation.status === "active" ? "专业版已激活" : "授权不可用";
  authValidUntil.textContent = `有效期至 ${validDate}`;
  sessionStatus.textContent = `${activation.maxSessions} 会话内`;
}

function setAuthMessage(title, body, tone = "danger") {
  authMessage.classList.remove("hidden");
  authMessage.classList.remove("danger-soft", "info-soft", "success-soft", "warning-soft");
  authMessage.classList.add(`${tone}-soft`);
  authMessage.querySelector("strong").textContent = title;
  authMessage.querySelector("p").textContent = body;
}

async function loadProjects() {
  if (!projectGrid) return;

  projectGrid.innerHTML = renderLoadingCard();

  try {
    const { projects } = await api("/api/projects");
    projectGrid.innerHTML = `${projects.map(renderProjectCard).join("")}${renderCreateProjectCard()}`;
  } catch (error) {
    projectGrid.innerHTML = renderErrorCard(error.message);
    if (error.status === 401) {
      showAuthAgain(error.message);
    }
  }
}

async function deleteProject(id) {
  await api(`/api/projects/${id}`, { method: "DELETE" });
  await loadProjects();
}

async function clearProjects() {
  const confirmed = window.confirm("确定清空全部历史摘要吗？该操作不会影响本地已下载的 PDF。");
  if (!confirmed) return;

  await api("/api/projects", { method: "DELETE" });
  await loadProjects();
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(async () => {
    try {
      const result = await api("/api/activation/heartbeat", { method: "POST" });
      updateActivationUI(result.activation);
    } catch (error) {
      clearInterval(heartbeatTimer);
      showAuthAgain(error.message);
    }
  }, 60_000);
}

function showAuthAgain(message) {
  shell.classList.add("hidden");
  authScreen.classList.remove("hidden");
  setAuthMessage("授权会话已失效", message, "warning");
}

function renderProjectCard(project) {
  const scoreClass = project.score >= 75 ? "good" : project.score >= 60 ? "warning" : "danger";
  const riskTone = project.score >= 75 ? "warning" : "danger";

  return `
    <article class="module project-card">
      <div class="card-top">
        <div>
          <p class="eyebrow">${escapeHtml(project.industry)}</p>
          <h4>${escapeHtml(project.companyName)}</h4>
          <span class="muted">${escapeHtml(project.reportingPeriod)} · ${escapeHtml(project.standard)} · ${escapeHtml(project.currency)}</span>
        </div>
        <div class="score-block ${scoreClass}">
          <strong>${project.score}</strong>
          <span>${escapeHtml(project.rating)}</span>
        </div>
      </div>
      <div class="divider"></div>
      <div class="risk-tags">
        ${project.mainRisks.map((risk) => `<span class="tag ${riskTone}">${escapeHtml(risk)}</span>`).join("")}
      </div>
      <div class="card-meta">
        <span>生成时间 ${formatDateTime(project.generatedAt)}</span>
        <button class="icon-button" data-delete-project="${project.id}" aria-label="删除">
          <span class="material-symbols-outlined">delete</span>
        </button>
      </div>
    </article>
  `;
}

function renderCreateProjectCard() {
  return `
    <article class="module project-card empty-card">
      <span class="material-symbols-outlined">note_add</span>
      <h4>创建新的分析项目</h4>
      <p>支持单期和两期对比，报告生成后请及时下载 PDF。</p>
      <button class="btn primary" data-go="setup">开始</button>
    </article>
  `;
}

function renderLoadingCard() {
  return `
    <article class="module project-card empty-card">
      <span class="material-symbols-outlined">progress_activity</span>
      <h4>正在读取历史摘要</h4>
      <p>云端仅保存项目卡片摘要。</p>
    </article>
  `;
}

function renderErrorCard(message) {
  return `
    <article class="module project-card empty-card">
      <span class="material-symbols-outlined">error</span>
      <h4>历史摘要读取失败</h4>
      <p>${escapeHtml(message)}</p>
    </article>
  `;
}

async function loadAdminData() {
  setAdminState("正在连接", "info");

  try {
    const [codesResult, configsResult] = await Promise.all([
      adminApi("/api/admin/activation-codes"),
      adminApi("/api/admin/configs"),
    ]);
    renderAdminActivationCodes(codesResult.activationCodes);
    adminConfigs = configsResult.configs;
    renderSelectedConfig(selectedConfigKey || "industry_benchmarks");
    setAdminState("后台已连接", "success");
  } catch (error) {
    setAdminState(error.message, "danger");
    if (adminCodeRows) {
      adminCodeRows.innerHTML = `<tr><td colspan="5">${escapeHtml(error.message)}</td></tr>`;
    }
  }
}

async function createActivationCode() {
  try {
    const code = document.querySelector("#newActivationCode").value.trim();
    const validUntil = document.querySelector("#newValidUntil").value;
    const maxSessions = Number(document.querySelector("#newMaxSessions").value || 2);

    await adminApi("/api/admin/activation-codes", {
      method: "POST",
      body: {
        code: code || undefined,
        validUntil,
        maxSessions,
        status: "active",
      },
    });

    document.querySelector("#newActivationCode").value = "";
    await loadAdminData();
  } catch (error) {
    setAdminState(error.message, "danger");
  }
}

async function bulkCreateActivationCodes() {
  try {
    const count = Number(document.querySelector("#bulkCount").value || 1);
    const prefix = document.querySelector("#bulkPrefix").value.trim() || "FIN";
    const validUntil = document.querySelector("#newValidUntil").value;
    const maxSessions = Number(document.querySelector("#newMaxSessions").value || 2);

    await adminApi("/api/admin/activation-codes/bulk", {
      method: "POST",
      body: {
        count,
        prefix,
        validUntil,
        maxSessions,
        status: "active",
      },
    });

    await loadAdminData();
  } catch (error) {
    setAdminState(error.message, "danger");
  }
}

async function toggleActivationCode(id, currentStatus) {
  try {
    await adminApi(`/api/admin/activation-codes/${id}`, {
      method: "PATCH",
      body: {
        status: currentStatus === "active" ? "inactive" : "active",
      },
    });
    await loadAdminData();
  } catch (error) {
    setAdminState(error.message, "danger");
  }
}

async function renewActivationCode(id) {
  const validUntil = window.prompt("请输入新的有效期，格式 YYYY-MM-DD", "2026-06-12");
  if (!validUntil) return;

  try {
    await adminApi(`/api/admin/activation-codes/${id}`, {
      method: "PATCH",
      body: { validUntil, status: "active" },
    });
    await loadAdminData();
  } catch (error) {
    setAdminState(error.message, "danger");
  }
}

async function saveSelectedConfig() {
  if (!selectedConfigKey) {
    setConfigMessage("请先选择一个配置项。", "warning");
    return;
  }

  try {
    const value = JSON.parse(configEditor.value);
    const result = await adminApi(`/api/admin/configs/${selectedConfigKey}`, {
      method: "PUT",
      body: { value },
    });
    const index = adminConfigs.findIndex((config) => config.key === selectedConfigKey);
    if (index >= 0) {
      adminConfigs[index] = result.config;
    } else {
      adminConfigs.push(result.config);
    }
    renderSelectedConfig(selectedConfigKey);
    setConfigMessage("配置已保存。", "success");
  } catch (error) {
    setConfigMessage(error.message, "danger");
  }
}

function renderAdminActivationCodes(codes) {
  if (!adminCodeRows) return;

  if (!codes.length) {
    adminCodeRows.innerHTML = `<tr><td colspan="5">暂无激活码。</td></tr>`;
    return;
  }

  adminCodeRows.innerHTML = codes
    .map((code) => {
      const expired = new Date(code.validUntil).getTime() <= Date.now();
      const tone = expired ? "danger" : code.status === "active" ? "success" : "warning";
      const label = expired ? "过期" : code.status === "active" ? "启用" : "停用";
      const toggleLabel = code.status === "active" ? "停用" : "启用";

      return `
        <tr>
          <td>${escapeHtml(code.code)}</td>
          <td><span class="tag ${tone}">${label}</span></td>
          <td>${formatDate(code.validUntil)}</td>
          <td>${code.activeSessions}/${code.maxSessions}</td>
          <td>
            <button class="text-link" data-toggle-code="${code.id}" data-code-status="${code.status}">${toggleLabel}</button>
            <button class="text-link" data-renew-code="${code.id}">续期</button>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderSelectedConfig(key) {
  selectedConfigKey = key;
  const config = adminConfigs.find((item) => item.key === key);

  document.querySelectorAll("[data-config-key]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.configKey === key);
  });

  if (!config) {
    configCurrentKey.textContent = key || "未选择";
    configEditor.value = "";
    setConfigMessage("配置项未加载。", "warning");
    return;
  }

  configCurrentKey.textContent = config.key;
  configEditor.value = JSON.stringify(config.value, null, 2);
  setConfigMessage(`最后更新：${formatDateTime(config.updatedAt)}`, "info");
}

function setAdminState(message, tone) {
  if (!adminState) return;
  adminState.classList.remove("success", "warning", "danger", "info");
  adminState.classList.add(tone);
  adminState.textContent = message;
}

function setConfigMessage(message, tone) {
  if (!configMessage) return;
  configMessage.className = `field-hint config-message ${tone}`;
  configMessage.textContent = message;
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function formatDateTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

document.addEventListener("click", async (event) => {
  const authSubmit = event.target.closest("[data-auth-submit]");
  if (authSubmit) {
    await verifyActivation();
    return;
  }

  const deleteButton = event.target.closest("[data-delete-project]");
  if (deleteButton) {
    await deleteProject(deleteButton.dataset.deleteProject);
    return;
  }

  const clearButton = event.target.closest("[data-clear-projects]");
  if (clearButton) {
    await clearProjects();
    return;
  }

  const analysisTypeButton = event.target.closest("[data-analysis-type]");
  if (analysisTypeButton) {
    selectedAnalysisType = analysisTypeButton.dataset.analysisType;
    document.querySelectorAll("[data-analysis-type]").forEach((button) => {
      button.classList.toggle("selected", button === analysisTypeButton);
    });
    updatePeriodUploadVisibility();
    setAnalysisStatus(
      selectedAnalysisType === "two_period" ? "已选择两期对比" : "已选择单期分析",
      selectedAnalysisType === "two_period"
        ? "请上传本期和上期的三张报表，系统会要求两期币种一致。"
        : "请选择三张财务报表 PDF 后创建分析任务，基础扫描件会尝试 OCR 解析。",
      selectedAnalysisType === "two_period" ? "warning" : "info",
    );
    return;
  }

  const startAnalysis = event.target.closest("[data-start-analysis]");
  if (startAnalysis) {
    await startAnalysisUploadFlow();
    return;
  }

  const confirmTab = event.target.closest("[data-confirm-tab]");
  if (confirmTab) {
    currentStatementTab = confirmTab.dataset.confirmTab;
    document.querySelectorAll("[data-confirm-tab]").forEach((button) => {
      button.classList.toggle("selected", button === confirmTab);
    });
    renderStatementRows();
    return;
  }

  const saveStatements = event.target.closest("[data-save-statements]");
  if (saveStatements) {
    try {
      await saveStatementEdits();
    } catch (error) {
      setParseStatus("保存失败", error.message, "danger");
    }
    return;
  }

  const confirmStatements = event.target.closest("[data-confirm-statements]");
  if (confirmStatements) {
    try {
      await confirmStatementEdits();
    } catch (error) {
      setParseStatus("确认失败", error.message, "danger");
    }
    return;
  }

  const downloadReport = event.target.closest("[data-download-report]");
  if (downloadReport) {
    downloadReport.disabled = true;
    setExportMessage("正在生成 PDF 报告，请不要关闭页面。", "info");
    try {
      await downloadReportPdf();
      setExportMessage("PDF 已开始下载。系统不会保存该报告；原始上传 PDF 仅临时保留 1 天，到期自动清理。", "success");
    } catch (error) {
      setExportMessage(error.message, "danger");
    } finally {
      downloadReport.disabled = false;
    }
    return;
  }

  const go = event.target.closest("[data-go]");
  if (go) {
    showScreen(go.dataset.go);
    if (go.dataset.go === "dashboard" && localStorage.getItem(SESSION_TOKEN_KEY)) {
      await loadProjects();
    }
    if (go.dataset.go === "result" && currentAnalysisJob?.id) {
      await loadAnalysisResult(currentAnalysisJob.id);
    }
  }

  const openModal = event.target.closest("[data-open-modal]");
  if (openModal) {
    const modal = document.querySelector(`[data-modal="${openModal.dataset.openModal}"]`);
    modal?.showModal();
  }

  const closeModal = event.target.closest("[data-close-modal]");
  if (closeModal) {
    closeModal.closest("dialog")?.close();
  }

  const modeButton = event.target.closest("[data-mode]");
  if (modeButton) {
    document.querySelectorAll("[data-mode]").forEach((button) => {
      button.classList.toggle("selected", button === modeButton);
    });
    document.querySelector("[data-metrics]")?.classList.toggle("learn-mode", modeButton.dataset.mode === "learn");
  }
});

authInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    verifyActivation();
  }
});

document.querySelectorAll("[data-upload-file]").forEach((input) => {
  input.addEventListener("change", () => {
    const file = input.files[0];
    const statementType = input.dataset.uploadFile;
    const period = input.dataset.uploadPeriod;
    if (!file) {
      markUploadBox(statementType, period, "", period === "previous" ? "两期对比时上传" : "拖拽 PDF 或点击选择");
      return;
    }
    markUploadBox(statementType, period, "", `${file.name} · 等待上传`);
    setAnalysisStatus("文件已选择", `${statementTypeLabel(statementType)} · ${periodLabel(period)}：${file.name}`, "info");
  });
});

updatePeriodUploadVisibility();

document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      dialog.close();
    }
  });
});

const cachedActivation = localStorage.getItem(ACTIVATION_KEY);
if (cachedActivation) {
  updateActivationUI(JSON.parse(cachedActivation));
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // PWA shell can still run without service worker support in local previews.
    });
  });
}
