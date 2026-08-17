const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = __dirname;
const DEFAULT_PUBLIC_DIR = path.join(ROOT, "public");
const DEFAULT_DATA_DIR = process.env.BOARD_DATA_DIR || path.join(ROOT, "data");
// Keep the app private when it is placed behind BaoTa/Nginx. Override HOST
// explicitly when a direct LAN/public bind is intentionally needed.
const DEFAULT_HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_PORT = Number(process.env.PORT || 8787);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_NOTE_LENGTH = 2000;
const MAX_ACTIVITY_ENTRIES = 5000;
const MAX_OWNER_DEVICES = 100;
const MAX_FAVORITES = 500;
const MAX_CUSTOM_EMOTION_LABEL_LENGTH = 24;
const SESSION_COOKIE = "star_bottle_owner";
const DEFAULT_SESSION_HOURS = 12;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 10;
const STAR_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const EMOTION_METADATA = Object.freeze({
  joy: Object.freeze({ label: "开心", colorLevel: 1, color: "#ff863e" }),
  anger: Object.freeze({ label: "生气", colorLevel: 2, color: "#ffb773" }),
  anxiety: Object.freeze({ label: "焦虑", colorLevel: 3, color: "#ffdbb2" }),
  sadness: Object.freeze({ label: "伤心", colorLevel: 4, color: "#fff7e9" }),
  baby: Object.freeze({ label: "宝宝！！", colorLevel: 5, color: "#9edfff" }),
  custom: Object.freeze({ label: "自定义状态", colorLevel: 6, color: "#b9ff91" }),
});
const ACTIVITY_SOURCES = new Set(["pointer", "favorite", "direct"]);

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".glb", "model/gltf-binary"],
  [".gltf", "model/gltf+json"],
  [".hdr", "application/octet-stream"],
]);

const VENDOR_FILES = new Map([
  ["/vendor/three.module.js", path.join(ROOT, "node_modules", "three", "build", "three.module.js")],
  ["/vendor/OrbitControls.js", path.join(ROOT, "node_modules", "three", "examples", "jsm", "controls", "OrbitControls.js")],
  ["/vendor/cannon-es.js", path.join(ROOT, "node_modules", "cannon-es", "dist", "cannon-es.js")],
]);

function writeJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let settled = false;

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (settled) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        settled = true;
        const error = new Error("提交内容过大");
        error.statusCode = 413;
        reject(error);
        request.resume();
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (settled) return;
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        const error = new Error("提交的数据格式不正确");
        error.statusCode = 400;
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function storageError(label, filePath, error) {
  console.error(`[storage] Could not save ${filePath}:`, error);
  const reason = error?.code === "ENOSPC"
    ? "磁盘空间不足"
    : ["EACCES", "EPERM", "EBUSY"].includes(error?.code)
      ? "数据文件正被占用，或当前服务没有写入权限"
      : error?.code === "EROFS"
        ? "数据目录处于只读状态"
        : "服务器无法写入数据文件";
  const failure = new Error(`${label}保存失败：${reason}。原内容未被替换。`);
  failure.statusCode = 503;
  failure.storageCode = typeof error?.code === "string" ? error.code : "WRITE_FAILED";
  return failure;
}

function syncFile(filePath) {
  // FlushFileBuffers on Windows needs a handle opened with write access.
  const descriptor = fs.openSync(filePath, "r+");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function pauseForFileUnlock(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function writeJsonFileSafely(filePath, document, validate, label) {
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  const directory = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const suffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;
  const temporaryPath = path.join(directory, `.${baseName}.${suffix}.tmp`);
  const backupPath = `${filePath}.bak`;
  let temporaryDescriptor = null;
  let fallbackBackupExists = false;
  let usedFallback = false;

  try {
    temporaryDescriptor = fs.openSync(temporaryPath, "wx");
    fs.writeFileSync(temporaryDescriptor, serialized, "utf8");
    fs.fsyncSync(temporaryDescriptor);
    fs.closeSync(temporaryDescriptor);
    temporaryDescriptor = null;

    // Validate the complete temporary file before it can replace live data.
    validate(JSON.parse(fs.readFileSync(temporaryPath, "utf8")));

    let renameError = null;
    for (const delay of [0, 35, 100]) {
      if (delay) pauseForFileUnlock(delay);
      try {
        fs.renameSync(temporaryPath, filePath);
        renameError = null;
        break;
      } catch (error) {
        renameError = error;
      }
    }

    if (renameError) {
      // Windows programs can briefly lock JSON files. Keep a recoverable copy,
      // then use a verified overwrite when an atomic rename stays unavailable.
      try {
        fs.copyFileSync(filePath, backupPath);
        syncFile(backupPath);
        fallbackBackupExists = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }

      try {
        fs.copyFileSync(temporaryPath, filePath);
        syncFile(filePath);
        usedFallback = true;
      } catch (error) {
        if (fallbackBackupExists) {
          try {
            fs.copyFileSync(backupPath, filePath);
            syncFile(filePath);
          } catch (restoreError) {
            error.restoreError = restoreError;
          }
        }
        throw error;
      }
    }

    try {
      return validate(JSON.parse(fs.readFileSync(filePath, "utf8")));
    } catch (error) {
      if (usedFallback && fallbackBackupExists) {
        try {
          fs.copyFileSync(backupPath, filePath);
          syncFile(filePath);
        } catch (restoreError) {
          error.restoreError = restoreError;
        }
      }
      throw error;
    }
  } catch (error) {
    throw storageError(label, filePath, error);
  } finally {
    if (temporaryDescriptor !== null) {
      try { fs.closeSync(temporaryDescriptor); } catch { /* already closed */ }
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (error.code !== "ENOENT") console.error(`[storage] Could not remove ${temporaryPath}:`, error);
    }
  }
}

function parseCookies(header = "") {
  const cookies = new Map();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left), "utf8");
  const rightBuffer = Buffer.from(String(right), "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    crypto.timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requestIsSecure(request) {
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  return request.socket.encrypted || String(forwardedProtocol).split(",")[0].trim() === "https";
}

function sessionCookie(token, request, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (requestIsSecure(request)) parts.push("Secure");
  return parts.join("; ");
}

function clientAddress(request) {
  const forwarded = request.headers["cf-connecting-ip"] || request.headers["x-forwarded-for"];
  return String(forwarded || request.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function normalizeCustomEmotionLabel(value) {
  if (typeof value !== "string") return EMOTION_METADATA.custom.label;
  const label = value.trim().slice(0, MAX_CUSTOM_EMOTION_LABEL_LENGTH);
  return label || EMOTION_METADATA.custom.label;
}

function normalizeCustomPosition(value) {
  return value === "right" ? "right" : "left";
}

function normalizeNotesDocument(raw) {
  if (!raw || !Array.isArray(raw.notes)) throw new Error("notes.json must contain a notes array");

  const ids = new Set();
  const notes = raw.notes.map((note, index) => {
    if (!note || typeof note !== "object") throw new Error(`Note ${index + 1} is invalid`);
    const id = typeof note.id === "string" ? note.id.trim() : "";
    if (!/^[a-z0-9-]{1,40}$/.test(id) || ids.has(id)) {
      throw new Error(`Note ${index + 1} has an invalid or duplicate id`);
    }
    const emotionMetadata = EMOTION_METADATA[note.emotion];
    if (!emotionMetadata) {
      throw new Error(`Note ${id} has an invalid emotion`);
    }
    if (note.colorLevel !== undefined && note.colorLevel !== emotionMetadata.colorLevel) {
      throw new Error(`Note ${id} has an invalid colorLevel`);
    }
    if (note.color !== undefined && (typeof note.color !== "string" || !STAR_COLOR_PATTERN.test(note.color))) {
      throw new Error(`Note ${id} has an invalid color`);
    }
    if (typeof note.text !== "string" || note.text.length > MAX_NOTE_LENGTH) {
      throw new Error(`Note ${id} has invalid text`);
    }
    ids.add(id);
    const isCustomEmotion = note.emotion === "custom";
    const normalizedNote = {
      id,
      emotion: note.emotion,
      emotionLabel: isCustomEmotion
        ? normalizeCustomEmotionLabel(note.emotionLabel)
        : emotionMetadata.label,
      colorLevel: emotionMetadata.colorLevel,
      color: typeof note.color === "string" ? note.color.toLowerCase() : emotionMetadata.color,
      text: note.text,
    };
    if (isCustomEmotion) normalizedNote.customPosition = normalizeCustomPosition(note.customPosition);
    return normalizedNote;
  });

  return {
    version: Number.isSafeInteger(raw.version) && raw.version > 0 ? raw.version : 1,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    notes,
  };
}

function readNotes(notesFile) {
  return normalizeNotesDocument(JSON.parse(fs.readFileSync(notesFile, "utf8")));
}

function emptyActivityDocument() {
  return { version: 1, updatedAt: new Date().toISOString(), entries: [] };
}

function normalizeActivityDocument(raw) {
  if (!raw || !Array.isArray(raw.entries)) return emptyActivityDocument();
  const entries = raw.entries.slice(-MAX_ACTIVITY_ENTRIES).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const id = typeof entry.id === "string" ? entry.id.slice(0, 64) : "";
    const noteId = typeof entry.noteId === "string" ? entry.noteId.slice(0, 40) : "";
    const visitorId = typeof entry.visitorId === "string" ? entry.visitorId.slice(0, 80) : "";
    const source = ACTIVITY_SOURCES.has(entry.source) ? entry.source : "direct";
    const openedAt = typeof entry.openedAt === "string" ? entry.openedAt : "";
    if (!id || !/^[a-z0-9-]{1,40}$/.test(noteId) || !visitorId || !openedAt) return [];
    return [{
      id,
      noteId,
      visitorId,
      source,
      openedAt,
      emotionAtOpen: EMOTION_METADATA[entry.emotionAtOpen] ? entry.emotionAtOpen : "",
      colorAtOpen: typeof entry.colorAtOpen === "string" && STAR_COLOR_PATTERN.test(entry.colorAtOpen)
        ? entry.colorAtOpen.toLowerCase()
        : "",
      textAtOpen: typeof entry.textAtOpen === "string" ? entry.textAtOpen.slice(0, MAX_NOTE_LENGTH) : "",
    }];
  });
  return {
    version: Number.isSafeInteger(raw.version) && raw.version > 0 ? raw.version : 1,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    entries,
  };
}

function readActivity(activityFile) {
  try {
    return normalizeActivityDocument(JSON.parse(fs.readFileSync(activityFile, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return emptyActivityDocument();
    throw error;
  }
}

function emptyOwnerDevicesDocument() {
  return { version: 1, updatedAt: new Date().toISOString(), devices: [] };
}

function normalizeOwnerDevicesDocument(raw) {
  if (!raw || !Array.isArray(raw.devices)) return emptyOwnerDevicesDocument();
  const seen = new Set();
  const devices = raw.devices.slice(-MAX_OWNER_DEVICES).flatMap((device) => {
    if (!device || typeof device !== "object") return [];
    const id = typeof device.id === "string" ? device.id.trim() : "";
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id) || seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      label: typeof device.label === "string" ? device.label.slice(0, 80) : "主人设备",
      firstLoginAt: typeof device.firstLoginAt === "string" ? device.firstLoginAt : new Date().toISOString(),
      lastLoginAt: typeof device.lastLoginAt === "string" ? device.lastLoginAt : new Date().toISOString(),
      loginCount: Number.isSafeInteger(device.loginCount) && device.loginCount > 0 ? device.loginCount : 1,
    }];
  });
  return {
    version: Number.isSafeInteger(raw.version) && raw.version > 0 ? raw.version : 1,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    devices,
  };
}

function readOwnerDevices(devicesFile) {
  try {
    return normalizeOwnerDevicesDocument(JSON.parse(fs.readFileSync(devicesFile, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return emptyOwnerDevicesDocument();
    throw error;
  }
}

function emptyFavoritesDocument() {
  return { version: 1, updatedAt: new Date().toISOString(), noteIds: [] };
}

function normalizeFavoritesDocument(raw) {
  if (!raw || !Array.isArray(raw.noteIds)) return emptyFavoritesDocument();
  const seen = new Set();
  const noteIds = raw.noteIds.slice(0, MAX_FAVORITES).flatMap((candidate) => {
    const id = typeof candidate === "string" ? candidate.trim() : "";
    if (!/^[a-z0-9-]{1,40}$/.test(id) || seen.has(id)) return [];
    seen.add(id);
    return [id];
  });
  return {
    version: Number.isSafeInteger(raw.version) && raw.version > 0 ? raw.version : 1,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    noteIds,
  };
}

function readFavorites(favoritesFile) {
  try {
    return normalizeFavoritesDocument(JSON.parse(fs.readFileSync(favoritesFile, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return emptyFavoritesDocument();
    throw error;
  }
}

function readSettings(settingsFile, passwordOverride) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const password = passwordOverride || process.env.OWNER_PASSWORD || raw.ownerPassword;
  if (typeof password !== "string" || password.length < 6) {
    throw new Error("Set OWNER_PASSWORD or provide data/settings.json with an ownerPassword of at least 6 characters");
  }
  const configuredHours = Number(process.env.SESSION_HOURS || raw.sessionHours);
  return {
    ownerPassword: password,
    sessionHours: Number.isFinite(configuredHours)
      ? Math.min(168, Math.max(1, configuredHours))
      : DEFAULT_SESSION_HOURS,
  };
}

function createStarBottleServer(options = {}) {
  const publicDir = options.publicDir || DEFAULT_PUBLIC_DIR;
  const realPublicDir = fs.realpathSync(publicDir);
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const notesFile = path.join(dataDir, "notes.json");
  const settingsFile = path.join(dataDir, "settings.json");
  const activityFile = path.join(dataDir, "activity.json");
  const devicesFile = path.join(dataDir, "owner-devices.json");
  const favoritesFile = path.join(dataDir, "favorites.json");
  const settings = readSettings(settingsFile, options.ownerPassword);
  let notesDocument = readNotes(notesFile);
  let notesSignature = JSON.stringify(notesDocument);
  let activityDocument = readActivity(activityFile);
  let ownerDevicesDocument = readOwnerDevices(devicesFile);
  let favoritesDocument = readFavorites(favoritesFile);
  let favoritesSignature = JSON.stringify(favoritesDocument);
  let watcher = null;
  let reloadTimer = null;
  let favoritesReloadTimer = null;

  const sessions = new Map();
  const loginAttempts = new Map();
  const activityAttempts = new Map();
  const favoriteAttempts = new Map();
  const eventClients = new Map();
  let favoritesWriteQueue = Promise.resolve();

  function sessionFor(request) {
    const cookieToken = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
    const authorization = String(request.headers.authorization || "");
    const bearerMatch = authorization.match(/^Bearer\s+([A-Za-z0-9_-]{32,128})$/i);
    const candidates = [cookieToken, bearerMatch?.[1]].filter(Boolean);
    for (const token of candidates) {
      const session = sessions.get(token);
      if (session?.expiresAt > Date.now()) return { token, ...session };
      sessions.delete(token);
    }
    return null;
  }

  function sendEvent(response, eventName, payload) {
    response.write(`event: ${eventName}\n`);
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function broadcast(eventName, payload) {
    for (const response of eventClients.values()) sendEvent(response, eventName, payload);
  }

  function saveNotes(nextDocument) {
    const persisted = writeJsonFileSafely(notesFile, nextDocument, normalizeNotesDocument, "纸条");
    notesDocument = persisted;
    notesSignature = JSON.stringify(persisted);
    return persisted;
  }

  function saveActivity(nextDocument) {
    const persisted = writeJsonFileSafely(activityFile, nextDocument, normalizeActivityDocument, "打开记录");
    activityDocument = persisted;
    return persisted;
  }

  function saveOwnerDevices(nextDocument) {
    const persisted = writeJsonFileSafely(devicesFile, nextDocument, normalizeOwnerDevicesDocument, "主人设备名单");
    ownerDevicesDocument = persisted;
    return persisted;
  }

  function saveFavorites(nextDocument) {
    const persisted = writeJsonFileSafely(favoritesFile, nextDocument, normalizeFavoritesDocument, "收藏");
    favoritesDocument = persisted;
    favoritesSignature = JSON.stringify(persisted);
    return persisted;
  }

  function queueFavoriteWrite(operation) {
    const queued = favoritesWriteQueue.then(operation, operation);
    favoritesWriteQueue = queued.catch(() => {});
    return queued;
  }

  async function registerOwnerDevice(visitorId, label = "主人设备") {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(visitorId)) return null;
    const now = new Date().toISOString();
    const existing = ownerDevicesDocument.devices.find((device) => device.id === visitorId);
    const device = existing
      ? { ...existing, label: String(label).slice(0, 80) || existing.label, lastLoginAt: now, loginCount: existing.loginCount + 1 }
      : { id: visitorId, label: String(label).slice(0, 80) || "主人设备", firstLoginAt: now, lastLoginAt: now, loginCount: 1 };
    const devices = existing
      ? ownerDevicesDocument.devices.map((candidate) => candidate.id === visitorId ? device : candidate)
      : [...ownerDevicesDocument.devices, device].slice(-MAX_OWNER_DEVICES);
    const nextDocument = {
      version: ownerDevicesDocument.version + 1,
      updatedAt: now,
      devices,
    };
    await saveOwnerDevices(nextDocument);
    return device;
  }

  function reloadNotesFromDisk() {
    try {
      const reloaded = readNotes(notesFile);
      const nextSignature = JSON.stringify(reloaded);
      if (nextSignature === notesSignature) return;
      notesDocument = reloaded;
      notesSignature = nextSignature;
      broadcast("notes", notesDocument);
    } catch (error) {
      console.error(`Could not reload data/notes.json: ${error.message}`);
    }
  }

  function reloadFavoritesFromDisk() {
    try {
      const reloaded = readFavorites(favoritesFile);
      const nextSignature = JSON.stringify(reloaded);
      if (nextSignature === favoritesSignature) return;
      favoritesDocument = reloaded;
      favoritesSignature = nextSignature;
      broadcast("favorites", favoritesDocument);
    } catch (error) {
      console.error(`Could not reload data/favorites.json: ${error.message}`);
    }
  }

  if (options.watch !== false) {
    watcher = fs.watch(dataDir, (eventType, fileName) => {
      const normalizedFileName = String(fileName || "").toLowerCase();
      if (normalizedFileName === "notes.json") {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(reloadNotesFromDisk, 120);
      } else if (normalizedFileName === "favorites.json") {
        clearTimeout(favoritesReloadTimer);
        favoritesReloadTimer = setTimeout(reloadFavoritesFromDisk, 120);
      }
    });
  }

  function isRateLimited(request) {
    const address = clientAddress(request);
    const now = Date.now();
    const recent = (loginAttempts.get(address) || []).filter((time) => now - time < LOGIN_WINDOW_MS);
    loginAttempts.set(address, recent);
    return recent.length >= LOGIN_ATTEMPT_LIMIT;
  }

  function recordFailedLogin(request) {
    const address = clientAddress(request);
    const recent = loginAttempts.get(address) || [];
    recent.push(Date.now());
    loginAttempts.set(address, recent);
  }

  function clearFailedLogins(request) {
    loginAttempts.delete(clientAddress(request));
  }

  function activityRateLimited(request) {
    const address = clientAddress(request);
    const now = Date.now();
    const recent = (activityAttempts.get(address) || []).filter((time) => now - time < 60_000);
    recent.push(now);
    activityAttempts.set(address, recent);
    return recent.length > 180;
  }

  function favoriteRateLimited(request) {
    const address = clientAddress(request);
    const now = Date.now();
    const recent = (favoriteAttempts.get(address) || []).filter((time) => now - time < 60_000);
    recent.push(now);
    favoriteAttempts.set(address, recent);
    return recent.length > 120;
  }

  async function handleApi(request, response, pathname) {
    if (pathname === "/api/health" && request.method === "GET") {
      writeJson(response, 200, {
        ok: true,
        service: "star-bottle",
        uptimeSeconds: Math.floor(process.uptime()),
      });
      return true;
    }

    if (pathname === "/api/notes" && request.method === "GET") {
      writeJson(response, 200, notesDocument);
      return true;
    }

    if (pathname === "/api/favorites" && request.method === "GET") {
      writeJson(response, 200, favoritesDocument);
      return true;
    }

    const favoriteMatch = pathname.match(/^\/api\/favorites\/([a-z0-9-]{1,40})$/);
    if (favoriteMatch && (request.method === "POST" || request.method === "PUT")) {
      if (favoriteRateLimited(request)) {
        writeJson(response, 429, { error: "收藏操作过于频繁，请稍后再试" });
        return true;
      }
      try {
        const body = await readJsonBody(request);
        if (typeof body.favorite !== "boolean") {
          writeJson(response, 400, { error: "收藏状态必须为 true 或 false" });
          return true;
        }
        const noteId = favoriteMatch[1];
        if (!notesDocument.notes.some((note) => note.id === noteId)) {
          writeJson(response, 404, { error: "找不到这颗星星" });
          return true;
        }
        const persistedDocument = await queueFavoriteWrite(() => {
          const alreadyFavorite = favoritesDocument.noteIds.includes(noteId);
          if (alreadyFavorite === body.favorite) return favoritesDocument;
          const noteIds = body.favorite
            ? [...favoritesDocument.noteIds, noteId].slice(-MAX_FAVORITES)
            : favoritesDocument.noteIds.filter((id) => id !== noteId);
          const persisted = saveFavorites({
            version: favoritesDocument.version + 1,
            updatedAt: new Date().toISOString(),
            noteIds,
          });
          broadcast("favorites", persisted);
          return persisted;
        });
        writeJson(response, 200, {
          saved: true,
          favorite: persistedDocument.noteIds.includes(noteId),
          document: persistedDocument,
        });
      } catch (error) {
        writeJson(response, error.statusCode || 400, {
          error: error.message || "收藏保存失败",
          code: error.storageCode,
        });
      }
      return true;
    }

    if (pathname === "/api/favorites/import" && request.method === "POST") {
      if (favoriteRateLimited(request)) {
        writeJson(response, 429, { error: "收藏操作过于频繁，请稍后再试" });
        return true;
      }
      try {
        const body = await readJsonBody(request);
        if (!Array.isArray(body.noteIds)) {
          writeJson(response, 400, { error: "收藏列表格式不正确" });
          return true;
        }
        const validNoteIds = new Set(notesDocument.notes.map((note) => note.id));
        const importedIds = normalizeFavoritesDocument({ noteIds: body.noteIds }).noteIds
          .filter((id) => validNoteIds.has(id));
        let imported = false;
        const persistedDocument = await queueFavoriteWrite(() => {
          if (favoritesDocument.version !== 1 || favoritesDocument.noteIds.length || !importedIds.length) {
            return favoritesDocument;
          }
          imported = true;
          const persisted = saveFavorites({
            version: 2,
            updatedAt: new Date().toISOString(),
            noteIds: importedIds,
          });
          broadcast("favorites", persisted);
          return persisted;
        });
        writeJson(response, 200, { saved: true, imported, document: persistedDocument });
      } catch (error) {
        writeJson(response, error.statusCode || 400, {
          error: error.message || "旧收藏迁移失败",
          code: error.storageCode,
        });
      }
      return true;
    }

    if (pathname === "/api/activity/open" && request.method === "POST") {
      if (activityRateLimited(request)) {
        writeJson(response, 429, { error: "Too many activity events" });
        return true;
      }
      try {
        const body = await readJsonBody(request);
        const noteId = typeof body.noteId === "string" ? body.noteId.trim() : "";
        const visitorId = typeof body.visitorId === "string" ? body.visitorId.trim() : "";
        const source = ACTIVITY_SOURCES.has(body.source) ? body.source : "direct";
        if (!/^[a-z0-9-]{1,40}$/.test(noteId)) {
          writeJson(response, 400, { error: "A valid note id is required" });
          return true;
        }
        if (!/^[A-Za-z0-9_-]{8,80}$/.test(visitorId)) {
          writeJson(response, 400, { error: "A valid visitor id is required" });
          return true;
        }
        const openedNote = notesDocument.notes.find((note) => note.id === noteId);
        if (!openedNote) {
          writeJson(response, 404, { error: "Note not found" });
          return true;
        }
        if (ownerDevicesDocument.devices.some((device) => device.id === visitorId)) {
          writeJson(response, 200, { recorded: false, reason: "owner-device" });
          return true;
        }
        const nextDocument = {
          version: activityDocument.version + 1,
          updatedAt: new Date().toISOString(),
          entries: [
            ...activityDocument.entries,
            {
              id: crypto.randomUUID(),
              noteId,
              visitorId,
              source,
              openedAt: new Date().toISOString(),
              emotionAtOpen: openedNote.emotion,
              colorAtOpen: openedNote.color,
              textAtOpen: openedNote.text,
            },
          ].slice(-MAX_ACTIVITY_ENTRIES),
        };
        await saveActivity(nextDocument);
        writeJson(response, 201, { recorded: true });
      } catch (error) {
        writeJson(response, error.statusCode || 400, { error: error.message || "Could not record activity" });
      }
      return true;
    }

    if (pathname === "/api/events" && request.method === "GET") {
      const clientId = crypto.randomUUID();
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      });
      response.write(": connected\n\n");
      eventClients.set(clientId, response);
      sendEvent(response, "notes", notesDocument);
      sendEvent(response, "favorites", favoritesDocument);
      request.on("close", () => eventClients.delete(clientId));
      return true;
    }

    if (pathname === "/api/owner/status" && request.method === "GET") {
      writeJson(response, 200, { authenticated: Boolean(sessionFor(request)) });
      return true;
    }

    if (pathname === "/api/owner/activity" && request.method === "GET") {
      if (!sessionFor(request)) {
        writeJson(response, 401, { error: "Owner login required" });
        return true;
      }
      const entries = activityDocument.entries.slice().reverse().map((entry) => {
        const note = notesDocument.notes.find((candidate) => candidate.id === entry.noteId);
        return {
          ...entry,
          note: note
            ? {
                text: note.text,
                emotion: note.emotion,
                emotionLabel: note.emotionLabel,
                colorLevel: note.colorLevel,
                color: note.color,
              }
            : null,
        };
      });
      writeJson(response, 200, {
        version: activityDocument.version,
        updatedAt: activityDocument.updatedAt,
        entries,
      });
      return true;
    }

    if (pathname === "/api/owner/activity" && request.method === "DELETE") {
      if (!sessionFor(request)) {
        writeJson(response, 401, { error: "Owner login required" });
        return true;
      }
      const nextDocument = {
        version: activityDocument.version + 1,
        updatedAt: new Date().toISOString(),
        entries: [],
      };
      try {
        await saveActivity(nextDocument);
        writeJson(response, 200, { cleared: true, version: nextDocument.version });
      } catch (error) {
        writeJson(response, error.statusCode || 503, {
          error: error.message || "打开记录清空失败",
          code: error.storageCode || "WRITE_FAILED",
        });
      }
      return true;
    }

    if (pathname === "/api/owner/devices" && request.method === "GET") {
      if (!sessionFor(request)) {
        writeJson(response, 401, { error: "Owner login required" });
        return true;
      }
      writeJson(response, 200, {
        version: ownerDevicesDocument.version,
        updatedAt: ownerDevicesDocument.updatedAt,
        devices: ownerDevicesDocument.devices
          .slice()
          .sort((left, right) => String(right.lastLoginAt).localeCompare(String(left.lastLoginAt))),
      });
      return true;
    }

    if (pathname === "/api/owner/devices/register" && request.method === "POST") {
      if (!sessionFor(request)) {
        writeJson(response, 401, { error: "Owner login required" });
        return true;
      }
      try {
        const body = await readJsonBody(request);
        const device = await registerOwnerDevice(
          typeof body.visitorId === "string" ? body.visitorId.trim() : "",
          typeof body.deviceLabel === "string" ? body.deviceLabel : "主人设备",
        );
        if (!device) {
          writeJson(response, 400, { error: "A valid device id is required" });
          return true;
        }
        writeJson(response, 200, { device });
      } catch (error) {
        writeJson(response, error.statusCode || 400, { error: error.message || "Could not register device" });
      }
      return true;
    }

    const deviceMatch = pathname.match(/^\/api\/owner\/devices\/([A-Za-z0-9_-]{8,80})$/);
    if (deviceMatch && request.method === "DELETE") {
      if (!sessionFor(request)) {
        writeJson(response, 401, { error: "Owner login required" });
        return true;
      }
      const id = deviceMatch[1];
      const devices = ownerDevicesDocument.devices.filter((device) => device.id !== id);
      if (devices.length === ownerDevicesDocument.devices.length) {
        writeJson(response, 404, { error: "Device not found" });
        return true;
      }
      const nextDocument = {
        version: ownerDevicesDocument.version + 1,
        updatedAt: new Date().toISOString(),
        devices,
      };
      try {
        await saveOwnerDevices(nextDocument);
        writeJson(response, 200, { removed: true, id });
      } catch (error) {
        writeJson(response, error.statusCode || 503, {
          error: error.message || "设备名单保存失败",
          code: error.storageCode || "WRITE_FAILED",
        });
      }
      return true;
    }

    if (pathname === "/api/owner/login" && request.method === "POST") {
      if (isRateLimited(request)) {
        writeJson(response, 429, { error: "Too many login attempts. Try again later." });
        return true;
      }

      try {
        const body = await readJsonBody(request);
        if (typeof body.password !== "string" || !safeEqual(body.password, settings.ownerPassword)) {
          recordFailedLogin(request);
          writeJson(response, 401, { error: "Password is incorrect" });
          return true;
        }

        clearFailedLogins(request);
        await registerOwnerDevice(
          typeof body.visitorId === "string" ? body.visitorId.trim() : "",
          typeof body.deviceLabel === "string" ? body.deviceLabel : "主人设备",
        );
        const token = crypto.randomBytes(32).toString("base64url");
        const sessionSeconds = settings.sessionHours * 60 * 60;
        sessions.set(token, { expiresAt: Date.now() + sessionSeconds * 1000 });
        writeJson(response, 200, {
          authenticated: true,
          ownerToken: token,
          expiresAt: new Date(Date.now() + sessionSeconds * 1000).toISOString(),
        }, {
          "Set-Cookie": sessionCookie(token, request, sessionSeconds),
        });
      } catch (error) {
        writeJson(response, error.statusCode || 400, { error: error.message || "Login failed" });
      }
      return true;
    }

    if (pathname === "/api/owner/logout" && request.method === "POST") {
      const session = sessionFor(request);
      if (session) sessions.delete(session.token);
      writeJson(response, 200, { authenticated: false }, {
        "Set-Cookie": sessionCookie("", request, 0),
      });
      return true;
    }

    const ownerNoteMatch = pathname.match(/^\/api\/owner\/notes\/([a-z0-9-]{1,40})$/);
    const isOwnerNotePost = ownerNoteMatch && request.method === "POST";
    const noteMatch = pathname.match(/^\/api\/notes\/([a-z0-9-]{1,40})$/);
    const isSingleNotePut = noteMatch && request.method === "PUT";
    const isBodyIdPut = pathname === "/api/notes" && request.method === "PUT";
    if (isOwnerNotePost || isSingleNotePut || isBodyIdPut) {
      if (!sessionFor(request)) {
        writeJson(response, 401, { error: "主人登录已失效，请重新进入编辑室" });
        return true;
      }

      try {
        const body = await readJsonBody(request);
        const id = isOwnerNotePost ? ownerNoteMatch[1] : isSingleNotePut ? noteMatch[1] : body.id;
        if (typeof id !== "string" || !/^[a-z0-9-]{1,40}$/.test(id)) {
          writeJson(response, 400, { error: "星星编号无效" });
          return true;
        }
        const noteIndex = notesDocument.notes.findIndex((note) => note.id === id);
        if (noteIndex < 0) {
          writeJson(response, 404, { error: "没有找到这颗星星" });
          return true;
        }

        const currentNote = notesDocument.notes[noteIndex];
        const nextText = body.text === undefined ? currentNote.text : body.text;
        const nextEmotion = body.emotion === undefined ? currentNote.emotion : body.emotion;
        if (typeof nextText !== "string" || nextText.length > MAX_NOTE_LENGTH) {
          writeJson(response, 400, { error: `纸条内容不能超过 ${MAX_NOTE_LENGTH} 个字符` });
          return true;
        }
        if (!EMOTION_METADATA[nextEmotion]) {
          writeJson(response, 400, { error: "请选择有效的星星状态" });
          return true;
        }

        const emotionMetadata = EMOTION_METADATA[nextEmotion];
        let nextEmotionLabel = emotionMetadata.label;
        let nextCustomPosition;
        if (nextEmotion === "custom") {
          const submittedLabel = body.emotionLabel === undefined
            ? (currentNote.emotion === "custom" ? currentNote.emotionLabel : emotionMetadata.label)
            : body.emotionLabel;
          if (typeof submittedLabel !== "string" || !submittedLabel.trim() || submittedLabel.trim().length > MAX_CUSTOM_EMOTION_LABEL_LENGTH) {
            writeJson(response, 400, { error: `自定义状态名称需要 1-${MAX_CUSTOM_EMOTION_LABEL_LENGTH} 个字符` });
            return true;
          }
          nextEmotionLabel = submittedLabel.trim();
          const submittedPosition = body.customPosition === undefined
            ? (currentNote.emotion === "custom" ? currentNote.customPosition : "left")
            : body.customPosition;
          if (submittedPosition !== "left" && submittedPosition !== "right") {
            writeJson(response, 400, { error: "自定义状态位置只能选择左侧或右侧" });
            return true;
          }
          nextCustomPosition = submittedPosition;
        }
        let nextColor;
        if (body.color === undefined) {
          nextColor = nextEmotion === currentNote.emotion ? currentNote.color : emotionMetadata.color;
        } else if (body.color === null || body.color === "") {
          nextColor = emotionMetadata.color;
        } else if (typeof body.color !== "string" || !STAR_COLOR_PATTERN.test(body.color)) {
          writeJson(response, 400, { error: "星星颜色格式不正确" });
          return true;
        } else {
          nextColor = body.color.toLowerCase();
        }
        const nextNote = {
          id: currentNote.id,
          text: nextText,
          emotion: nextEmotion,
          emotionLabel: nextEmotionLabel,
          colorLevel: emotionMetadata.colorLevel,
          color: nextColor,
        };
        if (nextEmotion === "custom") nextNote.customPosition = nextCustomPosition;
        const nextNotes = notesDocument.notes.map((note, index) => {
          if (index === noteIndex) return nextNote;
          if (nextEmotion === "custom" && note.emotion === "custom") {
            return {
              ...note,
              emotionLabel: nextEmotionLabel,
              customPosition: nextCustomPosition,
            };
          }
          return note;
        });
        const nextDocument = {
          version: notesDocument.version + 1,
          updatedAt: new Date().toISOString(),
          notes: nextNotes,
        };
        const persistedDocument = await saveNotes(nextDocument);
        const persistedNote = persistedDocument.notes.find((note) => note.id === id);
        console.log(`[notes] Saved ${id}; version ${persistedDocument.version}`);
        broadcast("note", { note: persistedNote, version: persistedDocument.version, updatedAt: persistedDocument.updatedAt });
        broadcast("notes", persistedDocument);
        writeJson(response, 200, {
          saved: true,
          note: persistedNote,
          document: persistedDocument,
          version: persistedDocument.version,
          updatedAt: persistedDocument.updatedAt,
        });
      } catch (error) {
        writeJson(response, error.statusCode || 400, {
          error: error.message || "纸条保存失败",
          code: error.storageCode,
        });
      }
      return true;
    }

    if (pathname === "/api/state" && request.method === "PUT") {
      writeJson(response, 405, { error: "Public editing is disabled" }, { Allow: "GET" });
      return true;
    }

    return false;
  }

  async function serveFile(request, response, filePath) {
    const extension = path.extname(filePath).toLowerCase();
    const contentType = CONTENT_TYPES.get(extension);
    if (!contentType) return false;

    try {
      const stats = await fs.promises.stat(filePath);
      if (!stats.isFile()) return false;
      const content = request.method === "HEAD" ? null : await fs.promises.readFile(filePath);
      response.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": stats.size,
        "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
      });
      response.end(content);
      return true;
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
      throw error;
    }
  }

  async function handleStatic(request, response, pathname) {
    if (request.method !== "GET" && request.method !== "HEAD") return false;

    const vendorFile = VENDOR_FILES.get(pathname);
    if (vendorFile) {
      const servedVendorFile = await serveFile(request, response, vendorFile);
      if (servedVendorFile) return true;
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    } catch {
      return false;
    }
    if (decodedPath.includes("\\") || decodedPath.includes("\0")) return false;

    const candidate = path.resolve(realPublicDir, `.${decodedPath}`);
    const relative = path.relative(realPublicDir, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
    try {
      const realCandidate = await fs.promises.realpath(candidate);
      const realRelative = path.relative(realPublicDir, realCandidate);
      if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) return false;
      return serveFile(request, response, realCandidate);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
      throw error;
    }
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      const pathname = url.pathname;

      if (pathname.startsWith("/api/")) {
        const handled = await handleApi(request, response, pathname);
        if (!handled) writeJson(response, 404, { error: "API endpoint not found" });
        return;
      }

      const handled = await handleStatic(request, response, pathname);
      if (!handled) {
        response.writeHead(404, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end("Not found");
      }
    } catch (error) {
      console.error(error);
      if (!response.headersSent) writeJson(response, 500, { error: "Internal server error" });
      else response.end();
    }
  });

  const heartbeat = setInterval(() => {
    for (const response of eventClients.values()) response.write(": heartbeat\n\n");
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(token);
    }
    for (const [address, attempts] of loginAttempts) {
      const recent = attempts.filter((time) => now - time < LOGIN_WINDOW_MS);
      if (recent.length) loginAttempts.set(address, recent);
      else loginAttempts.delete(address);
    }
    for (const [address, attempts] of activityAttempts) {
      const recent = attempts.filter((time) => now - time < 60_000);
      if (recent.length) activityAttempts.set(address, recent);
      else activityAttempts.delete(address);
    }
    for (const [address, attempts] of favoriteAttempts) {
      const recent = attempts.filter((time) => now - time < 60_000);
      if (recent.length) favoriteAttempts.set(address, recent);
      else favoriteAttempts.delete(address);
    }
  }, 20000);
  heartbeat.unref();

  function cleanup() {
    clearInterval(heartbeat);
    clearTimeout(reloadTimer);
    clearTimeout(favoritesReloadTimer);
    if (watcher) watcher.close();
    watcher = null;
    for (const response of eventClients.values()) response.end();
    eventClients.clear();
  }

  server.on("close", cleanup);
  return server;
}

if (require.main === module) {
  const server = createStarBottleServer();
  server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
    console.log(`Star bottle is running at http://localhost:${DEFAULT_PORT}`);
    console.log(`Listening on http://${DEFAULT_HOST}:${DEFAULT_PORT}`);
  });

  function shutdown() {
    server.close(() => process.exit(0));
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = { createStarBottleServer };
