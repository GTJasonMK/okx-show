# OKX 账户看板

OKX 账户看板采用“GitHub Pages 静态前端 + 独立 Cloudflare Worker API”的部署方式。

前端只发布静态文件，不保存 OKX Secret；Worker 负责 OKX 私有 REST 转发和 WebSocket 登录签名。这样可以继续用 GitHub Pages 部署页面，同时绕开 OKX 私有 REST 的浏览器 CORS 限制。

## 架构

- GitHub Pages：发布 `index.html`、`styles.css`、`okx-runtime.js`、`app.js`、`config.js` 和 `.nojekyll`。
- Cloudflare Worker：提供跨域 API，签名请求 OKX 私有接口。
- OKX WebSocket：浏览器直接连接 OKX 私有 WebSocket，但登录签名由 Worker 生成。

Worker 当前只开放页面需要的接口：

- `POST /api/okx/ws-login`：返回 OKX WebSocket 登录参数。
- `GET /api/v5/account/positions`：读取当前持仓快照。
- `GET /api/v5/account/positions-history`：读取最近三个月内的已结束持仓历史。

## 前端配置

编辑 `config.js`，只填写非密钥配置：

```js
window.OKX_DASHBOARD_CONFIG = {
  environment: "live", // live | demo；必须和 Worker 的 OKX_ENVIRONMENT 保持一致。
  wsUrl: "",
  apiBaseUrl: "https://your-worker.example.workers.dev",
  profitCurrency: "USDT",
  profitChartRefreshInterval: 60000,
  positionUpdateInterval: 2000,
  positionRefreshInterval: 2000,
  positionHistoryLimit: 10,
};
```

说明：

- `apiBaseUrl` 填 Worker 部署后的 origin，例如 `https://okx-show-api.username.workers.dev`，不要带结尾 `/`。
- `environment: "live"` 使用 OKX 实盘；`environment: "demo"` 使用模拟盘。
- 如果使用模拟盘，`config.js` 的 `environment` 和 `worker/wrangler.toml` 的 `OKX_ENVIRONMENT` 都要设为 `demo`。
- `profitChartRefreshInterval` 控制收益曲线自动刷新间隔，单位毫秒；`0` 表示关闭自动刷新。
- `positionRefreshInterval` 控制当前持仓 REST 快照刷新间隔，单位毫秒；`0` 表示只用 WebSocket 推送。

不要把 `apiKey`、`passphrase`、`secretKey` 写进 `config.js`。

## Worker 部署

Worker 代码在 `worker/` 目录。

先把 `worker/wrangler.toml` 里的 `ALLOWED_ORIGINS` 改成你的前端来源。这里只能写 origin，不能写路径：

```toml
[vars]
OKX_ENVIRONMENT = "live"
ALLOWED_ORIGINS = "https://yourname.github.io,http://127.0.0.1:8080,http://localhost:8080"
```

如果 GitHub Pages 地址是 `https://yourname.github.io/okx-show/`，这里仍然写 `https://yourname.github.io`。如果你使用自定义域名，把自定义域名 origin 也加进去。

配置 OKX 凭证时使用 Worker secrets，不要写进仓库文件：

```bash
cd worker
wrangler secret put OKX_API_KEY
wrangler secret put OKX_API_PASSPHRASE
wrangler secret put OKX_SECRET_KEY
wrangler deploy
```

兼容变量名：

- `OKX_API_PASSPHRASE` 也可以写成 `OKX_PASSPHRASE`。
- `OKX_SECRET_KEY` 也可以写成 `OKX_API_SECRET`。

本地调试 Worker 时可以使用 `worker/.dev.vars`，该文件已被 `.gitignore` 忽略。

## 本地运行

前端本身是静态文件，任选一个静态服务器即可：

```bash
python -m http.server 8080
```

打开：

```text
http://127.0.0.1:8080/
```

本地页面要能请求 Worker，`worker/wrangler.toml` 的 `ALLOWED_ORIGINS` 必须包含当前本地 origin，例如 `http://127.0.0.1:8080`。

## GitHub Pages 部署

仓库包含 GitHub Actions 工作流：[`.github/workflows/pages.yml`](.github/workflows/pages.yml)。

第一次上传到 GitHub 仓库后：

1. 进入仓库 `Settings` -> `Pages`。
2. 在 `Build and deployment` 里把 `Source` 选为 `GitHub Actions`。
3. 把代码推送到 `main` 或 `master` 分支，GitHub 会自动发布页面。
4. 也可以在仓库 `Actions` 页面手动运行 `Deploy GitHub Pages`。

工作流只发布静态前端文件，不会发布 `worker/`，也不会发布旧的 `functions/` 或本地开发服务。

## 数据与页面行为

顶部“账户看板 / 持仓历史”使用 `#dashboard` 和 `#positions-history` 做同页视图切换。切换视图不会加载新 HTML 文档，因此不会销毁并重建当前 WebSocket 连接。

账户看板数据来源：

- `account`：账户权益与币种明细。
- `positions`：全品类持仓 WebSocket 推送。
- `balance_and_position`：资产和持仓补充推送。
- `GET /api/v5/account/positions`：当前持仓 REST 快照，用于让已平仓持仓及时从表格移除。

持仓历史数据来源：

- `GET /api/v5/account/positions-history`：最近已结束持仓记录。

## 收益曲线

收益曲线使用 OKX 私有 REST `positions-history` 的已结束持仓记录绘制，不再依赖当前页面会话里的 WebSocket 采样点。

行为：

- 默认加载最近 7 天。
- 起始时间最早限制为当前时间前三个月。
- 结束时间留空表示从起始时间到当前时间。
- 起始时间、结束时间和周期会保存到浏览器本地，下次访问自动恢复。
- 支持周期：`15m`、`1h`、`4h`、`1d`。
- 结束时间留空时按 `profitChartRefreshInterval` 自动刷新；固定结束时间不会自动刷新。
- 横轴始终按当前选择的起止范围绘制，即使范围内暂时没有数据。

曲线按所选周期把已实现盈亏分桶汇总，然后绘制累计变化。`profitCurrency` 用于过滤持仓历史里的 `ccy`，避免把不同币种的盈亏直接相加；没有 `ccy` 的记录会按当前计价币种计入。

## 安全边界

OKX Secret 只应放在 Cloudflare Worker secrets 中，不能进入 `config.js`、README、GitHub Actions 日志或任何前端文件。

需要明确的是：CORS 不是用户鉴权。`ALLOWED_ORIGINS` 只能限制普通浏览器页面从哪些 origin 调用 Worker，不能证明访问者是你本人。如果 GitHub Pages 是公开的，任何能打开页面的人都可能看到页面展示的数据。

更稳妥的部署方式：

- OKX API key 只开启读取权限，不开启交易、划转或提现。
- Worker 和前端页面放在受控访问环境后面，例如 Cloudflare Access、自定义域名鉴权或等价的反向代理鉴权。
- 不要提交 `secret.txt`、`.env`、`.dev.vars`、`config1.js`、`config2.js` 或任何包含真实密钥的文件。

## 文件

- `index.html`：主页面结构，包含账户看板和持仓历史两个同页视图。
- `styles.css`：页面样式。
- `okx-runtime.js`：配置加载、Worker API 调用和 WebSocket 地址选择。
- `app.js`：WebSocket 连接、订阅、账户看板、收益曲线和持仓历史渲染逻辑。
- `config.js`：前端公开配置，只放 Worker URL 和页面参数。
- `worker/worker.js`：Cloudflare Worker API。
- `worker/wrangler.toml`：Worker 部署配置，不放密钥。
- `.github/workflows/pages.yml`：GitHub Pages 静态部署工作流。
