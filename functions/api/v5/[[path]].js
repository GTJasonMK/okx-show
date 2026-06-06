import { createOkxHeaders, json, methodNotAllowed, readOkxSettings } from "../../_shared/okx.js";

const ALLOWED_GET_PATHS = new Set([
  "/api/v5/account/positions",
  "/api/v5/account/positions-history",
]);

export async function onRequest(context) {
  if (context.request.method !== "GET") {
    return methodNotAllowed(["GET"]);
  }

  const requestUrl = new URL(context.request.url);
  if (!ALLOWED_GET_PATHS.has(requestUrl.pathname)) {
    return json({ code: "403", msg: "当前 OKX REST 路径未开放代理。" }, 403);
  }

  try {
    const settings = readOkxSettings(context.env);
    const requestPath = `${requestUrl.pathname}${requestUrl.search}`;
    const headers = await createOkxHeaders(settings, "GET", requestPath);
    const okxResponse = await fetch(`${settings.restBaseUrl}${requestPath}`, { headers });
    const responseHeaders = new Headers({
      "Cache-Control": "no-store",
      "Content-Type": okxResponse.headers.get("Content-Type") || "application/json",
    });

    return new Response(okxResponse.body, {
      status: okxResponse.status,
      headers: responseHeaders,
    });
  } catch (error) {
    return json({ code: "500", msg: error.message || "OKX REST 代理请求失败。" }, 500);
  }
}
