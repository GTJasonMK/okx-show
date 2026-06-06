const OKX_REST_BASE_URL = "https://www.okx.com";
const WS_SIGN_PATH = "/users/self/verify";
const AUTH_COOKIE_NAME = "okx_show_session";
const DEFAULT_AUTH_ITERATIONS = 210000;
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;
const LOGIN_DAILY_FAILURE_LIMIT = 5;
const BEIJING_TIME_OFFSET_MS = 8 * 60 * 60 * 1000;
const ALLOWED_REST_PATHS = new Set([
  "/api/v5/account/positions",
  "/api/v5/account/positions-history",
]);
const loginFailures = new Map();

export default {
  async fetch(request, env) {
    const corsHeaders = getCorsHeaders(request, env);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const url = new URL(request.url);
      if (!isOriginAllowed(request, env)) {
        return jsonResponse({ message: "Origin not allowed" }, 403, corsHeaders);
      }

      if (url.pathname === "/api/auth/session") {
        return await handleAuthSession(request, env, corsHeaders);
      }

      if (url.pathname === "/api/auth/login") {
        return await handleAuthLogin(request, env, corsHeaders);
      }

      if (url.pathname === "/api/auth/logout") {
        return handleAuthLogout(request, corsHeaders);
      }

      if (url.pathname === "/api/okx/ws-login") {
        const session = await requireSession(request, env);
        if (!session) {
          return jsonResponse({ message: "Unauthorized" }, 401, corsHeaders);
        }
        return await handleWebSocketLogin(request, env, corsHeaders);
      }

      if (ALLOWED_REST_PATHS.has(url.pathname)) {
        const session = await requireSession(request, env);
        if (!session) {
          return jsonResponse({ message: "Unauthorized" }, 401, corsHeaders);
        }
        return await handleOkxRest(request, env, url, corsHeaders);
      }

      return jsonResponse({ message: "Not found" }, 404, corsHeaders);
    } catch (error) {
      return jsonResponse(
        { message: error?.message || "Worker internal error" },
        500,
        corsHeaders,
      );
    }
  },
};

async function handleAuthSession(request, env, corsHeaders) {
  if (request.method !== "GET") {
    return jsonResponse({ message: "Method not allowed" }, 405, corsHeaders);
  }

  const session = await requireSession(request, env);
  if (!session) {
    return jsonResponse({ authenticated: false }, 401, corsHeaders);
  }

  return jsonResponse(
    {
      authenticated: true,
      username: session.username,
      expiresAt: session.expiresAt,
    },
    200,
    corsHeaders,
  );
}

async function handleAuthLogin(request, env, corsHeaders) {
  if (request.method !== "POST") {
    return jsonResponse({ message: "Method not allowed" }, 405, corsHeaders);
  }

  const authConfig = readAuthConfig(env);
  const body = await readJsonBody(request);
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const rateLimitKey = getLoginRateLimitKey(request, username);
  if (isLoginRateLimited(rateLimitKey)) {
    return jsonResponse({ message: "密码错误次数已达 5 次，今日已禁止登录" }, 429, corsHeaders);
  }

  const passwordMatches = password.length > 0 && (await verifyPassword(password, authConfig));
  const isValid = username === authConfig.username && passwordMatches;

  if (!isValid) {
    const failure = recordLoginFailure(rateLimitKey);
    return jsonResponse({
      message: failure.locked ? "密码错误次数已达 5 次，今日已禁止登录" : "账号或密码错误",
    }, failure.locked ? 429 : 401, corsHeaders, {
      "set-cookie": expireSessionCookie(),
    });
  }

  clearLoginFailures(rateLimitKey);
  const session = await createSessionToken(authConfig);
  return jsonResponse(
    {
      authenticated: true,
      username: authConfig.username,
      expiresAt: session.expiresAt,
    },
    200,
    corsHeaders,
    {
      "set-cookie": createSessionCookie(session.token, authConfig.sessionTtlSeconds),
    },
  );
}

function handleAuthLogout(request, corsHeaders) {
  if (request.method !== "POST") {
    return jsonResponse({ message: "Method not allowed" }, 405, corsHeaders);
  }

  return jsonResponse(
    { authenticated: false },
    200,
    corsHeaders,
    { "set-cookie": expireSessionCookie() },
  );
}

async function handleWebSocketLogin(request, env, corsHeaders) {
  if (request.method !== "POST") {
    return jsonResponse({ message: "Method not allowed" }, 405, corsHeaders);
  }

  const credentials = readOkxCredentials(env);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sign = await createOkxSignature(
    timestamp,
    "GET",
    WS_SIGN_PATH,
    "",
    credentials.secretKey,
  );

  return jsonResponse(
    {
      apiKey: credentials.apiKey,
      passphrase: credentials.passphrase,
      timestamp,
      sign,
    },
    200,
    corsHeaders,
  );
}

async function handleOkxRest(request, env, url, corsHeaders) {
  if (request.method !== "GET") {
    return jsonResponse({ message: "Method not allowed" }, 405, corsHeaders);
  }

  const credentials = readOkxCredentials(env);
  const requestPath = `${url.pathname}${url.search}`;
  const timestamp = new Date().toISOString();
  const sign = await createOkxSignature(
    timestamp,
    "GET",
    requestPath,
    "",
    credentials.secretKey,
  );

  const headers = new Headers({
    Accept: "application/json",
    "OK-ACCESS-KEY": credentials.apiKey,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": credentials.passphrase,
  });

  if (resolveEnvironment(env) === "demo") {
    headers.set("x-simulated-trading", "1");
  }

  const okxResponse = await fetch(`${OKX_REST_BASE_URL}${requestPath}`, {
    headers,
    method: "GET",
  });
  const body = await okxResponse.text();
  return new Response(body, {
    headers: {
      ...corsHeaders,
      "content-type": okxResponse.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    },
    status: okxResponse.status,
  });
}

function readOkxCredentials(env) {
  const apiKey = String(env.OKX_API_KEY || "").trim();
  const passphrase = String(env.OKX_API_PASSPHRASE || env.OKX_PASSPHRASE || "");
  const secretKey = String(env.OKX_SECRET_KEY || env.OKX_API_SECRET || "");
  const missing = [];
  if (!apiKey) missing.push("OKX_API_KEY");
  if (!passphrase) missing.push("OKX_API_PASSPHRASE");
  if (!secretKey) missing.push("OKX_SECRET_KEY");
  if (missing.length) {
    throw new Error(`Missing Worker secrets: ${missing.join(", ")}`);
  }
  return { apiKey, passphrase, secretKey };
}

function readAuthConfig(env) {
  const username = String(env.DASHBOARD_AUTH_USERNAME || "").trim();
  const passwordHash = String(env.DASHBOARD_AUTH_PASSWORD_HASH || "").trim().toLowerCase();
  const salt = String(env.DASHBOARD_AUTH_SALT || "").trim().toLowerCase();
  const sessionSecret = String(env.DASHBOARD_SESSION_SECRET || "").trim();
  const iterations = parseInteger(env.DASHBOARD_AUTH_ITERATIONS, DEFAULT_AUTH_ITERATIONS);
  const sessionTtlSeconds = parseInteger(
    env.DASHBOARD_SESSION_TTL_SECONDS,
    DEFAULT_SESSION_TTL_SECONDS,
  );
  const missing = [];
  if (!username) missing.push("DASHBOARD_AUTH_USERNAME");
  if (!passwordHash) missing.push("DASHBOARD_AUTH_PASSWORD_HASH");
  if (!salt) missing.push("DASHBOARD_AUTH_SALT");
  if (!sessionSecret) missing.push("DASHBOARD_SESSION_SECRET");
  if (missing.length) {
    throw new Error(`Missing Worker auth secrets: ${missing.join(", ")}`);
  }
  if (!isHex(passwordHash) || !isHex(salt)) {
    throw new Error("Invalid Worker auth secret format.");
  }
  return {
    username,
    passwordHash,
    salt,
    sessionSecret,
    iterations: clampNumber(iterations, 100000, 1000000),
    sessionTtlSeconds: clampNumber(sessionTtlSeconds, 900, 7 * 24 * 60 * 60),
  };
}

function getLoginRateLimitKey(request, username) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  return ip || username || "-";
}

function isLoginRateLimited(key) {
  const entry = loginFailures.get(key);
  if (!entry) {
    return false;
  }
  const dayKey = getLoginDayKey();
  if (entry.dayKey !== dayKey) {
    loginFailures.delete(key);
    return false;
  }
  return entry.count >= LOGIN_DAILY_FAILURE_LIMIT;
}

function recordLoginFailure(key) {
  const dayKey = getLoginDayKey();
  const entry = loginFailures.get(key);
  let nextEntry;
  if (!entry || entry.dayKey !== dayKey) {
    nextEntry = { count: 1, dayKey };
  } else {
    entry.count += 1;
    nextEntry = entry;
  }
  loginFailures.set(key, nextEntry);
  pruneLoginFailures(dayKey);
  return {
    count: nextEntry.count,
    locked: nextEntry.count >= LOGIN_DAILY_FAILURE_LIMIT,
  };
}

function clearLoginFailures(key) {
  loginFailures.delete(key);
}

function pruneLoginFailures(dayKey) {
  if (loginFailures.size < 1000) {
    return;
  }
  for (const [key, entry] of loginFailures) {
    if (entry.dayKey !== dayKey) {
      loginFailures.delete(key);
    }
  }
}

function getLoginDayKey() {
  return new Date(Date.now() + BEIJING_TIME_OFFSET_MS).toISOString().slice(0, 10);
}

function resolveEnvironment(env) {
  return env.OKX_ENVIRONMENT === "demo" ? "demo" : "live";
}

async function createOkxSignature(timestamp, method, requestPath, body, secretKey) {
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

async function verifyPassword(password, authConfig) {
  const expected = hexToBytes(authConfig.passwordHash);
  const actual = await derivePasswordHash(password, authConfig.salt, authConfig.iterations, expected.length);
  return constantTimeEqual(actual, expected);
}

async function derivePasswordHash(password, saltHex, iterations, byteLength) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations,
      salt: hexToBytes(saltHex),
    },
    cryptoKey,
    byteLength * 8,
  );
  return new Uint8Array(bits);
}

async function requireSession(request, env) {
  const authConfig = readAuthConfig(env);
  const token = readCookie(request, AUTH_COOKIE_NAME);
  if (!token) {
    return null;
  }

  return verifySessionToken(token, authConfig);
}

async function createSessionToken(authConfig) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + authConfig.sessionTtlSeconds;
  const payload = {
    sub: authConfig.username,
    iat: issuedAt,
    exp: expiresAt,
    nonce: base64UrlFromBytes(crypto.getRandomValues(new Uint8Array(16))),
  };
  const payloadPart = base64UrlFromString(JSON.stringify(payload));
  const signature = await createSessionSignature(payloadPart, authConfig.sessionSecret);
  return {
    expiresAt: expiresAt * 1000,
    token: `${payloadPart}.${signature}`,
  };
}

async function verifySessionToken(token, authConfig) {
  const [payloadPart, signature] = String(token || "").split(".");
  if (!payloadPart || !signature) {
    return null;
  }

  const expectedSignature = await createSessionSignature(payloadPart, authConfig.sessionSecret);
  if (!constantTimeEqual(stringToBytes(signature), stringToBytes(expectedSignature))) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(stringFromBase64Url(payloadPart));
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.sub !== authConfig.username || !Number.isFinite(payload.exp) || payload.exp <= now) {
    return null;
  }

  return {
    username: payload.sub,
    expiresAt: payload.exp * 1000,
  };
}

async function createSessionSignature(payloadPart, sessionSecret) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(sessionSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(payloadPart));
  return base64UrlFromBytes(new Uint8Array(signature));
}

function getCorsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowOrigin = isOriginAllowed(request, env) ? origin : "null";
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,accept",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function isOriginAllowed(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) {
    return false;
  }
  const allowedOrigins = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return allowedOrigins.includes(origin);
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function readCookie(request, name) {
  const cookie = request.headers.get("cookie") || "";
  const prefix = `${name}=`;
  for (const part of cookie.split(";")) {
    const item = part.trim();
    if (item.startsWith(prefix)) {
      return decodeURIComponent(item.slice(prefix.length));
    }
  }
  return "";
}

function createSessionCookie(token, maxAge) {
  return [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "Secure",
    "SameSite=None",
  ].join("; ");
}

function expireSessionCookie() {
  return [
    `${AUTH_COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "Secure",
    "SameSite=None",
  ].join("; ");
}

function jsonResponse(payload, status, corsHeaders, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    headers: {
      ...corsHeaders,
      ...extraHeaders,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    status,
  });
}

function parseInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function isHex(value) {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/.test(value);
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function stringToBytes(value) {
  return new TextEncoder().encode(value);
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

function base64FromBytes(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64UrlFromString(value) {
  return base64UrlFromBytes(new TextEncoder().encode(value));
}

function base64UrlFromBytes(bytes) {
  return base64FromBytes(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function stringFromBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}
