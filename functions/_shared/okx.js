const DEFAULT_REST_BASE_URL = "https://www.okx.com";
const WS_SIGN_PATH = "/users/self/verify";

export function readOkxSettings(env) {
  const environment = String(env.OKX_ENVIRONMENT || "live").trim().toLowerCase();
  const settings = {
    environment: environment === "demo" ? "demo" : "live",
    restBaseUrl: String(env.OKX_REST_BASE_URL || DEFAULT_REST_BASE_URL).replace(/\/+$/, ""),
    apiKey: getEnvValue(env, ["OKX_API_KEY"]).trim(),
    passphrase: getEnvValue(env, ["OKX_API_PASSPHRASE", "OKX_PASSPHRASE"]),
    secretKey: getEnvValue(env, ["OKX_SECRET_KEY", "OKX_API_SECRET"]),
  };

  const missing = [];
  if (!settings.apiKey) missing.push("OKX_API_KEY");
  if (!settings.passphrase) missing.push("OKX_API_PASSPHRASE 或 OKX_PASSPHRASE");
  if (!settings.secretKey) missing.push("OKX_SECRET_KEY 或 OKX_API_SECRET");
  if (missing.length) {
    throw new Error(`缺少环境变量：${missing.join("、")}`);
  }

  if (!isHttpsUrl(settings.restBaseUrl)) {
    throw new Error("OKX_REST_BASE_URL 必须是 HTTPS 地址。");
  }

  return settings;
}

function getEnvValue(env, names) {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== "") {
      return String(value);
    }
  }
  return "";
}

export async function createOkxHeaders(settings, method, requestPath, body = "") {
  const timestamp = new Date().toISOString();
  const sign = await createRequestSignature(timestamp, method, requestPath, body, settings.secretKey);
  const headers = new Headers({
    Accept: "application/json",
    "OK-ACCESS-KEY": settings.apiKey,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": settings.passphrase,
  });

  if (settings.environment === "demo") {
    headers.set("x-simulated-trading", "1");
  }

  return headers;
}

export async function createWebSocketLoginPayload(settings) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sign = await createRequestSignature(timestamp, "GET", WS_SIGN_PATH, "", settings.secretKey);
  return {
    apiKey: settings.apiKey,
    passphrase: settings.passphrase,
    timestamp,
    sign,
  };
}

export function json(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export function methodNotAllowed(allowedMethods) {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: {
      Allow: allowedMethods.join(", "),
      "Cache-Control": "no-store",
    },
  });
}

async function createRequestSignature(timestamp, method, requestPath, body, secretKey) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(`${timestamp}${method.toUpperCase()}${requestPath}${body || ""}`),
  );
  return base64FromBytes(new Uint8Array(signature));
}

function base64FromBytes(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
