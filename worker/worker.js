const OKX_REST_BASE_URL = "https://www.okx.com";
const WS_SIGN_PATH = "/users/self/verify";
const ALLOWED_REST_PATHS = new Set([
  "/api/v5/account/positions",
  "/api/v5/account/positions-history",
]);

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

      if (url.pathname === "/api/okx/ws-login") {
        return await handleWebSocketLogin(request, env, corsHeaders);
      }

      if (ALLOWED_REST_PATHS.has(url.pathname)) {
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

function getCorsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowOrigin = isOriginAllowed(request, env) ? origin : "null";
  return {
    "access-control-allow-origin": allowOrigin,
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

function jsonResponse(payload, status, corsHeaders) {
  return new Response(JSON.stringify(payload), {
    headers: {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    status,
  });
}

function base64FromBytes(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
