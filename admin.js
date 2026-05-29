const ADMIN_TOKEN_KEY = "financialAnalyzer.adminToken";
const API_BASE_PATH = window.location.pathname.startsWith("/financial/") ? "/financial" : "";

const adminTokenInput = document.querySelector("#adminToken");
const adminState = document.querySelector("[data-admin-state]");
const adminCodeRows = document.querySelector("[data-admin-code-rows]");
const configEditor = document.querySelector("[data-config-editor]");
const configCurrentKey = document.querySelector("[data-config-current-key]");
const configMessage = document.querySelector("[data-config-message]");

let adminConfigs = [];
let selectedConfigKey = "";

async function adminApi(path, options = {}) {
  const token = adminTokenInput?.value.trim() || localStorage.getItem(ADMIN_TOKEN_KEY) || "";
  const headers = {
    Accept: "application/json",
    "X-Admin-Token": token,
    ...(options.headers || {}),
  };

  if (options.body) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(apiPath(path), {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || "请求失败。");
    error.status = response.status;
    throw error;
  }

  if (token) {
    localStorage.setItem(ADMIN_TOKEN_KEY, token);
  }

  return payload;
}

function apiPath(path) {
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith("/api/")) return `${API_BASE_PATH}${path}`;
  return path;
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
  const adminLoad = event.target.closest("[data-admin-load]");
  if (adminLoad) {
    await loadAdminData();
    return;
  }

  const createCode = event.target.closest("[data-create-code]");
  if (createCode) {
    await createActivationCode();
    return;
  }

  const bulkCreate = event.target.closest("[data-bulk-create]");
  if (bulkCreate) {
    await bulkCreateActivationCodes();
    return;
  }

  const toggleCode = event.target.closest("[data-toggle-code]");
  if (toggleCode) {
    await toggleActivationCode(toggleCode.dataset.toggleCode, toggleCode.dataset.codeStatus);
    return;
  }

  const renewCode = event.target.closest("[data-renew-code]");
  if (renewCode) {
    await renewActivationCode(renewCode.dataset.renewCode);
    return;
  }

  const configButton = event.target.closest("[data-config-key]");
  if (configButton) {
    renderSelectedConfig(configButton.dataset.configKey);
    return;
  }

  const saveConfig = event.target.closest("[data-save-config]");
  if (saveConfig) {
    await saveSelectedConfig();
  }
});

const cachedAdminToken = localStorage.getItem(ADMIN_TOKEN_KEY);
if (cachedAdminToken && adminTokenInput) {
  adminTokenInput.value = cachedAdminToken;
}
