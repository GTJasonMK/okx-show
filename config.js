// 这个文件会被浏览器原样加载；不要把 OKX Secret 写进这里。
// OKX 凭证应配置在 Cloudflare Worker secrets 中，页面只填写 Worker 地址。
window.OKX_DASHBOARD_CONFIG = {
  environment: "demo", // live | demo；必须和 Worker 的 OKX_ENVIRONMENT 保持一致。
  wsUrl: "",
  apiBaseUrl: "https://okx-api.imggb.top",
  profitCurrency: "USDT",
  profitChartRefreshInterval: 300000,
  positionUpdateInterval: 2000,
  positionRefreshInterval: 5000,
  positionHistoryLimit: 10,
};
