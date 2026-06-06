# OKX 账户看板

一个 OKX 账户看板页面，用 OKX 私有 WebSocket 实时显示账户权益、币种余额和持仓信息，并通过同源服务端代理读取 OKX 私有 REST 数据。

OKX 私有 REST 接口不允许浏览器跨域直连。部署到线上域名后，`GET /api/v5/account/positions` 和 `GET /api/v5/account/positions-history` 必须经由同源后端代理转发到 `https://www.okx.com`，不能只靠前端代码修复 CORS。

## 使用方式

1. 在 OKX 创建 API key，只勾选读取权限，不要开启交易、划转或提现权限。
2. 编辑 `config.js`，填入当前项目一直使用的 `apiKey`、`passphrase`、`secretKey` 和页面配置。
3. 本地用 `node dev-server.js` 打开页面；它会读取同一个 `config.js` 并为 `/api/*` 做同源代理签名。
4. 公开部署到 Cloudflare Pages Functions 等服务端环境时，可以改用部署平台环境变量覆盖 `config.js` 里的敏感字段。

```js
window.OKX_DASHBOARD_CONFIG = {
  environment: "live",
  // 可选；留空时按 environment 自动选择 OKX 默认 WebSocket。
  // wsUrl: "wss://ws.okx.com:8443/ws/v5/private",
  // 默认走同源服务端代理，也就是当前域名下的 /api/v5/...。
  restUrl: "",
  restAuthMode: "server",
  webSocketAuthMode: "server",
  wsLoginUrl: "",
  apiKey: "你的 API Key",
  passphrase: "你的 Passphrase",
  secretKey: "你的 Secret Key",
  profitCurrency: "USDT",
  // 持仓频道推送周期：0 只按持仓事件推送；2000/3000/4000 会按毫秒周期定时推送。
  positionUpdateInterval: 2000,
  // 当前持仓 REST 快照刷新周期，毫秒；0 表示关闭 REST 定时刷新。
  positionRefreshInterval: 2000,
  positionHistoryLimit: 10
};
```

`environment: "live"` 会连接 OKX 实盘私有 WebSocket；`environment: "demo"` 会连接 OKX 模拟盘私有 WebSocket。如果你显式配置了 `wsUrl`、`restUrl` 或 `wsLoginUrl`，页面会优先使用配置里的地址。

`restAuthMode: "server"` 表示浏览器只请求同源代理，由本地 dev server 或部署平台函数向 OKX 签名转发。`webSocketAuthMode: "server"` 表示浏览器从 `/api/okx/ws-login` 获取 OKX WebSocket 登录参数。

`positionUpdateInterval` 用于控制主页面持仓表的 WebSocket 推送频率，默认 2 秒。OKX 的 `positions` 频道如果设置为 `0`，只会在持仓事件发生时推送，不会定时刷新标记价和未实现盈亏。

`positionRefreshInterval` 用于控制主页面当前持仓 REST 快照刷新频率，默认 2 秒。持仓表会用 `GET /api/v5/account/positions` 覆盖成当前快照，因此已平仓的持仓会从表格里移除；设置为 `0` 可以关闭这层 REST 定时刷新。

页面启动时会用 `config.js?v=当前时间戳` 加载配置，避免普通刷新继续使用浏览器缓存里的旧配置。注意：GitHub Pages 链接只能读取已经推送并部署完成的 `config.js`；本地刚改完但还没 push/deploy 的配置，不会出现在 GitHub Pages 页面里。

`index.html` 是主入口，顶部“账户看板 / 持仓历史”使用 `#dashboard` 和 `#positions-history` 做同页视图切换。切换视图不会加载新的 HTML 文档，因此不会因为看持仓历史而销毁并重建当前 WebSocket 连接。

页面没有 API 输入表单，也没有连接日志；WebSocket 连接状态只显示在右上角。持仓历史的 REST 加载结果显示在持仓历史视图的摘要里，不覆盖右上角连接状态。

## 本地运行

不要用 `python -m http.server`、`serve` 这类普通静态服务器运行本项目。它们只会返回静态文件，不能处理 `/api/okx/ws-login` 和 `/api/v5/...`，会出现 `501 Unsupported method ('POST')` 或 `/api/v5/account/positions-history` 404。

本地使用仓库自带的 Node 开发服务：

```bash
node dev-server.js
```

默认地址是 `http://127.0.0.1:8080/`。如需换端口：

```bash
PORT=8789 node dev-server.js
```

本地 dev server 默认读取当前项目的 `config.js`，也就是页面原本使用的 `window.OKX_DASHBOARD_CONFIG`。如果你想临时覆盖，也可以把凭证放在 `.env` 或当前 shell 环境变量里，`.env` 已被 `.gitignore` 忽略：

```env
OKX_API_KEY=你的 API Key
OKX_API_PASSPHRASE=你的 Passphrase
OKX_SECRET_KEY=你的 Secret Key
OKX_ENVIRONMENT=live
```

仓库提供了 `.env.example` 模板。环境变量优先级高于 `config.js`。`OKX_API_PASSPHRASE` 也可以写成 `OKX_PASSPHRASE`，`OKX_SECRET_KEY` 也可以写成 `OKX_API_SECRET`。

如果浏览器只显示 `500 (Internal Server Error)`，先看 DevTools 的 Network 响应体或运行 `node dev-server.js` 的终端日志。常见原因是 `config.js` 里缺少 `apiKey/passphrase/secretKey`，或者线上平台没有配置对应环境变量。

如果终端显示 `无法连接 OKX REST` 或 `fetch failed`，说明本地 Node 进程连不上 `https://www.okx.com`。浏览器能访问不代表 Node 一定会走同一个代理；需要显式给 dev server 配 REST 代理：

```bash
OKX_REST_PROXY=http://127.0.0.1:7897 node dev-server.js
```

`OKX_REST_PROXY` 目前支持 `http://` 代理，会通过 HTTP CONNECT 访问 OKX HTTPS 接口。也可以用通用的 `HTTPS_PROXY` / `https_proxy`，但 `OKX_REST_PROXY` 优先级更清楚。

## Cloudflare Pages 部署

推荐使用 Cloudflare Pages 或等价的 serverless 平台部署，因为当前持仓快照和持仓历史都依赖同源 REST 代理。

Cloudflare Pages 需要配置这些环境变量：

- `OKX_API_KEY`：OKX API key。
- `OKX_API_PASSPHRASE`：OKX API passphrase。
- `OKX_SECRET_KEY`：OKX API secret。
- `OKX_ENVIRONMENT`：可选，`live` 或 `demo`，默认 `live`。
- `OKX_REST_BASE_URL`：可选，默认 `https://www.okx.com`。

`functions/api/v5/[[path]].js` 只代理当前页面需要的两个 GET 路径：

- `/api/v5/account/positions`
- `/api/v5/account/positions-history`

`functions/api/okx/ws-login.js` 会返回 WebSocket 登录所需的一次性签名参数。

## GitHub Pages 限制

项目仍保留 GitHub Actions 工作流：`.github/workflows/pages.yml`，但 GitHub Pages 只能发布静态文件，不能运行 `functions/` 里的代理代码。

第一次上传到 GitHub 仓库后：

1. 进入仓库的 `Settings` -> `Pages`。
2. 在 `Build and deployment` 里把 `Source` 选为 `GitHub Actions`。
3. 把代码推送到 `main` 或 `master` 分支，GitHub 会自动发布页面。
4. 也可以在仓库的 `Actions` 页面手动运行 `Deploy GitHub Pages` 工作流。

工作流只会发布运行页面需要的静态文件：`index.html`、`positions-history.html`、`styles.css`、`okx-runtime.js`、`app.js`、`positions-history.js`、`config.js` 和 `.nojekyll`。

如果只部署到 GitHub Pages，REST 代理路径会返回 404，持仓历史和当前持仓 REST 快照不可用。主页面 WebSocket 也需要服务端登录签名接口；如果改回浏览器签名模式，就必须把 Secret 放进前端，这是不推荐的旧模式。

注意：如果仓库或 Pages 是公开的，`config.js` 也会公开。不要把真实 OKX API 凭证写入 `config.js`；真实凭证应放在部署平台的环境变量或 secret 管理里。

## 安全边界

浏览器加载的任何文件都可以被访问者读取。把真实密钥写进 `config.js` 并部署到公开仓库或公开域名，等同于把密钥公开给所有访问者。

建议只把页面部署在自己可控、访问受限的环境里，并在 Cloudflare Access、反向代理鉴权或等价机制后面使用。不要提交 `secret.txt`、`.env` 或任何包含真实密钥的文件。页面不会把 API 凭证写入 `localStorage`；代码不会发送交易、下单、划转或提现请求，但“只能读取”必须由 OKX 后台的 API key 权限来保证。

## 文件

- `index.html`：主页面结构，包含账户看板和持仓历史两个同页视图。
- `positions-history.html`：旧持仓历史入口兼容页，导航会指向 `index.html#positions-history`。
- `styles.css`：页面样式。
- `okx-runtime.js`：配置加载、WebSocket 地址选择、同源代理调用和旧版客户端签名。
- `app.js`：OKX WebSocket 登录、订阅、账户看板渲染、同页视图切换和持仓历史渲染逻辑。
- `positions-history.js`：旧持仓历史入口兼容逻辑。
- `config.js`：连接配置。
- `.env.example`：本地环境变量模板，不包含真实密钥。
- `dev-server.js`：本地开发用静态文件服务和同源 OKX API 代理。
- `functions/`：Cloudflare Pages Functions 代理和签名接口。

## 数据来源

- `account`：账户权益与币种明细。
- `positions`：全品类持仓。
- `balance_and_position`：资产和持仓补充推送。
- `GET /api/v5/account/positions`：主页面定时刷新当前持仓快照，经由同源代理转发到 OKX。
- `GET /api/v5/account/positions-history`：持仓历史页拉取最近已结束持仓记录，经由同源代理转发到 OKX。

## 收益曲线

收益曲线使用 OKX 私有 REST `GET /api/v5/account/positions-history` 里的已结束持仓记录，不再依赖当前页面会话里的 WebSocket 采样点。页面默认加载最近 7 天，结束时间留空时表示从起始时间到当前时间，也可以手动填写起始和结束时间。起始和结束时间会保存到浏览器本地，下次访问会自动恢复。

曲线会按所选周期把范围内的已实现盈亏分桶汇总，再绘制累计变化。目前支持 `15m`、`1h`、`4h`、`1d`。OKX 该接口只返回最近 3 个月记录，所以页面会把可选时间限制在当前时间前 3 个月到当前时间之间。

结束时间留空时，页面会按 `profitChartRefreshInterval` 自动刷新到当前时间，默认 60 秒；设置为 `0` 可以关闭自动刷新。填写了结束时间的固定历史区间不会自动轮询。

如果想看其他计价币种，把 `config.js` 里的 `profitCurrency` 改成对应币种，例如 `USDC`。曲线会优先使用持仓历史里的 `ccy` 过滤匹配币种，避免把不同币种的盈亏直接相加；没有 `ccy` 的记录会按当前计价币种计入。

## 持仓历史页

打开 `index.html#positions-history` 可以查看当前 API 配置下最近已结束持仓的盈亏情况。该视图使用同一个 `config.js`，通过同源代理请求 OKX 私有 REST `GET /api/v5/account/positions-history` 拉取持仓历史，默认显示最近 10 条。

页面会展示合约、产品类型、方向、平仓量、开仓均价、平仓均价、已实现盈亏、盈亏率、手续费/资金费/强平罚金、模式/杠杆，并在顶部统计当前显示记录的累计已实现盈亏和盈利/亏损笔数。点击“刷新”会重新拉取。

`positionHistoryLimit` 控制最多请求和显示多少条记录，默认 10，页面逻辑上限为 50。如果接口没有返回记录，页面不会伪造数据，只会显示暂无持仓历史。
