# OKX 账户看板

一个可直接部署到 GitHub Pages 的静态页面，用 OKX 私有 WebSocket 实时显示账户权益、币种余额和持仓信息。

## 使用方式

1. 在 OKX 创建 API key，只勾选读取权限，不要开启交易或提现权限。
2. 编辑 `config.js`，填入 `API Key`、`Passphrase`、`Secret Key` 和要跟踪的稳定币。
3. 通过本地静态服务或 GitHub Pages 打开页面，页面会加载最新的 `config.js` 并自动连接。

```js
window.OKX_DASHBOARD_CONFIG = {
  environment: "live",
  // 可选；留空时按 environment 自动选择 OKX 默认 WebSocket。
  // wsUrl: "wss://ws.okx.com:8443/ws/v5/private",
  // 可选；留空时使用 https://www.okx.com。
  // restUrl: "https://www.okx.com",
  apiKey: "你的 API Key",
  passphrase: "你的 Passphrase",
  secretKey: "你的 Secret Key",
  profitCurrency: "USDT",
  positionHistoryLimit: 10
};
```

`environment: "live"` 会连接 OKX 实盘私有 WebSocket；`environment: "demo"` 会连接 OKX 模拟盘私有 WebSocket。如果你显式配置了 `wsUrl` 或 `restUrl`，页面会优先使用配置里的地址。

页面启动时会用 `config.js?v=当前时间戳` 加载配置，避免普通刷新继续使用浏览器缓存里的旧配置。注意：GitHub Pages 链接只能读取已经推送并部署完成的 `config.js`；本地刚改完但还没 push/deploy 的配置，不会出现在 GitHub Pages 页面里。

页面没有 API 输入表单，也没有连接日志；连接状态只显示在右上角。

## 自动部署到 GitHub Pages

项目已经包含 GitHub Actions 工作流：`.github/workflows/pages.yml`。

第一次上传到 GitHub 仓库后：

1. 进入仓库的 `Settings` -> `Pages`。
2. 在 `Build and deployment` 里把 `Source` 选为 `GitHub Actions`。
3. 把代码推送到 `main` 或 `master` 分支，GitHub 会自动发布页面。
4. 也可以在仓库的 `Actions` 页面手动运行 `Deploy GitHub Pages` 工作流。

工作流只会发布运行页面需要的静态文件：`index.html`、`positions-history.html`、`styles.css`、`okx-runtime.js`、`app.js`、`positions-history.js`、`config.js` 和 `.nojekyll`。

注意：如果仓库或 Pages 是公开的，`config.js` 也会公开。真实 OKX API 凭证只建议用于私有仓库、受限访问环境，且 API key 必须只保留读取权限。

## 安全边界

GitHub Pages 是纯静态托管，浏览器必须拿到 `Secret Key` 才能生成 OKX WebSocket 登录签名。因此把真实密钥写进 `config.js` 并部署到公开仓库，等同于把密钥公开给所有访问者。

建议只把页面部署在自己可控、访问受限的环境里。不要提交 `secret.txt`、`.env` 或任何包含真实密钥的文件。页面不会把 API 凭证写入 `localStorage`；代码不会发送交易、下单、划转或提现请求，但“只能读取”必须由 OKX 后台的 API key 权限来保证。

## 文件

- `index.html`：页面结构。
- `positions-history.html`：最近已结束持仓页面结构。
- `styles.css`：页面样式。
- `okx-runtime.js`：配置加载、WebSocket 地址选择和 OKX 登录签名。
- `app.js`：OKX WebSocket 登录、订阅和渲染逻辑。
- `positions-history.js`：持仓历史拉取、盈亏统计和渲染逻辑。
- `config.js`：连接配置。

## 数据来源

- `account`：账户权益与币种明细。
- `positions`：全品类持仓。
- `balance_and_position`：资产和持仓补充推送。
- `GET /api/v5/account/positions-history`：持仓历史页拉取最近已结束持仓记录。

## 收益曲线

页面会在当前连接会话内记录最近 240 个推送点，并绘制实时曲线：

- `USDT 现金变化`：默认用当前 `USDT` 现金余额减去本次连接收到的首个 `USDT` 现金余额，适合看稳定币余额变化。
- `权益折合 USDT 变化`：用 OKX 推送的账户总权益变化；如果总权益字段暂时没有推送，则用资产明细里的折合价值求和后计算变化。

如果想看其他稳定币，把 `config.js` 里的 `profitCurrency` 改成对应币种，例如 `USDC`。曲线数据只保存在当前页面内存里，刷新或重连后会重新开始。

## 持仓历史页

打开 `positions-history.html` 可以单独查看当前 API 配置下最近已结束持仓的盈亏情况。该页面使用同一个 `config.js`，通过 OKX 私有 REST `GET /api/v5/account/positions-history` 拉取持仓历史，默认显示最近 10 条。

页面会展示合约、产品类型、方向、平仓量、开仓均价、平仓均价、已实现盈亏、盈亏率、手续费/资金费/强平罚金、模式/杠杆，并在顶部统计当前显示记录的累计已实现盈亏和盈利/亏损笔数。点击“刷新”会重新拉取。

`positionHistoryLimit` 控制最多请求和显示多少条记录，默认 10，页面逻辑上限为 50。如果接口没有返回记录，页面不会伪造数据，只会显示暂无持仓历史。
