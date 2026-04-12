(function () {
  const vscode = acquireVsCodeApi();
  const defaultUi = {
    sections: { sidebarControls: true, sessionList: true, detailSummary: true, messagePreview: true },
    sizes: { sidebarControls: 210, detailSummary: 280 },
  };
  const state = {
    reqSeq: 1,
    pending: new Map(),
    mode: "active",
    search: "",
    items: [],
    selectedId: null,
    detail: null,
    searchTimer: null,
    loadingList: false,
    mismatchOnly: false,
    mismatchCount: 0,
    listTotal: 0,
    providerEditing: false,
    configInfo: null,
    sessionHealth: null,
    ui: buildUiState(vscode.getState()?.ui),
  };
  const els = {
    configProviderInfo: document.getElementById("configProviderInfo"),
    globalRefreshBtn: document.getElementById("globalRefreshBtn"),
    sidebarStack: document.getElementById("sidebarStack"),
    sidebarControlsSection: document.getElementById("sidebarControlsSection"),
    sessionListSection: document.getElementById("sessionListSection"),
    sidebarResizer: document.getElementById("sidebarResizer"),
    tabActiveBtn: document.getElementById("tabActiveBtn"),
    tabRecycleBtn: document.getElementById("tabRecycleBtn"),
    searchInput: document.getElementById("searchInput"),
    mismatchOnlyBtn: document.getElementById("mismatchOnlyBtn"),
    batchProviderInput: document.getElementById("batchProviderInput"),
    batchUpdateBtn: document.getElementById("batchUpdateBtn"),
    listSummary: document.getElementById("listSummary"),
    sessionList: document.getElementById("sessionList"),
    emptyState: document.getElementById("emptyState"),
    detailPane: document.getElementById("detailPane"),
    detailSummarySection: document.getElementById("detailSummarySection"),
    messageSection: document.getElementById("messageSection"),
    detailResizer: document.getElementById("detailResizer"),
    detailTitle: document.getElementById("detailTitle"),
    detailMeta: document.getElementById("detailMeta"),
    providerInline: document.getElementById("providerInline"),
    execInline: document.getElementById("execInline"),
    providerValue: document.getElementById("providerValue"),
    providerEditInput: document.getElementById("providerEditInput"),
    editProviderBtn: document.getElementById("editProviderBtn"),
    saveProviderBtn: document.getElementById("saveProviderBtn"),
    cancelProviderBtn: document.getElementById("cancelProviderBtn"),
    providerState: document.getElementById("providerState"),
    execStateText: document.getElementById("execStateText"),
    repairProviderBtn: document.getElementById("repairProviderBtn"),
    checkExecBtn: document.getElementById("checkExecBtn"),
    repairExecBtn: document.getElementById("repairExecBtn"),
    copyResumeBtn: document.getElementById("copyResumeBtn"),
    copySessionIdBtn: document.getElementById("copySessionIdBtn"),
    runResumeBtn: document.getElementById("runResumeBtn"),
    deleteRestoreBtn: document.getElementById("deleteRestoreBtn"),
    refreshDetailBtn: document.getElementById("refreshDetailBtn"),
    messageStats: document.getElementById("messageStats"),
    messageList: document.getElementById("messageList"),
    statusBar: document.getElementById("statusBar"),
  };

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }
  function buildUiState(raw) {
    return {
      sections: {
        sidebarControls: raw?.sections?.sidebarControls !== false,
        sessionList: raw?.sections?.sessionList !== false,
        detailSummary: raw?.sections?.detailSummary !== false,
        messagePreview: raw?.sections?.messagePreview !== false,
      },
      sizes: {
        sidebarControls: clamp(Number(raw?.sizes?.sidebarControls) || defaultUi.sizes.sidebarControls, 150, 480),
        detailSummary: clamp(Number(raw?.sizes?.detailSummary) || defaultUi.sizes.detailSummary, 180, 640),
      },
    };
  }
  function persistUiState() {
    vscode.setState({ ui: state.ui });
  }
  function esc(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] || ch));
  }
  function escWithBreaks(text) {
    return esc(text).replace(/\n/g, "<br />");
  }
  function shortId(id) {
    const raw = String(id || "");
    return raw.length > 14 ? `${raw.slice(0, 8)}...${raw.slice(-4)}` : raw;
  }
  function formatTime(value) {
    if (!value) return "-";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }
  function setStatus(text, type = "info") {
    els.statusBar.textContent = text;
    els.statusBar.classList.remove("is-error", "is-success");
    if (type === "error") els.statusBar.classList.add("is-error");
    if (type === "success") els.statusBar.classList.add("is-success");
  }
  function rpc(op, payload) {
    return new Promise((resolve, reject) => {
      const id = String(state.reqSeq++);
      state.pending.set(id, { resolve, reject });
      vscode.postMessage({ id, op, payload: payload || {} });
      setTimeout(() => {
        if (!state.pending.has(id)) return;
        state.pending.delete(id);
        reject(new Error(`请求超时: ${op}`));
      }, 45000);
    });
  }
  async function confirmDanger(message, confirmText = "\u786e\u5b9a") {
    try {
      const data = await rpc("confirmAction", { message, confirmText });
      return !!data?.confirmed;
    } catch (error) {
      setStatus(`\u786e\u8ba4\u5f39\u7a97\u5931\u8d25: ${error.message}`, "error");
      return false;
    }
  }
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg?.id) return;
    const task = state.pending.get(msg.id);
    if (!task) return;
    state.pending.delete(msg.id);
    if (msg.ok) {
      task.resolve(msg.data);
      return;
    }
    task.reject(new Error(msg.error || "未知错误"));
  });

  function getSummaryHeight(section) {
    return Math.ceil(section.querySelector("summary")?.getBoundingClientRect().height || 42);
  }
  function getSplitBounds(stack, top, bottom, handle, options = {}) {
    const stackHeight = Math.ceil(stack.getBoundingClientRect().height || stack.clientHeight || 0);
    const handleHeight = Math.ceil(handle.getBoundingClientRect().height || handle.offsetHeight || 10);
    const min = getSummaryHeight(top) + Number(options.minTopBody || 110);
    const rawMax = stackHeight - handleHeight - getSummaryHeight(bottom) - Number(options.minBottomBody || 140);
    return { min, max: Math.max(min, rawMax) };
  }
  function syncSplitLayout(stack, top, bottom, handle, sizeKey, options = {}) {
    const topOpen = !!top.open;
    const bottomOpen = !!bottom.open;
    top.style.height = "";
    top.style.flex = "0 0 auto";
    bottom.style.flex = "0 0 auto";
    if (topOpen && bottomOpen) {
      const bounds = getSplitBounds(stack, top, bottom, handle, options);
      const next = clamp(Math.round(state.ui.sizes[sizeKey] || bounds.min), bounds.min, bounds.max);
      state.ui.sizes[sizeKey] = next;
      top.style.height = `${next}px`;
      bottom.style.flex = "1 1 0";
      handle.classList.remove("hidden");
      return;
    }
    handle.classList.add("hidden");
    if (topOpen) top.style.flex = "1 1 0";
    else if (bottomOpen) bottom.style.flex = "1 1 0";
  }
  function syncSectionLayout() {
    syncSplitLayout(els.sidebarStack, els.sidebarControlsSection, els.sessionListSection, els.sidebarResizer, "sidebarControls", { minTopBody: 130, minBottomBody: 140 });
    syncSplitLayout(els.detailPane, els.detailSummarySection, els.messageSection, els.detailResizer, "detailSummary", { minTopBody: 180, minBottomBody: 180 });
  }
  function bindSectionToggle(section, key) {
    section.addEventListener("toggle", () => {
      state.ui.sections[key] = !!section.open;
      syncSectionLayout();
      persistUiState();
    });
  }
  function bindSplitResizer(stack, top, bottom, handle, sizeKey, options = {}) {
    handle.addEventListener("pointerdown", (event) => {
      if (!top.open || !bottom.open) return;
      const startHeight = Math.round(top.getBoundingClientRect().height);
      const startY = event.clientY;
      const bounds = getSplitBounds(stack, top, bottom, handle, options);
      event.preventDefault();
      document.body.classList.add("is-resizing");
      const onMove = (moveEvent) => {
        state.ui.sizes[sizeKey] = clamp(startHeight + (moveEvent.clientY - startY), bounds.min, bounds.max);
        syncSectionLayout();
      };
      const stop = () => {
        document.body.classList.remove("is-resizing");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
        persistUiState();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    });
  }
  function initLayout() {
    els.sidebarControlsSection.open = state.ui.sections.sidebarControls;
    els.sessionListSection.open = state.ui.sections.sessionList;
    els.detailSummarySection.open = state.ui.sections.detailSummary;
    els.messageSection.open = state.ui.sections.messagePreview;
    bindSectionToggle(els.sidebarControlsSection, "sidebarControls");
    bindSectionToggle(els.sessionListSection, "sessionList");
    bindSectionToggle(els.detailSummarySection, "detailSummary");
    bindSectionToggle(els.messageSection, "messagePreview");
    bindSplitResizer(els.sidebarStack, els.sidebarControlsSection, els.sessionListSection, els.sidebarResizer, "sidebarControls", { minTopBody: 130, minBottomBody: 140 });
    bindSplitResizer(els.detailPane, els.detailSummarySection, els.messageSection, els.detailResizer, "detailSummary", { minTopBody: 180, minBottomBody: 180 });
    window.addEventListener("resize", syncSectionLayout);
    syncSectionLayout();
  }

  function updateTabs() {
    const isArchive = state.mode === "archive";
    els.tabActiveBtn.classList.toggle("is-active", !isArchive);
    els.tabRecycleBtn.classList.toggle("is-active", isArchive);
  }
  function renderConfigProvider() {
    const data = state.configInfo;
    els.configProviderInfo.classList.remove("is-error", "is-warning", "is-ok");
    if (!data) {
      els.configProviderInfo.textContent = "Config Provider: -";
      els.configProviderInfo.title = "";
      return;
    }
    if (!data.exists) {
      els.configProviderInfo.textContent = "Config: 未找到";
      els.configProviderInfo.classList.add("is-warning");
      els.configProviderInfo.title = data.configPath || "";
      return;
    }
    if (data.parseError) {
      els.configProviderInfo.textContent = "Config: 解析失败";
      els.configProviderInfo.classList.add("is-error");
      els.configProviderInfo.title = `${data.configPath || ""}\n${data.parseError}`;
      return;
    }
    const active = data.activeProvider || "-";
    const count = Array.isArray(data.providers) ? data.providers.length : 0;
    els.configProviderInfo.textContent = `Config: ${active}${count ? ` (${count})` : ""}`;
    els.configProviderInfo.classList.add("is-ok");
    els.configProviderInfo.title = `${data.configPath || ""}\nProviders: ${(data.providers || []).join(", ") || "-"}`;
  }
  function updateMismatchToggle() {
    const active = state.mismatchOnly;
    els.mismatchOnlyBtn.classList.toggle("is-active", active);
    els.mismatchOnlyBtn.setAttribute("aria-pressed", active ? "true" : "false");
    els.mismatchOnlyBtn.textContent = active ? "仅看不一致: 开" : "仅看不一致";
  }
  function renderList() {
    if (state.loadingList) {
      els.sessionList.innerHTML = '<div class="list-empty">正在加载...</div>';
      return;
    }
    if (!state.items.length) {
      if (state.mode === "archive") els.sessionList.innerHTML = '<div class="list-empty">归档列表为空</div>';
      else if (state.mismatchOnly) els.sessionList.innerHTML = '<div class="list-empty">当前筛选下没有不一致会话</div>';
      else els.sessionList.innerHTML = '<div class="list-empty">没有匹配会话</div>';
      return;
    }
    els.sessionList.innerHTML = state.items.map((item) => {
      const selected = item.id === state.selectedId ? "is-selected" : "";
      const line2 = item.firstUserMessage || item.cwd || "无会话摘要";
      const provider = item.provider || "(empty)";
      const fileProvider = item.fileProvider || "(empty)";
      let providerHtml = `<div class="session-provider">${esc(provider)}</div>`;
      if (item.providerMismatch) {
        providerHtml = `<div class="session-provider mismatch-provider" title="DB=${esc(provider)} | FILE=${esc(fileProvider)}"><span>DB:${esc(provider)}</span><span>FILE:${esc(fileProvider)}</span></div>`;
      }
      return `<button class="session-item ${selected}" data-id="${esc(item.id)}" title="${esc(item.id)}"><div class="session-main"><div class="session-title">${esc(item.title || "未命名会话")}</div><div class="session-sub">${esc(line2)}</div><div class="session-id">${esc(shortId(item.id))}</div></div><div class="session-side">${providerHtml}<div class="session-time">${esc(formatTime(item.updatedAt))}</div></div></button>`;
    }).join("");
  }
  function renderMeta(session) {
    return [
      `<div class="meta-cell"><span class="meta-key">ID</span><span class="mono" title="${esc(session.id)}">${esc(session.id)}</span></div>`,
      `<div class="meta-cell"><span class="meta-key">Source</span><span>${esc(session.source || "-")}</span></div>`,
      `<div class="meta-cell"><span class="meta-key">更新</span><span>${esc(formatTime(session.updatedAt))}</span></div>`,
      `<div class="meta-cell"><span class="meta-key">创建</span><span>${esc(formatTime(session.createdAt))}</span></div>`,
      `<div class="meta-cell meta-cwd"><span class="meta-key">CWD</span><span title="${esc(session.cwd || "-")}">${esc(session.cwd || "-")}</span></div>`,
    ].join("");
  }
  function getProviderState(session) {
    const dbProvider = String(session.provider || "").trim() || "(empty)";
    const fileProvider = String(session.fileProvider || "").trim() || "(empty)";
    if (session.providerMismatchError) return { text: `文件 Provider 读取失败: ${session.providerMismatchError}`, kind: "error", canRepair: false };
    if (session.providerMismatch) return { text: `不一致: DB=${dbProvider} / FILE=${fileProvider}`, kind: "warning", canRepair: true };
    if (session.fileProvider) return { text: `一致: FILE=${fileProvider}`, kind: "ok", canRepair: false };
    return { text: "未读取到文件 Provider", kind: "warning", canRepair: false };
  }
  function setProviderEditing(editing) {
    state.providerEditing = !!editing;
    els.providerValue.classList.toggle("hidden", state.providerEditing);
    els.editProviderBtn.classList.toggle("hidden", state.providerEditing);
    els.providerEditInput.classList.toggle("hidden", !state.providerEditing);
    els.saveProviderBtn.classList.toggle("hidden", !state.providerEditing);
    els.cancelProviderBtn.classList.toggle("hidden", !state.providerEditing);
    const canRepair = els.repairProviderBtn.dataset.canRepair === "1";
    els.repairProviderBtn.classList.toggle("hidden", !canRepair || state.providerEditing);
    if (state.providerEditing) {
      els.providerEditInput.focus();
      els.providerEditInput.select();
    }
  }
  function renderProviderInline(session) {
    els.providerInline.classList.remove("hidden");
    els.providerValue.textContent = session.provider || "(empty)";
    els.providerEditInput.value = session.provider || "";
    const info = getProviderState(session);
    els.providerState.textContent = info.text;
    els.providerState.classList.remove("is-ok", "is-warning", "is-error");
    if (info.kind === "ok") els.providerState.classList.add("is-ok");
    else if (info.kind === "warning") els.providerState.classList.add("is-warning");
    else if (info.kind === "error") els.providerState.classList.add("is-error");
    els.repairProviderBtn.dataset.canRepair = info.canRepair ? "1" : "0";
    setProviderEditing(false);
  }
  function getSessionHealthView(health) {
    if (!health) return { text: "未检测", kind: "warning", canRepair: false };
    const openCount = Number(health.openTaskCount || 0);
    const idle = Number.isFinite(Number(health.idleSeconds)) ? `${health.idleSeconds}s` : "-";
    if (health.status === "healthy") return { text: "正常：未发现未闭合任务", kind: "ok", canRepair: false };
    if (health.status === "running") return { text: `运行中：未闭合任务 ${openCount} · 最近活动 ${idle} 前`, kind: "warning", canRepair: false };
    if (health.status === "stuck") return { text: `疑似卡住：未闭合任务 ${openCount} · 空闲 ${idle}`, kind: "error", canRepair: !!health.canRepair };
    return { text: `检测异常：${health.reason || "unknown"}`, kind: "error", canRepair: false };
  }
  function renderSessionHealth() {
    const session = state.detail?.session;
    if (!session?.id) {
      els.execInline.classList.add("hidden");
      return;
    }
    els.execInline.classList.remove("hidden");
    const info = getSessionHealthView(state.sessionHealth);
    els.execStateText.textContent = info.text;
    els.execStateText.classList.remove("is-ok", "is-warning", "is-error");
    if (info.kind === "ok") els.execStateText.classList.add("is-ok");
    else if (info.kind === "warning") els.execStateText.classList.add("is-warning");
    else els.execStateText.classList.add("is-error");
    els.repairExecBtn.classList.toggle("hidden", !info.canRepair);
  }
  function renderDetail() {
    const detail = state.detail;
    if (!detail?.session || detail.session.id !== state.selectedId) {
      els.emptyState.classList.remove("hidden");
      els.detailPane.classList.add("hidden");
      els.detailTitle.textContent = "";
      els.detailMeta.innerHTML = "";
      els.providerInline.classList.add("hidden");
      els.execInline.classList.add("hidden");
      els.messageStats.textContent = "";
      els.messageList.innerHTML = "";
      syncSectionLayout();
      return;
    }
    const session = detail.session;
    els.emptyState.classList.add("hidden");
    els.detailPane.classList.remove("hidden");
    els.detailTitle.textContent = session.title || session.firstUserMessage || session.id;
    els.detailMeta.innerHTML = renderMeta(session);
    renderProviderInline(session);
    renderSessionHealth();
    els.deleteRestoreBtn.textContent = session.archived ? "恢复会话" : "归档会话";
    els.deleteRestoreBtn.classList.toggle("danger", !session.archived);
    const msgCount = Number(detail.messageCount || 0);
    const userTurns = Number(detail.userTurns || 0);
    let stats = `消息 ${msgCount} · 用户 ${userTurns}`;
    if (detail.fileError) stats += ` · 文件异常: ${detail.fileError}`;
    els.messageStats.textContent = stats;
    const messages = Array.isArray(detail.messages) ? detail.messages : [];
    if (!messages.length) {
      els.messageList.innerHTML = '<div class="message-empty">暂无可预览消息</div>';
      syncSectionLayout();
      return;
    }
    els.messageList.innerHTML = messages.map((msg) => {
      const role = String(msg.role || "assistant").toLowerCase();
      const roleClass = role === "user" ? "role-user" : role === "system" ? "role-system" : "role-assistant";
      return `<article class="message ${roleClass}"><div class="message-top"><div class="message-role">${esc(role)}</div><div class="message-time">${esc(formatTime(msg.timestamp))}</div></div><div class="message-text">${escWithBreaks(msg.text || "")}</div></article>`;
    }).join("");
    els.messageList.scrollTop = 0;
    syncSectionLayout();
  }
  function renderSummary(total) {
    const totalNum = Number(total || state.items.length);
    if (state.mode === "archive") {
      els.listSummary.textContent = `归档 ${state.items.length}/${totalNum}`;
      return;
    }
    if (state.mismatchOnly) {
      els.listSummary.textContent = `不一致 ${state.items.length}/${Math.max(state.mismatchCount, state.items.length)}`;
      return;
    }
    els.listSummary.textContent = `会话 ${state.items.length}/${totalNum} · 不一致 ${state.mismatchCount}`;
  }
  function setSelected(id) {
    state.selectedId = id;
    renderList();
  }
  function captureListContext() {
    const hasSearchFocus = document.activeElement === els.searchInput;
    return {
      hasSearchFocus,
      selectionStart: hasSearchFocus ? els.searchInput.selectionStart : null,
      selectionEnd: hasSearchFocus ? els.searchInput.selectionEnd : null,
      listScrollTop: Number(els.sessionList.scrollTop || 0),
    };
  }
  function restoreListContext(ctx) {
    if (!ctx) return;
    if (ctx.hasSearchFocus) {
      els.searchInput.focus();
      if (Number.isInteger(ctx.selectionStart) && Number.isInteger(ctx.selectionEnd)) {
        try {
          els.searchInput.setSelectionRange(ctx.selectionStart, ctx.selectionEnd);
        } catch {
          // ignore selection restore errors
        }
      }
    }
    if (Number.isFinite(ctx.listScrollTop)) els.sessionList.scrollTop = ctx.listScrollTop;
  }
  function chooseNearbySessionId(fallbackIndex) {
    if (!state.items.length) return "";
    const safeIndex = Math.max(0, Math.min(Number(fallbackIndex || 0), state.items.length - 1));
    return String(state.items[safeIndex]?.id || state.items[0].id || "");
  }
  async function loadHealth() {
    const data = await rpc("health");
    if (!data.exists) {
      setStatus(`未找到数据库: ${data.dbPath}`, "error");
      return;
    }
    setStatus(`就绪 · ${data.codexHome}`, "success");
  }
  async function loadConfigProviders() {
    state.configInfo = await rpc("getConfigProviders");
    renderConfigProvider();
  }
  async function loadList(options = {}) {
    const keepSelection = options.keepSelection !== false;
    const silent = options.silent === true;
    state.loadingList = true;
    renderList();
    if (!silent) setStatus("加载会话列表...");
    const data = await rpc("listSessions", { mode: state.mode, q: state.search, mismatchOnly: state.mismatchOnly, limit: 300 });
    state.loadingList = false;
    state.items = Array.isArray(data.items) ? data.items : [];
    state.listTotal = Number(data.total || 0);
    state.mismatchCount = Number(data.mismatchCount || 0);
    renderSummary(state.listTotal);
    if (keepSelection && state.selectedId && state.items.some((item) => item.id === state.selectedId)) {
      renderList();
      return;
    }
    if (state.items.length > 0) {
      state.sessionHealth = null;
      setSelected(state.items[0].id);
      await loadDetail(state.items[0].id, { silent: true });
    } else {
      state.selectedId = null;
      state.detail = null;
      state.sessionHealth = null;
      renderList();
      renderDetail();
    }
    if (!silent) setStatus("列表已更新", "success");
  }
  async function loadDetail(id, options = {}) {
    if (!id) return;
    const silent = options.silent === true;
    if (!silent) setStatus(`加载会话 ${shortId(id)} 详情...`);
    const data = await rpc("getSessionDetail", { id, maxMessages: 220 });
    if (state.selectedId !== id) return;
    state.detail = data;
    renderDetail();
    if (!silent) setStatus("详情已更新", "success");
  }
  async function onRefreshAll() {
    try {
      await loadConfigProviders();
      await loadList({ keepSelection: true });
      if (state.selectedId) await loadDetail(state.selectedId, { silent: true });
      setStatus("刷新完成", "success");
    } catch (error) {
      setStatus(`刷新失败: ${error.message}`, "error");
    }
  }
  async function onSelectSession(id) {
    if (!id || id === state.selectedId) return;
    setSelected(id);
    state.detail = null;
    state.sessionHealth = null;
    renderDetail();
    try {
      await loadDetail(id);
    } catch (error) {
      setStatus(`加载详情失败: ${error.message}`, "error");
    }
  }
  async function onSaveProvider() {
    const id = state.detail?.session?.id;
    if (!id) {
      setStatus("请先选择会话", "error");
      return;
    }
    const provider = els.providerEditInput.value.trim();
    if (!provider) {
      setStatus("Provider 不能为空", "error");
      return;
    }
    els.saveProviderBtn.disabled = true;
    try {
      setStatus("正在保存 Provider...");
      await rpc("updateProvider", { id, provider });
      await loadDetail(id, { silent: true });
      await loadList({ keepSelection: true, silent: true });
      setProviderEditing(false);
      setStatus("Provider 已保存并修复可加载性", "success");
    } catch (error) {
      setStatus(`保存 Provider 失败: ${error.message}`, "error");
    } finally {
      els.saveProviderBtn.disabled = false;
    }
  }
  async function onRepairProvider() {
    const id = state.detail?.session?.id;
    if (!id) {
      setStatus("请先选择会话", "error");
      return;
    }
    els.repairProviderBtn.disabled = true;
    try {
      const data = await rpc("repairSingle", { id });
      await loadDetail(id, { silent: true });
      await loadList({ keepSelection: true, silent: true });
      setStatus(data.changed ? `已修正不一致: ${data.from} -> ${data.to}` : "Provider 已一致，无需修正", "success");
    } catch (error) {
      setStatus(`修正失败: ${error.message}`, "error");
    } finally {
      els.repairProviderBtn.disabled = false;
    }
  }
  async function onBatchUpdateProvider() {
    const provider = els.batchProviderInput.value.trim();
    if (!provider) {
      setStatus("请填写批量 Provider", "error");
      return;
    }
    const ids = state.items.map((item) => item.id).filter(Boolean);
    if (!ids.length) {
      setStatus("当前筛选结果为空", "error");
      return;
    }
    const loadedHint = state.listTotal > ids.length ? `\n注意：当前筛选总数为 ${state.listTotal}，本次仅修改已加载的 ${ids.length} 条（列表上限 300）。` : "";
    const ok = await confirmDanger(`确认将当前筛选的 ${ids.length} 条会话批量设置为 provider: ${provider} ?${loadedHint}`, "继续");
    if (!ok) return;
    const ok2 = await confirmDanger("该操作会同时写入数据库和会话文件，是否继续？", "确认批量修改");
    if (!ok2) return;
    els.batchUpdateBtn.disabled = true;
    try {
      setStatus(`批量更新中 (${ids.length})...`);
      const data = await rpc("batchUpdate", { ids, provider });
      await loadList({ keepSelection: true, silent: true });
      if (state.selectedId) await loadDetail(state.selectedId, { silent: true });
      const hasFailure = Number(data.failed || 0) > 0;
      setStatus(`批量完成: updated=${data.updated || 0}, failed=${data.failed || 0}, missing=${data.missing || 0}`, hasFailure ? "error" : "success");
    } catch (error) {
      setStatus(`批量更新失败: ${error.message}`, "error");
    } finally {
      els.batchUpdateBtn.disabled = false;
    }
  }
  async function onDeleteOrRestore() {
    const session = state.detail?.session;
    if (!session?.id) {
      setStatus("请先选择会话", "error");
      return;
    }
    const uiContext = captureListContext();
    const previousIndex = state.items.findIndex((item) => item.id === session.id);
    const isArchived = !!session.archived;
    const ok = await confirmDanger(isArchived ? "确定将此会话恢复到会话列表吗？" : "确定将此会话归档吗？", isArchived ? "恢复会话" : "归档会话");
    if (!ok) return;
    els.deleteRestoreBtn.disabled = true;
    try {
      const actionData = isArchived ? await rpc("restoreFromRecycle", { id: session.id }) : await rpc("moveToRecycle", { id: session.id });
      if (!isArchived && actionData?.moved === false) setStatus(actionData.alreadyInRecycle ? "会话已在归档列表" : "归档未生效，请刷新后重试", "error");
      if (isArchived && actionData?.restored === false) setStatus(actionData.alreadyActive ? "会话已在会话列表" : "恢复未生效，请刷新后重试", "error");
      const currentId = session.id;
      await loadList({ keepSelection: true, silent: true });
      const stillExists = state.items.some((item) => item.id === currentId);
      if (stillExists) {
        setSelected(currentId);
        await loadDetail(currentId, { silent: true });
      } else if (state.items.length > 0) {
        const nextId = chooseNearbySessionId(previousIndex);
        setSelected(nextId);
        await loadDetail(nextId, { silent: true });
      } else {
        state.selectedId = null;
        state.detail = null;
        renderDetail();
      }
      if ((isArchived && actionData?.restored) || (!isArchived && actionData?.moved)) setStatus(isArchived ? "会话已恢复到会话列表" : "会话已归档", "success");
    } catch (error) {
      setStatus(`操作失败: ${error.message}`, "error");
    } finally {
      els.deleteRestoreBtn.disabled = false;
      restoreListContext(uiContext);
    }
  }
  async function onCheckSessionHealth() {
    const id = state.detail?.session?.id;
    if (!id) {
      setStatus("请先选择会话", "error");
      return;
    }
    els.checkExecBtn.disabled = true;
    try {
      setStatus("正在检测会话执行状态...");
      const data = await rpc("checkSessionHealth", { id, maxIdleSeconds: 600 });
      if (state.selectedId !== id) return;
      state.sessionHealth = data;
      renderSessionHealth();
      if (data.status === "healthy") setStatus("检测完成：会话状态正常", "success");
      else if (data.status === "running") setStatus("检测完成：会话仍在运行或刚刚活动", "success");
      else if (data.status === "stuck") setStatus(data.canRepair ? "检测完成：发现疑似卡住，可执行修复" : "检测完成：疑似卡住，但缺少可修复 turn_id", "error");
      else setStatus(`检测完成：${data.reason || "状态异常"}`, "error");
    } catch (error) {
      setStatus(`检测失败: ${error.message}`, "error");
    } finally {
      els.checkExecBtn.disabled = false;
    }
  }
  async function onRepairSessionHealth() {
    const id = state.detail?.session?.id;
    if (!id) {
      setStatus("请先选择会话", "error");
      return;
    }
    let health = state.sessionHealth;
    if (!health || health.id !== id) {
      try {
        health = await rpc("checkSessionHealth", { id, maxIdleSeconds: 600 });
        state.sessionHealth = health;
        renderSessionHealth();
      } catch (error) {
        setStatus(`修复前检测失败: ${error.message}`, "error");
        return;
      }
    }
    if (!health.canRepair) {
      setStatus("当前会话未检测到可修复的卡住状态", "error");
      return;
    }
    const ok = await confirmDanger(`确认修复该会话的执行状态吗？turn_id=${health.repairTurnId || "-"}`, "确认修复");
    if (!ok) return;
    els.repairExecBtn.disabled = true;
    try {
      setStatus("正在修复会话执行状态...");
      const data = await rpc("repairSessionHealth", { id, maxIdleSeconds: 600, reason: "interrupted" });
      if (state.selectedId !== id) return;
      state.sessionHealth = { id, ...(data.after || {}) };
      renderSessionHealth();
      await loadDetail(id, { silent: true });
      setStatus(data.repaired ? `修复完成，已备份: ${data.backupPath}` : "修复执行完成，但状态仍需人工确认", data.repaired ? "success" : "error");
    } catch (error) {
      setStatus(`修复失败: ${error.message}`, "error");
    } finally {
      els.repairExecBtn.disabled = false;
    }
  }
  async function onCopyResume() {
    const id = state.detail?.session?.id || state.selectedId;
    if (!id) {
      setStatus("请先选择会话", "error");
      return;
    }
    try {
      await rpc("copyResume", { id });
      setStatus("Resume 命令已复制", "success");
    } catch (error) {
      setStatus(`复制失败: ${error.message}`, "error");
    }
  }
  async function onCopySessionId() {
    const id = state.detail?.session?.id || state.selectedId;
    if (!id) {
      setStatus("请先选择会话", "error");
      return;
    }
    try {
      await rpc("copySessionId", { id });
      setStatus("会话 ID 已复制", "success");
    } catch (error) {
      setStatus(`复制会话 ID 失败: ${error.message}`, "error");
    }
  }
  async function onRunResume() {
    const session = state.detail?.session;
    if (!session?.id) {
      setStatus("请先选择会话", "error");
      return;
    }
    try {
      await rpc("runResume", { id: session.id, cwd: session.cwd || "" });
      setStatus("已在终端执行 Resume", "success");
    } catch (error) {
      setStatus(`执行失败: ${error.message}`, "error");
    }
  }
  function onSearchInput() {
    state.search = els.searchInput.value.trim();
    if (state.searchTimer) clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      loadList({ keepSelection: false }).catch((error) => setStatus(`搜索失败: ${error.message}`, "error"));
    }, 220);
  }
  function bindEvents() {
    els.globalRefreshBtn.addEventListener("click", onRefreshAll);
    els.tabActiveBtn.addEventListener("click", async () => {
      if (state.mode === "active") return;
      state.mode = "active";
      updateTabs();
      state.selectedId = null;
      state.detail = null;
      renderDetail();
      try {
        await loadList({ keepSelection: false });
      } catch (error) {
        setStatus(`切换失败: ${error.message}`, "error");
      }
    });
    els.tabRecycleBtn.addEventListener("click", async () => {
      if (state.mode === "archive") return;
      state.mode = "archive";
      updateTabs();
      state.selectedId = null;
      state.detail = null;
      renderDetail();
      try {
        await loadList({ keepSelection: false });
      } catch (error) {
        setStatus(`切换失败: ${error.message}`, "error");
      }
    });
    els.searchInput.addEventListener("input", onSearchInput);
    els.searchInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      if (state.searchTimer) clearTimeout(state.searchTimer);
      state.search = els.searchInput.value.trim();
      loadList({ keepSelection: false }).catch((error) => setStatus(`搜索失败: ${error.message}`, "error"));
    });
    els.mismatchOnlyBtn.addEventListener("click", async () => {
      state.mismatchOnly = !state.mismatchOnly;
      updateMismatchToggle();
      try {
        await loadList({ keepSelection: false });
      } catch (error) {
        setStatus(`筛选失败: ${error.message}`, "error");
      }
    });
    els.batchUpdateBtn.addEventListener("click", onBatchUpdateProvider);
    els.batchProviderInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") onBatchUpdateProvider();
    });
    els.sessionList.addEventListener("click", (event) => {
      const item = event.target.closest(".session-item[data-id]");
      if (item) onSelectSession(item.dataset.id || "");
    });
    els.refreshDetailBtn.addEventListener("click", async () => {
      if (!state.selectedId) {
        setStatus("请先选择会话", "error");
        return;
      }
      try {
        await loadDetail(state.selectedId);
      } catch (error) {
        setStatus(`刷新详情失败: ${error.message}`, "error");
      }
    });
    els.editProviderBtn.addEventListener("click", () => setProviderEditing(true));
    els.cancelProviderBtn.addEventListener("click", () => setProviderEditing(false));
    els.saveProviderBtn.addEventListener("click", onSaveProvider);
    els.providerEditInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") onSaveProvider();
      if (event.key === "Escape") setProviderEditing(false);
    });
    els.repairProviderBtn.addEventListener("click", onRepairProvider);
    els.checkExecBtn.addEventListener("click", onCheckSessionHealth);
    els.repairExecBtn.addEventListener("click", onRepairSessionHealth);
    els.deleteRestoreBtn.addEventListener("click", onDeleteOrRestore);
    els.copyResumeBtn.addEventListener("click", onCopyResume);
    els.copySessionIdBtn.addEventListener("click", onCopySessionId);
    els.runResumeBtn.addEventListener("click", onRunResume);
  }
  async function bootstrap() {
    initLayout();
    updateTabs();
    updateMismatchToggle();
    bindEvents();
    try {
      await loadHealth();
      await loadConfigProviders();
      await loadList({ keepSelection: false });
    } catch (error) {
      setStatus(`初始化失败: ${error.message}`, "error");
    }
  }
  bootstrap();
})();
