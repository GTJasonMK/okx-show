(() => {
  "use strict";

  const ENDPOINTS = {
    live: "wss://ws.okx.com:8443/ws/v5/private",
    demo: "wss://wspap.okx.com:8443/ws/v5/private",
  };

  const REST_BASE_URL = "https://www.okx.com";
  const WS_LOGIN_PATH = "/api/okx/ws-login";
  const SIGN_PATH = "/users/self/verify";

  const DEFAULT_CONFIG = {
    environment: "live",
    wsUrl: "",
    restUrl: "",
    restAuthMode: "server",
    webSocketAuthMode: "server",
    wsLoginUrl: "",
    apiKey: "",
    passphrase: "",
    secretKey: "",
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
    const restAuthMode = resolveAuthMode(config.restAuthMode);
    const webSocketAuthMode = resolveAuthMode(config.webSocketAuthMode);
    return {
      environment,
      wsUrl: resolveWebSocketUrl(config, environment),
      restUrl: resolveRestUrl(config, restAuthMode),
      restAuthMode,
      webSocketAuthMode,
      wsLoginUrl: resolveWsLoginUrl(config),
      apiKey: String(config.apiKey || "").trim(),
      passphrase: String(config.passphrase || ""),
      secretKey: String(config.secretKey || ""),
    };
  }

  function validateCredentials(credentials, purpose = "websocket") {
    const missing = [];
    if (!ENDPOINTS[credentials.environment]) missing.push("环境");
    if (purpose === "websocket" || purpose === "all") {
      if (!isValidWebSocketUrl(credentials.wsUrl)) missing.push("WebSocket URL");
      if (credentials.webSocketAuthMode === "server") {
        if (!isValidHttpUrl(credentials.wsLoginUrl)) missing.push("WebSocket 登录代理 URL");
      } else {
        pushMissingClientCredentials(credentials, missing);
      }
    }
    if (purpose === "rest" || purpose === "all") {
      if (!isValidHttpUrl(credentials.restUrl)) missing.push("REST URL");
      if (credentials.restAuthMode === "client") {
        pushMissingClientCredentials(credentials, missing);
      }
    }
    if (missing.length) {
      throw new Error(`缺少 ${missing.join("、")}。`);
    }
  }

  function hasUsableCredentials(credentials) {
    return hasUsableWebSocketAccess(credentials);
  }

  function hasUsableRestAccess(credentials) {
    if (!ENDPOINTS[credentials.environment] || !isValidHttpUrl(credentials.restUrl)) {
      return false;
    }
    return credentials.restAuthMode === "server" || hasClientCredentials(credentials);
  }

  function hasUsableWebSocketAccess(credentials) {
    if (!ENDPOINTS[credentials.environment] || !isValidWebSocketUrl(credentials.wsUrl)) {
      return false;
    }
    return credentials.webSocketAuthMode === "server"
      ? isValidHttpUrl(credentials.wsLoginUrl)
      : hasClientCredentials(credentials);
  }

  function hasClientCredentials(credentials) {
    return Boolean(credentials.apiKey && credentials.passphrase && credentials.secretKey);
  }

  async function createSignature(timestamp, secretKey) {
    return createRequestSignature(timestamp, "GET", SIGN_PATH, "", secretKey);
  }

  async function privateGet(credentials, path, params = {}) {
    validateCredentials(credentials, "rest");
    const requestPath = createRequestPath(path, params);
    const headers = {
      Accept: "application/json",
    };

    if (credentials.restAuthMode === "client") {
      const timestamp = new Date().toISOString();
      const sign = await createRequestSignature(timestamp, "GET", requestPath, "", credentials.secretKey);
      headers["OK-ACCESS-KEY"] = credentials.apiKey;
      headers["OK-ACCESS-SIGN"] = sign;
      headers["OK-ACCESS-TIMESTAMP"] = timestamp;
      headers["OK-ACCESS-PASSPHRASE"] = credentials.passphrase;

      if (credentials.environment === "demo") {
        headers["x-simulated-trading"] = "1";
      }
    }

    const response = await fetch(`${credentials.restUrl}${requestPath}`, {
      cache: "no-store",
      headers,
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(formatHttpError("OKX REST", response, payload));
    }
    if (payload.code && payload.code !== "0") {
      throw new Error(`${payload.code} ${payload.msg || "OKX REST 请求失败"}`.trim());
    }
    return Array.isArray(payload.data) ? payload.data : [];
  }

  async function createWebSocketLoginPayload(credentials) {
    validateCredentials(credentials, "websocket");

    if (credentials.webSocketAuthMode === "client") {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const sign = await createSignature(timestamp, credentials.secretKey);
      return {
        apiKey: credentials.apiKey,
        passphrase: credentials.passphrase,
        timestamp,
        sign,
      };
    }

    const response = await fetch(credentials.wsLoginUrl, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
      method: "POST",
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(formatHttpError("OKX WebSocket 登录代理", response, payload));
    }

    const loginPayload = {
      apiKey: String(payload.apiKey || "").trim(),
      passphrase: String(payload.passphrase || ""),
      timestamp: String(payload.timestamp || ""),
      sign: String(payload.sign || ""),
    };
    if (!loginPayload.apiKey || !loginPayload.passphrase || !loginPayload.timestamp || !loginPayload.sign) {
      throw new Error("OKX WebSocket 登录代理返回数据不完整。");
    }
    return loginPayload;
  }

  async function createRequestSignature(timestamp, method, requestPath, body, secretKey) {
    const encoder = new TextEncoder();
    const cryptoKey = await window.crypto.subtle.importKey(
      "raw",
      encoder.encode(secretKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await window.crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      encoder.encode(`${timestamp}${method.toUpperCase()}${requestPath}${body || ""}`),
    );
    return base64FromBytes(new Uint8Array(signature));
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

  function endpointLabel(credentials) {
    const defaultUrl = ENDPOINTS[credentials.environment];
    if (credentials.wsUrl && credentials.wsUrl !== defaultUrl) {
      return credentials.wsUrl;
    }
    return credentials.environment === "demo" ? "OKX 模拟盘" : "OKX 实盘";
  }

  function resolveWebSocketUrl(config, environment) {
    const configuredUrl = String(config.wsUrl || "").trim();
    if (configuredUrl) {
      return configuredUrl;
    }
    return ENDPOINTS[environment];
  }

  function resolveRestUrl(config, authMode) {
    const configuredUrl = String(config.restUrl || "").trim();
    if (!configuredUrl) {
      return authMode === "server" ? resolveSameOriginUrl("") : REST_BASE_URL;
    }
    return configuredUrl.replace(/\/+$/, "");
  }

  function resolveWsLoginUrl(config) {
    const configuredUrl = String(config.wsLoginUrl || "").trim();
    if (configuredUrl) {
      return configuredUrl;
    }
    return resolveSameOriginUrl(WS_LOGIN_PATH);
  }

  function resolveAuthMode(value) {
    return value === "client" ? "client" : "server";
  }

  function resolveSameOriginUrl(path) {
    const origin = window.location.origin;
    if (!isValidHttpUrl(origin)) {
      return "";
    }
    return `${origin}${path}`;
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

  function pushMissingClientCredentials(credentials, missing) {
    if (!credentials.apiKey) missing.push("API Key");
    if (!credentials.passphrase) missing.push("Passphrase");
    if (!credentials.secretKey) missing.push("Secret Key");
  }

  function formatHttpError(label, response, payload) {
    const detail = payload.msg || payload.message || "";
    return detail ? `${label} HTTP ${response.status}: ${detail}` : `${label} HTTP ${response.status}`;
  }

  function base64FromBytes(bytes) {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return window.btoa(binary);
  }

  window.OKXRuntime = Object.freeze({
    DEFAULT_CONFIG,
    ENDPOINTS,
    createWebSocketLoginPayload,
    createSignature,
    endpointLabel,
    hasUsableCredentials,
    hasUsableRestAccess,
    hasUsableWebSocketAccess,
    loadConfig,
    privateGet,
    readCredentials,
    validateCredentials,
  });
})();
