(() => {
  "use strict";

  const THEME_STORAGE_KEY = "okx-dashboard.theme.v1";
  const HISTORY_PATH = "/api/v5/account/positions-history";
  const DEFAULT_LIMIT = 10;

  const okx = window.OKXRuntime;
  let config = { ...okx.DEFAULT_CONFIG };
  let credentials = null;
  const urlParams = new URLSearchParams(window.location.search);

  const state = {
    records: [],
    error: "",
    loading: false,
  };

  const els = {
    pill: document.querySelector("#connection-pill"),
    statusLabel: document.querySelector("#status-label"),
    themeToggle: document.querySelector("#theme-toggle"),
    themeIcon: document.querySelector("#theme-icon"),
    themeLabel: document.querySelector("#theme-label"),
    count: document.querySelector("#position-history-count"),
    totalPnl: document.querySelector("#position-history-pnl"),
    outcome: document.querySelector("#position-history-outcome"),
    summary: document.querySelector("#position-history-summary"),
    refreshButton: document.querySelector("#refresh-history-button"),
    body: document.querySelector("#positions-history-body"),
  };

  applyTheme(getInitialTheme());
  render();
  bindEvents();
  boot().catch((error) => failLoad(error));

  function bindEvents() {
    els.themeToggle.addEventListener("click", toggleTheme);
    els.refreshButton.addEventListener("click", () => {
      if (credentials) {
        loadPositionHistory(credentials);
      }
    });
  }

  async function boot() {
    setStatus("connecting", "加载配置", "正在加载最新 config.js。");
    config = await okx.loadConfig();
    credentials = okx.readCredentials(config);

    if (urlParams.has("noAutoConnect")) {
      setStatus("idle", "未加载", "已通过 noAutoConnect 暂停自动加载。");
      return;
    }

    if (!okx.hasUsableCredentials(credentials)) {
      failLoad(new Error("config.js 缺少完整 OKX API 配置。"));
      return;
    }

    await loadPositionHistory(credentials);
  }

  async function loadPositionHistory(activeCredentials) {
    state.loading = true;
    state.error = "";
    setStatus("connecting", "加载中", "正在拉取最近持仓历史。");
    render();

    try {
      const rows = await okx.privateGet(activeCredentials, HISTORY_PATH, {
        limit: getHistoryLimit(),
      });
      state.records = rows.map(normalizePositionHistory).sort((a, b) => b.time - a.time);
      state.loading = false;
      setStatus("connected", "已加载", `已加载 ${state.records.length} 条持仓历史。`);
      render();
    } catch (error) {
      state.loading = false;
      failLoad(error);
    }
  }

  function normalizePositionHistory(item) {
    const pnl = toFiniteNumber(firstValue(item.realizedPnl, item.pnl, item.closePnl, item.posPnl));
    const fee = toFiniteNumber(firstValue(item.fee, item.openFee, item.closeFee));
    const fundingFee = toFiniteNumber(firstValue(item.fundingFee, item.funding, item.fundingPnl));
    const penalty = toFiniteNumber(firstValue(item.liqPenalty, item.liquidationPenalty, item.penalty));
    const closeSize = firstValue(item.closeTotalPos, item.closePos, item.pos, item.sz);
    const time = toTimestamp(firstValue(item.uTime, item.cTime, item.closeTime, item.ts, Date.now()));

    return {
      time,
      instId: item.instId || "--",
      instType: item.instType || "--",
      side: firstValue(item.direction, item.posSide, item.side),
      closeSize,
      openAvgPx: firstValue(item.openAvgPx, item.avgPx, item.openAvgPrice),
      closeAvgPx: firstValue(item.closeAvgPx, item.closeAvgPrice, item.closePx),
      pnl,
      pnlRatio: firstValue(item.pnlRatio, item.realizedPnlRatio, item.roe),
      fee,
      fundingFee,
      penalty,
      marginMode: firstValue(item.mgnMode, item.marginMode),
      leverage: firstValue(item.lever, item.leverage),
    };
  }

  function render() {
    renderSummary();
    renderTable();
  }

  function renderSummary() {
    const pnlValues = state.records.map((record) => record.pnl).filter(Number.isFinite);
    const totalPnl = pnlValues.reduce((sum, value) => sum + value, 0);
    const winners = pnlValues.filter((value) => value > 0).length;
    const losers = pnlValues.filter((value) => value < 0).length;

    els.count.textContent = String(state.records.length);
    setSignedValue(els.totalPnl, pnlValues.length ? totalPnl : NaN);
    els.outcome.textContent = `${winners} / ${losers}`;

    if (state.error) {
      els.summary.textContent = state.error;
      return;
    }

    if (state.loading) {
      els.summary.textContent = "正在拉取最近持仓历史";
      return;
    }

    els.summary.textContent = state.records.length
      ? `显示最近 ${state.records.length} 条已结束持仓，最多 ${getHistoryLimit()} 条。`
      : "暂无持仓历史记录";
  }

  function renderTable() {
    els.body.replaceChildren();

    if (!state.records.length) {
      appendEmptyRow(
        els.body,
        11,
        state.loading ? "正在拉取最近持仓历史" : "暂无已结束持仓记录",
      );
      return;
    }

    for (const record of state.records) {
      const row = document.createElement("tr");
      appendCell(row, formatDateTime(record.time), "left");
      appendCell(row, record.instId, "left");
      appendCell(row, record.instType);
      appendCell(row, formatSide(record.side));
      appendCell(row, formatNumber(record.closeSize));
      appendCell(row, formatNumber(record.openAvgPx));
      appendCell(row, formatNumber(record.closeAvgPx));
      appendCell(row, formatSigned(record.pnl), pnlClass(record.pnl));
      appendCell(row, formatRatio(record.pnlRatio), pnlClass(toFiniteNumber(record.pnlRatio)));
      appendCell(row, formatCosts(record));
      appendCell(row, formatModeLeverage(record));
      els.body.append(row);
    }
  }

  function getHistoryLimit() {
    const limit = Number(config.positionHistoryLimit);
    if (!Number.isInteger(limit) || limit < 1) {
      return DEFAULT_LIMIT;
    }
    return Math.min(limit, 50);
  }

  function failLoad(error) {
    state.error = error.message || String(error);
    setStatus("error", "错误", state.error);
    render();
  }

  function setStatus(status, label, detail) {
    els.pill.dataset.status = status;
    els.statusLabel.textContent = label;
    els.pill.title = detail || label;
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
  }

  function applyTheme(theme) {
    const isDark = theme === "dark";
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
    els.themeIcon.textContent = isDark ? "☀" : "☾";
    els.themeLabel.textContent = isDark ? "日间" : "夜间";
    els.themeToggle.setAttribute("aria-pressed", String(isDark));
    els.themeToggle.setAttribute("aria-label", isDark ? "切换到日间主题" : "切换到夜间主题");
  }

  function setSignedValue(element, value) {
    const number = toFiniteNumber(value);
    element.textContent = Number.isFinite(number) ? formatSigned(number) : "--";
    element.classList.toggle("positive", Number.isFinite(number) && number > 0);
    element.classList.toggle("negative", Number.isFinite(number) && number < 0);
  }

  function pnlClass(value) {
    const number = toFiniteNumber(value);
    if (!Number.isFinite(number) || number === 0) {
      return "";
    }
    return number > 0 ? "positive" : "negative";
  }

  function formatSide(side) {
    if (!side || side === "net") return "净";
    if (side === "long") return "多";
    if (side === "short") return "空";
    if (side === "buy") return "买入";
    if (side === "sell") return "卖出";
    return String(side);
  }

  function formatModeLeverage(record) {
    const parts = [];
    if (record.marginMode) parts.push(String(record.marginMode));
    if (record.leverage) parts.push(`${record.leverage}x`);
    return parts.join(" / ") || "--";
  }

  function formatCosts(record) {
    const fee = Number.isFinite(record.fee) ? formatSigned(record.fee) : "--";
    const fundingFee = Number.isFinite(record.fundingFee) ? formatSigned(record.fundingFee) : "--";
    const penalty = Number.isFinite(record.penalty) ? formatSigned(record.penalty) : "--";
    return `${fee} / ${fundingFee} / ${penalty}`;
  }

  function formatRatio(value) {
    if (value === undefined || value === null || value === "") {
      return "--";
    }

    const number = Number(value);
    if (!Number.isFinite(number)) {
      return String(value);
    }

    const percent = Math.abs(number) <= 1 ? number * 100 : number;
    return `${percent > 0 ? "+" : ""}${formatNumber(percent, 2)}%`;
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

  function formatDateTime(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
      return "--";
    }
    return date.toLocaleString();
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

  function firstValue(...values) {
    return values.find((value) => value !== undefined && value !== null && value !== "");
  }

  function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : NaN;
  }

  function toTimestamp(value) {
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number < 100000000000 ? number * 1000 : number;
    }

    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }
})();
