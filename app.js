(() => {
  "use strict";

  const THEME_STORAGE_KEY = "okx-dashboard.theme.v1";
  const PROFIT_CHART_RANGE_STORAGE_KEY = "okx-dashboard.profit-chart-range.v1";
  const LOGIN_FAILURE_STORAGE_KEY = "okx-dashboard.login-failures.v1";
  const CLIENT_LOGIN_DAILY_FAILURE_LIMIT = 5;
  const BEIJING_TIME_OFFSET_MS = 8 * 60 * 60 * 1000;
  const CURRENT_POSITIONS_PATH = "/api/v5/account/positions";
  const HISTORY_PATH = "/api/v5/account/positions-history";
  const DEFAULT_HISTORY_LIMIT = 10;
  const CHART_DEFAULT_LOOKBACK_DAYS = 7;
  const CHART_HISTORY_MONTHS = 3;
  const CHART_HISTORY_PAGE_LIMIT = 100;
  const CHART_HISTORY_MAX_PAGES = 20;
  const CHART_HISTORY_PAGE_DELAY_MS = 220;
  const DEFAULT_CHART_AUTO_REFRESH_INTERVAL_MS = 60000;
  const DEFAULT_CHART_PERIOD = "1h";
  const CHART_PERIODS = new Map([
    ["15m", { label: "15m", ms: 15 * 60 * 1000 }],
    ["1h", { label: "1h", ms: 60 * 60 * 1000 }],
    ["4h", { label: "4h", ms: 4 * 60 * 60 * 1000 }],
    ["1d", { label: "1d", ms: 24 * 60 * 60 * 1000 }],
  ]);
  const VIEW_COPY = {
    dashboard: {
      eyebrow: "OKX Private WebSocket",
      title: "账户看板",
      documentTitle: "OKX 账户看板",
    },
    "positions-history": {
      eyebrow: "OKX Private REST",
      title: "持仓历史",
      documentTitle: "OKX 持仓历史",
    },
  };

  const okx = window.OKXRuntime;
  let config = { ...okx.DEFAULT_CONFIG };
  const urlParams = new URLSearchParams(window.location.search);

  const state = {
    activeView: getRouteView(),
    configLoaded: false,
    accessGranted: false,
    accessUser: "",
    loginInFlight: false,
    ws: null,
    authenticated: false,
    connectionError: "",
    heartbeatId: 0,
    positionRefreshId: 0,
    positionRefreshInFlight: false,
    positionRefreshToken: 0,
    messageId: 1,
    account: {},
    balances: new Map(),
    positions: new Map(),
    lastPositionUpdateAt: 0,
    profitChart: {
      period: DEFAULT_CHART_PERIOD,
      startTime: 0,
      endTime: null,
      records: [],
      points: [],
      error: "",
      loading: false,
      loaded: false,
      includedRecordCount: 0,
      excludedCurrencyCount: 0,
      invalidPnlCount: 0,
      pageCount: 0,
      truncated: false,
      refreshId: 0,
    },
    positionHistory: {
      records: [],
      error: "",
      loading: false,
      loaded: false,
    },
    connectedAt: 0,
  };

  const els = {
    viewEyebrow: document.querySelector("#view-eyebrow"),
    viewTitle: document.querySelector("#view-title"),
    viewLinks: document.querySelectorAll("[data-view-link]"),
    dashboardView: document.querySelector("#dashboard-view"),
    positionsHistoryView: document.querySelector("#positions-history-view"),
    pill: document.querySelector("#connection-pill"),
    statusLabel: document.querySelector("#status-label"),
    themeToggle: document.querySelector("#theme-toggle"),
    themeIcon: document.querySelector("#theme-icon"),
    themeLabel: document.querySelector("#theme-label"),
    logoutButton: document.querySelector("#logout-button"),
    loginPanel: document.querySelector("#login-panel"),
    loginForm: document.querySelector("#login-form"),
    loginUsername: document.querySelector("#login-username"),
    loginPassword: document.querySelector("#login-password"),
    loginError: document.querySelector("#login-error"),
    loginButton: document.querySelector("#login-button"),
    profitChartControls: document.querySelector("#profit-chart-controls"),
    profitStartInput: document.querySelector("#profit-start-input"),
    profitEndInput: document.querySelector("#profit-end-input"),
    profitPeriodSelect: document.querySelector("#profit-period-select"),
    loadProfitChartButton: document.querySelector("#load-profit-chart-button"),
    chartSummary: document.querySelector("#chart-summary"),
    equityLegendLabel: document.querySelector("#equity-legend-label"),
    chartCanvas: document.querySelector("#profit-chart"),
    chartEmpty: document.querySelector("#chart-empty"),
    chartTotalPnl: document.querySelector("#chart-total-pnl"),
    chartHighPnl: document.querySelector("#chart-high-pnl"),
    chartLowPnl: document.querySelector("#chart-low-pnl"),
    chartRecordCount: document.querySelector("#chart-record-count"),
    hideZero: document.querySelector("#hide-zero-input"),
    balancesBody: document.querySelector("#balances-body"),
    positionsBody: document.querySelector("#positions-body"),
    balanceCount: document.querySelector("#balance-count"),
    positionCount: document.querySelector("#position-count"),
    positionHistoryCount: document.querySelector("#position-history-count"),
    positionHistoryPnl: document.querySelector("#position-history-pnl"),
    positionHistoryOutcome: document.querySelector("#position-history-outcome"),
    positionHistorySummary: document.querySelector("#position-history-summary"),
    refreshHistoryButton: document.querySelector("#refresh-history-button"),
    positionsHistoryBody: document.querySelector("#positions-history-body"),
  };

  initializeProfitChartControls();
  applyTheme(getInitialTheme());
  applyActiveView(state.activeView, { skipChartLoad: true, skipHistoryLoad: true });
  render();
  bindEvents();
  boot().catch((error) => failConnection(error));

  function bindEvents() {
    els.themeToggle.addEventListener("click", toggleTheme);
    window.addEventListener("resize", () => drawProfitChart());
    window.addEventListener("hashchange", () => applyActiveView(getRouteView()));
    window.addEventListener("beforeunload", stopProfitChartAutoRefresh);
    els.profitChartControls.addEventListener("submit", (event) => {
      event.preventDefault();
      loadProfitChart({ force: true, syncControls: true });
    });
    els.profitStartInput.addEventListener("change", updateProfitChartInputLimits);
    els.profitEndInput.addEventListener("change", updateProfitChartInputLimits);
    for (const link of els.viewLinks) {
      link.addEventListener("click", (event) => {
        const nextView = normalizeView(link.dataset.viewLink);
        if (state.activeView === nextView) {
          event.preventDefault();
          applyActiveView(nextView);
        }
      });
    }
    els.hideZero.addEventListener("change", renderBalances);
    els.refreshHistoryButton.addEventListener("click", () => {
      loadPositionHistory({ force: true });
    });
    els.loginForm.addEventListener("submit", (event) => {
      event.preventDefault();
      submitLogin();
    });
    els.logoutButton.addEventListener("click", () => {
      logout();
    });
  }

  async function boot() {
    setStatus("connecting", "加载配置", "正在加载最新 config.js。");
    config = await okx.loadConfig();
    state.configLoaded = true;
    const credentials = okx.readCredentials(config);
    renderProfitChart();
    renderPositionHistory();

    if (urlParams.has("noAutoConnect")) {
      setStatus("idle", "未连接", "已通过 noAutoConnect 暂停自动连接。");
      if (state.activeView === "positions-history") {
        state.positionHistory.error = "已通过 noAutoConnect 暂停自动加载。";
        renderPositionHistory();
      }
      return;
    }

    if (!okx.hasUsableCredentials(credentials)) {
      renderAccessState();
      failConnection(new Error("config.js 缺少可用的 Worker API 配置。"));
      return;
    }

    setStatus("connecting", "验证登录", "正在验证登录会话。");
    let session;
    try {
      session = await okx.getAuthSession(credentials);
    } catch (error) {
      renderAccessState();
      failConnection(error);
      return;
    }

    if (!session.authenticated) {
      state.accessGranted = false;
      state.accessUser = "";
      renderAccessState();
      setStatus("idle", "待登录", "请先登录。");
      return;
    }

    state.accessGranted = true;
    state.accessUser = session.username;
    renderAccessState();
    await startAuthenticatedSession();
  }

  async function startAuthenticatedSession() {
    ensureProfitChartLoaded();
    ensurePositionHistoryLoaded();
    await connect();
  }

  async function submitLogin() {
    if (!state.configLoaded || state.loginInFlight) {
      return;
    }

    if (isClientLoginLocked()) {
      failLogin(new Error(getClientLoginLockedMessage()));
      return;
    }

    const credentials = okx.readCredentials(config);
    if (!okx.hasUsableCredentials(credentials)) {
      failLogin(new Error("config.js 缺少可用的 Worker API 配置。"));
      return;
    }

    state.loginInFlight = true;
    renderAccessState();
    setStatus("connecting", "登录中", "正在验证账号密码。");
    try {
      const session = await okx.login(
        credentials,
        els.loginUsername.value.trim(),
        els.loginPassword.value,
      );
      if (!session.authenticated) {
        throw new Error("登录失败。");
      }
      els.loginPassword.value = "";
      clearClientLoginFailures();
      state.accessGranted = true;
      state.accessUser = session.username;
      state.loginInFlight = false;
      renderAccessState();
      await startAuthenticatedSession();
    } catch (error) {
      state.loginInFlight = false;
      if (error.status === 401) {
        const failure = recordClientLoginFailure();
        if (failure.locked) {
          failLogin(new Error(getClientLoginLockedMessage()));
          return;
        }
      } else if (error.status === 429) {
        lockClientLoginForToday();
        failLogin(new Error(getClientLoginLockedMessage()));
        return;
      }
      failLogin(error);
    }
  }

  function failLogin(error) {
    state.accessGranted = false;
    state.accessUser = "";
    els.loginError.textContent = error.message || String(error);
    renderAccessState();
    setStatus("error", "登录失败", els.loginError.textContent);
  }

  async function logout() {
    const credentials = okx.readCredentials(config);
    try {
      if (okx.hasUsableCredentials(credentials)) {
        await okx.logout(credentials);
      }
    } catch {
      // Local logout still clears protected data even if the network request fails.
    }
    closeSocket();
    resetProtectedData();
    state.accessGranted = false;
    state.accessUser = "";
    state.authenticated = false;
    renderAccessState();
    render();
    setStatus("idle", "已退出", "已退出登录。");
  }

  function getRouteView() {
    return normalizeView(window.location.hash.replace(/^#/, ""));
  }

  function normalizeView(view) {
    return view === "positions-history" ? "positions-history" : "dashboard";
  }

  function applyActiveView(view, options = {}) {
    const activeView = normalizeView(view);
    state.activeView = activeView;

    els.dashboardView.classList.toggle("hidden", activeView !== "dashboard");
    els.positionsHistoryView.classList.toggle("hidden", activeView !== "positions-history");
    for (const link of els.viewLinks) {
      const isCurrent = normalizeView(link.dataset.viewLink) === activeView;
      if (isCurrent) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    }

    const copy = VIEW_COPY[activeView];
    els.viewEyebrow.textContent = copy.eyebrow;
    els.viewTitle.textContent = copy.title;
    document.title = copy.documentTitle;

    if (activeView === "dashboard") {
      window.requestAnimationFrame(() => renderProfitChart());
      if (!options.skipChartLoad) {
        ensureProfitChartLoaded();
      }
      syncProfitChartAutoRefresh();
      return;
    }

    stopProfitChartAutoRefresh();
    renderPositionHistory();
    if (!options.skipHistoryLoad) {
      ensurePositionHistoryLoaded();
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

    closeSocket();
    resetAccountState();
    state.authenticated = false;
    state.connectionError = "";
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
        setStatus("authenticating", "认证中", "正在从 Worker 获取 OKX 登录签名。");
        const loginPayload = await okx.createWebSocketLoginPayload(credentials);
        sendJson({ op: "login", args: [loginPayload] }, { withId: false });
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
      if (state.ws === socket) {
        failConnection(new Error("WebSocket 连接发生错误。"));
      }
    });
    socket.addEventListener("close", (event) => {
      if (state.ws !== socket) {
        return;
      }
      const wasAuthenticated = state.authenticated;
      stopHeartbeat();
      stopPositionRefresh();
      state.ws = null;
      state.authenticated = false;

      if (state.connectionError) {
        setStatus("error", "错误", state.connectionError);
      } else if (!wasAuthenticated) {
        setStatus("error", "认证中断", formatCloseDetail(event, "认证未完成，WebSocket 已关闭。"));
      } else if (event.wasClean) {
        setStatus("idle", "已断开", formatCloseDetail(event, "连接已关闭。"));
      } else {
        setStatus("error", "已断开", formatCloseDetail(event, "连接异常关闭。"));
      }
    });
  }

  function closeSocket() {
    stopHeartbeat();
    stopPositionRefresh();
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

    render();
  }

  function handleEventMessage(message) {
    if (message.event === "login") {
      if (message.code === "0") {
        state.authenticated = true;
        state.connectionError = "";
        setStatus("connected", "已连接", "登录成功，正在订阅账户与持仓。");
        subscribePrivateChannels();
        startPositionRefresh();
        return;
      }
      failConnection(new Error(formatOkxEventError(message, "OKX 登录失败")));
      return;
    }

    if (message.event === "subscribe") {
      return;
    }

    if (message.event === "error") {
      failConnection(new Error(formatOkxEventError(message, "OKX WebSocket 错误")));
    }
  }

  function subscribePrivateChannels() {
    const positionUpdateInterval = getPositionUpdateInterval();
    sendJson({
      op: "subscribe",
      args: [
        { channel: "account" },
        {
          channel: "positions",
          instType: "ANY",
          extraParams: JSON.stringify({ updateInterval: String(positionUpdateInterval) }),
        },
        { channel: "balance_and_position" },
      ],
    });
  }

  function getPositionUpdateInterval() {
    const interval = Number(config.positionUpdateInterval);
    return [0, 2000, 3000, 4000].includes(interval) ? interval : 2000;
  }

  function startPositionRefresh() {
    stopPositionRefresh();
    const refreshInterval = getPositionRefreshInterval();
    if (refreshInterval === 0) {
      return;
    }

    state.positionRefreshToken += 1;
    const refreshToken = state.positionRefreshToken;
    refreshCurrentPositions(refreshToken);
    state.positionRefreshId = window.setInterval(
      () => refreshCurrentPositions(refreshToken),
      refreshInterval,
    );
  }

  function stopPositionRefresh() {
    if (state.positionRefreshId) {
      window.clearInterval(state.positionRefreshId);
      state.positionRefreshId = 0;
    }
    state.positionRefreshToken += 1;
    state.positionRefreshInFlight = false;
  }

  function getPositionRefreshInterval() {
    const interval = Number(config.positionRefreshInterval);
    if (interval === 0) {
      return 0;
    }
    if (!Number.isFinite(interval) || interval < 2000) {
      return 2000;
    }
    return Math.min(interval, 60000);
  }

  async function refreshCurrentPositions(refreshToken) {
    if (refreshToken !== state.positionRefreshToken || state.positionRefreshInFlight) {
      return;
    }

    const credentials = okx.readCredentials(config);
    state.positionRefreshInFlight = true;
    try {
      const positions = await okx.privateGet(credentials, CURRENT_POSITIONS_PATH);
      if (refreshToken !== state.positionRefreshToken) {
        return;
      }
      applyPositionsSnapshot(positions);
      renderPositions();
      setStatus("connected", "已连接", `当前持仓已刷新：${new Date().toLocaleTimeString()}。`);
    } catch (error) {
      if (refreshToken === state.positionRefreshToken) {
        setStatus("error", "REST 错误", error.message || String(error));
      }
    } finally {
      if (refreshToken === state.positionRefreshToken) {
        state.positionRefreshInFlight = false;
      }
    }
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
    markPositionsUpdated();
  }

  function applyPositionsSnapshot(items) {
    state.positions.clear();
    for (const item of items || []) {
      upsertPosition(item);
    }
    markPositionsUpdated();
  }

  function applyBalanceAndPositionData(items) {
    for (const item of items) {
      for (const balance of item.balData || []) {
        upsertBalance({ ...balance, uTime: balance.uTime || item.pTime });
      }

      for (const position of item.posData || []) {
        upsertPosition(position);
      }
      if (item.posData?.length) {
        markPositionsUpdated();
      }
    }
  }

  function markPositionsUpdated() {
    state.lastPositionUpdateAt = Date.now();
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
    state.lastPositionUpdateAt = 0;
    render();
  }

  function resetProtectedData() {
    stopProfitChartAutoRefresh();
    stopPositionRefresh();
    state.account = {};
    state.balances.clear();
    state.positions.clear();
    state.lastPositionUpdateAt = 0;
    Object.assign(state.profitChart, {
      records: [],
      points: [],
      error: "",
      loading: false,
      loaded: false,
      includedRecordCount: 0,
      excludedCurrencyCount: 0,
      invalidPnlCount: 0,
      pageCount: 0,
      truncated: false,
    });
    Object.assign(state.positionHistory, {
      records: [],
      error: "",
      loading: false,
      loaded: false,
    });
  }

  function render() {
    renderAccessState();
    renderProfitChart();
    renderBalances();
    renderPositions();
    renderPositionHistory();
  }

  function renderAccessState() {
    const showLogin =
      state.configLoaded &&
      !state.accessGranted &&
      !urlParams.has("noAutoConnect") &&
      okx.hasUsableCredentials(okx.readCredentials(config));
    const loginLocked = showLogin && isClientLoginLocked();
    els.loginPanel.classList.toggle("hidden", !showLogin);
    els.logoutButton.classList.toggle("hidden", !state.accessGranted);
    els.loginButton.disabled = state.loginInFlight || loginLocked;
    els.loginUsername.disabled = state.loginInFlight || loginLocked;
    els.loginPassword.disabled = state.loginInFlight || loginLocked;
    if (loginLocked) {
      els.loginError.textContent = getClientLoginLockedMessage();
    }
    if (showLogin && !els.loginError.textContent) {
      els.loginError.textContent = "登录后加载账户数据";
    }
    if (state.accessGranted) {
      els.loginError.textContent = "";
    }
  }

  function isClientLoginLocked() {
    return readClientLoginFailures().count >= CLIENT_LOGIN_DAILY_FAILURE_LIMIT;
  }

  function recordClientLoginFailure() {
    const failure = readClientLoginFailures();
    const nextFailure = {
      dayKey: getClientLoginDayKey(),
      count: Math.min(failure.count + 1, CLIENT_LOGIN_DAILY_FAILURE_LIMIT),
    };
    writeClientLoginFailures(nextFailure);
    return {
      count: nextFailure.count,
      locked: nextFailure.count >= CLIENT_LOGIN_DAILY_FAILURE_LIMIT,
    };
  }

  function lockClientLoginForToday() {
    writeClientLoginFailures({
      dayKey: getClientLoginDayKey(),
      count: CLIENT_LOGIN_DAILY_FAILURE_LIMIT,
    });
  }

  function clearClientLoginFailures() {
    try {
      localStorage.removeItem(LOGIN_FAILURE_STORAGE_KEY);
    } catch {
      // localStorage can be unavailable in restricted browser modes.
    }
  }

  function readClientLoginFailures() {
    const dayKey = getClientLoginDayKey();
    try {
      const raw = localStorage.getItem(LOGIN_FAILURE_STORAGE_KEY);
      if (!raw) {
        return { count: 0, dayKey };
      }
      const parsed = JSON.parse(raw);
      if (parsed?.dayKey !== dayKey) {
        clearClientLoginFailures();
        return { count: 0, dayKey };
      }
      return {
        dayKey,
        count: Math.max(0, Math.min(Number(parsed.count) || 0, CLIENT_LOGIN_DAILY_FAILURE_LIMIT)),
      };
    } catch {
      return { count: 0, dayKey };
    }
  }

  function writeClientLoginFailures(failure) {
    try {
      localStorage.setItem(
        LOGIN_FAILURE_STORAGE_KEY,
        JSON.stringify({
          dayKey: failure.dayKey,
          count: failure.count,
        }),
      );
    } catch {
      // localStorage can be unavailable in restricted browser modes.
    }
  }

  function getClientLoginDayKey() {
    return new Date(Date.now() + BEIJING_TIME_OFFSET_MS).toISOString().slice(0, 10);
  }

  function getClientLoginLockedMessage() {
    return "密码错误次数已达 5 次，今日前端已停止发送登录请求。";
  }

  function initializeProfitChartControls() {
    const now = Date.now();
    const allowedRange = getAllowedProfitChartRange(now);
    const savedRange = readSavedProfitChartRange(allowedRange);
    const defaultStartTime = roundToMinute(
      now - CHART_DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    );
    const fallbackStartTime = clampTimestamp(
      defaultStartTime,
      allowedRange.minTime,
      allowedRange.maxTime - 60000,
    );
    const normalizedRange = normalizeProfitChartRange(
      {
        startTime: savedRange?.startTime ?? fallbackStartTime,
        endTime: savedRange?.endTime ?? null,
        period: savedRange?.period ?? DEFAULT_CHART_PERIOD,
      },
      allowedRange,
    );

    state.profitChart.startTime = normalizedRange.startTime;
    state.profitChart.endTime = normalizedRange.endTime;
    state.profitChart.period = normalizedRange.period;
    applyProfitChartRangeToControls(normalizedRange, allowedRange);
  }

  function ensureProfitChartLoaded() {
    if (state.activeView !== "dashboard" || !state.configLoaded || !state.accessGranted) {
      return;
    }
    if (state.profitChart.loaded || state.profitChart.loading) {
      return;
    }
    loadProfitChart();
  }

  async function loadProfitChart(options = {}) {
    if (!state.configLoaded) {
      return;
    }
    if (!state.accessGranted) {
      failProfitChartLoad(new Error("请先登录。"), {
        preserveData: true,
      });
      return;
    }
    if (!options.force && (state.profitChart.loaded || state.profitChart.loading)) {
      return;
    }
    if (state.profitChart.loading) {
      return;
    }

    let range;
    try {
      range = options.syncControls ? readProfitChartControls() : getProfitChartRange();
    } catch (error) {
      failProfitChartLoad(error);
      return;
    }

    stopProfitChartAutoRefresh();
    const nextChartState = {
      ...range,
      error: "",
      loading: true,
      loaded: options.preserveData ? state.profitChart.loaded : false,
    };
    if (!options.preserveData) {
      Object.assign(nextChartState, {
        records: [],
        points: [],
        includedRecordCount: 0,
        excludedCurrencyCount: 0,
        invalidPnlCount: 0,
        pageCount: 0,
        truncated: false,
      });
    }
    Object.assign(state.profitChart, nextChartState);
    renderProfitChart();

    const credentials = okx.readCredentials(config);
    if (!okx.hasUsableCredentials(credentials)) {
      failProfitChartLoad(new Error("config.js 缺少可用的 Worker API 配置。"), {
        preserveData: options.preserveData,
      });
      return;
    }

    const effectiveEndTime = range.endTime ?? Date.now();
    try {
      const result = await fetchPositionHistoryRange(
        credentials,
        range.startTime,
        effectiveEndTime,
        Boolean(range.endTime),
      );
      const aggregation = buildProfitChartPoints(
        result.records,
        range.period,
        range.startTime,
        effectiveEndTime,
      );

      Object.assign(state.profitChart, aggregation, {
        records: result.records,
        loading: false,
        loaded: true,
        error: "",
        pageCount: result.pageCount,
        truncated: result.truncated,
      });
      renderProfitChart();
      syncProfitChartAutoRefresh();
    } catch (error) {
      failProfitChartLoad(error, { preserveData: options.preserveData });
    }
  }

  function readProfitChartControls() {
    const allowedRange = getAllowedProfitChartRange();
    updateProfitChartInputLimits(allowedRange);
    const startTime = parseDateTimeInput(els.profitStartInput.value);
    if (!Number.isFinite(startTime)) {
      throw new Error("请选择收益曲线起始时间。");
    }

    const endTime = els.profitEndInput.value
      ? parseDateTimeInput(els.profitEndInput.value)
      : null;
    if (els.profitEndInput.value && !Number.isFinite(endTime)) {
      throw new Error("收益曲线结束时间无效。");
    }

    if (startTime < allowedRange.minTime) {
      throw new Error(`起始时间不能早于最近 ${CHART_HISTORY_MONTHS} 个月。`);
    }
    if (startTime > allowedRange.maxTime) {
      throw new Error("起始时间不能晚于当前时间。");
    }
    if (endTime !== null && endTime > allowedRange.maxTime) {
      throw new Error("结束时间不能晚于当前时间。");
    }
    if (endTime !== null && endTime < allowedRange.minTime) {
      throw new Error(`结束时间不能早于最近 ${CHART_HISTORY_MONTHS} 个月。`);
    }

    const effectiveEndTime = endTime ?? Date.now();
    if (startTime >= effectiveEndTime) {
      throw new Error(endTime ? "起始时间必须早于结束时间。" : "起始时间必须早于当前时间。");
    }

    const range = {
      startTime,
      endTime,
      period: normalizeChartPeriod(els.profitPeriodSelect.value),
    };
    saveProfitChartRange(range);
    return range;
  }

  function getProfitChartRange() {
    const allowedRange = getAllowedProfitChartRange();
    const range = normalizeProfitChartRange(state.profitChart, allowedRange);
    const effectiveEndTime = range.endTime ?? Date.now();

    if (!Number.isFinite(range.startTime) || range.startTime >= effectiveEndTime) {
      throw new Error("收益曲线日期范围无效。");
    }

    return range;
  }

  function getAllowedProfitChartRange(now = Date.now()) {
    const maxTime = roundToMinute(now);
    return {
      minTime: roundToMinute(subtractMonths(maxTime, CHART_HISTORY_MONTHS)),
      maxTime,
    };
  }

  function normalizeProfitChartRange(range, allowedRange = getAllowedProfitChartRange()) {
    const defaultStartTime = roundToMinute(
      Date.now() - CHART_DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    );
    let endTime =
      range?.endTime !== null &&
      range?.endTime !== undefined &&
      range?.endTime !== "" &&
      Number.isFinite(Number(range.endTime))
        ? Number(range.endTime)
        : null;
    if (endTime !== null) {
      endTime = clampTimestamp(endTime, allowedRange.minTime + 60000, allowedRange.maxTime);
    }

    const effectiveEndTime = endTime ?? allowedRange.maxTime;
    const latestStartTime = Math.max(
      allowedRange.minTime,
      Math.min(allowedRange.maxTime - 60000, effectiveEndTime - 60000),
    );
    const rawStartTime = Number.isFinite(Number(range?.startTime))
      ? Number(range.startTime)
      : defaultStartTime;
    return {
      startTime: clampTimestamp(rawStartTime, allowedRange.minTime, latestStartTime),
      endTime,
      period: normalizeChartPeriod(range?.period),
    };
  }

  function applyProfitChartRangeToControls(range, allowedRange = getAllowedProfitChartRange()) {
    els.profitStartInput.value = formatDateTimeInput(range.startTime);
    els.profitEndInput.value = range.endTime ? formatDateTimeInput(range.endTime) : "";
    els.profitPeriodSelect.value = normalizeChartPeriod(range.period);
    updateProfitChartInputLimits(allowedRange);
  }

  function updateProfitChartInputLimits(allowedRange) {
    const range =
      Number.isFinite(allowedRange?.minTime) && Number.isFinite(allowedRange?.maxTime)
        ? allowedRange
        : getAllowedProfitChartRange();
    const startTime = parseDateTimeInput(els.profitStartInput.value);
    const endMinTime = Number.isFinite(startTime)
      ? Math.min(range.maxTime, Math.max(range.minTime, startTime + 60000))
      : range.minTime;

    els.profitStartInput.min = formatDateTimeInput(range.minTime);
    els.profitStartInput.max = formatDateTimeInput(range.maxTime);
    els.profitEndInput.min = formatDateTimeInput(endMinTime);
    els.profitEndInput.max = formatDateTimeInput(range.maxTime);
  }

  function readSavedProfitChartRange(allowedRange) {
    try {
      const raw = localStorage.getItem(PROFIT_CHART_RANGE_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      return normalizeProfitChartRange(
        {
          startTime: Number(parsed.startTime),
          endTime: parsed.endTime === null || parsed.endTime === "" ? null : Number(parsed.endTime),
          period: parsed.period,
        },
        allowedRange,
      );
    } catch {
      return null;
    }
  }

  function saveProfitChartRange(range) {
    try {
      localStorage.setItem(
        PROFIT_CHART_RANGE_STORAGE_KEY,
        JSON.stringify({
          startTime: range.startTime,
          endTime: range.endTime,
          period: normalizeChartPeriod(range.period),
        }),
      );
    } catch {
      // localStorage can be unavailable in restricted browser modes.
    }
  }

  async function fetchPositionHistoryRange(credentials, startTime, endTime, hasExplicitEndTime) {
    const records = [];
    const seen = new Set();
    let cursor = hasExplicitEndTime ? endTime + 1 : null;
    let pageCount = 0;
    let reachedEnd = false;

    for (let pageIndex = 0; pageIndex < CHART_HISTORY_MAX_PAGES; pageIndex += 1) {
      const params = { limit: CHART_HISTORY_PAGE_LIMIT };
      if (Number.isFinite(cursor)) {
        params.after = String(Math.ceil(cursor));
      }

      const rows = await okx.privateGet(credentials, HISTORY_PATH, params);
      pageCount += 1;
      if (!rows.length) {
        reachedEnd = true;
        break;
      }

      const pageRecords = rows
        .map(normalizePositionHistory)
        .filter((record) => Number.isFinite(record.time));
      if (!pageRecords.length) {
        reachedEnd = true;
        break;
      }

      const times = pageRecords.map((record) => record.time);
      const pageOldestTime = Math.min(...times);
      const pageNewestTime = Math.max(...times);

      for (const record of pageRecords) {
        if (record.time < startTime || record.time > endTime) {
          continue;
        }
        const key = getPositionHistoryRecordKey(record);
        if (!seen.has(key)) {
          seen.add(key);
          records.push(record);
        }
      }

      if (
        pageOldestTime <= startTime ||
        pageNewestTime < startTime ||
        rows.length < CHART_HISTORY_PAGE_LIMIT
      ) {
        reachedEnd = true;
        break;
      }

      if (Number.isFinite(cursor) && pageOldestTime >= cursor) {
        reachedEnd = true;
        break;
      }

      cursor = pageOldestTime;
      await delay(CHART_HISTORY_PAGE_DELAY_MS);
    }

    return {
      records: records.sort((a, b) => a.time - b.time),
      pageCount,
      truncated: !reachedEnd,
    };
  }

  function buildProfitChartPoints(records, period, startTime, endTime) {
    const periodInfo = CHART_PERIODS.get(period) || CHART_PERIODS.get(DEFAULT_CHART_PERIOD);
    const currency = getProfitCurrency();
    const buckets = new Map();
    let includedRecordCount = 0;
    let excludedCurrencyCount = 0;
    let invalidPnlCount = 0;

    for (const record of records) {
      if (!Number.isFinite(record.pnl)) {
        invalidPnlCount += 1;
        continue;
      }
      if (!recordMatchesProfitCurrency(record, currency)) {
        excludedCurrencyCount += 1;
        continue;
      }

      const bucketStart = Math.floor(record.time / periodInfo.ms) * periodInfo.ms;
      const bucket = buckets.get(bucketStart) || {
        time: Math.min(bucketStart + periodInfo.ms, endTime),
        delta: 0,
      };
      bucket.delta += record.pnl;
      buckets.set(bucketStart, bucket);
      includedRecordCount += 1;
    }

    const points = [];
    let runningPnl = 0;
    const bucketRows = [...buckets.values()].sort((a, b) => a.time - b.time);
    if (bucketRows.length) {
      points.push({ time: startTime, value: 0 });
    }

    for (const bucket of bucketRows) {
      runningPnl += bucket.delta;
      const time = Math.max(startTime, Math.min(bucket.time, endTime));
      const last = points.at(-1);
      if (last && last.time === time) {
        last.value = runningPnl;
      } else {
        points.push({ time, value: runningPnl });
      }
    }

    const last = points.at(-1);
    if (last && last.time < endTime) {
      points.push({ time: endTime, value: runningPnl });
    }

    return {
      points,
      includedRecordCount,
      excludedCurrencyCount,
      invalidPnlCount,
    };
  }

  function failProfitChartLoad(error, options = {}) {
    state.profitChart.error = error.message || String(error);
    state.profitChart.loading = false;
    if (!options.preserveData) {
      state.profitChart.loaded = false;
    }
    renderProfitChart();
    syncProfitChartAutoRefresh();
  }

  function syncProfitChartAutoRefresh() {
    const interval = getProfitChartRefreshInterval();
    const shouldRefresh =
      interval > 0 &&
      !urlParams.has("noAutoConnect") &&
      state.activeView === "dashboard" &&
      state.configLoaded &&
      state.accessGranted &&
      state.profitChart.loaded &&
      !state.profitChart.loading &&
      state.profitChart.endTime === null;

    if (!shouldRefresh) {
      stopProfitChartAutoRefresh();
      return;
    }
    if (state.profitChart.refreshId) {
      return;
    }

    state.profitChart.refreshId = window.setInterval(() => {
      if (
        state.activeView !== "dashboard" ||
        state.profitChart.loading ||
        state.profitChart.endTime !== null
      ) {
        syncProfitChartAutoRefresh();
        return;
      }
      loadProfitChart({ force: true, preserveData: true });
    }, interval);
  }

  function stopProfitChartAutoRefresh() {
    if (!state.profitChart.refreshId) {
      return;
    }
    window.clearInterval(state.profitChart.refreshId);
    state.profitChart.refreshId = 0;
  }

  function getProfitChartRefreshInterval() {
    const interval = Number(config.profitChartRefreshInterval);
    if (interval === 0) {
      return 0;
    }
    if (!Number.isFinite(interval)) {
      return DEFAULT_CHART_AUTO_REFRESH_INTERVAL_MS;
    }
    return Math.min(Math.max(interval, 15000), 300000);
  }

  function renderProfitChart() {
    const series = getChartSeries();
    const pnlStats = getSeriesStats(series.equity);
    const hasAnySeries = series.equity.length > 0;
    const currency = getProfitCurrency();

    els.chartEmpty.classList.toggle("hidden", hasAnySeries);
    els.chartEmpty.textContent = getChartEmptyText();
    els.equityLegendLabel.textContent = `累计已实现盈亏（${currency}）`;
    els.chartSummary.textContent = getChartSummary(pnlStats);
    els.chartRecordCount.textContent = state.profitChart.loading
      ? "..."
      : String(state.profitChart.includedRecordCount);
    setSignedValue(els.chartTotalPnl, pnlStats?.current);
    setSignedValue(els.chartHighPnl, pnlStats?.high);
    setSignedValue(els.chartLowPnl, pnlStats?.low);
    setProfitChartControlsDisabled(state.profitChart.loading);

    drawProfitChart(series);
  }

  function getChartSeries() {
    return {
      stable: [],
      equity: state.profitChart.points
        .map((point) => ({
          time: point.time,
          value: point.value,
        }))
        .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.value)),
    };
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

  function getChartSummary(pnlStats) {
    const chart = state.profitChart;
    const currency = getProfitCurrency();
    const period = CHART_PERIODS.get(chart.period) || CHART_PERIODS.get(DEFAULT_CHART_PERIOD);

    if (chart.error) {
      return chart.error;
    }
    if (state.configLoaded && !state.accessGranted && !urlParams.has("noAutoConnect")) {
      return "登录后加载历史收益数据";
    }
    if (chart.loading) {
      return `正在拉取持仓历史 · ${formatChartRangeLabel()}`;
    }
    if (!chart.loaded) {
      return "等待历史收益数据";
    }

    const notes = [];
    if (chart.truncated) {
      notes.push(`已到 ${CHART_HISTORY_MAX_PAGES * CHART_HISTORY_PAGE_LIMIT} 条上限`);
    }
    if (chart.excludedCurrencyCount) {
      notes.push(`${chart.excludedCurrencyCount} 条非 ${currency} 未计入`);
    }
    if (chart.invalidPnlCount) {
      notes.push(`${chart.invalidPnlCount} 条无盈亏字段`);
    }
    const suffix = notes.length ? ` · ${notes.join(" · ")}` : "";
    const periodLabel = period?.label || chart.period;

    if (!pnlStats) {
      return `暂无累计已实现盈亏 · ${formatChartRangeLabel()} · ${periodLabel}${suffix}`;
    }

    return [
      `累计 ${formatSigned(pnlStats.current)} ${currency}`,
      formatChartRangeLabel(),
      periodLabel,
      `${chart.includedRecordCount} 条`,
    ].join(" · ") + suffix;
  }

  function getChartEmptyText() {
    const chart = state.profitChart;
    if (chart.error) {
      return chart.error;
    }
    if (state.configLoaded && !state.accessGranted && !urlParams.has("noAutoConnect")) {
      return "登录后加载历史收益数据";
    }
    if (chart.loading) {
      return "正在拉取持仓历史";
    }
    if (chart.loaded) {
      return chart.records.length ? `暂无 ${getProfitCurrency()} 已实现盈亏` : "范围内暂无已结束持仓";
    }
    return "等待历史收益数据";
  }

  function setProfitChartControlsDisabled(disabled) {
    const shouldDisable = disabled || !state.configLoaded || !state.accessGranted;
    els.profitStartInput.disabled = shouldDisable;
    els.profitEndInput.disabled = shouldDisable;
    els.profitPeriodSelect.disabled = shouldDisable;
    els.loadProfitChartButton.disabled = shouldDisable;
  }

  function formatChartRangeLabel() {
    const start = formatCompactDateTime(state.profitChart.startTime);
    const end = state.profitChart.endTime
      ? formatCompactDateTime(state.profitChart.endTime)
      : "当前";
    return `${start} - ${end}`;
  }

  function normalizeChartPeriod(period) {
    return CHART_PERIODS.has(period) ? period : DEFAULT_CHART_PERIOD;
  }

  function getPositionHistoryRecordKey(record) {
    return [
      record.time,
      record.posId,
      record.instId,
      record.side,
      record.closeSize,
      record.pnl,
    ].join("|");
  }

  function recordMatchesProfitCurrency(record, currency) {
    const recordCurrency = String(record.ccy || "").trim().toUpperCase();
    return !recordCurrency || recordCurrency === currency;
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
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
    const padding = { top: 20, right: 18, bottom: 42, left: 54 };
    const chartWidth = Math.max(1, cssWidth - padding.left - padding.right);
    const chartHeight = Math.max(1, cssHeight - padding.top - padding.bottom);
    const colors = getChartColors();
    const allValues = getAllChartValues(series);
    const timeRange = getChartDrawTimeRange(allValues);

    drawChartGrid(ctx, padding, chartWidth, chartHeight, colors);
    drawXAxisLabels(ctx, timeRange.minTime, timeRange.maxTime, padding, chartWidth, chartHeight, colors);

    if (!allValues.length) {
      ctx.restore();
      return;
    }

    const numbers = allValues.map((point) => point.value);
    const minValue = Math.min(...numbers, 0);
    const maxValue = Math.max(...numbers, 0);
    const minTime = timeRange.minTime;
    const maxTime = timeRange.maxTime;
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
    ctx.restore();
  }

  function getAllChartValues(series) {
    return [...series.stable, ...series.equity].filter((point) => Number.isFinite(point.value));
  }

  function getChartDrawTimeRange(values) {
    const configuredStart = Number(state.profitChart.startTime);
    const configuredEnd = Number(state.profitChart.endTime ?? Date.now());
    if (Number.isFinite(configuredStart) && Number.isFinite(configuredEnd) && configuredEnd > configuredStart) {
      return {
        minTime: configuredStart,
        maxTime: configuredEnd,
      };
    }

    const times = values.map((point) => point.time).filter(Number.isFinite);
    if (times.length) {
      const minTime = Math.min(...times);
      const maxTime = Math.max(...times);
      return {
        minTime,
        maxTime: maxTime > minTime ? maxTime : minTime + 60000,
      };
    }

    const now = Date.now();
    return {
      minTime: now - 60 * 60 * 1000,
      maxTime: now,
    };
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

  function drawXAxisLabels(ctx, minTime, maxTime, padding, chartWidth, chartHeight, colors) {
    if (!Number.isFinite(minTime) || !Number.isFinite(maxTime)) {
      return;
    }

    ctx.fillStyle = colors.text;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "top";

    const y = padding.top + chartHeight + 10;
    const labels =
      chartWidth < 360
        ? [
            { align: "left", time: minTime, x: padding.left },
            { align: "right", time: maxTime, x: padding.left + chartWidth },
          ]
        : [
            { align: "left", time: minTime, x: padding.left },
            { align: "center", time: minTime + (maxTime - minTime) / 2, x: padding.left + chartWidth / 2 },
            { align: "right", time: maxTime, x: padding.left + chartWidth },
          ];

    for (const label of labels) {
      ctx.textAlign = label.align;
      ctx.fillText(formatChartAxisTime(label.time), label.x, y);
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

    const updatedAt = state.lastPositionUpdateAt
      ? ` · ${new Date(state.lastPositionUpdateAt).toLocaleTimeString()}`
      : "";
    els.positionCount.textContent = `${rows.length} 个持仓${updatedAt}`;
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

  function ensurePositionHistoryLoaded() {
    if (state.activeView !== "positions-history" || !state.configLoaded || !state.accessGranted) {
      return;
    }
    if (state.positionHistory.loaded || state.positionHistory.loading) {
      return;
    }
    loadPositionHistory();
  }

  async function loadPositionHistory(options = {}) {
    if (!state.configLoaded) {
      return;
    }
    if (!state.accessGranted) {
      failPositionHistoryLoad(new Error("请先登录。"));
      return;
    }
    if (!options.force && (state.positionHistory.loaded || state.positionHistory.loading)) {
      return;
    }

    const credentials = okx.readCredentials(config);
    if (!okx.hasUsableCredentials(credentials)) {
      failPositionHistoryLoad(new Error("config.js 缺少可用的 Worker API 配置。"));
      return;
    }

    state.positionHistory.loading = true;
    state.positionHistory.error = "";
    renderPositionHistory();

    try {
      const rows = await okx.privateGet(credentials, HISTORY_PATH, {
        limit: getHistoryLimit(),
      });
      state.positionHistory.records = rows
        .map(normalizePositionHistory)
        .sort((a, b) => b.time - a.time);
      state.positionHistory.loaded = true;
      state.positionHistory.loading = false;
      renderPositionHistory();
    } catch (error) {
      state.positionHistory.loading = false;
      failPositionHistoryLoad(error);
    }
  }

  function failPositionHistoryLoad(error) {
    state.positionHistory.error = error.message || String(error);
    state.positionHistory.loaded = false;
    renderPositionHistory();
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
      posId: item.posId || "",
      ccy: item.ccy || "",
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

  function renderPositionHistory() {
    const records = state.positionHistory.records;
    const pnlValues = records.map((record) => record.pnl).filter(Number.isFinite);
    const totalPnl = pnlValues.reduce((sum, value) => sum + value, 0);
    const winners = pnlValues.filter((value) => value > 0).length;
    const losers = pnlValues.filter((value) => value < 0).length;

    els.positionHistoryCount.textContent = String(records.length);
    setSignedValue(els.positionHistoryPnl, pnlValues.length ? totalPnl : NaN);
    els.positionHistoryOutcome.textContent = `${winners} / ${losers}`;
    els.refreshHistoryButton.disabled =
      state.positionHistory.loading || !state.configLoaded || !state.accessGranted;

    if (state.positionHistory.error) {
      els.positionHistorySummary.textContent = state.positionHistory.error;
    } else if (state.configLoaded && !state.accessGranted && !urlParams.has("noAutoConnect")) {
      els.positionHistorySummary.textContent = "登录后加载持仓历史";
    } else if (state.positionHistory.loading) {
      els.positionHistorySummary.textContent = "正在拉取最近持仓历史";
    } else {
      els.positionHistorySummary.textContent = records.length
        ? `显示最近 ${records.length} 条已结束持仓，最多 ${getHistoryLimit()} 条。`
        : "暂无持仓历史记录";
    }

    els.positionsHistoryBody.replaceChildren();
    if (!records.length) {
      appendEmptyRow(
        els.positionsHistoryBody,
        11,
        state.positionHistory.loading ? "正在拉取最近持仓历史" : "暂无已结束持仓记录",
      );
      return;
    }

    for (const record of records) {
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
      els.positionsHistoryBody.append(row);
    }
  }

  function getHistoryLimit() {
    const limit = Number(config.positionHistoryLimit);
    if (!Number.isInteger(limit) || limit < 1) {
      return DEFAULT_HISTORY_LIMIT;
    }
    return Math.min(limit, 50);
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
    state.connectionError = error.message || String(error);
    setStatus("error", "错误", state.connectionError);
  }

  function formatOkxEventError(message, fallback) {
    return `${message.code || "error"} ${message.msg || fallback}`.trim();
  }

  function formatCloseDetail(event, fallback) {
    const code = event.code || "unknown";
    const reason = event.reason ? `：${event.reason}` : "";
    return `${fallback} code=${code}${reason}`;
  }

  function nextMessageId() {
    const id = String(state.messageId);
    state.messageId += 1;
    return id;
  }

  function formatSide(side) {
    if (!side || side === "net") return "净";
    if (side === "long") return "多";
    if (side === "short") return "空";
    if (side === "buy") return "买入";
    if (side === "sell") return "卖出";
    return side;
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

  function formatCompactDateTime(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
      return "--";
    }
    return date.toLocaleString(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatChartAxisTime(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
      return "--";
    }
    return date.toLocaleString(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatDateTimeInput(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
      return "";
    }

    const year = date.getFullYear();
    const month = padDatePart(date.getMonth() + 1);
    const day = padDatePart(date.getDate());
    const hours = padDatePart(date.getHours());
    const minutes = padDatePart(date.getMinutes());
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }

  function parseDateTimeInput(value) {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? NaN : timestamp;
  }

  function roundToMinute(timestamp) {
    return Math.floor(timestamp / 60000) * 60000;
  }

  function subtractMonths(timestamp, months) {
    const date = new Date(timestamp);
    const day = date.getDate();
    date.setMonth(date.getMonth() - months);
    if (date.getDate() !== day) {
      date.setDate(0);
    }
    return date.getTime();
  }

  function clampTimestamp(timestamp, minTime, maxTime) {
    return Math.min(Math.max(timestamp, minTime), maxTime);
  }

  function padDatePart(value) {
    return String(value).padStart(2, "0");
  }

  function pnlClass(value) {
    const number = toFiniteNumber(value);
    if (!Number.isFinite(number) || number === 0) {
      return "";
    }
    return number > 0 ? "positive" : "negative";
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

  function toTimestamp(value) {
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number < 100000000000 ? number * 1000 : number;
    }

    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }
})();
