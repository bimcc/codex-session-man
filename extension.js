const vscode = require("vscode");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const readline = require("node:readline");
const { pipeline } = require("node:stream/promises");

const VIEW_IDS = {
  container: "codexSessionManager",
  controls: "codexSessionManager.controls",
  sessions: "codexSessionManager.sessions",
  details: "codexSessionManager.details",
  messages: "codexSessionManager.messages",
};

let sqliteModCache;
let resumeTerminal = null;

function getSqliteModule() {
  if (sqliteModCache !== undefined) {
    return sqliteModCache || null;
  }
  try {
    sqliteModCache = require("node:sqlite");
  } catch {
    sqliteModCache = null;
  }
  return sqliteModCache;
}

function activate(context) {
  const store = new SessionManagerStore(context);
  const sessionsProvider = new SessionsTreeDataProvider(store);

  const controlsProvider = new ControlsWebviewProvider(context, store);
  const detailsProvider = new DetailsWebviewProvider(context, store);
  const messagesProvider = new MessagesWebviewProvider(context, store);

  context.subscriptions.push(
    sessionsProvider,
    controlsProvider,
    detailsProvider,
    messagesProvider,
    vscode.window.registerTreeDataProvider(VIEW_IDS.sessions, sessionsProvider),
    vscode.window.registerWebviewViewProvider(VIEW_IDS.controls, controlsProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(VIEW_IDS.details, detailsProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(VIEW_IDS.messages, messagesProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    store,
  );

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      if (resumeTerminal && terminal === resumeTerminal) {
        resumeTerminal = null;
      }
    }),
  );

  const openCmd = vscode.commands.registerCommand("codexSessionManager.open", async () => {
    await vscode.commands.executeCommand(`workbench.view.extension.${VIEW_IDS.container}`);
    await vscode.commands.executeCommand(`${VIEW_IDS.sessions}.focus`);
  });

  const refreshCmd = vscode.commands.registerCommand("codexSessionManager.refresh", async () => {
    await store.refreshAll({ preserveSelection: true });
  });

  const selectSessionCmd = vscode.commands.registerCommand("codexSessionManager.selectSession", async (id) => {
    await store.selectSession(String(id || ""));
  });

  context.subscriptions.push(openCmd, refreshCmd, selectSessionCmd);
  void store.initialize();
}

function deactivate() {}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration("codexSessionManager");
  return {
    codexHome: String(cfg.get("codexHome") || "").trim(),
  };
}

function resolveCodexHome(configuredHome) {
  if (configuredHome) {
    if (configuredHome.startsWith("~")) {
      return path.join(os.homedir(), configuredHome.slice(1));
    }
    return configuredHome;
  }
  return path.join(os.homedir(), ".codex");
}

function getEnvironment() {
  const cfg = getConfig();
  const codexHome = resolveCodexHome(cfg.codexHome);
  return {
    codexHome,
    dbPath: path.join(codexHome, "state_5.sqlite"),
  };
}

function formatDisplayTime(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString();
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (ch) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[ch] || ch;
  });
}

function shortId(id) {
  const raw = String(id || "");
  return raw.length > 14 ? `${raw.slice(0, 8)}...${raw.slice(-4)}` : raw;
}

class SessionTreeItem extends vscode.TreeItem {
  constructor(session, selectedId) {
    super(session.title || session.firstUserMessage || session.id, vscode.TreeItemCollapsibleState.None);
    this.id = session.id;
    this.description = `${session.provider || "(empty)"} · ${formatDisplayTime(session.updatedAt)}`;
    this.tooltip = `${session.id}\n${session.cwd || ""}`.trim();
    this.command = {
      command: "codexSessionManager.selectSession",
      title: "Select Session",
      arguments: [session.id],
    };
    this.contextValue = session.archived ? "archivedSession" : "activeSession";
    this.iconPath = new vscode.ThemeIcon(
      session.id === selectedId ? "circle-filled" : session.providerMismatch ? "warning" : "comment-discussion",
      new vscode.ThemeColor(session.providerMismatch ? "problemsWarningIcon.foreground" : "list.activeSelectionIconForeground"),
    );
  }
}

class SessionsTreeDataProvider {
  constructor(store) {
    this.store = store;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.disposable = store.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  dispose() {
    this.disposable.dispose();
    this._onDidChangeTreeData.dispose();
  }

  getTreeItem(item) {
    return item;
  }

  getChildren() {
    const state = this.store.getState();
    return state.items.map((item) => new SessionTreeItem(item, state.selectedId));
  }
}

class SessionManagerStore {
  constructor(context) {
    this.context = context;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
    this.state = {
      codexHome: "",
      dbPath: "",
      dbExists: false,
      mode: "active",
      search: "",
      mismatchOnly: false,
      items: [],
      listTotal: 0,
      mismatchCount: 0,
      selectedId: "",
      detail: null,
      sessionHealth: null,
      configInfo: null,
      statusText: "就绪",
      statusType: "info",
    };
  }

  dispose() {
    this._onDidChange.dispose();
  }

  getState() {
    return { ...this.state };
  }

  emitChange() {
    this._onDidChange.fire(this.getState());
  }

  setStatus(text, type = "info") {
    this.state.statusText = text;
    this.state.statusType = type;
    this.emitChange();
  }

  updateEnvironment() {
    const env = getEnvironment();
    this.state.codexHome = env.codexHome;
    this.state.dbPath = env.dbPath;
    this.state.dbExists = fs.existsSync(env.dbPath);
    return env;
  }

  async initialize() {
    try {
      this.updateEnvironment();
      await this.loadConfigProviders();
      await this.loadList({ keepSelection: false });
      if (!this.state.dbExists) {
        this.setStatus(`未找到数据库: ${this.state.dbPath}`, "error");
      } else {
        this.setStatus(`就绪 · ${this.state.codexHome}`, "success");
      }
    } catch (error) {
      this.setStatus(`初始化失败: ${error.message}`, "error");
    }
  }

  async refreshAll(options = {}) {
    this.updateEnvironment();
    await this.loadConfigProviders();
    await this.loadList({ keepSelection: options.preserveSelection !== false });
    if (this.state.selectedId) {
      await this.loadDetail(this.state.selectedId, { silent: true });
    }
    this.setStatus("刷新完成", "success");
  }

  async loadConfigProviders() {
    const { codexHome } = this.updateEnvironment();
    this.state.configInfo = await getConfigProviders(codexHome);
    this.emitChange();
  }

  async loadList(options = {}) {
    const { dbPath } = this.updateEnvironment();
    const keepSelection = options.keepSelection !== false;
    const data = await listSessions(dbPath, {
      mode: this.state.mode,
      q: this.state.search,
      mismatchOnly: this.state.mismatchOnly,
      limit: 300,
    });
    this.state.items = Array.isArray(data.items) ? data.items : [];
    this.state.listTotal = Number(data.total || 0);
    this.state.mismatchCount = Number(data.mismatchCount || 0);

    if (keepSelection && this.state.selectedId && this.state.items.some((item) => item.id === this.state.selectedId)) {
      this.emitChange();
      return;
    }

    if (this.state.items.length > 0) {
      this.state.selectedId = this.state.items[0].id;
      this.state.sessionHealth = null;
      this.emitChange();
      await this.loadDetail(this.state.selectedId, { silent: true });
      return;
    }

    this.state.selectedId = "";
    this.state.detail = null;
    this.state.sessionHealth = null;
    this.emitChange();
  }

  async loadDetail(id, options = {}) {
    if (!id) {
      return;
    }
    const { dbPath } = this.updateEnvironment();
    const data = await getSessionDetail(dbPath, { id, maxMessages: 220 });
    if (this.state.selectedId !== id) {
      return;
    }
    this.state.detail = data;
    this.emitChange();
    if (!options.silent) {
      this.setStatus("详情已更新", "success");
    }
  }

  async selectSession(id) {
    if (!id || id === this.state.selectedId) {
      return;
    }
    this.state.selectedId = id;
    this.state.detail = null;
    this.state.sessionHealth = null;
    this.emitChange();
    try {
      await this.loadDetail(id);
    } catch (error) {
      this.setStatus(`加载详情失败: ${error.message}`, "error");
    }
  }

  async setMode(mode) {
    const next = mode === "archive" ? "archive" : "active";
    if (this.state.mode === next) {
      return;
    }
    this.state.mode = next;
    this.state.selectedId = "";
    this.state.detail = null;
    this.state.sessionHealth = null;
    this.emitChange();
    await this.loadList({ keepSelection: false });
  }

  async setSearch(search) {
    this.state.search = String(search || "").trim();
    this.emitChange();
    await this.loadList({ keepSelection: false });
  }

  async toggleMismatchOnly() {
    this.state.mismatchOnly = !this.state.mismatchOnly;
    this.emitChange();
    await this.loadList({ keepSelection: false });
  }

  async updateProvider(id, provider) {
    const { dbPath } = this.updateEnvironment();
    await updateProvider(dbPath, { id, provider });
    await this.loadDetail(id, { silent: true });
    await this.loadList({ keepSelection: true });
    this.setStatus("Provider 已保存并修复可加载性", "success");
  }

  async repairProvider(id) {
    const { dbPath } = this.updateEnvironment();
    const data = await repairSingle(dbPath, { id });
    await this.loadDetail(id, { silent: true });
    await this.loadList({ keepSelection: true });
    this.setStatus(data.changed ? `已修正不一致: ${data.from} -> ${data.to}` : "Provider 已一致，无需修正", "success");
  }

  async batchUpdateProvider(provider) {
    const ids = this.state.items.map((item) => item.id).filter(Boolean);
    if (!provider) {
      throw new Error("Provider 不能为空");
    }
    if (!ids.length) {
      throw new Error("当前筛选结果为空");
    }
    const { dbPath } = this.updateEnvironment();
    const data = await batchUpdateProviders(dbPath, { ids, provider });
    await this.loadList({ keepSelection: true });
    if (this.state.selectedId) {
      await this.loadDetail(this.state.selectedId, { silent: true });
    }
    const hasFailure = Number(data.failed || 0) > 0;
    this.setStatus(`批量完成: updated=${data.updated || 0}, failed=${data.failed || 0}, missing=${data.missing || 0}`, hasFailure ? "error" : "success");
  }

  async archiveOrRestoreSelected() {
    const session = this.state.detail?.session;
    if (!session?.id) {
      throw new Error("请先选择会话");
    }
    const { dbPath } = this.updateEnvironment();
    const previousIndex = this.state.items.findIndex((item) => item.id === session.id);
    if (session.archived) {
      await restoreFromRecycle(dbPath, { id: session.id });
    } else {
      await moveToRecycle(dbPath, { id: session.id });
    }
    const currentId = session.id;
    await this.loadList({ keepSelection: true });
    const stillExists = this.state.items.some((item) => item.id === currentId);
    if (stillExists) {
      this.state.selectedId = currentId;
      await this.loadDetail(currentId, { silent: true });
    } else if (this.state.items.length > 0) {
      const nextId = String(this.state.items[Math.max(0, Math.min(previousIndex, this.state.items.length - 1))]?.id || "");
      this.state.selectedId = nextId;
      await this.loadDetail(nextId, { silent: true });
    } else {
      this.state.selectedId = "";
      this.state.detail = null;
      this.emitChange();
    }
    this.setStatus(session.archived ? "会话已恢复到会话列表" : "会话已归档", "success");
  }

  async checkSessionHealth() {
    const id = this.state.detail?.session?.id;
    if (!id) {
      throw new Error("请先选择会话");
    }
    const { dbPath } = this.updateEnvironment();
    const data = await checkSessionHealth(dbPath, { id, maxIdleSeconds: 600 });
    if (this.state.selectedId !== id) {
      return;
    }
    this.state.sessionHealth = data;
    this.emitChange();
    if (data.status === "healthy") {
      this.setStatus("检测完成：会话状态正常", "success");
    } else if (data.status === "running") {
      this.setStatus("检测完成：会话仍在运行或刚刚活动", "success");
    } else if (data.status === "stuck") {
      this.setStatus(data.canRepair ? "检测完成：发现疑似卡住，可执行修复" : "检测完成：疑似卡住，但缺少可修复 turn_id", "error");
    } else {
      this.setStatus(`检测完成：${data.reason || "状态异常"}`, "error");
    }
  }

  async repairSessionHealth() {
    const id = this.state.detail?.session?.id;
    if (!id) {
      throw new Error("请先选择会话");
    }
    const { dbPath } = this.updateEnvironment();
    const data = await repairSessionHealth(dbPath, { id, maxIdleSeconds: 600, reason: "interrupted" });
    if (this.state.selectedId !== id) {
      return;
    }
    this.state.sessionHealth = { id, ...(data.after || {}) };
    await this.loadDetail(id, { silent: true });
    this.emitChange();
    this.setStatus(data.repaired ? `修复完成，已备份: ${data.backupPath}` : "修复执行完成，但状态仍需人工确认", data.repaired ? "success" : "error");
  }
}

class BaseWebviewProvider {
  constructor(context, store) {
    this.context = context;
    this.store = store;
    this.view = null;
    this.disposable = store.onDidChange(() => this.render());
  }

  dispose() {
    this.disposable.dispose();
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webviewView.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.render();
  }

  render() {}

  async onMessage() {}
}

class ControlsWebviewProvider extends BaseWebviewProvider {
  render() {
    if (!this.view) {
      return;
    }
    const state = this.store.getState();
    this.view.title = `Controls · ${state.mode === "archive" ? "Archive" : "Active"}`;
    this.view.webview.html = renderControlsHtml(this.view.webview, state);
  }

  async onMessage(msg) {
    if (!msg || typeof msg !== "object") {
      return;
    }
    try {
      switch (msg.type) {
        case "refresh":
          await this.store.refreshAll({ preserveSelection: true });
          break;
        case "setMode":
          await this.store.setMode(msg.mode);
          break;
        case "search":
          await this.store.setSearch(msg.value);
          break;
        case "toggleMismatch":
          await this.store.toggleMismatchOnly();
          break;
        case "batchUpdate": {
          const provider = String(msg.provider || "").trim();
          const count = this.store.getState().items.length;
          const ok = await confirmAction({ message: `确认将当前筛选的 ${count} 条会话批量设置为 provider: ${provider} ?`, confirmText: "继续" });
          if (ok.confirmed) {
            await this.store.batchUpdateProvider(provider);
          }
          break;
        }
        default:
          break;
      }
    } catch (error) {
      this.store.setStatus(error.message || String(error), "error");
    }
  }
}

class DetailsWebviewProvider extends BaseWebviewProvider {
  render() {
    if (!this.view) {
      return;
    }
    const state = this.store.getState();
    this.view.title = state.detail?.session?.title ? `Details · ${state.detail.session.title}` : "Details";
    this.view.description = state.selectedId ? shortId(state.selectedId) : "";
    this.view.webview.html = renderDetailsHtml(this.view.webview, state);
  }

  async onMessage(msg) {
    if (!msg || typeof msg !== "object") {
      return;
    }
    const session = this.store.getState().detail?.session;
    try {
      switch (msg.type) {
        case "saveProvider":
          if (!session?.id) {
            throw new Error("请先选择会话");
          }
          await this.store.updateProvider(session.id, String(msg.provider || "").trim());
          break;
        case "repairProvider":
          if (!session?.id) {
            throw new Error("请先选择会话");
          }
          await this.store.repairProvider(session.id);
          break;
        case "checkHealth":
          await this.store.checkSessionHealth();
          break;
        case "repairHealth": {
          const health = this.store.getState().sessionHealth;
          const ok = await confirmAction({
            message: `确认修复该会话的执行状态吗？turn_id=${health?.repairTurnId || "-"}`,
            confirmText: "确认修复",
          });
          if (ok.confirmed) {
            await this.store.repairSessionHealth();
          }
          break;
        }
        case "copyResume":
          if (!session?.id) {
            throw new Error("请先选择会话");
          }
          await copyResumeCommand({ id: session.id });
          this.store.setStatus("Resume 命令已复制", "success");
          break;
        case "copySessionId":
          if (!session?.id) {
            throw new Error("请先选择会话");
          }
          await copySessionId({ id: session.id });
          this.store.setStatus("会话 ID 已复制", "success");
          break;
        case "runResume":
          if (!session?.id) {
            throw new Error("请先选择会话");
          }
          await runResumeCommand({ id: session.id, cwd: session.cwd || "" });
          this.store.setStatus("已在终端执行 Resume", "success");
          break;
        case "toggleArchive":
          if (!session?.id) {
            throw new Error("请先选择会话");
          }
          {
            const ok = await confirmAction({
              message: session.archived ? "确定将此会话恢复到会话列表吗？" : "确定将此会话归档吗？",
              confirmText: session.archived ? "恢复会话" : "归档会话",
            });
            if (ok.confirmed) {
              await this.store.archiveOrRestoreSelected();
            }
          }
          break;
        case "refreshDetail":
          if (!session?.id) {
            throw new Error("请先选择会话");
          }
          await this.store.loadDetail(session.id);
          break;
        default:
          break;
      }
    } catch (error) {
      this.store.setStatus(error.message || String(error), "error");
    }
  }
}

class MessagesWebviewProvider extends BaseWebviewProvider {
  render() {
    if (!this.view) {
      return;
    }
    const state = this.store.getState();
    const count = Number(state.detail?.messageCount || 0);
    this.view.title = count ? `Messages · ${count}` : "Messages";
    this.view.webview.html = renderMessagesHtml(this.view.webview, state);
  }
}

function webviewShell(webview, title, body) {
  const nonce = `${Date.now()}${Math.random().toString(16).slice(2)}`;
  const csp = ["default-src 'none'", `style-src ${webview.cspSource} 'unsafe-inline'`, `script-src 'nonce-${nonce}'`].join("; ");
  return `<!doctype html>
  <html lang="zh-CN">
    <head>
      <meta charset="UTF-8" />
      <meta http-equiv="Content-Security-Policy" content="${csp}" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${escapeHtml(title)}</title>
      <style>
        :root {
          color-scheme: light dark;
          --line: var(--vscode-panel-border, rgba(127,127,127,.3));
          --muted: var(--vscode-descriptionForeground, #9aa0a6);
          --bg-soft: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 92%, #fff 8%);
          --bg-card: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 84%, #fff 16%);
          --ok: #59a177;
          --warn: #c6a35b;
          --danger: #cc6e67;
          --accent: var(--vscode-focusBorder, #3e92ad);
        }
        * { box-sizing: border-box; }
        body { margin: 0; padding: 8px; color: var(--vscode-foreground); background: transparent; font: 12px/1.45 var(--vscode-font-family); }
        .stack { display: grid; gap: 8px; }
        .card { border: 1px solid var(--line); border-radius: 8px; background: var(--bg-soft); padding: 10px; }
        .title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .3px; color: var(--muted); margin-bottom: 8px; }
        .row { display: grid; gap: 6px; margin-bottom: 8px; }
        .row:last-child { margin-bottom: 0; }
        .inline { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
        .grow { flex: 1 1 auto; }
        .muted { color: var(--muted); }
        .status { padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; }
        .status.success { border-color: color-mix(in srgb, var(--ok) 60%, var(--line)); color: #d5f0e1; }
        .status.error { border-color: color-mix(in srgb, var(--danger) 60%, var(--line)); color: #ffd7d4; }
        button, input { width: 100%; border: 1px solid var(--line); border-radius: 6px; background: var(--bg-card); color: inherit; padding: 6px 8px; font: inherit; }
        button { cursor: pointer; }
        button.primary { border-color: color-mix(in srgb, var(--accent) 70%, var(--line)); }
        button.warn { border-color: color-mix(in srgb, var(--warn) 60%, var(--line)); }
        button.danger { border-color: color-mix(in srgb, var(--danger) 60%, var(--line)); }
        button.half { width: calc(50% - 3px); }
        .pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 999px; padding: 3px 8px; }
        .meta { display: grid; gap: 6px; }
        .meta-item { display: grid; gap: 2px; }
        .meta-key { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .3px; }
        .mono { font-family: Consolas, "Courier New", monospace; word-break: break-all; }
        .messages { display: grid; gap: 8px; }
        .message { border: 1px solid var(--line); border-radius: 8px; padding: 8px; background: var(--bg-card); }
        .message-top { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
        .prewrap { white-space: pre-wrap; word-break: break-word; }
      </style>
    </head>
    <body>${body.replace("__NONCE__", nonce)}</body>
  </html>`;
}

function renderControlsHtml(webview, state) {
  const config = state.configInfo;
  let configText = "Config: -";
  if (config?.exists === false) configText = "Config: 未找到";
  else if (config?.parseError) configText = "Config: 解析失败";
  else if (config) configText = `Config: ${config.activeProvider || "-"}${config.providers?.length ? ` (${config.providers.length})` : ""}`;
  const summary = state.mode === "archive"
    ? `归档 ${state.items.length}/${state.listTotal}`
    : state.mismatchOnly
      ? `不一致 ${state.items.length}/${Math.max(state.mismatchCount, state.items.length)}`
      : `会话 ${state.items.length}/${state.listTotal} · 不一致 ${state.mismatchCount}`;
  return webviewShell(
    webview,
    "Controls",
    `<div class="stack">
      <div class="card">
        <div class="title">Mode</div>
        <div class="inline">
          <button class="half ${state.mode === "active" ? "primary" : ""}" data-action="mode" data-mode="active">会话列表</button>
          <button class="half ${state.mode === "archive" ? "primary" : ""}" data-action="mode" data-mode="archive">归档</button>
        </div>
      </div>
      <div class="card">
        <div class="title">Filters</div>
        <div class="row"><input id="searchInput" type="text" value="${escapeHtml(state.search)}" placeholder="搜索会话 / provider..." /></div>
        <div class="row"><button data-action="toggleMismatch" class="${state.mismatchOnly ? "warn" : ""}">${state.mismatchOnly ? "仅看不一致: 开" : "仅看不一致"}</button></div>
        <div class="row"><div class="pill">${escapeHtml(summary)}</div></div>
      </div>
      <div class="card">
        <div class="title">Batch</div>
        <div class="row"><input id="batchProviderInput" type="text" placeholder="批量设置 Provider" /></div>
        <div class="row"><button data-action="batchUpdate">应用到当前筛选</button></div>
      </div>
      <div class="card">
        <div class="title">Status</div>
        <div class="meta">
          <div class="meta-item"><span class="meta-key">Config</span><span>${escapeHtml(configText)}</span></div>
          <div class="meta-item"><span class="meta-key">CodeX Home</span><span class="mono">${escapeHtml(state.codexHome || "-")}</span></div>
          <div class="meta-item"><span class="meta-key">Database</span><span class="mono">${escapeHtml(state.dbPath || "-")}</span></div>
        </div>
      </div>
      <div class="status ${escapeHtml(state.statusType)}">${escapeHtml(state.statusText || "就绪")}</div>
      <div><button data-action="refresh">刷新全部</button></div>
    </div>
    <script nonce="__NONCE__">
      const vscode = acquireVsCodeApi();
      const searchInput = document.getElementById("searchInput");
      const batchInput = document.getElementById("batchProviderInput");
      let timer = null;
      document.body.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-action]");
        if (!button) return;
        const action = button.dataset.action;
        if (action === "mode") vscode.postMessage({ type: "setMode", mode: button.dataset.mode });
        else if (action === "toggleMismatch") vscode.postMessage({ type: "toggleMismatch" });
        else if (action === "refresh") vscode.postMessage({ type: "refresh" });
        else if (action === "batchUpdate") vscode.postMessage({ type: "batchUpdate", provider: batchInput.value });
      });
      searchInput.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => vscode.postMessage({ type: "search", value: searchInput.value }), 220);
      });
      searchInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") vscode.postMessage({ type: "search", value: searchInput.value });
      });
      batchInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") vscode.postMessage({ type: "batchUpdate", provider: batchInput.value });
      });
    </script>`,
  );
}

function getProviderState(session) {
  const dbProvider = String(session.provider || "").trim() || "(empty)";
  const fileProvider = String(session.fileProvider || "").trim() || "(empty)";
  if (session.providerMismatchError) return { text: `文件 Provider 读取失败: ${session.providerMismatchError}`, kind: "error", canRepair: false };
  if (session.providerMismatch) return { text: `不一致: DB=${dbProvider} / FILE=${fileProvider}`, kind: "warning", canRepair: true };
  if (session.fileProvider) return { text: `一致: FILE=${fileProvider}`, kind: "ok", canRepair: false };
  return { text: "未读取到文件 Provider", kind: "warning", canRepair: false };
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

function renderDetailsHtml(webview, state) {
  const detail = state.detail;
  if (!detail?.session || detail.session.id !== state.selectedId) {
    return webviewShell(webview, "Details", `<div class="card muted">请在 Sessions 视图中选择一个会话。</div>`);
  }
  const session = detail.session;
  const providerInfo = getProviderState(session);
  const healthInfo = getSessionHealthView(state.sessionHealth);
  return webviewShell(
    webview,
    "Details",
    `<div class="stack">
      <div class="card">
        <div class="title">Session</div>
        <div style="font-size:16px;font-weight:700;margin-bottom:8px;">${escapeHtml(session.title || session.firstUserMessage || session.id)}</div>
        <div class="meta">
          <div class="meta-item"><span class="meta-key">ID</span><span class="mono">${escapeHtml(session.id)}</span></div>
          <div class="meta-item"><span class="meta-key">Source</span><span>${escapeHtml(session.source || "-")}</span></div>
          <div class="meta-item"><span class="meta-key">更新</span><span>${escapeHtml(formatDisplayTime(session.updatedAt))}</span></div>
          <div class="meta-item"><span class="meta-key">创建</span><span>${escapeHtml(formatDisplayTime(session.createdAt))}</span></div>
          <div class="meta-item"><span class="meta-key">CWD</span><span class="mono">${escapeHtml(session.cwd || "-")}</span></div>
        </div>
      </div>
      <div class="card">
        <div class="title">Provider</div>
        <div class="row"><input id="providerInput" type="text" value="${escapeHtml(session.provider || "")}" placeholder="Provider" /></div>
        <div class="row"><div class="status ${providerInfo.kind === "ok" ? "success" : providerInfo.kind === "error" ? "error" : ""}">${escapeHtml(providerInfo.text)}</div></div>
        <div class="inline">
          <button class="half primary" data-action="saveProvider">保存</button>
          <button class="half warn" data-action="repairProvider" ${providerInfo.canRepair ? "" : "disabled"}>修正不一致</button>
        </div>
      </div>
      <div class="card">
        <div class="title">Execution</div>
        <div class="row"><div class="status ${healthInfo.kind === "ok" ? "success" : healthInfo.kind === "error" ? "error" : ""}">${escapeHtml(healthInfo.text)}</div></div>
        <div class="inline">
          <button class="half" data-action="checkHealth">检测状态</button>
          <button class="half warn" data-action="repairHealth" ${healthInfo.canRepair ? "" : "disabled"}>修复会话</button>
        </div>
      </div>
      <div class="card">
        <div class="title">Actions</div>
        <div class="inline">
          <button class="half" data-action="copyResume">复制 Resume</button>
          <button class="half" data-action="copySessionId">复制会话 ID</button>
          <button class="half primary" data-action="runResume">在终端 Resume</button>
          <button class="half ${session.archived ? "" : "danger"}" data-action="toggleArchive">${session.archived ? "恢复会话" : "归档会话"}</button>
        </div>
        <div class="row" style="margin-top:8px;"><button data-action="refreshDetail">刷新详情</button></div>
      </div>
    </div>
    <script nonce="__NONCE__">
      const vscode = acquireVsCodeApi();
      const providerInput = document.getElementById("providerInput");
      document.body.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-action]");
        if (!button || button.disabled) return;
        const type = button.dataset.action;
        if (type === "saveProvider") vscode.postMessage({ type, provider: providerInput.value });
        else vscode.postMessage({ type });
      });
      providerInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") vscode.postMessage({ type: "saveProvider", provider: providerInput.value });
      });
    </script>`,
  );
}

function renderMessagesHtml(webview, state) {
  const detail = state.detail;
  if (!detail?.session || detail.session.id !== state.selectedId) {
    return webviewShell(webview, "Messages", `<div class="card muted">未选择会话。</div>`);
  }
  const stats = `消息 ${Number(detail.messageCount || 0)} · 用户 ${Number(detail.userTurns || 0)}${detail.fileError ? ` · 文件异常: ${detail.fileError}` : ""}`;
  const messages = Array.isArray(detail.messages) ? detail.messages : [];
  const body = messages.length
    ? messages.map((msg) => `<div class="message"><div class="message-top"><strong>${escapeHtml(String(msg.role || "assistant").toUpperCase())}</strong><span class="muted">${escapeHtml(formatDisplayTime(msg.timestamp))}</span></div><div class="prewrap">${escapeHtml(msg.text || "")}</div></div>`).join("")
    : `<div class="card muted">暂无可预览消息</div>`;
  return webviewShell(webview, "Messages", `<div class="stack"><div class="card"><div class="title">Summary</div><div>${escapeHtml(stats)}</div></div><div class="messages">${body}</div></div>`);
}

async function handleOperation(op, payload) {
  const cfg = getConfig();
  const codexHome = resolveCodexHome(cfg.codexHome);
  const dbPath = path.join(codexHome, "state_5.sqlite");

  switch (op) {
    case "health":
      return {
        codexHome,
        dbPath,
        exists: fs.existsSync(dbPath),
      };
    case "listSessions":
      return listSessions(dbPath, payload || {});
    case "getSessionDetail":
      return getSessionDetail(dbPath, payload || {});
    case "checkSessionHealth":
      return checkSessionHealth(dbPath, payload || {});
    case "repairSessionHealth":
      return repairSessionHealth(dbPath, payload || {});
    case "updateProvider":
      return updateProvider(dbPath, payload || {});
    case "batchUpdate":
      return batchUpdateProviders(dbPath, payload || {});
    case "moveToRecycle":
      return moveToRecycle(dbPath, payload || {});
    case "restoreFromRecycle":
      return restoreFromRecycle(dbPath, payload || {});
    case "repairSingle":
      return repairSingle(dbPath, payload || {});
    case "getConfigProviders":
      return getConfigProviders(codexHome);
    case "confirmAction":
      return confirmAction(payload || {});
    case "copySessionId":
      return copySessionId(payload || {});
    case "copyResume":
      return copyResumeCommand(payload || {});
    case "runResume":
      return runResumeCommand(payload || {});
    default:
      throw new Error(`Unknown operation: ${op}`);
  }
}

function openDb(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`state sqlite not found: ${dbPath}`);
  }

  const sqlite = getSqliteModule();
  if (!sqlite || !sqlite.DatabaseSync) {
    throw new Error(
      "Current VS Code runtime does not expose node:sqlite. Please update VS Code to a newer version.",
    );
  }

  return new sqlite.DatabaseSync(dbPath, { readOnly: false });
}

function closeDb(db) {
  db.close();
}

function dbAll(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

function dbGet(db, sql, params = []) {
  return db.prepare(sql).get(...params) || null;
}

function dbRun(db, sql, params = []) {
  const info = db.prepare(sql).run(...params);
  return { changes: info?.changes || 0, lastID: info?.lastInsertRowid || null };
}

function toIso(epochSec) {
  if (!Number.isFinite(epochSec)) {
    return null;
  }
  return new Date(epochSec * 1000).toISOString();
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function pathKey(filePath) {
  return path.resolve(String(filePath || "")).replace(/\\/g, "/").toLowerCase();
}

function isSamePath(a, b) {
  if (!a || !b) {
    return false;
  }
  return pathKey(a) === pathKey(b);
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function ensureUniqueFilePath(filePath) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const name = path.basename(filePath, ext);

  let next = filePath;
  let seq = 1;
  while (fs.existsSync(next)) {
    next = path.join(dir, `${name}-${seq}${ext}`);
    seq += 1;
  }
  return next;
}

function moveFileSafe(fromPath, toPath) {
  let nextPath = toPath;
  if (fs.existsSync(nextPath) && !isSamePath(fromPath, nextPath)) {
    nextPath = ensureUniqueFilePath(nextPath);
  }

  ensureParentDir(nextPath);

  try {
    fs.renameSync(fromPath, nextPath);
  } catch (error) {
    if (error && error.code === "EXDEV") {
      fs.copyFileSync(fromPath, nextPath);
      fs.unlinkSync(fromPath);
    } else {
      throw error;
    }
  }

  return nextPath;
}

function pickRolloutBaseName(rolloutPath, id) {
  const raw = String(rolloutPath || "").trim();
  const base = path.basename(raw);
  if (base && base !== "." && base !== "..") {
    return base;
  }

  const safeId = String(id || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `rollout-restored-${safeId}.jsonl`;
}

function buildArchiveRolloutPath(codexHome, rolloutPath, id) {
  const base = pickRolloutBaseName(rolloutPath, id);
  return path.join(codexHome, "archived_sessions", base);
}

function buildSessionRolloutPath(codexHome, rolloutPath, id) {
  const base = pickRolloutBaseName(rolloutPath, id);
  const match = base.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T/i);

  if (match) {
    return path.join(codexHome, "sessions", match[1], match[2], match[3], base);
  }

  return path.join(codexHome, "sessions", "restored", base);
}

function getResumeCommand(id) {
  return `codex resume ${id}`;
}

function normalizeCwd(cwd) {
  const raw = String(cwd || "").trim();
  if (!raw) {
    return null;
  }
  if (raw.startsWith("\\\\?\\")) {
    return raw.slice(4);
  }
  return raw;
}

function stripInlineTomlComment(line) {
  let result = "";
  let quote = null;
  let escaped = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (quote === '"' && ch === "\\") {
      result += ch;
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      }
      result += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      result += ch;
      continue;
    }

    if (ch === "#") {
      break;
    }

    result += ch;
  }

  return result.trim();
}

function parseTomlValue(raw) {
  const source = stripInlineTomlComment(String(raw || "").trim());
  if (!source) {
    return "";
  }

  if (source.startsWith('"')) {
    for (let i = 1; i < source.length; i += 1) {
      if (source[i] === '"' && source[i - 1] !== "\\") {
        const quoted = source.slice(0, i + 1);
        try {
          return JSON.parse(quoted);
        } catch {
          return quoted.slice(1, -1);
        }
      }
    }
    return source.slice(1);
  }

  if (source.startsWith("'")) {
    const end = source.indexOf("'", 1);
    if (end > 0) {
      return source.slice(1, end);
    }
    return source.slice(1);
  }

  return source.split(/\s+/)[0] || "";
}

function parseConfigProvidersText(text) {
  const lines = String(text || "").split(/\r?\n/);
  const providers = new Set();
  const profileProviders = new Map();
  let currentSection = "";
  let rootModelProvider = "";
  let defaultProfile = "";

  for (const raw of lines) {
    const line = raw.replace(/^\uFEFF/, "").trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      currentSection = sec[1].trim();
      const mp = currentSection.match(/^model_providers\.(.+)$/);
      if (mp) {
        const sectionProvider = mp[1].trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");
        if (sectionProvider) {
          providers.add(sectionProvider);
        }
      }
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) {
      continue;
    }

    const key = kv[1];
    const value = parseTomlValue(kv[2]);

    if (key === "default_profile" && !currentSection) {
      defaultProfile = value;
      continue;
    }

    if (key === "model_provider") {
      if (!currentSection) {
        rootModelProvider = value;
      } else if (currentSection.startsWith("profiles.")) {
        profileProviders.set(currentSection.slice("profiles.".length), value);
      }
      if (value) {
        providers.add(value);
      }
      continue;
    }

    if (key === "provider") {
      if (currentSection.startsWith("profiles.")) {
        profileProviders.set(currentSection.slice("profiles.".length), value);
      }
      if (value) {
        providers.add(value);
      }
    }
  }

  const activeProvider =
    rootModelProvider ||
    (defaultProfile ? profileProviders.get(defaultProfile) : "") ||
    profileProviders.get("default") ||
    [...providers][0] ||
    "";

  return {
    activeProvider,
    providers: [...providers].sort((a, b) => a.localeCompare(b)),
  };
}

async function getConfigProviders(codexHome) {
  const configPath = path.join(codexHome, "config.toml");
  if (!fs.existsSync(configPath)) {
    return {
      configPath,
      exists: false,
      activeProvider: "",
      providers: [],
    };
  }

  try {
    const content = await fsp.readFile(configPath, "utf8");
    const parsed = parseConfigProvidersText(content);
    return {
      configPath,
      exists: true,
      activeProvider: parsed.activeProvider,
      providers: parsed.providers,
    };
  } catch (error) {
    return {
      configPath,
      exists: true,
      activeProvider: "",
      providers: [],
      parseError: error?.message || String(error),
    };
  }
}

function readFileProvider(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      fileProvider: "",
      fileProviderError: "Session file not found",
    };
  }

  try {
    const info = parseSessionMetaFromFile(filePath);
    const fileProvider = String(info?.payload?.model_provider || "").trim();
    return {
      fileProvider,
      fileProviderError: "",
    };
  } catch (error) {
    return {
      fileProvider: "",
      fileProviderError: error?.message || String(error),
    };
  }
}
function buildWhere(mode, q) {
  const clauses = [];
  const params = [];

  if (mode === "archive" || mode === "recycle") {
    clauses.push("COALESCE(archived, 0) = 1");
  } else {
    clauses.push("COALESCE(archived, 0) = 0");
  }

  if (q) {
    clauses.push("(id LIKE ? OR title LIKE ? OR cwd LIKE ? OR first_user_message LIKE ? OR model_provider LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  return {
    sql: clauses.join(" AND "),
    params,
  };
}

async function listSessions(dbPath, query) {
  const db = openDb(dbPath);
  try {
    const modeRaw = String(query.mode || "active").trim().toLowerCase();
    const mode = modeRaw === "archive" || modeRaw === "recycle" ? "archive" : "active";
    const q = String(query.q || "").trim();
    const limit = Math.max(10, Math.min(500, Number(query.limit || 200)));
    const mismatchOnlyRaw = String(query.mismatchOnly || "").trim().toLowerCase();
    const mismatchOnly = query.mismatchOnly === true || mismatchOnlyRaw === "1" || mismatchOnlyRaw === "true";
    const where = buildWhere(mode, q);

    const countRow = dbGet(db, `SELECT COUNT(*) AS total FROM threads WHERE ${where.sql}`, where.params);
    const total = Number(countRow?.total || 0);

    const mapRow = (row) => {
      const providerInfo = readFileProvider(row.rollout_path);
      const dbProvider = String(row.model_provider || "").trim();
      const fileProvider = String(providerInfo.fileProvider || "").trim();
      const providerMismatch = !providerInfo.fileProviderError && !!fileProvider && dbProvider !== fileProvider;

      return {
        id: row.id,
        title: row.title || row.first_user_message || row.id,
        firstUserMessage: row.first_user_message || "",
        source: row.source || "",
        provider: row.model_provider || "",
        fileProvider,
        providerMismatch,
        providerMismatchError: providerInfo.fileProviderError || "",
        cwd: row.cwd || "",
        rolloutPath: row.rollout_path || "",
        updatedAt: toIso(row.updated_at),
        createdAt: toIso(row.created_at),
        archived: Number(row.archived || 0) === 1,
        archivedAt: row.archived_at ? toIso(row.archived_at) : null,
        cliVersion: row.cli_version || "",
      };
    };

    if (!mismatchOnly) {
      const rows = dbAll(
        db,
        `SELECT id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
                first_user_message, cli_version, archived, archived_at
         FROM threads
         WHERE ${where.sql}
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
        [...where.params, limit],
      );

      const mapped = rows.map(mapRow);
      const mismatchCount = mapped.filter((item) => item.providerMismatch).length;

      return {
        mode,
        mismatchOnly,
        total,
        mismatchCount,
        items: mapped,
      };
    }

    const pageSize = Math.max(120, limit);
    let offset = 0;
    let mismatchCount = 0;
    const items = [];

    while (offset < total) {
      const rows = dbAll(
        db,
        `SELECT id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
                first_user_message, cli_version, archived, archived_at
         FROM threads
         WHERE ${where.sql}
         ORDER BY updated_at DESC, id DESC
         LIMIT ? OFFSET ?`,
        [...where.params, pageSize, offset],
      );

      if (!rows.length) {
        break;
      }

      for (const row of rows) {
        const mapped = mapRow(row);
        if (!mapped.providerMismatch) {
          continue;
        }

        mismatchCount += 1;
        if (items.length < limit) {
          items.push(mapped);
        }
      }

      offset += rows.length;
      if (rows.length < pageSize) {
        break;
      }
    }

    return {
      mode,
      mismatchOnly,
      total,
      mismatchCount,
      items,
    };
  } finally {
    closeDb(db);
  }
}

function firstLineInfo(filePath) {
  const fd = fs.openSync(filePath, "r");
  const chunkSize = 64 * 1024;
  const chunks = [];
  let offset = 0;
  let hadNewline = false;
  let newline = "\n";

  try {
    while (true) {
      const buf = Buffer.allocUnsafe(chunkSize);
      const bytesRead = fs.readSync(fd, buf, 0, chunkSize, offset);
      if (bytesRead === 0) {
        break;
      }
      const data = buf.subarray(0, bytesRead);
      const nl = data.indexOf(0x0a);
      if (nl !== -1) {
        hadNewline = true;
        let linePart = data.subarray(0, nl);
        if (linePart.length && linePart[linePart.length - 1] === 0x0d) {
          linePart = linePart.subarray(0, linePart.length - 1);
          newline = "\r\n";
        }
        chunks.push(linePart);
        return {
          line: Buffer.concat(chunks).toString("utf8"),
          afterOffset: offset + nl + 1,
          hadNewline,
          newline,
        };
      }
      chunks.push(data);
      offset += bytesRead;
    }
    return {
      line: Buffer.concat(chunks).toString("utf8"),
      afterOffset: offset,
      hadNewline,
      newline,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function parseSessionMetaFromFile(filePath) {
  const info = firstLineInfo(filePath);
  const obj = JSON.parse(info.line);
  if (obj?.type !== "session_meta" || !obj?.payload?.id) {
    throw new Error("First line is not valid session_meta");
  }
  return { ...info, payload: obj.payload, rootObj: obj };
}

async function writeProviderToSessionFile(filePath, provider, expectedId) {
  const info = parseSessionMetaFromFile(filePath);
  if (expectedId && info.payload.id !== expectedId) {
    throw new Error(`Session id mismatch: file has ${info.payload.id}, expected ${expectedId}`);
  }
  info.rootObj.payload.model_provider = provider;

  const tmpPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const writeStream = fs.createWriteStream(tmpPath, { encoding: "utf8" });
  const readStream = fs.createReadStream(filePath, { start: info.afterOffset });
  const firstLine = `${JSON.stringify(info.rootObj)}${info.hadNewline ? info.newline : ""}`;

  await new Promise((resolve, reject) => {
    writeStream.write(firstLine, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });

  await pipeline(readStream, writeStream);
  await fsp.rename(tmpPath, filePath);
}

function extractTextFromContent(content) {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (!item) {
        continue;
      }
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      if (typeof item.text === "string") {
        parts.push(item.text);
        continue;
      }
      if (typeof item.output_text === "string") {
        parts.push(item.output_text);
        continue;
      }
      if (typeof item.input_text === "string") {
        parts.push(item.input_text);
        continue;
      }
      if (typeof item.refusal === "string") {
        parts.push(item.refusal);
      }
    }
    return parts.join("\n").trim();
  }

  if (typeof content === "object" && typeof content.text === "string") {
    return content.text.trim();
  }

  return "";
}

function parseMessageEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }

  if (event.type === "event_msg" && event.payload?.type === "user_message") {
    const text = String(event.payload.message || "").trim();
    if (!text) {
      return null;
    }
    return {
      role: "user",
      text,
      timestamp: event.timestamp || null,
    };
  }

  if (event.type === "response_item" && event.payload?.type === "message") {
    const role = String(event.payload.role || "assistant").trim() || "assistant";
    const text = extractTextFromContent(event.payload.content);
    if (!text) {
      return null;
    }
    return {
      role,
      text,
      timestamp: event.timestamp || null,
    };
  }

  return null;
}

async function readSessionMessages(filePath, maxMessages) {
  if (!fs.existsSync(filePath)) {
    return { messages: [], fileError: "Session file not found" };
  }

  const messages = [];
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const raw = line.trim();
      if (!raw) {
        continue;
      }
      let obj;
      try {
        obj = JSON.parse(raw);
      } catch {
        continue;
      }
      const message = parseMessageEvent(obj);
      if (!message) {
        continue;
      }
      messages.push(message);
      if (messages.length > maxMessages) {
        messages.shift();
      }
    }
    return { messages, fileError: null };
  } finally {
    rl.close();
    stream.destroy();
  }
}

function parseTimestampMs(value) {
  if (!value) {
    return 0;
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

function extractTurnId(event) {
  const payload = event?.payload || {};
  const candidates = [
    payload.turn_id,
    payload.turnId,
    payload?.turn?.id,
    payload?.context?.turn_id,
  ];

  for (const candidate of candidates) {
    const id = String(candidate || "").trim();
    if (id) {
      return id;
    }
  }
  return "";
}

const TASK_CLOSE_EVENTS = new Set([
  "task_complete",
  "task_aborted",
  "turn_aborted",
  "turn_complete",
  "turn_completed",
  "task_failed",
]);

async function analyzeSessionExecutionHealth(filePath, options = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      filePath,
      exists: false,
      status: "error",
      reason: "session_file_not_found",
      canRepair: false,
      openTaskCount: 0,
      openKnownTaskCount: 0,
      openUnknownTaskCount: 0,
      repairTurnId: "",
      lastEventType: "",
      lastEventAt: null,
      lastWriteAt: null,
      idleSeconds: null,
      thresholdSeconds: Math.max(30, Number(options.maxIdleSeconds || 600)),
      parsedLines: 0,
      parseErrors: 0,
    };
  }

  const thresholdSeconds = Math.max(30, Number(options.maxIdleSeconds || 600));
  const openTasks = new Map();

  let openUnknownTaskCount = 0;
  let parseErrors = 0;
  let parsedLines = 0;
  let lastEventType = "";
  let lastEventAtMs = 0;

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      parsedLines += 1;
      const raw = line.trim();
      if (!raw) {
        continue;
      }

      let obj;
      try {
        obj = JSON.parse(raw);
      } catch {
        parseErrors += 1;
        continue;
      }

      const timestampMs = parseTimestampMs(obj.timestamp);
      if (timestampMs > lastEventAtMs) {
        lastEventAtMs = timestampMs;
      }

      if (obj?.type !== "event_msg" || !obj?.payload?.type) {
        continue;
      }

      const eventType = String(obj.payload.type || "").trim();
      if (!eventType) {
        continue;
      }

      lastEventType = eventType;
      const turnId = extractTurnId(obj);

      if (eventType === "task_started") {
        if (!turnId) {
          openUnknownTaskCount += 1;
          continue;
        }

        let entry = openTasks.get(turnId);
        if (!entry) {
          entry = {
            turnId,
            openCount: 0,
            firstStartedAtMs: 0,
            lastStartedAtMs: 0,
          };
          openTasks.set(turnId, entry);
        }

        entry.openCount += 1;
        if (!entry.firstStartedAtMs && timestampMs > 0) {
          entry.firstStartedAtMs = timestampMs;
        }
        if (timestampMs > entry.lastStartedAtMs) {
          entry.lastStartedAtMs = timestampMs;
        }
        continue;
      }

      if (TASK_CLOSE_EVENTS.has(eventType)) {
        if (!turnId) {
          if (openUnknownTaskCount > 0) {
            openUnknownTaskCount -= 1;
          }
          continue;
        }

        const entry = openTasks.get(turnId);
        if (!entry || entry.openCount <= 0) {
          continue;
        }

        entry.openCount -= 1;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const stat = fs.statSync(filePath);
  const lastWriteMs = Number(stat.mtimeMs || 0);
  const activityMs = Math.max(lastEventAtMs, lastWriteMs);
  const idleSeconds = activityMs > 0 ? Math.max(0, Math.floor((Date.now() - activityMs) / 1000)) : null;

  const openEntries = [...openTasks.values()]
    .filter((item) => item.openCount > 0)
    .sort((a, b) => (a.lastStartedAtMs || 0) - (b.lastStartedAtMs || 0));

  const openKnownTaskCount = openEntries.reduce((sum, item) => sum + Number(item.openCount || 0), 0);
  const openTaskCount = openKnownTaskCount + openUnknownTaskCount;
  const repairTurnId = openEntries.length ? String(openEntries[openEntries.length - 1].turnId || "") : "";

  let status = "healthy";
  let reason = "closed";
  if (openTaskCount > 0) {
    if (idleSeconds !== null && idleSeconds >= thresholdSeconds) {
      status = "stuck";
      reason = "open_without_terminal_event_and_idle_timeout";
    } else {
      status = "running";
      reason = "open_task_started_with_recent_activity";
    }
  }

  const canRepair = status === "stuck" && !!repairTurnId;

  return {
    filePath,
    exists: true,
    status,
    reason,
    canRepair,
    openTaskCount,
    openKnownTaskCount,
    openUnknownTaskCount,
    repairTurnId,
    lastEventType,
    lastEventAt: lastEventAtMs ? new Date(lastEventAtMs).toISOString() : null,
    lastWriteAt: lastWriteMs ? new Date(lastWriteMs).toISOString() : null,
    idleSeconds,
    thresholdSeconds,
    parsedLines,
    parseErrors,
  };
}

function buildBackupPath(filePath) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${filePath}.bak-${stamp}`;
}

function fileEndsWithNewline(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.size) {
    return true;
  }

  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(1);
    fs.readSync(fd, buf, 0, 1, Math.max(0, stat.size - 1));
    return buf[0] === 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

async function appendAbortEvents(filePath, turnId, reason) {
  const timestamp = new Date().toISOString();
  const events = [
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "task_aborted",
        turn_id: turnId,
        reason,
        source: "session_manager_fix",
      },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "turn_aborted",
        turn_id: turnId,
        reason,
        source: "session_manager_fix",
      },
    },
  ];

  const prefix = fileEndsWithNewline(filePath) ? "" : "\n";
  const body = events.map((item) => JSON.stringify(item)).join("\n") + "\n";
  await fsp.appendFile(filePath, prefix + body, "utf8");
  return events.length;
}

async function checkSessionHealth(dbPath, payload) {
  const id = String(payload.id || "").trim();
  if (!id) {
    throw new Error("id is required");
  }

  const maxIdleSeconds = Math.max(30, Number(payload.maxIdleSeconds || 600));
  const db = openDb(dbPath);

  try {
    const row = dbGet(
      db,
      `SELECT id, rollout_path
       FROM threads
       WHERE id = ?`,
      [id],
    );

    if (!row) {
      throw new Error("Session not found");
    }

    const health = await analyzeSessionExecutionHealth(row.rollout_path, { maxIdleSeconds });
    return {
      id,
      maxIdleSeconds,
      ...health,
    };
  } finally {
    closeDb(db);
  }
}

async function repairSessionHealth(dbPath, payload) {
  const id = String(payload.id || "").trim();
  if (!id) {
    throw new Error("id is required");
  }

  let reason = String(payload.reason || "interrupted").trim() || "interrupted";
  if (reason === "manual_force_stop") {
    reason = "interrupted";
  }
  const maxIdleSeconds = Math.max(30, Number(payload.maxIdleSeconds || 600));
  const db = openDb(dbPath);

  try {
    const row = dbGet(
      db,
      `SELECT id, rollout_path
       FROM threads
       WHERE id = ?`,
      [id],
    );

    if (!row) {
      throw new Error("Session not found");
    }

    const before = await analyzeSessionExecutionHealth(row.rollout_path, { maxIdleSeconds });
    if (!before.canRepair || !before.repairTurnId) {
      throw new Error(`Session is not repairable (status=${before.status}, reason=${before.reason})`);
    }

    const backupPath = buildBackupPath(row.rollout_path);
    await fsp.copyFile(row.rollout_path, backupPath);

    const appended = await appendAbortEvents(row.rollout_path, before.repairTurnId, reason);

    dbRun(
      db,
      `UPDATE threads
       SET updated_at = ?
       WHERE id = ?`,
      [nowSec(), id],
    );

    const after = await analyzeSessionExecutionHealth(row.rollout_path, { maxIdleSeconds });

    return {
      id,
      repaired: before.canRepair && after.status !== "stuck",
      reason,
      turnId: before.repairTurnId,
      backupPath,
      appended,
      before,
      after,
    };
  } finally {
    closeDb(db);
  }
}
async function getSessionDetail(dbPath, payload) {
  const id = String(payload.id || "").trim();
  if (!id) {
    throw new Error("id is required");
  }

  const maxMessages = Math.max(20, Math.min(500, Number(payload.maxMessages || 220)));
  const db = openDb(dbPath);

  try {
    const row = dbGet(
      db,
      `SELECT id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
              first_user_message, cli_version, archived, archived_at, sandbox_policy,
              approval_mode, tokens_used
       FROM threads
       WHERE id = ?`,
      [id],
    );

    if (!row) {
      throw new Error("Session not found");
    }

    const messageData = await readSessionMessages(row.rollout_path, maxMessages);
    const providerInfo = readFileProvider(row.rollout_path);
    const dbProvider = String(row.model_provider || "").trim();
    const fileProvider = String(providerInfo.fileProvider || "").trim();
    const providerMismatch = !!fileProvider && dbProvider !== fileProvider;
    const userTurns = messageData.messages.filter((msg) => msg.role === "user").length;

    return {
      session: {
        id: row.id,
        title: row.title || row.first_user_message || row.id,
        firstUserMessage: row.first_user_message || "",
        source: row.source || "",
        provider: row.model_provider || "",
        fileProvider,
        providerMismatch,
        providerMismatchError: providerInfo.fileProviderError || "",
        cwd: row.cwd || "",
        rolloutPath: row.rollout_path || "",
        updatedAt: toIso(row.updated_at),
        createdAt: toIso(row.created_at),
        archived: Number(row.archived || 0) === 1,
        archivedAt: row.archived_at ? toIso(row.archived_at) : null,
        cliVersion: row.cli_version || "",
        sandboxPolicy: row.sandbox_policy || "",
        approvalMode: row.approval_mode || "",
        tokensUsed: Number(row.tokens_used || 0),
      },
      resumeCommand: getResumeCommand(row.id),
      userTurns,
      messageCount: messageData.messages.length,
      fileError: messageData.fileError,
      messages: messageData.messages,
    };
  } finally {
    closeDb(db);
  }
}

async function updateProvider(dbPath, payload) {
  const id = String(payload.id || "").trim();
  const provider = String(payload.provider || "").trim();
  if (!id) {
    throw new Error("id is required");
  }
  if (!provider) {
    throw new Error("provider cannot be empty");
  }

  const db = openDb(dbPath);
  try {
    const row = dbGet(
      db,
      `SELECT id, rollout_path
       FROM threads
       WHERE id = ?`,
      [id],
    );
    if (!row) {
      throw new Error("Session not found in threads index");
    }
    if (!fs.existsSync(row.rollout_path)) {
      throw new Error(`Session file does not exist: ${row.rollout_path}`);
    }

    await writeProviderToSessionFile(row.rollout_path, provider, id);

    dbRun(
      db,
      `UPDATE threads
       SET model_provider = ?, updated_at = ?
       WHERE id = ?`,
      [provider, nowSec(), id],
    );

    return { id, provider, fixed: true };
  } finally {
    closeDb(db);
  }
}


async function batchUpdateProviders(dbPath, payload) {
  const provider = String(payload.provider || "").trim();
  const ids = Array.isArray(payload.ids) ? payload.ids.map((id) => String(id || "").trim()).filter(Boolean) : [];

  if (!provider) {
    throw new Error("provider cannot be empty");
  }
  if (!ids.length) {
    throw new Error("ids is required");
  }

  const db = openDb(dbPath);
  try {
    const uniqIds = [...new Set(ids)];
    const failures = [];
    let updated = 0;
    let failed = 0;
    let missing = 0;
    const ts = nowSec();

    for (const id of uniqIds) {
      const row = dbGet(
        db,
        `SELECT id, rollout_path
         FROM threads
         WHERE id = ?`,
        [id],
      );

      if (!row) {
        missing += 1;
        continue;
      }

      try {
        if (!fs.existsSync(row.rollout_path)) {
          throw new Error(`Session file does not exist: ${row.rollout_path}`);
        }

        await writeProviderToSessionFile(row.rollout_path, provider, id);
        dbRun(
          db,
          `UPDATE threads
           SET model_provider = ?, updated_at = ?
           WHERE id = ?`,
          [provider, ts, id],
        );
        updated += 1;
      } catch (error) {
        failed += 1;
        failures.push({ id, error: error?.message || String(error) });
      }
    }

    return {
      requested: uniqIds.length,
      updated,
      failed,
      missing,
      provider,
      failures: failures.slice(0, 50),
    };
  } finally {
    closeDb(db);
  }
}
async function repairSingle(dbPath, payload) {
  const id = String(payload.id || "").trim();
  if (!id) {
    throw new Error("id is required");
  }

  const db = openDb(dbPath);
  try {
    const row = dbGet(
      db,
      `SELECT id, rollout_path, model_provider
       FROM threads
       WHERE id = ?`,
      [id],
    );

    if (!row) {
      throw new Error("Session not found");
    }

    const providerInfo = readFileProvider(row.rollout_path);
    if (providerInfo.fileProviderError) {
      throw new Error(providerInfo.fileProviderError);
    }

    const from = String(row.model_provider || "").trim();
    const to = String(providerInfo.fileProvider || "").trim();
    if (!to) {
      throw new Error("Session file provider is empty");
    }

    if (from === to) {
      return { id, changed: false, from, to };
    }

    dbRun(
      db,
      `UPDATE threads
       SET model_provider = ?, updated_at = ?
       WHERE id = ?`,
      [to, nowSec(), id],
    );

    return { id, changed: true, from, to };
  } finally {
    closeDb(db);
  }
}
async function moveToRecycle(dbPath, payload) {
  const id = String(payload.id || "").trim();
  if (!id) {
    throw new Error("id is required");
  }

  const db = openDb(dbPath);
  const codexHome = path.dirname(dbPath);

  try {
    const row = dbGet(
      db,
      `SELECT id, archived, archived_at, rollout_path
       FROM threads
       WHERE id = ?`,
      [id],
    );

    if (!row) {
      throw new Error("Session not found");
    }

    const currentPath = String(row.rollout_path || "").trim();
    if (!currentPath) {
      throw new Error("Session rollout_path is empty");
    }

    let finalPath = buildArchiveRolloutPath(codexHome, currentPath, id);
    let fileMoved = false;

    if (fs.existsSync(currentPath)) {
      if (isSamePath(currentPath, finalPath)) {
        finalPath = currentPath;
      } else {
        finalPath = moveFileSafe(currentPath, finalPath);
        fileMoved = true;
      }
    } else if (fs.existsSync(finalPath)) {
      // file already moved by other tools/processes
    } else {
      throw new Error(`Session file does not exist: ${currentPath}`);
    }

    const wasArchived = Number(row.archived || 0) === 1;
    const now = nowSec();

    dbRun(
      db,
      `UPDATE threads
       SET archived = 1,
           archived_at = COALESCE(archived_at, ?),
           updated_at = ?,
           rollout_path = ?
       WHERE id = ?`,
      [now, now, finalPath, id],
    );

    const changed = !wasArchived || !isSamePath(currentPath, finalPath) || fileMoved;
    return {
      id,
      moved: changed,
      alreadyInRecycle: !changed,
      rolloutPath: finalPath,
    };
  } finally {
    closeDb(db);
  }
}

async function restoreFromRecycle(dbPath, payload) {
  const id = String(payload.id || "").trim();
  if (!id) {
    throw new Error("id is required");
  }

  const db = openDb(dbPath);
  const codexHome = path.dirname(dbPath);

  try {
    const row = dbGet(
      db,
      `SELECT id, archived, rollout_path
       FROM threads
       WHERE id = ?`,
      [id],
    );

    if (!row) {
      throw new Error("Session not found");
    }

    const currentPath = String(row.rollout_path || "").trim();
    if (!currentPath) {
      throw new Error("Session rollout_path is empty");
    }

    let finalPath = buildSessionRolloutPath(codexHome, currentPath, id);
    let fileMoved = false;

    if (fs.existsSync(currentPath)) {
      if (isSamePath(currentPath, finalPath)) {
        finalPath = currentPath;
      } else {
        finalPath = moveFileSafe(currentPath, finalPath);
        fileMoved = true;
      }
    } else if (fs.existsSync(finalPath)) {
      // file already moved by other tools/processes
    } else {
      throw new Error(`Session file does not exist: ${currentPath}`);
    }

    const wasArchived = Number(row.archived || 0) === 1;

    dbRun(
      db,
      `UPDATE threads
       SET archived = 0,
           archived_at = NULL,
           updated_at = ?,
           rollout_path = ?
       WHERE id = ?`,
      [nowSec(), finalPath, id],
    );

    const changed = wasArchived || !isSamePath(currentPath, finalPath) || fileMoved;
    return {
      id,
      restored: changed,
      alreadyActive: !changed,
      rolloutPath: finalPath,
    };
  } finally {
    closeDb(db);
  }
}

async function confirmAction(payload) {
  const message = String(payload.message || "请确认操作").trim() || "请确认操作";
  const confirmText = String(payload.confirmText || "确定").trim() || "确定";
  const pick = await vscode.window.showWarningMessage(message, { modal: true }, confirmText);
  return { confirmed: pick === confirmText };
}
async function copySessionId(payload) {
  const id = String(payload.id || "").trim();
  if (!id) {
    throw new Error("id is required");
  }

  await vscode.env.clipboard.writeText(id);
  return { id, copied: true };
}
async function copyResumeCommand(payload) {
  const id = String(payload.id || "").trim();
  if (!id) {
    throw new Error("id is required");
  }

  const command = getResumeCommand(id);
  await vscode.env.clipboard.writeText(command);
  return { id, command, copied: true };
}

async function runResumeCommand(payload) {
  const id = String(payload.id || "").trim();
  if (!id) {
    throw new Error("id is required");
  }

  const command = getResumeCommand(id);
  const cwd = normalizeCwd(payload.cwd);

  if (!resumeTerminal || resumeTerminal.exitStatus) {
    resumeTerminal = vscode.window.createTerminal({
      name: "Codex Resume",
      cwd: cwd || undefined,
    });
  } else if (cwd) {
    const safeCwd = cwd.replace(/"/g, '""');
    resumeTerminal.sendText(`cd \"${safeCwd}\"`, true);
  }

  resumeTerminal.show(true);
  resumeTerminal.sendText(command, true);

  return { id, command, started: true };
}

module.exports = {
  activate,
  deactivate,
};

































