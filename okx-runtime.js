(() => {
  "use strict";

  const ENDPOINTS = {
    live: "wss://ws.okx.com:8443/ws/v5/private",
    demo: "wss://wspap.okx.com:8443/ws/v5/private",
  };

  const DEFAULT_CONFIG = {
    environment: "live",
    wsUrl: "",
    apiBaseUrl: "",
    profitCurrency: "USDT",
    profitChartRefreshInterval: 60000,
    positionUpdateInterval: 2000,
    positionRefreshInterval: 2000,
    positionHistoryLimit: 10,
  };

  function loadConfig() {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const configUrl = new URL("./config.js", window.location.href);
      configUrl.searchParams.set("v", String(Date.now()));

      delete window.OKX_DASHBOARD_CONFIG;
      script.src = configUrl.href;
      script.async = true;
      script.onload = () => resolve({ ...DEFAULT_CONFIG, ...(window.OKX_DASHBOARD_CONFIG || {}) });
      script.onerror = () => reject(new Error("无法加载最新 config.js。"));
      document.head.append(script);
    });
  }

  function readCredentials(config) {
    const environment = ENDPOINTS[config.environment] ? config.environment : "live";
    return {
      environment,
      wsUrl: resolveWebSocketUrl(config, environment),
      apiBaseUrl: resolveApiBaseUrl(config),
    };
  }

  function validateCredentials(credentials) {
    const missing = [];
    if (!ENDPOINTS[credentials.environment]) missing.push("环境");
    if (!isValidWebSocketUrl(credentials.wsUrl)) missing.push("WebSocket URL");
    if (!isValidHttpUrl(credentials.apiBaseUrl)) missing.push("Worker API URL");
    if (missing.length) {
      throw new Error(`缺少 ${missing.join("、")}。`);
    }
  }

  function hasUsableCredentials(credentials) {
    try {
      validateCredentials(credentials);
      return true;
    } catch {
      return false;
    }
  }

  async function createWebSocketLoginPayload(credentials) {
    validateCredentials(credentials);
    const response = await fetch(`${credentials.apiBaseUrl}/api/okx/ws-login`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      method: "POST",
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(formatHttpError("OKX WebSocket 登录 Worker", response, payload));
    }
    if (!payload.apiKey || !payload.passphrase || !payload.timestamp || !payload.sign) {
      throw new Error("OKX WebSocket 登录 Worker 返回数据不完整。");
    }
    return {
      apiKey: String(payload.apiKey),
      passphrase: String(payload.passphrase),
      timestamp: String(payload.timestamp),
      sign: String(payload.sign),
    };
  }

  async function privateGet(credentials, path, params = {}) {
    validateCredentials(credentials);
    const requestPath = createRequestPath(path, params);
    const response = await fetch(`${credentials.apiBaseUrl}${requestPath}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(formatHttpError("OKX REST Worker", response, payload));
    }
    if (payload.code && payload.code !== "0") {
      throw new Error(`${payload.code} ${payload.msg || "OKX REST 请求失败"}`.trim());
    }
    return Array.isArray(payload.data) ? payload.data : [];
  }

  function endpointLabel(credentials) {
    const defaultUrl = ENDPOINTS[credentials.environment];
    if (credentials.wsUrl && credentials.wsUrl !== defaultUrl) {
      return credentials.wsUrl;
    }
    return credentials.environment === "demo" ? "OKX 模拟盘" : "OKX 实盘";
  }

  function resolveWebSocketUrl(config, environment) {
    const configuredUrl = String(config.wsUrl || "").trim();
    return configuredUrl || ENDPOINTS[environment];
  }

  function resolveApiBaseUrl(config) {
    return String(config.apiBaseUrl || "").trim().replace(/\/+$/, "");
  }

  function isValidWebSocketUrl(url) {
    try {
      return new URL(url).protocol === "wss:";
    } catch {
      return false;
    }
  }

  function isValidHttpUrl(url) {
    try {
      const protocol = new URL(url).protocol;
      return protocol === "https:" || protocol === "http:";
    } catch {
      return false;
    }
  }

  function createRequestPath(path, params) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== "") {
        searchParams.set(key, String(value));
      }
    }
    const query = searchParams.toString();
    return query ? `${path}?${query}` : path;
  }

  async function parseJsonResponse(response) {
    try {
      return await response.json();
    } catch {
      return {};
    }
  }

  function formatHttpError(label, response, payload) {
    const detail = payload.msg || payload.message || "";
    return detail ? `${label} HTTP ${response.status}: ${detail}` : `${label} HTTP ${response.status}`;
  }

  window.OKXRuntime = Object.freeze({
    DEFAULT_CONFIG,
    ENDPOINTS,
    createWebSocketLoginPayload,
    endpointLabel,
    hasUsableCredentials,
    loadConfig,
    privateGet,
    readCredentials,
    validateCredentials,
  });
})();
