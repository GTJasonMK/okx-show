import {
  createWebSocketLoginPayload,
  json,
  methodNotAllowed,
  readOkxSettings,
} from "../../_shared/okx.js";

export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  try {
    const settings = readOkxSettings(context.env);
    return json(await createWebSocketLoginPayload(settings));
  } catch (error) {
    return json({ code: "500", msg: error.message || "OKX WebSocket 登录签名失败。" }, 500);
  }
}
