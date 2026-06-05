(() => {
  "use strict";

  const ENDPOINTS = {
    live: "wss://ws.okx.com:8443/ws/v5/private",
    demo: "wss://wspap.okx.com:8443/ws/v5/private",
  };

  const REST_BASE_URL = "https://www.okx.com";
  const SIGN_PATH = "/users/self/verify";

  const DEFAULT_CONFIG = {
    environment: "live",
    wsUrl: "",
    restUrl: "",
    apiKey: "",
    passphrase: "",
    secretKey: "",
    profitCurrency: "USDT",
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
      restUrl: resolveRestUrl(config),
      apiKey: String(config.apiKey || "").trim(),
      passphrase: String(config.passphrase || ""),
      secretKey: String(config.secretKey || ""),
    };
  }

  function validateCredentials(credentials) {
    const missing = [];
    if (!ENDPOINTS[credentials.environment]) missing.push("环境");
    if (!isValidWebSocketUrl(credentials.wsUrl)) missing.push("WebSocket URL");
    if (!isValidHttpsUrl(credentials.restUrl)) missing.push("REST URL");
    if (!credentials.apiKey) missing.push("API Key");
    if (!credentials.passphrase) missing.push("Passphrase");
    if (!credentials.secretKey) missing.push("Secret Key");
    if (missing.length) {
      throw new Error(`缺少 ${missing.join("、")}。`);
    }
  }

  function hasUsableCredentials(credentials) {
    return Boolean(credentials.apiKey && credentials.passphrase && credentials.secretKey);
  }

  async function createSignature(timestamp, secretKey) {
    return createRequestSignature(timestamp, "GET", SIGN_PATH, "", secretKey);
  }

  async function privateGet(credentials, path, params = {}) {
    validateCredentials(credentials);
    const requestPath = createRequestPath(path, params);
    const timestamp = new Date().toISOString();
    const sign = await createRequestSignature(timestamp, "GET", requestPath, "", credentials.secretKey);
    const headers = {
      Accept: "application/json",
      "OK-ACCESS-KEY": credentials.apiKey,
      "OK-ACCESS-SIGN": sign,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": credentials.passphrase,
    };

    if (credentials.environment === "demo") {
      headers["x-simulated-trading"] = "1";
    }

    const response = await fetch(`${credentials.restUrl}${requestPath}`, { headers });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(`OKX REST HTTP ${response.status}`);
    }
    if (payload.code && payload.code !== "0") {
      throw new Error(`${payload.code} ${payload.msg || "OKX REST 请求失败"}`.trim());
    }
    return Array.isArray(payload.data) ? payload.data : [];
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

  function resolveRestUrl(config) {
    const configuredUrl = String(config.restUrl || "").trim();
    if (!configuredUrl) {
      return REST_BASE_URL;
    }
    return configuredUrl.replace(/\/+$/, "");
  }

  function isValidWebSocketUrl(url) {
    try {
      return new URL(url).protocol === "wss:";
    } catch {
      return false;
    }
  }

  function isValidHttpsUrl(url) {
    try {
      return new URL(url).protocol === "https:";
    } catch {
      return false;
    }
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
    createSignature,
    endpointLabel,
    hasUsableCredentials,
    loadConfig,
    privateGet,
    readCredentials,
    validateCredentials,
  });
})();
