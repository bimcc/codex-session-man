const vscode = require("vscode");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const readline = require("node:readline");
const { pipeline } = require("node:stream/promises");

const VIEW_TYPE = "codexSessionManager.panel";
const SIDEBAR_CONTAINER_ID = "codexSessionManager";
const SIDEBAR_VIEW_ID = "codexSessionManager.main";

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
  let panelRef = null;

  const provider = {
    resolveWebviewView(webviewView) {
      setupWebview(webviewView.webview, context);
    },
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      if (resumeTerminal && terminal === resumeTerminal) {
        resumeTerminal = null;
      }
    }),
  );

  const openCmd = vscode.commands.registerCommand("codexSessionManager.open", async () => {
    try {
      await vscode.commands.executeCommand(`workbench.view.extension.${SIDEBAR_CONTAINER_ID}`);
      await vscode.commands.executeCommand(`${SIDEBAR_VIEW_ID}.focus`);
      return;
    } catch {
      // fallback to panel below
    }

    if (panelRef) {
      panelRef.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      "Codex Session Manager",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
        retainContextWhenHidden: true,
      },
    );

    panelRef = panel;
    setupWebview(panel.webview, context);
    panel.onDidDispose(() => {
      panelRef = null;
    });
  });

  context.subscriptions.push(openCmd);
}

function deactivate() {}

function setupWebview(webview, context) {
  webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
  };
  webview.html = getWebviewHtml(webview, context.extensionUri);

  webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg !== "object") {
      return;
    }
    const id = msg.id;
    const op = msg.op;
    const payload = msg.payload || {};
    if (!id || !op) {
      return;
    }

    try {
      const data = await handleOperation(op, payload);
      webview.postMessage({ id, ok: true, data });
    } catch (error) {
      webview.postMessage({
        id,
        ok: false,
        error: error?.message || String(error),
      });
    }
  });
}

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

  const reason = String(payload.reason || "manual_force_stop").trim() || "manual_force_stop";
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

function getWebviewHtml(webview, extensionUri) {
  const nonce = String(Date.now()) + String(Math.random()).slice(2);
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview.css"));
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview.js"));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Codex Session Manager</title>
    <link rel="stylesheet" href="${cssUri}" />
  </head>
  <body>
    <div class="app">
      <header class="topbar">
        <div class="brand">Codex Session Manager</div>
        <div class="top-actions">
          <span id="configProviderInfo" class="config-provider">Config Provider: -</span>
          <button id="globalRefreshBtn" class="btn">刷新</button>
        </div>
      </header>

      <main class="workspace">
        <aside class="sidebar">
          <div class="tabs">
            <button id="tabActiveBtn" class="tab is-active">会话列表</button>
            <button id="tabRecycleBtn" class="tab">\u5f52\u6863</button>
          </div>

          <div class="search-row">
            <input id="searchInput" type="text" placeholder="搜索会话 / provider..." />
          </div>

          <div class="filter-row">
            <button id="mismatchOnlyBtn" class="btn toggle">仅看不一致</button>
          </div>

          <div class="batch-row">
            <input id="batchProviderInput" type="text" placeholder="批量设置 Provider" />
            <button id="batchUpdateBtn" class="btn">应用到当前筛选</button>
          </div>

          <div class="list-meta">
            <span id="listSummary">加载中...</span>
          </div>

          <div id="sessionList" class="session-list"></div>
        </aside>

        <section class="detail-area">
          <div id="emptyState" class="empty-state">请在左侧选择一个会话</div>

          <div id="detailPane" class="detail-pane hidden">
            <div class="detail-head">
              <div>
                <h2 id="detailTitle" class="detail-title"></h2>
                <div id="detailMeta" class="detail-meta"></div>
                <div id="providerInline" class="provider-inline hidden">
                  <span class="provider-label">Provider</span>
                  <span id="providerValue" class="provider-value"></span>
                  <input id="providerEditInput" type="text" class="hidden" />
                  <span id="providerState" class="provider-state"></span>
                  <button id="editProviderBtn" class="btn mini">编辑</button>
                  <button id="saveProviderBtn" class="btn mini hidden">保存</button>
                  <button id="cancelProviderBtn" class="btn mini hidden">取消</button>
                  <button id="repairProviderBtn" class="btn mini warn hidden">修正不一致</button>
                </div>
                <div id="execInline" class="provider-inline exec-inline hidden">
                  <span class="provider-label">执行状态</span>
                  <span id="execStateText" class="provider-state">未检测</span>
                  <button id="checkExecBtn" class="btn mini">检测状态</button>
                  <button id="repairExecBtn" class="btn mini warn hidden">修复会话</button>
                </div>
              </div>

              <div class="detail-actions">
                <button id="copyResumeBtn" class="btn">复制 Resume 命令</button>
                <button id="copySessionIdBtn" class="btn">复制会话ID</button>
                <button id="runResumeBtn" class="btn primary">在终端 Resume</button>
                <button id="deleteRestoreBtn" class="btn danger"></button>
                <button id="refreshDetailBtn" class="btn">刷新详情</button>
              </div>
            </div>


            <div class="messages-head">
              <span>会话内容预览</span>
              <span id="messageStats" class="muted"></span>
            </div>

            <div id="messageList" class="message-list"></div>
          </div>
        </section>
      </main>

      <footer id="statusBar" class="status-bar">就绪</footer>
    </div>

    <script nonce="${nonce}" src="${jsUri}"></script>
  </body>
</html>`;
}

module.exports = {
  activate,
  deactivate,
};

































