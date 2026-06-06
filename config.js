// 这个文件会被浏览器原样加载；只在本地或受控访问环境里填写真实 OKX 配置。
// 本地 dev-server.js 会读取这里的 apiKey/passphrase/secretKey 来完成同源代理签名。
// 公开部署时不要把真实 Secret 写进这个文件，改用部署平台环境变量。
window.OKX_DASHBOARD_CONFIG = {
  environment: "demo", // live | demo
  wsUrl: "",
  restUrl: "",
  restAuthMode: "server",
  webSocketAuthMode: "server",
  wsLoginUrl: "",
  apiKey: "d669bf19-9804-4c7d-8d4d-f30752b6ae1e",
  passphrase: "15022852945Gjs&",
  secretKey: "287BA826122630A45920EDD3AA31C7AF",
  profitCurrency: "USDT",
  positionUpdateInterval: 2000,
  positionRefreshInterval: 2000,
  positionHistoryLimit: 10,
};
