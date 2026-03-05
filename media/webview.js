(function () {
  const vscode = acquireVsCodeApi();

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
  };

  const els = {
    configProviderInfo: document.getElementById("configProviderInfo"),
    globalRefreshBtn: document.getElementById("globalRefreshBtn"),
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
    detailTitle: document.getElementById("detailTitle"),
    detailMeta: document.getElementById("detailMeta"),
    providerInline: document.getElementById("providerInline"),
    providerValue: document.getElementById("providerValue"),
    providerEditInput: document.getElementById("providerEditInput"),
    editProviderBtn: document.getElementById("editProviderBtn"),
    saveProviderBtn: document.getElementById("saveProviderBtn"),
    cancelProviderBtn: document.getElementById("cancelProviderBtn"),
    providerState: document.getElementById("providerState"),
    repairProviderBtn: document.getElementById("repairProviderBtn"),
    copyResumeBtn: document.getElementById("copyResumeBtn"),
    copySessionIdBtn: document.getElementById("copySessionIdBtn"),
    runResumeBtn: document.getElementById("runResumeBtn"),
    deleteRestoreBtn: document.getElementById("deleteRestoreBtn"),
    refreshDetailBtn: document.getElementById("refreshDetailBtn"),
    messageStats: document.getElementById("messageStats"),
    messageList: document.getElementById("messageList"),
    statusBar: document.getElementById("statusBar"),
  };

  function esc(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => {
      const map = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      };
      return map[ch] || ch;
    });
  }

  function escWithBreaks(text) {
    return esc(text).replace(/\n/g, "<br />");
  }

  function shortId(id) {
    const raw = String(id || "");
    return raw.length > 14 ? `${raw.slice(0, 8)}...${raw.slice(-4)}` : raw;
  }

  function formatTime(value) {
    if (!value) {
      return "-";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return String(value);
    }
    return date.toLocaleString();
  }

  function setStatus(text, type = "info") {
    els.statusBar.textContent = text;
    els.statusBar.classList.remove("is-error", "is-success");
    if (type === "error") {
      els.statusBar.classList.add("is-error");
    }
    if (type === "success") {
      els.statusBar.classList.add("is-success");
    }
  }

  function rpc(op, payload) {
    return new Promise((resolve, reject) => {
      const id = String(state.reqSeq++);
      state.pending.set(id, { resolve, reject });
      vscode.postMessage({ id, op, payload: payload || {} });
      setTimeout(() => {
        if (!state.pending.has(id)) {
          return;
        }
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
    if (!msg || !msg.id) {
      return;
    }
    const task = state.pending.get(msg.id);
    if (!task) {
      return;
    }

    state.pending.delete(msg.id);
    if (msg.ok) {
      task.resolve(msg.data);
      return;
    }
    task.reject(new Error(msg.error || "未知错误"));
  });

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
      els.sessionList.innerHTML = "<div class=\"list-empty\">\u6b63\u5728\u52a0\u8f7d...</div>";
      return;
    }

    if (!state.items.length) {
      if (state.mode === "archive") {
        els.sessionList.innerHTML = "<div class=\"list-empty\">\u5f52\u6863\u5217\u8868\u4e3a\u7a7a</div>";
      } else if (state.mismatchOnly) {
        els.sessionList.innerHTML = "<div class=\"list-empty\">\u5f53\u524d\u7b5b\u9009\u4e0b\u6ca1\u6709\u4e0d\u4e00\u81f4\u4f1a\u8bdd</div>";
      } else {
        els.sessionList.innerHTML = "<div class=\"list-empty\">\u6ca1\u6709\u5339\u914d\u4f1a\u8bdd</div>";
      }
      return;
    }

    els.sessionList.innerHTML = state.items
      .map((item) => {
        const selected = item.id === state.selectedId ? "is-selected" : "";
        const line2 = item.firstUserMessage || item.cwd || "\u65e0\u4f1a\u8bdd\u6458\u8981";
        const provider = item.provider || "(empty)";
        const fileProvider = item.fileProvider || "(empty)";

        let providerHtml = `<div class="session-provider">${esc(provider)}</div>`;
        if (item.providerMismatch) {
          providerHtml = `
            <div class="session-provider mismatch-provider" title="DB=${esc(provider)} | FILE=${esc(fileProvider)}">
              <span>DB:${esc(provider)}</span>
              <span>FILE:${esc(fileProvider)}</span>
            </div>
          `;
        }

        return `
          <button class="session-item ${selected}" data-id="${esc(item.id)}" title="${esc(item.id)}">
            <div class="session-main">
              <div class="session-title">${esc(item.title || "\u672a\u547d\u540d\u4f1a\u8bdd")}</div>
              <div class="session-sub">${esc(line2)}</div>
              <div class="session-id">${esc(shortId(item.id))}</div>
            </div>
            <div class="session-side">
              ${providerHtml}
              <div class="session-time">${esc(formatTime(item.updatedAt))}</div>
            </div>
          </button>
        `;
      })
      .join("");
  }


  function renderMeta(session) {
    const chunks = [
      `<div class="meta-cell"><span class="meta-key">ID</span><span class="mono" title="${esc(session.id)}">${esc(session.id)}</span></div>`,
      `<div class="meta-cell"><span class="meta-key">Source</span><span>${esc(session.source || "-")}</span></div>`,
      `<div class="meta-cell"><span class="meta-key">更新</span><span>${esc(formatTime(session.updatedAt))}</span></div>`,
      `<div class="meta-cell"><span class="meta-key">创建</span><span>${esc(formatTime(session.createdAt))}</span></div>`,
      `<div class="meta-cell meta-cwd"><span class="meta-key">CWD</span><span title="${esc(session.cwd || "-")}">${esc(session.cwd || "-")}</span></div>`,
    ];
    return chunks.join("");
  }

  function getProviderState(session) {
    const dbProvider = String(session.provider || "").trim() || "(empty)";
    const fileProvider = String(session.fileProvider || "").trim() || "(empty)";

    if (session.providerMismatchError) {
      return {
        text: `文件 Provider 读取失败: ${session.providerMismatchError}`,
        kind: "error",
        canRepair: false,
      };
    }

    if (session.providerMismatch) {
      return {
        text: `不一致: DB=${dbProvider} / FILE=${fileProvider}`,
        kind: "warning",
        canRepair: true,
      };
    }

    if (session.fileProvider) {
      return {
        text: `一致: FILE=${fileProvider}`,
        kind: "ok",
        canRepair: false,
      };
    }

    return {
      text: "未读取到文件 Provider",
      kind: "warning",
      canRepair: false,
    };
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
    if (info.kind === "ok") {
      els.providerState.classList.add("is-ok");
    } else if (info.kind === "warning") {
      els.providerState.classList.add("is-warning");
    } else if (info.kind === "error") {
      els.providerState.classList.add("is-error");
    }
    els.repairProviderBtn.dataset.canRepair = info.canRepair ? "1" : "0";
    setProviderEditing(false);
  }

  function renderDetail() {
    const detail = state.detail;
    if (!detail || !detail.session || detail.session.id !== state.selectedId) {
      els.emptyState.classList.remove("hidden");
      els.detailPane.classList.add("hidden");
      els.detailTitle.textContent = "";
      els.detailMeta.innerHTML = "";
      els.providerInline.classList.add("hidden");
      els.messageStats.textContent = "";
      els.messageList.innerHTML = "";
      return;
    }

    const session = detail.session;
    els.emptyState.classList.add("hidden");
    els.detailPane.classList.remove("hidden");

    els.detailTitle.textContent = session.title || session.firstUserMessage || session.id;
    els.detailMeta.innerHTML = renderMeta(session);
    renderProviderInline(session);

    els.deleteRestoreBtn.textContent = session.archived ? "\u6062\u590d\u4f1a\u8bdd" : "\u5f52\u6863\u4f1a\u8bdd";
    els.deleteRestoreBtn.classList.toggle("danger", !session.archived);

    const msgCount = Number(detail.messageCount || 0);
    const userTurns = Number(detail.userTurns || 0);
    let stats = `消息 ${msgCount} · 用户 ${userTurns}`;
    if (detail.fileError) {
      stats += ` · 文件异常: ${detail.fileError}`;
    }
    els.messageStats.textContent = stats;

    const messages = Array.isArray(detail.messages) ? detail.messages : [];
    if (!messages.length) {
      els.messageList.innerHTML = '<div class="message-empty">暂无可预览消息</div>';
      return;
    }

    els.messageList.innerHTML = messages
      .map((msg) => {
        const role = String(msg.role || "assistant").toLowerCase();
        const roleClass = role === "user" ? "role-user" : role === "system" ? "role-system" : "role-assistant";
        return `
          <article class="message ${roleClass}">
            <div class="message-top">
              <div class="message-role">${esc(role)}</div>
              <div class="message-time">${esc(formatTime(msg.timestamp))}</div>
            </div>
            <div class="message-text">${escWithBreaks(msg.text || "")}</div>
          </article>
        `;
      })
      .join("");

    els.messageList.scrollTop = 0;
  }

  function renderSummary(total) {
    const totalNum = Number(total || state.items.length);
    if (state.mode === "archive") {
      els.listSummary.textContent = `\u5f52\u6863 ${state.items.length}/${totalNum}`;
      return;
    }

    if (state.mismatchOnly) {
      els.listSummary.textContent = `\u4e0d\u4e00\u81f4 ${state.items.length}/${Math.max(state.mismatchCount, state.items.length)}`;
      return;
    }

    els.listSummary.textContent = `\u4f1a\u8bdd ${state.items.length}/${totalNum} \u00b7 \u4e0d\u4e00\u81f4 ${state.mismatchCount}`;
  }


  function setSelected(id) {
    state.selectedId = id;
    renderList();
  }

  function captureListContext() {
    const hasSearchFocus = document.activeElement === els.searchInput;
    const selectionStart = hasSearchFocus ? els.searchInput.selectionStart : null;
    const selectionEnd = hasSearchFocus ? els.searchInput.selectionEnd : null;

    return {
      hasSearchFocus,
      selectionStart,
      selectionEnd,
      listScrollTop: Number(els.sessionList.scrollTop || 0),
    };
  }

  function restoreListContext(ctx) {
    if (!ctx) {
      return;
    }

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

    if (Number.isFinite(ctx.listScrollTop)) {
      els.sessionList.scrollTop = ctx.listScrollTop;
    }
  }

  function chooseNearbySessionId(fallbackIndex) {
    if (!state.items.length) {
      return "";
    }
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
    if (!silent) {
      setStatus("加载会话列表...");
    }

    const data = await rpc("listSessions", {
      mode: state.mode,
      q: state.search,
      mismatchOnly: state.mismatchOnly,
      limit: 300,
    });

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
      setSelected(state.items[0].id);
      await loadDetail(state.items[0].id, { silent: true });
    } else {
      state.selectedId = null;
      state.detail = null;
      renderList();
      renderDetail();
    }

    if (!silent) {
      setStatus("列表已更新", "success");
    }
  }

  async function loadDetail(id, options = {}) {
    const silent = options.silent === true;
    if (!id) {
      return;
    }

    if (!silent) {
      setStatus(`加载会话 ${shortId(id)} 详情...`);
    }

    const data = await rpc("getSessionDetail", { id, maxMessages: 220 });
    if (state.selectedId !== id) {
      return;
    }

    state.detail = data;
    renderDetail();

    if (!silent) {
      setStatus("详情已更新", "success");
    }
  }

  async function onRefreshAll() {
    try {
      await loadConfigProviders();
      await loadList({ keepSelection: true });
      if (state.selectedId) {
        await loadDetail(state.selectedId, { silent: true });
      }
      setStatus("刷新完成", "success");
    } catch (error) {
      setStatus(`刷新失败: ${error.message}`, "error");
    }
  }

  async function onSelectSession(id) {
    if (!id || id === state.selectedId) {
      return;
    }

    setSelected(id);
    state.detail = null;
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
      if (data.changed) {
        setStatus(`已修正不一致: ${data.from} -> ${data.to}`, "success");
      } else {
        setStatus("Provider 已一致，无需修正", "success");
      }
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
    const loadedHint =
      state.listTotal > ids.length
        ? `\n\u6ce8\u610f\uff1a\u5f53\u524d\u7b5b\u9009\u603b\u6570\u4e3a ${state.listTotal}\uff0c\u672c\u6b21\u4ec5\u4fee\u6539\u5df2\u52a0\u8f7d\u7684 ${ids.length} \u6761\uff08\u5217\u8868\u4e0a\u9650 300\uff09\u3002`
        : "";

    const ok = await confirmDanger(`\u786e\u8ba4\u5c06\u5f53\u524d\u7b5b\u9009\u7684 ${ids.length} \u6761\u4f1a\u8bdd\u6279\u91cf\u8bbe\u7f6e\u4e3a provider: ${provider} ?${loadedHint}`, "\u7ee7\u7eed");
    if (!ok) {
      return;
    }
    const ok2 = await confirmDanger("\u8be5\u64cd\u4f5c\u4f1a\u540c\u65f6\u5199\u5165\u6570\u636e\u5e93\u548c\u4f1a\u8bdd\u6587\u4ef6\uff0c\u662f\u5426\u7ee7\u7eed\uff1f", "\u786e\u8ba4\u6279\u91cf\u4fee\u6539");
    if (!ok2) {
      return;
    }

    els.batchUpdateBtn.disabled = true;
    try {
      setStatus(`批量更新中 (${ids.length})...`);
      const data = await rpc("batchUpdate", { ids, provider });
      await loadList({ keepSelection: true, silent: true });
      if (state.selectedId) {
        await loadDetail(state.selectedId, { silent: true });
      }

      const hasFailure = Number(data.failed || 0) > 0;
      const summary = `批量完成: updated=${data.updated || 0}, failed=${data.failed || 0}, missing=${data.missing || 0}`;
      setStatus(summary, hasFailure ? "error" : "success");
    } catch (error) {
      setStatus(`批量更新失败: ${error.message}`, "error");
    } finally {
      els.batchUpdateBtn.disabled = false;
    }
  }

  async function onDeleteOrRestore() {
    const session = state.detail?.session;
    if (!session || !session.id) {
      setStatus("\u8bf7\u5148\u9009\u62e9\u4f1a\u8bdd", "error");
      return;
    }

    const uiContext = captureListContext();
    const previousIndex = state.items.findIndex((item) => item.id === session.id);

    const isArchived = !!session.archived;
    if (!isArchived) {
      const ok = await confirmDanger("\u786e\u5b9a\u5c06\u6b64\u4f1a\u8bdd\u5f52\u6863\u5417\uff1f", "\u5f52\u6863\u4f1a\u8bdd");
      if (!ok) {
        return;
      }
    } else {
      const ok = await confirmDanger("\u786e\u5b9a\u5c06\u6b64\u4f1a\u8bdd\u6062\u590d\u5230\u4f1a\u8bdd\u5217\u8868\u5417\uff1f", "\u6062\u590d\u4f1a\u8bdd");
      if (!ok) {
        return;
      }
    }

    els.deleteRestoreBtn.disabled = true;
    try {
      const actionData = isArchived
        ? await rpc("restoreFromRecycle", { id: session.id })
        : await rpc("moveToRecycle", { id: session.id });

      if (!isArchived && actionData && actionData.moved === false) {
        setStatus(actionData.alreadyInRecycle ? "\u4f1a\u8bdd\u5df2\u5728\u5f52\u6863\u5217\u8868" : "\u5f52\u6863\u672a\u751f\u6548\uff0c\u8bf7\u5237\u65b0\u540e\u91cd\u8bd5", "error");
      }
      if (isArchived && actionData && actionData.restored === false) {
        setStatus(actionData.alreadyActive ? "\u4f1a\u8bdd\u5df2\u5728\u4f1a\u8bdd\u5217\u8868" : "\u6062\u590d\u672a\u751f\u6548\uff0c\u8bf7\u5237\u65b0\u540e\u91cd\u8bd5", "error");
      }

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

      if ((isArchived && actionData?.restored) || (!isArchived && actionData?.moved)) {
        setStatus(isArchived ? "\u4f1a\u8bdd\u5df2\u6062\u590d\u5230\u4f1a\u8bdd\u5217\u8868" : "\u4f1a\u8bdd\u5df2\u5f52\u6863", "success");
      }
    } catch (error) {
      setStatus(`\u64cd\u4f5c\u5931\u8d25: ${error.message}`, "error");
    } finally {
      els.deleteRestoreBtn.disabled = false;
      restoreListContext(uiContext);
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
    if (!session || !session.id) {
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
    if (state.searchTimer) {
      clearTimeout(state.searchTimer);
    }

    state.searchTimer = setTimeout(() => {
      loadList({ keepSelection: false }).catch((error) => {
        setStatus(`搜索失败: ${error.message}`, "error");
      });
    }, 220);
  }

  function bindEvents() {
    els.globalRefreshBtn.addEventListener("click", onRefreshAll);

    els.tabActiveBtn.addEventListener("click", async () => {
      if (state.mode === "active") {
        return;
      }
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
      if (state.mode === "archive") {
        return;
      }
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
    els.mismatchOnlyBtn.addEventListener("click", async () => {
      state.mismatchOnly = !state.mismatchOnly;
      updateMismatchToggle();
      try {
        await loadList({ keepSelection: false });
      } catch (error) {
        setStatus(`筛选失败: ${error.message}`, "error");
      }
    });
    els.searchInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }

      if (state.searchTimer) {
        clearTimeout(state.searchTimer);
      }
      state.search = els.searchInput.value.trim();
      loadList({ keepSelection: false }).catch((error) => {
        setStatus(`搜索失败: ${error.message}`, "error");
      });
    });

    els.batchUpdateBtn.addEventListener("click", onBatchUpdateProvider);
    els.batchProviderInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        onBatchUpdateProvider();
      }
    });

    els.sessionList.addEventListener("click", (event) => {
      const item = event.target.closest(".session-item[data-id]");
      if (!item) {
        return;
      }
      onSelectSession(item.dataset.id || "");
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
      if (event.key === "Enter") {
        onSaveProvider();
      }
      if (event.key === "Escape") {
        setProviderEditing(false);
      }
    });
    els.repairProviderBtn.addEventListener("click", onRepairProvider);

    els.deleteRestoreBtn.addEventListener("click", onDeleteOrRestore);
    els.copyResumeBtn.addEventListener("click", onCopyResume);
    els.copySessionIdBtn.addEventListener("click", onCopySessionId);
    els.runResumeBtn.addEventListener("click", onRunResume);
  }

  async function bootstrap() {
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
















