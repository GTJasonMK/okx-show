(() => {
  "use strict";

  const THEME_STORAGE_KEY = "okx-dashboard.theme.v1";
  const MAX_CHART_POINTS = 240;

  const okx = window.OKXRuntime;
  let config = { ...okx.DEFAULT_CONFIG };
  const urlParams = new URLSearchParams(window.location.search);

  const state = {
    ws: null,
    heartbeatId: 0,
    messageId: 1,
    account: {},
    balances: new Map(),
    positions: new Map(),
    profitSeries: [],
    stableBaseline: null,
    equityBaseline: null,
    connectedAt: 0,
  };

  const els = {
    pill: document.querySelector("#connection-pill"),
    statusLabel: document.querySelector("#status-label"),
    themeToggle: document.querySelector("#theme-toggle"),
    themeIcon: document.querySelector("#theme-icon"),
    themeLabel: document.querySelector("#theme-label"),
    chartSummary: document.querySelector("#chart-summary"),
    stableLegendLabel: document.querySelector("#stable-legend-label"),
    equityLegendLabel: document.querySelector("#equity-legend-label"),
    chartCanvas: document.querySelector("#profit-chart"),
    chartEmpty: document.querySelector("#chart-empty"),
    stableCurrentLabel: document.querySelector("#stable-current-label"),
    stableCurrent: document.querySelector("#stable-current"),
    equityCurrent: document.querySelector("#equity-current"),
    equityHigh: document.querySelector("#equity-high"),
    equityLow: document.querySelector("#equity-low"),
    hideZero: document.querySelector("#hide-zero-input"),
    balancesBody: document.querySelector("#balances-body"),
    positionsBody: document.querySelector("#positions-body"),
    balanceCount: document.querySelector("#balance-count"),
    positionCount: document.querySelector("#position-count"),
  };

  applyTheme(getInitialTheme());
  render();
  bindEvents();
  boot().catch((error) => failConnection(error));

  function bindEvents() {
    els.themeToggle.addEventListener("click", toggleTheme);
    window.addEventListener("resize", () => drawProfitChart());
    els.hideZero.addEventListener("change", renderBalances);
  }

  async function boot() {
    setStatus("connecting", "加载配置", "正在加载最新 config.js。");
    config = await okx.loadConfig();

    if (urlParams.has("noAutoConnect")) {
      setStatus("idle", "未连接", "已通过 noAutoConnect 暂停自动连接。");
    } else if (okx.hasUsableCredentials(okx.readCredentials(config))) {
      await connect();
    } else {
      failConnection(new Error("config.js 缺少完整 OKX API 配置。"));
    }
  }

  function getInitialTheme() {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme === "light" || savedTheme === "dark") {
      return savedTheme;
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function toggleTheme() {
    const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    renderProfitChart();
  }

  function applyTheme(theme) {
    const isDark = theme === "dark";
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
    els.themeIcon.textContent = isDark ? "☀" : "☾";
    els.themeLabel.textContent = isDark ? "日间" : "夜间";
    els.themeToggle.setAttribute("aria-pressed", String(isDark));
    els.themeToggle.setAttribute("aria-label", isDark ? "切换到日间主题" : "切换到夜间主题");
  }

  async function connect() {
    const credentials = okx.readCredentials(config);
    okx.validateCredentials(credentials);

    if (!window.crypto?.subtle) {
      throw new Error("当前页面不可用 Web Crypto，请通过 HTTPS 或 localhost 打开。");
    }

    resetAccountState();
    closeSocket();
    setStatus("connecting", "连接中", `正在连接 ${okx.endpointLabel(credentials)}。`);

    const socket = new WebSocket(credentials.wsUrl);
    state.ws = socket;

    socket.addEventListener("open", async () => {
      if (state.ws !== socket) {
        return;
      }
      try {
        state.connectedAt = Date.now();
        startHeartbeat();
        setStatus("authenticating", "认证中", "正在发送 OKX 登录签名。");
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const sign = await okx.createSignature(timestamp, credentials.secretKey);
        sendJson(
          {
            op: "login",
            args: [
              {
                apiKey: credentials.apiKey,
                passphrase: credentials.passphrase,
                timestamp,
                sign,
              },
            ],
          },
          { withId: false },
        );
      } catch (error) {
        failConnection(error);
        closeSocket();
      }
    });

    socket.addEventListener("message", (event) => {
      if (state.ws === socket) {
        handleMessage(event.data);
      }
    });
    socket.addEventListener("error", () => {
      if (state.ws !== socket) {
        return;
      }
      setStatus("error", "连接异常", "WebSocket 连接发生错误。");
    });
    socket.addEventListener("close", (event) => {
      if (state.ws !== socket) {
        return;
      }
      stopHeartbeat();
      state.ws = null;
      if (event.wasClean) {
        setStatus("idle", "未连接", "连接已关闭。");
      } else {
        setStatus("error", "已断开", `连接异常关闭：${event.code || "unknown"}`);
      }
    });
  }

  function closeSocket() {
    stopHeartbeat();
    if (state.ws) {
      const socket = state.ws;
      state.ws = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, "client disconnect");
      }
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    state.heartbeatId = window.setInterval(() => {
      if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send("ping");
      }
    }, 25000);
  }

  function stopHeartbeat() {
    if (state.heartbeatId) {
      window.clearInterval(state.heartbeatId);
      state.heartbeatId = 0;
    }
  }

  function sendJson(payload, options = {}) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket 尚未连接。");
    }
    const shouldAttachId = options.withId !== false;
    state.ws.send(JSON.stringify(shouldAttachId ? { id: nextMessageId(), ...payload } : payload));
  }

  function handleMessage(raw) {
    if (raw === "pong") {
      return;
    }

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.event) {
      handleEventMessage(message);
      return;
    }

    const channel = message.arg?.channel;
    if (channel === "account") {
      applyAccountData(message.data || []);
    } else if (channel === "positions") {
      applyPositionsData(message);
    } else if (channel === "balance_and_position") {
      applyBalanceAndPositionData(message.data || []);
    }

    captureProfitPoint();
    render();
  }

  function handleEventMessage(message) {
    if (message.event === "login" && message.code === "0") {
      setStatus("connected", "已连接", "登录成功，正在订阅账户与持仓。");
      subscribePrivateChannels();
      return;
    }

    if (message.event === "subscribe") {
      return;
    }

    if (message.event === "error") {
      setStatus("error", "错误", `${message.code || "error"} ${message.msg || ""}`.trim());
    }
  }

  function subscribePrivateChannels() {
    sendJson({
      op: "subscribe",
      args: [
        { channel: "account" },
        {
          channel: "positions",
          instType: "ANY",
          extraParams: JSON.stringify({ updateInterval: "0" }),
        },
        { channel: "balance_and_position" },
      ],
    });
  }

  function applyAccountData(items) {
    for (const item of items) {
      state.account = { ...state.account, ...item };
      const updateTime = item.uTime || item.pTime;
      for (const detail of item.details || []) {
        upsertBalance({ ...detail, uTime: detail.uTime || updateTime });
      }
    }
  }

  function applyPositionsData(message) {
    if (message.eventType === "snapshot" && Number(message.curPage || 1) === 1) {
      state.positions.clear();
    }

    for (const item of message.data || []) {
      upsertPosition(item);
    }
  }

  function applyBalanceAndPositionData(items) {
    for (const item of items) {
      for (const balance of item.balData || []) {
        upsertBalance({ ...balance, uTime: balance.uTime || item.pTime });
      }

      for (const position of item.posData || []) {
        upsertPosition(position);
      }
    }
  }

  function upsertBalance(balance) {
    const key = balance.ccy;
    if (!key) {
      return;
    }
    state.balances.set(key, { ...(state.balances.get(key) || {}), ...balance });
  }

  function upsertPosition(position) {
    const key =
      position.posId ||
      [position.instId, position.posSide, position.mgnMode, position.ccy].filter(Boolean).join(":");

    if (!key) {
      return;
    }

    if (Number(position.pos || 0) === 0) {
      state.positions.delete(key);
      return;
    }

    state.positions.set(key, { ...(state.positions.get(key) || {}), ...position });
  }

  function resetAccountState() {
    state.account = {};
    state.balances.clear();
    state.positions.clear();
    state.profitSeries = [];
    state.stableBaseline = null;
    state.equityBaseline = null;
    render();
  }

  function render() {
    renderProfitChart();
    renderBalances();
    renderPositions();
  }

  function captureProfitPoint() {
    const stableBalance = getStableBalanceValue();
    const equityValue = getEquityValue();

    if (!Number.isFinite(stableBalance) && !Number.isFinite(equityValue)) {
      return;
    }

    if (Number.isFinite(stableBalance) && state.stableBaseline === null) {
      state.stableBaseline = stableBalance;
    }

    if (Number.isFinite(equityValue) && state.equityBaseline === null) {
      state.equityBaseline = equityValue;
    }

    const point = {
      time: Date.now(),
      stable: Number.isFinite(stableBalance) ? stableBalance - state.stableBaseline : null,
      stableBalance: Number.isFinite(stableBalance) ? stableBalance : null,
      equity: Number.isFinite(equityValue) ? equityValue - state.equityBaseline : null,
      equityValue: Number.isFinite(equityValue) ? equityValue : null,
    };

    const last = state.profitSeries.at(-1);
    if (last && point.time - last.time < 1000) {
      state.profitSeries[state.profitSeries.length - 1] = {
        ...last,
        time: point.time,
        stable: point.stable ?? last.stable,
        stableBalance: point.stableBalance ?? last.stableBalance,
        equity: point.equity ?? last.equity,
        equityValue: point.equityValue ?? last.equityValue,
      };
    } else {
      state.profitSeries.push(point);
    }

    if (state.profitSeries.length > MAX_CHART_POINTS) {
      state.profitSeries.splice(0, state.profitSeries.length - MAX_CHART_POINTS);
    }
  }

  function renderProfitChart() {
    const series = getChartSeries();
    const stableStats = getSeriesStats(series.stable);
    const equityStats = getSeriesStats(series.equity);
    const hasAnySeries = series.stable.length > 0 || series.equity.length > 0;
    const currency = getProfitCurrency();

    els.chartEmpty.classList.toggle("hidden", hasAnySeries);
    els.chartEmpty.textContent = `等待第一条 ${currency} 或权益数据`;
    els.stableLegendLabel.textContent = `${currency} 现金变化`;
    els.equityLegendLabel.textContent = `权益折合 ${currency} 变化`;
    els.stableCurrentLabel.textContent = `${currency} 当前`;
    els.chartSummary.textContent = getChartSummary(series, stableStats, equityStats);
    setSignedValue(els.stableCurrent, stableStats?.current);
    setSignedValue(els.equityCurrent, equityStats?.current);
    setSignedValue(els.equityHigh, equityStats?.high);
    setSignedValue(els.equityLow, equityStats?.low);

    drawProfitChart(series);
  }

  function getChartSeries() {
    return {
      stable: getSeriesValues("stable"),
      equity: getSeriesValues("equity"),
    };
  }

  function getSeriesValues(key) {
    return state.profitSeries
      .map((point) => ({
        time: point.time,
        value: point[key],
      }))
      .filter((point) => Number.isFinite(point.value));
  }

  function getSeriesStats(values) {
    if (!values.length) {
      return null;
    }

    const numbers = values.map((point) => point.value);
    return {
      current: numbers.at(-1),
      high: Math.max(...numbers),
      low: Math.min(...numbers),
    };
  }

  function getChartSummary(series, stableStats, equityStats) {
    const values = getAllChartValues(series);
    if (!values.length) {
      return `等待 ${getProfitCurrency()} 数据`;
    }

    const times = values.map((point) => point.time);
    const start = new Date(Math.min(...times)).toLocaleTimeString();
    const end = new Date(Math.max(...times)).toLocaleTimeString();
    const stableText = stableStats ? `${getProfitCurrency()} ${formatSigned(stableStats.current)}` : `${getProfitCurrency()} --`;
    const equityText = equityStats ? `权益 ${formatSigned(equityStats.current)}` : "权益 --";
    return `${equityText} · ${stableText} · ${start} - ${end}`;
  }

  function drawProfitChart(series = getChartSeries()) {
    const canvas = els.chartCanvas;
    const rect = canvas.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width * pixelRatio));
    const height = Math.max(1, Math.floor(rect.height * pixelRatio));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.scale(pixelRatio, pixelRatio);

    const cssWidth = width / pixelRatio;
    const cssHeight = height / pixelRatio;
    const padding = { top: 20, right: 18, bottom: 28, left: 54 };
    const chartWidth = Math.max(1, cssWidth - padding.left - padding.right);
    const chartHeight = Math.max(1, cssHeight - padding.top - padding.bottom);
    const colors = getChartColors();
    const allValues = getAllChartValues(series);

    drawChartGrid(ctx, padding, chartWidth, chartHeight, colors);

    if (!allValues.length) {
      ctx.restore();
      return;
    }

    const numbers = allValues.map((point) => point.value);
    const times = allValues.map((point) => point.time);
    const minValue = Math.min(...numbers, 0);
    const maxValue = Math.max(...numbers, 0);
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const span = maxValue - minValue || 1;
    const paddedMin = minValue - span * 0.12;
    const paddedMax = maxValue + span * 0.12;
    const paddedSpan = paddedMax - paddedMin || 1;

    const xForTime = (time) =>
      padding.left + (maxTime === minTime ? chartWidth / 2 : ((time - minTime) / (maxTime - minTime)) * chartWidth);
    const yForValue = (value) =>
      padding.top + chartHeight - ((value - paddedMin) / paddedSpan) * chartHeight;

    drawZeroLine(ctx, yForValue(0), padding, chartWidth, colors);
    drawYAxisLabels(ctx, paddedMin, paddedMax, padding, chartHeight, colors);
    drawSeries(ctx, series.equity, xForTime, yForValue, {
      color: colors.equity,
      fill: colors.equityFill,
      lineWidth: 2.4,
    });
    drawSeries(ctx, series.stable, xForTime, yForValue, {
      color: colors.stable,
      lineDash: [6, 5],
      lineWidth: 2,
    });
    ctx.restore();
  }

  function getAllChartValues(series) {
    return [...series.stable, ...series.equity].filter((point) => Number.isFinite(point.value));
  }

  function getChartColors() {
    const styles = getComputedStyle(document.documentElement);
    return {
      equity: styles.getPropertyValue("--accent-strong").trim(),
      equityFill: styles.getPropertyValue("--accent-soft").trim(),
      stable: styles.getPropertyValue("--amber").trim(),
      text: styles.getPropertyValue("--muted").trim(),
      grid: styles.getPropertyValue("--line").trim(),
      zero: styles.getPropertyValue("--accent").trim(),
    };
  }

  function drawChartGrid(ctx, padding, chartWidth, chartHeight, colors) {
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.55;
    for (let index = 0; index <= 4; index += 1) {
      const y = padding.top + (chartHeight / 4) * index;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + chartWidth, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawZeroLine(ctx, y, padding, chartWidth, colors) {
    ctx.strokeStyle = colors.zero;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartWidth, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawYAxisLabels(ctx, minValue, maxValue, padding, chartHeight, colors) {
    ctx.fillStyle = colors.text;
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (let index = 0; index <= 2; index += 1) {
      const ratio = index / 2;
      const value = maxValue - (maxValue - minValue) * ratio;
      const y = padding.top + chartHeight * ratio;
      ctx.fillText(formatCompact(value), padding.left - 8, y);
    }
  }

  function drawSeries(ctx, values, xForTime, yForValue, options) {
    if (!values.length) {
      return;
    }

    const points = values.map((point) => ({
      x: xForTime(point.time),
      y: yForValue(point.value),
    }));

    ctx.save();

    if (points.length === 1) {
      ctx.fillStyle = options.color;
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    if (options.fill) {
      ctx.beginPath();
      points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.lineTo(points.at(-1).x, yForValue(0));
      ctx.lineTo(points[0].x, yForValue(0));
      ctx.closePath();
      ctx.fillStyle = options.fill;
      ctx.fill();
    }

    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.strokeStyle = options.color;
    ctx.lineWidth = options.lineWidth || 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash(options.lineDash || []);
    ctx.stroke();
    ctx.setLineDash([]);

    const last = points.at(-1);
    ctx.fillStyle = options.color;
    ctx.beginPath();
    ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function renderBalances() {
    const rows = [...state.balances.values()]
      .filter((balance) => !els.hideZero.checked || hasBalanceValue(balance))
      .sort((a, b) => valueForSort(b) - valueForSort(a));

    els.balanceCount.textContent = `${rows.length} 个币种`;
    els.balancesBody.replaceChildren();

    if (!rows.length) {
      appendEmptyRow(els.balancesBody, 5, "暂无资产数据");
      return;
    }

    for (const balance of rows) {
      const row = document.createElement("tr");
      appendCell(row, balance.ccy || "--", "left");
      appendCell(row, formatAssetAmount(firstValue(balance.eq, balance.cashBal)));
      appendCell(row, formatAssetAmount(firstValue(balance.availEq, balance.availBal)));
      appendCell(row, formatAssetAmount(balance.cashBal));
      appendCell(row, formatAssetAmount(firstValue(balance.disEq, balance.eqUsd), { usd: true }));
      els.balancesBody.append(row);
    }
  }

  function renderPositions() {
    const rows = [...state.positions.values()].sort(
      (a, b) => Number(b.notionalUsd || 0) - Number(a.notionalUsd || 0),
    );

    els.positionCount.textContent = `${rows.length} 个持仓`;
    els.positionsBody.replaceChildren();

    if (!rows.length) {
      appendEmptyRow(els.positionsBody, 7, "暂无持仓数据");
      return;
    }

    for (const position of rows) {
      const row = document.createElement("tr");
      appendCell(row, position.instId || position.ccy || "--", "left");
      appendCell(row, formatSide(position.posSide));
      appendCell(row, formatNumber(position.pos));
      appendCell(row, formatNumber(position.avgPx));
      appendCell(row, formatNumber(firstValue(position.markPx, position.last)));
      appendCell(row, formatSigned(position.upl), Number(position.upl || 0) >= 0 ? "positive" : "negative");
      appendCell(row, position.lever ? `${position.lever}x` : "--");
      els.positionsBody.append(row);
    }
  }

  function appendCell(row, text, className) {
    const cell = document.createElement("td");
    cell.textContent = text || "--";
    if (className) {
      cell.className = className;
    }
    row.append(cell);
  }

  function appendEmptyRow(body, colspan, text) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = colspan;
    cell.className = "empty-cell";
    cell.textContent = text;
    row.append(cell);
    body.append(row);
  }

  function getStableBalanceValue() {
    const currency = getProfitCurrency();
    const balance =
      state.balances.get(currency) ||
      [...state.balances.entries()].find(([ccy]) => ccy.toUpperCase() === currency)?.[1];
    if (!balance) {
      return NaN;
    }

    return toFiniteNumber(firstValue(balance.cashBal, balance.eq, balance.availEq, balance.availBal));
  }

  function getEquityValue() {
    const accountEquity = toFiniteNumber(firstValue(state.account.totalEq, state.account.disEq));
    if (Number.isFinite(accountEquity)) {
      return accountEquity;
    }

    const convertedValues = [...state.balances.values()]
      .map((balance) => getConvertedBalanceValue(balance))
      .filter((value) => Number.isFinite(value));

    if (!convertedValues.length) {
      return NaN;
    }

    return convertedValues.reduce((sum, value) => sum + value, 0);
  }

  function getConvertedBalanceValue(balance) {
    const convertedValue = toFiniteNumber(firstValue(balance.disEq, balance.eqUsd));
    if (Number.isFinite(convertedValue)) {
      return convertedValue;
    }

    const currency = String(balance.ccy || "").toUpperCase();
    if (currency === getProfitCurrency()) {
      return toFiniteNumber(firstValue(balance.cashBal, balance.eq, balance.availEq, balance.availBal));
    }

    return NaN;
  }

  function getProfitCurrency() {
    return String(config.profitCurrency || "USDT").trim().toUpperCase();
  }

  function setSignedValue(element, value) {
    const number = toFiniteNumber(value);
    element.textContent = Number.isFinite(number) ? formatSigned(number) : "--";
    element.classList.toggle("positive", Number.isFinite(number) && number > 0);
    element.classList.toggle("negative", Number.isFinite(number) && number < 0);
  }

  function setStatus(status, label, detail) {
    els.pill.dataset.status = status;
    els.statusLabel.textContent = label;
    els.pill.title = detail || label;
  }

  function failConnection(error) {
    setStatus("error", "错误", error.message || String(error));
  }

  function nextMessageId() {
    const id = String(state.messageId);
    state.messageId += 1;
    return id;
  }

  function describePush(message) {
    const channel = message.arg?.channel || "unknown";
    const count = Array.isArray(message.data) ? message.data.length : 0;
    const type = message.eventType || "push";
    return `${channel} ${type} ${count} 条`;
  }

  function formatSide(side) {
    if (!side || side === "net") return "净";
    if (side === "long") return "多";
    if (side === "short") return "空";
    return side;
  }

  function formatSigned(value) {
    if (value === undefined || value === null || value === "") {
      return "--";
    }
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return String(value);
    }
    return `${number > 0 ? "+" : ""}${formatNumber(number)}`;
  }

  function formatNumber(value, fixedDecimals) {
    if (value === undefined || value === null || value === "") {
      return "--";
    }

    const number = Number(value);
    if (!Number.isFinite(number)) {
      return String(value);
    }

    const abs = Math.abs(number);
    const maximumFractionDigits =
      fixedDecimals ?? (abs >= 100 ? 2 : abs >= 1 ? 6 : 10);

    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: fixedDecimals ?? 0,
      maximumFractionDigits,
    }).format(number);
  }

  function formatAssetAmount(value, options = {}) {
    if (value === undefined || value === null || value === "") {
      return "--";
    }

    const number = Number(value);
    if (!Number.isFinite(number)) {
      return String(value);
    }

    if (number === 0) {
      return "0";
    }

    const abs = Math.abs(number);
    if (options.usd) {
      return abs < 0.01 ? "<0.01" : formatNumber(number, 2);
    }

    if (abs < 0.000001) {
      return number.toExponential(2);
    }

    const maximumFractionDigits = abs >= 1 ? 6 : 8;
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits,
    }).format(number);
  }

  function formatCompact(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return "--";
    }

    return new Intl.NumberFormat("en-US", {
      notation: Math.abs(number) >= 10000 ? "compact" : "standard",
      maximumFractionDigits: Math.abs(number) >= 100 ? 0 : 2,
    }).format(number);
  }

  function hasBalanceValue(balance) {
    return [balance.eq, balance.cashBal, balance.availEq, balance.availBal, balance.disEq].some(
      (value) => Math.abs(Number(value || 0)) > 0,
    );
  }

  function valueForSort(balance) {
    return Math.abs(Number(firstValue(balance.disEq, balance.eqUsd, balance.eq, balance.cashBal) || 0));
  }

  function firstValue(...values) {
    return values.find((value) => value !== undefined && value !== null && value !== "");
  }

  function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : NaN;
  }
})();
