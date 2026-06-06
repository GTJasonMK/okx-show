#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const tls = require("node:tls");
const vm = require("node:vm");

const ROOT = __dirname;
const DEFAULT_REST_BASE_URL = "https://www.okx.com";
const WS_SIGN_PATH = "/users/self/verify";
const REQUEST_TIMEOUT_MS = 15000;
const ALLOWED_GET_PATHS = new Set([
  "/api/v5/account/positions",
  "/api/v5/account/positions-history",
]);
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
]);

loadEnvFile(path.join(ROOT, ".env"));

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8080);

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    const message = describeError(error);
    console.error(`[dev-server] ${request.method} ${request.url}: ${message}`);
    sendJson(response, 500, { code: "500", msg: message });
  });
});

server.listen(port, host, () => {
  console.log(`OKX dashboard dev server: http://${host}:${port}/`);
});

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);

  if (url.pathname === "/api/okx/ws-login") {
    await handleWebSocketLogin(request, response);
    return;
  }

  if (url.pathname.startsWith("/api/v5/")) {
    await handleOkxRest(request, response, url);
    return;
  }

  serveStatic(request, response, url);
}

async function handleWebSocketLogin(request, response) {
  if (request.method !== "POST") {
    sendText(response, 405, "Method Not Allowed", { Allow: "POST" });
    return;
  }

  const settings = readOkxSettings();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  sendJson(response, 200, {
    apiKey: settings.apiKey,
    passphrase: settings.passphrase,
    timestamp,
    sign: createRequestSignature(timestamp, "GET", WS_SIGN_PATH, "", settings.secretKey),
  });
}

async function handleOkxRest(request, response, url) {
  if (request.method !== "GET") {
    sendText(response, 405, "Method Not Allowed", { Allow: "GET" });
    return;
  }

  if (!ALLOWED_GET_PATHS.has(url.pathname)) {
    sendJson(response, 403, { code: "403", msg: "当前 OKX REST 路径未开放代理。" });
    return;
  }

  const settings = readOkxSettings();
  const requestPath = `${url.pathname}${url.search}`;
  const okxResponse = await requestOkxRest(settings, requestPath);
  response.writeHead(okxResponse.statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": okxResponse.headers["content-type"] || "application/json; charset=utf-8",
  });
  response.end(okxResponse.body);
}

function serveStatic(request, response, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "Method Not Allowed", { Allow: "GET, HEAD" });
    return;
  }

  const filePath = resolveStaticPath(url.pathname);
  if (!filePath) {
    sendText(response, 403, "Forbidden");
    return;
  }

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      sendText(response, 404, "File not found");
      return;
    }

    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": stat.size,
      "Content-Type": MIME_TYPES.get(path.extname(filePath)) || "application/octet-stream",
    });

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    fs.createReadStream(filePath).pipe(response);
  });
}

function resolveStaticPath(pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const filePath = path.resolve(ROOT, relativePath);
  if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${path.sep}`)) {
    return null;
  }
  return filePath;
}

function readOkxSettings() {
  const dashboardConfig = loadDashboardConfig();
  const environment = String(
    getEnvValue(["OKX_ENVIRONMENT"]) || dashboardConfig.environment || "live",
  )
    .trim()
    .toLowerCase();
  const settings = {
    environment: environment === "demo" ? "demo" : "live",
    restBaseUrl: resolveRestBaseUrl(dashboardConfig),
    proxyUrl: getEnvValue(["OKX_REST_PROXY", "HTTPS_PROXY", "https_proxy"]),
    apiKey: (getEnvValue(["OKX_API_KEY"]) || dashboardConfig.apiKey || "").trim(),
    passphrase:
      getEnvValue(["OKX_API_PASSPHRASE", "OKX_PASSPHRASE"]) || dashboardConfig.passphrase || "",
    secretKey:
      getEnvValue(["OKX_SECRET_KEY", "OKX_API_SECRET"]) || dashboardConfig.secretKey || "",
  };

  const missing = [];
  if (!settings.apiKey) missing.push("config.apiKey 或 OKX_API_KEY");
  if (!settings.passphrase) missing.push("config.passphrase 或 OKX_API_PASSPHRASE");
  if (!settings.secretKey) missing.push("config.secretKey 或 OKX_SECRET_KEY");
  if (missing.length) {
    throw new Error(`config.js 或环境变量缺少：${missing.join("、")}`);
  }

  try {
    if (new URL(settings.restBaseUrl).protocol !== "https:") {
      throw new Error("OKX_REST_BASE_URL 必须是 HTTPS 地址。");
    }
  } catch {
    throw new Error("OKX_REST_BASE_URL 必须是 HTTPS 地址。");
  }

  return settings;
}

function requestOkxRest(settings, requestPath) {
  const url = new URL(`${settings.restBaseUrl}${requestPath}`);
  const headers = {
    ...createOkxHeaders(settings, "GET", requestPath),
    "Accept-Encoding": "identity",
    Connection: "close",
  };
  const requestOptions = {
    headers,
    hostname: url.hostname,
    method: "GET",
    path: `${url.pathname}${url.search}`,
    port: Number(url.port || 443),
    timeout: REQUEST_TIMEOUT_MS,
  };

  if (settings.proxyUrl) {
    return requestOkxRestViaProxy(settings.proxyUrl, requestOptions);
  }

  return requestHttps(requestOptions);
}

async function requestOkxRestViaProxy(proxyUrl, requestOptions) {
  const socket = await createProxyTlsSocket(proxyUrl, requestOptions.hostname, requestOptions.port);
  return requestHttpOverTlsSocket(socket, requestOptions);
}

function requestHttps(requestOptions) {
  return new Promise((resolve, reject) => {
    const request = https.request(requestOptions, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          body: Buffer.concat(chunks),
          headers: response.headers,
          statusCode: response.statusCode || 502,
        });
      });
    });

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`OKX REST 请求超时：${REQUEST_TIMEOUT_MS}ms`));
    });
    request.on("error", (error) => {
      reject(new Error(`无法连接 OKX REST：${describeError(error)}`));
    });
    request.end();
  });
}

function requestHttpOverTlsSocket(socket, requestOptions) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;

    socket.setTimeout(REQUEST_TIMEOUT_MS);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("timeout", () => {
      rejectOnce(new Error(`OKX REST 请求超时：${REQUEST_TIMEOUT_MS}ms`));
      socket.destroy();
    });
    socket.once("error", (error) => {
      rejectOnce(new Error(`无法连接 OKX REST：${describeError(error)}`));
    });
    socket.once("end", finish);
    socket.once("close", finish);
    socket.write(formatHttpRequest(requestOptions));

    function finish() {
      if (settled) {
        return;
      }
      try {
        resolveOnce(parseHttpResponse(Buffer.concat(chunks)));
      } catch (error) {
        rejectOnce(error);
      }
    }

    function resolveOnce(value) {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    }

    function rejectOnce(error) {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    }
  });
}

function formatHttpRequest(requestOptions) {
  const headers = {
    Host: requestOptions.hostname,
    ...requestOptions.headers,
  };
  return [
    `${requestOptions.method} ${requestOptions.path} HTTP/1.1`,
    ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
    "",
    "",
  ].join("\r\n");
}

function parseHttpResponse(buffer) {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    throw new Error("OKX REST 返回了不完整的 HTTP 响应。");
  }

  const headerText = buffer.subarray(0, headerEnd).toString("utf8");
  const [statusLine, ...headerLines] = headerText.split("\r\n");
  const statusCode = Number(statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/)?.[1]);
  if (!statusCode) {
    throw new Error(`OKX REST 返回了无效状态行：${statusLine || "empty"}`);
  }

  const headers = {};
  for (const line of headerLines) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }

  const rawBody = buffer.subarray(headerEnd + 4);
  return {
    body: isChunked(headers) ? decodeChunkedBody(rawBody) : rawBody,
    headers,
    statusCode,
  };
}

function isChunked(headers) {
  return String(headers["transfer-encoding"] || "").toLowerCase().includes("chunked");
}

function decodeChunkedBody(buffer) {
  const chunks = [];
  let offset = 0;

  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd === -1) {
      throw new Error("OKX REST 返回了不完整的 chunked 响应。");
    }

    const sizeText = buffer.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0];
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size)) {
      throw new Error(`OKX REST 返回了无效 chunk 大小：${sizeText}`);
    }

    offset = lineEnd + 2;
    if (size === 0) {
      return Buffer.concat(chunks);
    }

    const chunkEnd = offset + size;
    chunks.push(buffer.subarray(offset, chunkEnd));
    offset = chunkEnd + 2;
  }

  throw new Error("OKX REST 返回了不完整的 chunked 响应。");
}

function createProxyTlsSocket(proxyUrl, targetHostname, targetPort) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let proxy;
    try {
      proxy = new URL(proxyUrl);
    } catch {
      rejectOnce(new Error("OKX_REST_PROXY 必须是有效 URL，例如 http://127.0.0.1:7897。"));
      return;
    }

    if (proxy.protocol !== "http:") {
      rejectOnce(new Error("OKX_REST_PROXY 目前只支持 http:// 代理。"));
      return;
    }

    const proxyPort = Number(proxy.port || 80);
    const proxySocket = net.connect(proxyPort, proxy.hostname);
    const chunks = [];

    proxySocket.setTimeout(REQUEST_TIMEOUT_MS);
    proxySocket.once("connect", () => {
      const target = `${targetHostname}:${targetPort}`;
      const authHeader =
        proxy.username || proxy.password
          ? `Proxy-Authorization: Basic ${Buffer.from(
              `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
            ).toString("base64")}\r\n`
          : "";
      proxySocket.write(
        `CONNECT ${target} HTTP/1.1\r\n` +
          `Host: ${target}\r\n` +
          authHeader +
          "Proxy-Connection: Keep-Alive\r\n" +
          "\r\n",
      );
    });
    proxySocket.on("data", onProxyData);
    proxySocket.once("timeout", () => {
      rejectOnce(new Error(`连接 OKX_REST_PROXY 超时：${REQUEST_TIMEOUT_MS}ms`));
      proxySocket.destroy();
    });
    proxySocket.once("error", (error) => {
      rejectOnce(new Error(`无法连接 OKX_REST_PROXY ${proxy.host}：${describeError(error)}`));
    });

    function onProxyData(chunk) {
      chunks.push(chunk);
      const responseBuffer = Buffer.concat(chunks);
      const headerEnd = responseBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      proxySocket.removeListener("data", onProxyData);
      const header = responseBuffer.subarray(0, headerEnd).toString("utf8");
      const statusLine = header.split("\r\n")[0] || "";
      const statusCode = Number(statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/)?.[1]);
      if (statusCode !== 200) {
        proxySocket.destroy();
        rejectOnce(new Error(`OKX_REST_PROXY CONNECT 失败：${statusLine || "unknown response"}`));
        return;
      }

      const secureSocket = tls.connect({
        servername: targetHostname,
        socket: proxySocket,
      });
      secureSocket.once("secureConnect", () => {
        secureSocket.setTimeout(0);
        resolveOnce(secureSocket);
      });
      secureSocket.once("error", (error) => {
        rejectOnce(new Error(`OKX_REST_PROXY TLS 握手失败：${describeError(error)}`));
      });
    }

    function resolveOnce(socket) {
      if (settled) {
        return;
      }
      settled = true;
      resolve(socket);
    }

    function rejectOnce(error) {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    }
  });
}

function resolveRestBaseUrl(dashboardConfig) {
  const configuredUrl = getEnvValue(["OKX_REST_BASE_URL"]) || dashboardConfig.restUrl || "";
  if (!configuredUrl) {
    return DEFAULT_REST_BASE_URL;
  }

  const trimmedUrl = String(configuredUrl).trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmedUrl);
    if (url.protocol === "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      return trimmedUrl;
    }
  } catch {
    return DEFAULT_REST_BASE_URL;
  }

  return DEFAULT_REST_BASE_URL;
}

function loadDashboardConfig() {
  const configPath = path.join(ROOT, "config.js");
  if (!fs.existsSync(configPath)) {
    return {};
  }

  const sandbox = {
    window: {},
  };
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;

  try {
    const source = fs.readFileSync(configPath, "utf8");
    vm.runInNewContext(source, sandbox, {
      filename: configPath,
      timeout: 1000,
    });
  } catch (error) {
    throw new Error(`无法读取 config.js：${error.message || error}`);
  }

  const config = sandbox.window.OKX_DASHBOARD_CONFIG;
  return config && typeof config === "object" ? config : {};
}

function getEnvValue(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") {
      return String(value);
    }
  }
  return "";
}

function describeError(error) {
  const messages = [];
  let current = error;
  while (current) {
    const message = current.code ? `${current.message} (${current.code})` : current.message;
    if (message) {
      messages.push(message);
    }
    current = current.cause;
  }
  return messages.length ? messages.join("；cause: ") : String(error);
}

function createOkxHeaders(settings, method, requestPath, body = "") {
  const timestamp = new Date().toISOString();
  const headers = {
    Accept: "application/json",
    "OK-ACCESS-KEY": settings.apiKey,
    "OK-ACCESS-SIGN": createRequestSignature(timestamp, method, requestPath, body, settings.secretKey),
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": settings.passphrase,
  };

  if (settings.environment === "demo") {
    headers["x-simulated-trading"] = "1";
  }

  return headers;
}

function createRequestSignature(timestamp, method, requestPath, body, secretKey) {
  return crypto
    .createHmac("sha256", secretKey)
    .update(`${timestamp}${method.toUpperCase()}${requestPath}${body || ""}`)
    .digest("base64");
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function sendText(response, status, text, headers = {}) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  response.end(text);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match || process.env[match[1]] !== undefined) {
      continue;
    }

    process.env[match[1]] = unquoteEnvValue(match[2].trim());
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
