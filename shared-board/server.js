const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  FEATURE_REGISTRY,
  createFeatureRegistry,
  featureForPath,
  listPublicFeatures,
} = require("./lib/feature-registry");
const {
  MAX_ANNOUNCEMENT_LENGTH,
  MAX_FEATURE_DESCRIPTION_LENGTH,
  MAX_FEATURE_TITLE_LENGTH,
  MAX_PORTAL_ACTIVITY_ENTRIES,
  MAX_VISITOR_NAME_LENGTH,
  MAX_VISITOR_REMARK_LENGTH,
  PORTAL_ACCENTS,
  PORTAL_VISITOR_ID_PATTERN,
  emptyPortalActivityDocument,
  emptyPortalSettingsDocument,
  normalizePortalActivityDocument,
  normalizePortalSettingsDocument,
} = require("./lib/portal-state");

const ROOT = __dirname;
const DEFAULT_PUBLIC_DIR = path.join(ROOT, "public");
const DEFAULT_DATA_DIR = process.env.BOARD_DATA_DIR || path.join(ROOT, "data");
// Keep the app private when it is placed behind BaoTa/Nginx. Override HOST
// explicitly when a direct LAN/public bind is intentionally needed.
const DEFAULT_HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_PORT = Number(process.env.PORT || 8787);
const PORTAL_ENTRY = "/portal/home.html";
const LOGIN_ENTRY = "/login.html";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_NOTE_LENGTH = 2000;
const MAX_NOTE_COUNT = 500;
const MIN_NOTE_COUNT = 1;
const MAX_ACTIVITY_ENTRIES = 5000;
const PORTAL_ACTIVITY_WINDOW_MS = 60 * 1000;
const PORTAL_ACTIVITY_LIMIT = 180;
const MAX_OWNER_DEVICES = 100;
const MAX_FAVORITES = 500;
const MAX_CUSTOM_EMOTION_LABEL_LENGTH = 24;
const LOVE_STARS_MESSAGE_MAX_LENGTH = 200;
const LOVE_STARS_MESSAGE_MAX_COUNT = 500;
const LOVE_STARS_MESSAGE_WINDOW_MS = 10 * 1000;
const LOVE_STARS_BLOCKED_WORDS = Object.freeze(["傻逼", "妈的", "操你", "fuck", "shit", "nmsl"]);
const WRONG_COUNTER_HISTORY_LIMIT = 500;
const WRONG_HIT_WINDOW_MS = 60 * 1000;
const WRONG_HIT_LIMIT = 240;
const WRONG_VISITOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{3,127}$/;
const SESSION_COOKIE = "star_bottle_owner";
const SITE_SESSION_COOKIE = "star_bottle_access";
const PORTAL_VISITOR_COOKIE = "myuan_portal_visitor";
const PORTAL_VISITOR_COOKIE_SECONDS = 365 * 24 * 60 * 60;
const DEFAULT_SESSION_HOURS = 12;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 10;
const STAR_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const NOTE_CHANGE_STATUSES = new Set(["read", "unread"]);
const NOTE_CHANGE_REASONS = new Set(["added", "updated", "manual"]);
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
  [".txt", "text/plain; charset=utf-8"],
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
  [".wav", "audio/wav"],
  [".m4a", "audio/mp4"],
  [".aac", "audio/aac"],
  [".flac", "audio/flac"],
  [".glb", "model/gltf-binary"],
  [".gltf", "model/gltf+json"],
  [".hdr", "application/octet-stream"],
]);

const MUSIC_EXTENSIONS = new Set([".mp3", ".ogg", ".wav", ".m4a", ".aac", ".flac"]);

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

async function readMusicTracks(publicDir) {
  const musicDirectory = path.join(publicDir, "music");
  let entries;
  try {
    entries = await fs.promises.readdir(musicDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && MUSIC_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => {
      const extension = path.extname(entry.name);
      const title = path.basename(entry.name, extension).replace(/[_-]+/g, " ").trim();
      return {
        file: entry.name,
        title: title || entry.name,
        url: `/music/${encodeURIComponent(entry.name)}`,
      };
    })
    .sort((left, right) =>
      left.title.localeCompare(right.title, "zh-CN", { numeric: true, sensitivity: "base" }),
    )
    .slice(0, 100);
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

function isLoopbackAddress(value) {
  const address = String(value || "").trim().toLowerCase();
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function requestIsSecure(request) {
  if (request.socket.encrypted) return true;
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false;
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  return String(forwardedProtocol).split(",").at(-1).trim() === "https";
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

function siteSessionCookie(token, request, maxAgeSeconds) {
  const parts = [
    `${SITE_SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (requestIsSecure(request)) parts.push("Secure");
  return parts.join("; ");
}

function portalVisitorCookie(visitorId, request) {
  const parts = [
    `${PORTAL_VISITOR_COOKIE}=${visitorId}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${PORTAL_VISITOR_COOKIE_SECONDS}`,
  ];
  if (requestIsSecure(request)) parts.push("Secure");
  return parts.join("; ");
}

function clientAddress(request) {
  const peerAddress = String(request.socket.remoteAddress || "unknown").trim();
  if (!isLoopbackAddress(peerAddress)) return peerAddress;
  const cloudflareAddress = String(request.headers["cf-connecting-ip"] || "").trim();
  if (cloudflareAddress) return cloudflareAddress;
  const forwardedAddresses = String(request.headers["x-forwarded-for"] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return forwardedAddresses.at(-1) || peerAddress;
}

function normalizeCustomEmotionLabel(value) {
  if (typeof value !== "string") return EMOTION_METADATA.custom.label;
  const label = value.trim().slice(0, MAX_CUSTOM_EMOTION_LABEL_LENGTH);
  return label || EMOTION_METADATA.custom.label;
}

function normalizeCustomPosition(value) {
  return value === "right" ? "right" : "left";
}

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function normalizeNoteChangeMetadata(note) {
  return {
    changeStatus: note.changeStatus === "unread" ? "unread" : "read",
    changeReason: NOTE_CHANGE_REASONS.has(note.changeReason) ? note.changeReason : "",
    changeAt: normalizeTimestamp(note.changeAt),
    readAt: normalizeTimestamp(note.readAt),
  };
}

function buildOwnerNote(body, id, currentNote = null, customTemplate = null) {
  const nextText = body.text === undefined
    ? (currentNote?.text ?? "新星星的纸条")
    : body.text;
  const nextEmotion = body.emotion === undefined
    ? (currentNote?.emotion ?? "joy")
    : body.emotion;
  if (typeof nextText !== "string" || nextText.length > MAX_NOTE_LENGTH) {
    throw requestError(`纸条内容不能超过 ${MAX_NOTE_LENGTH} 个字符`);
  }
  if (!EMOTION_METADATA[nextEmotion]) {
    throw requestError("请选择有效的星星状态");
  }

  const emotionMetadata = EMOTION_METADATA[nextEmotion];
  let nextEmotionLabel = emotionMetadata.label;
  let nextCustomPosition;
  if (nextEmotion === "custom") {
    const submittedLabel = body.emotionLabel === undefined
      ? (currentNote?.emotion === "custom"
          ? currentNote.emotionLabel
          : customTemplate?.emotionLabel || emotionMetadata.label)
      : body.emotionLabel;
    if (
      typeof submittedLabel !== "string" ||
      !submittedLabel.trim() ||
      submittedLabel.trim().length > MAX_CUSTOM_EMOTION_LABEL_LENGTH
    ) {
      throw requestError(`自定义状态名称需要 1-${MAX_CUSTOM_EMOTION_LABEL_LENGTH} 个字符`);
    }
    nextEmotionLabel = submittedLabel.trim();
    const submittedPosition = body.customPosition === undefined
      ? (currentNote?.emotion === "custom"
          ? currentNote.customPosition
          : customTemplate?.customPosition || "left")
      : body.customPosition;
    if (submittedPosition !== "left" && submittedPosition !== "right") {
      throw requestError("自定义状态位置只能选择左侧或右侧");
    }
    nextCustomPosition = submittedPosition;
  }

  let nextColor;
  if (body.color === undefined) {
    nextColor = currentNote && nextEmotion === currentNote.emotion
      ? currentNote.color
      : emotionMetadata.color;
  } else if (body.color === null || body.color === "") {
    nextColor = emotionMetadata.color;
  } else if (typeof body.color !== "string" || !STAR_COLOR_PATTERN.test(body.color)) {
    throw requestError("星星颜色格式不正确");
  } else {
    nextColor = body.color.toLowerCase();
  }

  const note = {
    id,
    text: nextText,
    emotion: nextEmotion,
    emotionLabel: nextEmotionLabel,
    colorLevel: emotionMetadata.colorLevel,
    color: nextColor,
  };
  if (nextEmotion === "custom") note.customPosition = nextCustomPosition;
  return note;
}

function noteContentChanged(currentNote, nextNote) {
  return currentNote.text !== nextNote.text ||
    currentNote.emotion !== nextNote.emotion ||
    currentNote.emotionLabel !== nextNote.emotionLabel ||
    currentNote.color !== nextNote.color ||
    (currentNote.customPosition || "") !== (nextNote.customPosition || "");
}

function applyNoteChangeMetadata(note, currentNote, body, reason, now) {
  const submittedStatus = body.changeStatus;
  if (submittedStatus !== undefined && !NOTE_CHANGE_STATUSES.has(submittedStatus)) {
    throw requestError("阅读状态只能选择已读或未读");
  }

  if (!currentNote) {
    const changeStatus = submittedStatus || "unread";
    return {
      ...note,
      changeStatus,
      changeReason: "added",
      changeAt: now,
      readAt: changeStatus === "read" ? now : "",
    };
  }

  const contentChanged = reason === "updated";
  if (contentChanged) {
    const changeStatus = submittedStatus || "unread";
    return {
      ...note,
      changeStatus,
      changeReason: "updated",
      changeAt: now,
      readAt: changeStatus === "read" ? now : "",
    };
  }

  if (submittedStatus !== undefined) {
    return {
      ...note,
      changeStatus: submittedStatus,
      changeReason: "manual",
      changeAt: submittedStatus === "unread" ? now : currentNote.changeAt,
      readAt: submittedStatus === "read" ? now : "",
    };
  }

  return { ...note, ...normalizeNoteChangeMetadata(currentNote) };
}

function nextNoteId(notes) {
  const usedIds = new Set(notes.map((note) => note.id));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const id = `star-${suffix}`;
    if (!usedIds.has(id)) return id;
  }
  throw requestError("暂时无法生成新的星星编号，请重试", 503);
}

function normalizeNotesDocument(raw) {
  if (!raw || !Array.isArray(raw.notes)) throw new Error("notes.json must contain a notes array");
  if (raw.notes.length > MAX_NOTE_COUNT) {
    throw new Error(`notes.json cannot contain more than ${MAX_NOTE_COUNT} notes`);
  }

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
      ...normalizeNoteChangeMetadata(note),
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

function emptyLoveStarsMessagesDocument() {
  return { version: 1, updatedAt: new Date().toISOString(), messages: [] };
}

function normalizeLoveStarsMessagesDocument(raw) {
  if (!raw || !Array.isArray(raw.messages)) return emptyLoveStarsMessagesDocument();
  const seen = new Set();
  const messages = raw.messages.slice(-LOVE_STARS_MESSAGE_MAX_COUNT).flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const numericId = typeof message.id === "number"
      ? message.id
      : typeof message.id === "string" && /^\d{1,16}$/.test(message.id)
        ? Number(message.id)
        : 0;
    const content = typeof message.content === "string" ? message.content.trim() : "";
    if (!Number.isSafeInteger(numericId) || numericId < 1 || !content ||
      content.length > LOVE_STARS_MESSAGE_MAX_LENGTH || seen.has(numericId)) return [];
    seen.add(numericId);
    return [{
      id: numericId,
      content,
      created_at: typeof message.created_at === "string" ? message.created_at : "",
    }];
  });
  return {
    version: Number.isSafeInteger(raw.version) && raw.version > 0 ? raw.version : 1,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    messages,
  };
}

function readLoveStarsMessages(messagesFile) {
  try {
    return normalizeLoveStarsMessagesDocument(JSON.parse(fs.readFileSync(messagesFile, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return emptyLoveStarsMessagesDocument();
    throw error;
  }
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number));
}

function emptyWrongCounterDocument() {
  return {
    version: 1,
    totalHits: 0,
    visitors: Object.create(null),
    updatedAt: new Date().toISOString(),
    hitHistory: [],
  };
}

function normalizeWrongCounterDocument(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyWrongCounterDocument();
  }

  const visitors = Object.create(null);
  const visitorSource = raw.visitors && typeof raw.visitors === "object" && !Array.isArray(raw.visitors)
    ? raw.visitors
    : raw.visitorCounts && typeof raw.visitorCounts === "object" && !Array.isArray(raw.visitorCounts)
      ? raw.visitorCounts
      : {};
  let visitorTotal = 0;
  for (const [id, rawCount] of Object.entries(visitorSource)) {
    if (!WRONG_VISITOR_ID_PATTERN.test(id)) continue;
    const count = normalizeNonNegativeInteger(rawCount);
    if (!count) continue;
    visitors[id] = count;
    visitorTotal = Math.min(Number.MAX_SAFE_INTEGER, visitorTotal + count);
  }

  const historySource = Array.isArray(raw.hitHistory)
    ? raw.hitHistory
    : Array.isArray(raw.recentHits)
      ? raw.recentHits
      : [];
  const hitHistory = historySource.flatMap((record) => {
    if (!record || typeof record !== "object") return [];
    const rawTimestamp = record.at ?? record.timestamp ?? record.time ?? record.createdAt;
    const timestamp = Date.parse(rawTimestamp);
    if (!Number.isFinite(timestamp)) return [];
    const rawVisitorId = record.visitorId ?? record.visitor ?? record.id;
    const visitorId = typeof rawVisitorId === "string" && WRONG_VISITOR_ID_PATTERN.test(rawVisitorId)
      ? rawVisitorId
      : null;
    return [{ visitorId, at: new Date(timestamp).toISOString() }];
  }).sort((left, right) => right.at.localeCompare(left.at)).slice(0, WRONG_COUNTER_HISTORY_LIMIT);

  const submittedTotal = normalizeNonNegativeInteger(raw.totalHits ?? raw.total);
  const totalHits = Math.max(submittedTotal, visitorTotal, hitHistory.length);
  const normalizedUpdatedAt = normalizeTimestamp(raw.updatedAt);
  return {
    version: Number.isSafeInteger(raw.version) && raw.version > 0 ? raw.version : 1,
    totalHits,
    visitors,
    updatedAt: normalizedUpdatedAt || hitHistory[0]?.at || new Date().toISOString(),
    hitHistory,
  };
}

function readWrongCounter(counterFile) {
  try {
    return normalizeWrongCounterDocument(JSON.parse(fs.readFileSync(counterFile, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return emptyWrongCounterDocument();
    throw error;
  }
}

function wrongCounterSnapshot(document) {
  const visitors = Object.entries(document.visitors)
    .map(([id, hits]) => ({ id, hits, count: hits }))
    .sort((left, right) => right.hits - left.hits || left.id.localeCompare(right.id));
  const recentHits = document.hitHistory.map((record) => ({
    visitorId: record.visitorId,
    at: record.at,
    timestamp: record.at,
  }));
  return {
    ok: true,
    totalHits: document.totalHits,
    total: document.totalHits,
    visitorCount: visitors.length,
    visitors,
    updatedAt: document.updatedAt,
    hitHistory: recentHits,
    recentHits,
    historyLimit: WRONG_COUNTER_HISTORY_LIMIT,
    historyTruncated: document.totalHits > recentHits.length,
  };
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

function readPortalSettings(settingsFile, featureIds) {
  try {
    return normalizePortalSettingsDocument(
      JSON.parse(fs.readFileSync(settingsFile, "utf8")),
      featureIds,
    );
  } catch (error) {
    if (error.code === "ENOENT") return emptyPortalSettingsDocument();
    throw error;
  }
}

function readPortalActivity(activityFile, featurePaths) {
  try {
    return normalizePortalActivityDocument(
      JSON.parse(fs.readFileSync(activityFile, "utf8")),
      featurePaths,
    );
  } catch (error) {
    if (error.code === "ENOENT") return emptyPortalActivityDocument();
    throw error;
  }
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertOnlyKeys(value, allowedKeys, label) {
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected) throw requestError(`${label}包含不支持的字段：${unexpected}`);
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

function readSettings(settingsFile, passwordOverride, authOptions = {}) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const ownerPassword = passwordOverride || raw.ownerPassword || process.env.OWNER_PASSWORD;
  if (typeof ownerPassword !== "string" || ownerPassword.length < 6) {
    throw new Error("Set OWNER_PASSWORD or provide data/settings.json with an ownerPassword of at least 6 characters");
  }
  // Site access is deliberately separate from the owner/editor session. It
  // defaults to the existing owner password so an installation gets the new
  // gate without a data migration, while allowing a distinct credential in
  // production through SITE_USERNAME/SITE_PASSWORD.
  const siteUsername = authOptions.siteUsername || authOptions.username ||
    raw.siteUsername || process.env.SITE_USERNAME || "QbaiW";
  const sitePassword = authOptions.sitePassword || authOptions.password ||
    raw.sitePassword || process.env.SITE_PASSWORD || ownerPassword;
  // The owner/editor login uses its own account (username + password), separate
  // from the visitor/site credential. Stored values win over the environment so
  // a change made in the admin panel survives a restart.
  const ownerUsername = authOptions.ownerUsername ||
    raw.ownerUsername || process.env.OWNER_USERNAME || siteUsername;
  if (typeof ownerUsername !== "string" || ownerUsername.length < 1 || ownerUsername.length > 128) {
    throw new Error("OWNER_USERNAME must contain 1 to 128 characters");
  }
  if (typeof siteUsername !== "string" || siteUsername.length < 1 || siteUsername.length > 128) {
    throw new Error("SITE_USERNAME must contain 1 to 128 characters");
  }
  if (typeof sitePassword !== "string" || sitePassword.length < 6) {
    throw new Error("SITE_PASSWORD must contain at least 6 characters");
  }
  const configuredHours = Number(process.env.SESSION_HOURS || raw.sessionHours);
  return {
    ownerUsername,
    ownerPassword,
    siteUsername,
    sitePassword,
    sessionHours: Number.isFinite(configuredHours)
      ? Math.min(168, Math.max(1, configuredHours))
      : DEFAULT_SESSION_HOURS,
  };
}

function normalizeSettingsDocument(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("账号配置必须是对象");
  }
  const ownerUsername = typeof raw.ownerUsername === "string" ? raw.ownerUsername.trim() : "";
  const ownerPassword = typeof raw.ownerPassword === "string" ? raw.ownerPassword : "";
  const siteUsername = typeof raw.siteUsername === "string" ? raw.siteUsername.trim() : "";
  const sitePassword = typeof raw.sitePassword === "string" ? raw.sitePassword : "";
  if (ownerUsername.length < 1 || ownerUsername.length > 128) {
    throw new Error("管理员账号必须为 1 到 128 个字符");
  }
  if (ownerPassword.length < 6) {
    throw new Error("管理员密码至少 6 个字符");
  }
  if (siteUsername.length < 1 || siteUsername.length > 128) {
    throw new Error("访客账号必须为 1 到 128 个字符");
  }
  if (sitePassword.length < 6) {
    throw new Error("访客密码至少 6 个字符");
  }
  const configuredHours = Number(raw.sessionHours);
  return {
    ownerUsername,
    ownerPassword,
    siteUsername,
    sitePassword,
    sessionHours: Number.isFinite(configuredHours)
      ? Math.min(168, Math.max(1, configuredHours))
      : DEFAULT_SESSION_HOURS,
  };
}

function createStarBottleServer(options = {}) {
  const publicDir = options.publicDir || DEFAULT_PUBLIC_DIR;
  const realPublicDir = fs.realpathSync(publicDir);
  const featureRegistry = createFeatureRegistry(options.featureRegistry || FEATURE_REGISTRY);
  const disabledFeatureEntries = new Set(
    featureRegistry.filter((feature) => !feature.enabled).map((feature) => feature.entry),
  );
  const disabledFeaturePaths = featureRegistry
    .filter((feature) => !feature.enabled)
    .map((feature) => feature.path);
  const enabledFeatureIds = new Set(
    featureRegistry.filter((feature) => feature.enabled).map((feature) => feature.id),
  );
  const registeredFeatureIds = new Set(featureRegistry.map((feature) => feature.id));
  const registeredFeaturePathsById = new Map(
    featureRegistry.map((feature) => [feature.id, feature.path]),
  );
  const registeredFeatureByEntry = new Map(
    featureRegistry.map((feature) => [feature.entry, feature]),
  );
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const notesFile = path.join(dataDir, "notes.json");
  const settingsFile = path.join(dataDir, "settings.json");
  const activityFile = path.join(dataDir, "activity.json");
  const devicesFile = path.join(dataDir, "owner-devices.json");
  const favoritesFile = path.join(dataDir, "favorites.json");
  const loveStarsMessagesFile = path.join(dataDir, "love-stars-messages.json");
  const wrongCounterFile = path.join(dataDir, "wrong-counter.json");
  const portalSettingsFile = path.join(dataDir, "portal-settings.json");
  const portalActivityFile = path.join(dataDir, "portal-activity.json");
  let settings = readSettings(settingsFile, options.ownerPassword, options);
  // The public site is protected by default. Tests and local migration tools
  // can explicitly opt out through constructor options without exposing a
  // production environment switch that could disable the gate by accident.
  const explicitSiteAuth = options.siteAuth ?? options.requireSiteAuth ??
    (options.disableSiteAuth === undefined ? undefined : !options.disableSiteAuth);
  const siteAuthEnabled = explicitSiteAuth !== false;
  let notesDocument = readNotes(notesFile);
  let notesSignature = JSON.stringify(notesDocument);
  let activityDocument = readActivity(activityFile);
  let ownerDevicesDocument = readOwnerDevices(devicesFile);
  let favoritesDocument = readFavorites(favoritesFile);
  let favoritesSignature = JSON.stringify(favoritesDocument);
  let loveStarsMessagesDocument = readLoveStarsMessages(loveStarsMessagesFile);
  let wrongCounterDocument = readWrongCounter(wrongCounterFile);
  let portalSettingsDocument = readPortalSettings(portalSettingsFile, registeredFeatureIds);
  let portalActivityDocument = readPortalActivity(portalActivityFile, registeredFeaturePathsById);
  let watcher = null;
  let reloadTimer = null;
  let favoritesReloadTimer = null;

  const sessions = new Map();
  const siteSessions = new Map();
  const loginAttempts = new Map();
  const siteLoginAttempts = new Map();
  const activityAttempts = new Map();
  const favoriteAttempts = new Map();
  const loveStarsMessageAttempts = new Map();
  const wrongHitAttempts = new Map();
  const portalActivityAttempts = new Map();
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

  function siteSessionFor(request) {
    const cookieToken = parseCookies(request.headers.cookie).get(SITE_SESSION_COOKIE);
    const authorization = String(request.headers.authorization || "");
    const bearerMatch = authorization.match(/^Bearer\s+([A-Za-z0-9_-]{32,128})$/i);
    const candidates = [cookieToken, bearerMatch?.[1]].filter(Boolean);
    for (const token of candidates) {
      const session = siteSessions.get(token);
      if (session?.expiresAt > Date.now()) return { token, ...session };
      siteSessions.delete(token);
    }
    return null;
  }

  function hasSiteAccess(request) {
    // Keep the public site credential separate from the owner/editor session.
    // Knowing the owner password alone must not bypass the account prompt.
    return Boolean(siteSessionFor(request));
  }

  function isSiteAuthEndpoint(pathname) {
    return pathname === "/api/site/login" ||
      pathname === "/api/site/login/" ||
      pathname === "/api/site/logout" ||
      pathname === "/api/site/logout/" ||
      pathname === "/api/site/status" ||
      pathname === "/api/site/status/" ||
      pathname === "/api/auth/login" ||
      pathname === "/api/auth/login/" ||
      pathname === "/api/auth/logout" ||
      pathname === "/api/auth/logout/" ||
      pathname === "/api/auth/status" ||
      pathname === "/api/auth/status/";
  }

  function isPublicSitePath(pathname) {
    return pathname === "/login" ||
      pathname === "/login/" ||
      pathname === LOGIN_ENTRY ||
      pathname === "/login.css" ||
      pathname === "/login.js" ||
      pathname === "/favicon.png" ||
      pathname === "/favicon-180.png" ||
      pathname === "/api/health" ||
      isSiteAuthEndpoint(pathname) ||
      pathname === "/api/owner/login" ||
      pathname === "/api/owner/login/" ||
      pathname === "/api/owner/logout" ||
      pathname === "/api/owner/logout/" ||
      pathname === "/api/owner/status" ||
      pathname === "/api/owner/status/";
  }

  // Admin/owner APIs are protected by the owner session, not the visitor/site
  // session. Letting the site gate block them is what made an expired site
  // session look like a *repeated* owner login prompt: the owner logs in, the
  // gate still refuses /api/owner/* until a visitor session exists, and the
  // dialog reopens forever. So owner APIs bypass the site gate entirely.
  function isOwnerApiPath(pathname) {
    return pathname === "/api/owner" ||
      pathname.startsWith("/api/owner/");
  }

  function writeSiteAuthRequired(request, response, pathname = "") {
    // API callers need a machine-readable response. Every other request is a
    // browser/page/resource request and is sent through the login page. The
    // return target is always a same-origin path derived from the request URL.
    if (!String(pathname).startsWith("/api/")) {
      let parsed;
      try {
        parsed = new URL(request.url || "/", "http://localhost");
      } catch {
        parsed = new URL("/", "http://localhost");
      }
      let returnPath = `${parsed.pathname}${parsed.search}`;
      if (
        !returnPath.startsWith("/") ||
        returnPath.startsWith("//") ||
        returnPath.includes("\\")
      ) returnPath = "/home";
      const encoded = encodeURIComponent(returnPath.slice(0, 512));
      response.writeHead(302, {
        Location: `/login?return=${encoded}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      response.end();
      return;
    }
    writeJson(response, 401, { error: "Site login required", code: "SITE_LOGIN_REQUIRED" }, {
      "WWW-Authenticate": "Bearer",
    });
  }

  function portalVisitorFor(request, { create = true } = {}) {
    const existing = parseCookies(request.headers.cookie).get(PORTAL_VISITOR_COOKIE) || "";
    if (PORTAL_VISITOR_ID_PATTERN.test(existing)) return { id: existing, created: false };
    if (!create) return { id: "", created: false };
    return {
      id: `portal_${crypto.randomBytes(18).toString("base64url")}`,
      created: true,
    };
  }

  function sendEvent(response, eventName, payload) {
    response.write(`event: ${eventName}\n`);
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function closeEventClient(clientId, client) {
    eventClients.delete(clientId);
    client.response.end();
  }

  function closeSiteEventClients(siteToken) {
    if (!siteToken) return;
    for (const [clientId, client] of eventClients) {
      if (client.siteToken === siteToken) closeEventClient(clientId, client);
    }
  }

  function broadcast(eventName, payload) {
    const now = Date.now();
    for (const [clientId, client] of eventClients) {
      const siteSession = client.siteToken ? siteSessions.get(client.siteToken) : null;
      if (siteAuthEnabled && (!siteSession || siteSession.expiresAt <= now)) {
        if (client.siteToken) siteSessions.delete(client.siteToken);
        closeEventClient(clientId, client);
        continue;
      }
      sendEvent(client.response, eventName, payload);
    }
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

  function saveLoveStarsMessages(nextDocument) {
    const persisted = writeJsonFileSafely(
      loveStarsMessagesFile,
      nextDocument,
      normalizeLoveStarsMessagesDocument,
      "七夕留言",
    );
    loveStarsMessagesDocument = persisted;
    return persisted;
  }

  function saveWrongCounter(nextDocument) {
    const persisted = writeJsonFileSafely(
      wrongCounterFile,
      nextDocument,
      normalizeWrongCounterDocument,
      "敲打计数",
    );
    wrongCounterDocument = persisted;
    return persisted;
  }

  function savePortalSettings(nextDocument) {
    const persisted = writeJsonFileSafely(
      portalSettingsFile,
      nextDocument,
      (raw) => normalizePortalSettingsDocument(raw, registeredFeatureIds),
      "主页设置",
    );
    portalSettingsDocument = persisted;
    return persisted;
  }

  function saveSettings(nextDocument) {
    const persisted = writeJsonFileSafely(
      settingsFile,
      nextDocument,
      normalizeSettingsDocument,
      "账号配置",
    );
    settings = persisted;
    return persisted;
  }

  function savePortalActivity(nextDocument) {
    const persisted = writeJsonFileSafely(
      portalActivityFile,
      nextDocument,
      (raw) => normalizePortalActivityDocument(raw, registeredFeaturePathsById),
      "主页访问记录",
    );
    portalActivityDocument = persisted;
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

  function isRateLimited(request, attemptsByAddress = loginAttempts) {
    const address = clientAddress(request);
    const now = Date.now();
    const recent = (attemptsByAddress.get(address) || [])
      .filter((time) => now - time < LOGIN_WINDOW_MS);
    attemptsByAddress.set(address, recent);
    return recent.length >= LOGIN_ATTEMPT_LIMIT;
  }

  function recordFailedLogin(request, attemptsByAddress = loginAttempts) {
    const address = clientAddress(request);
    const recent = attemptsByAddress.get(address) || [];
    recent.push(Date.now());
    attemptsByAddress.set(address, recent);
  }

  function clearFailedLogins(request, attemptsByAddress = loginAttempts) {
    attemptsByAddress.delete(clientAddress(request));
  }

  function activityRateLimited(request) {
    const address = clientAddress(request);
    const now = Date.now();
    const recent = (activityAttempts.get(address) || []).filter((time) => now - time < 60_000);
    recent.push(now);
    activityAttempts.set(address, recent);
    return recent.length > 180;
  }

  function portalActivityRateLimited(request) {
    const address = clientAddress(request);
    const now = Date.now();
    const recent = (portalActivityAttempts.get(address) || [])
      .filter((time) => now - time < PORTAL_ACTIVITY_WINDOW_MS);
    recent.push(now);
    portalActivityAttempts.set(address, recent);
    return recent.length > PORTAL_ACTIVITY_LIMIT;
  }

  function favoriteRateLimited(request) {
    const address = clientAddress(request);
    const now = Date.now();
    const recent = (favoriteAttempts.get(address) || []).filter((time) => now - time < 60_000);
    recent.push(now);
    favoriteAttempts.set(address, recent);
    return recent.length > 120;
  }

  function loveStarsMessageRateLimited(request) {
    const address = clientAddress(request);
    const now = Date.now();
    const recent = (loveStarsMessageAttempts.get(address) || [])
      .filter((time) => now - time < LOVE_STARS_MESSAGE_WINDOW_MS);
    recent.push(now);
    loveStarsMessageAttempts.set(address, recent);
    return recent.length > 1;
  }

  function wrongHitRateLimited(request) {
    const address = clientAddress(request);
    const now = Date.now();
    const recent = (wrongHitAttempts.get(address) || [])
      .filter((time) => now - time < WRONG_HIT_WINDOW_MS);
    recent.push(now);
    wrongHitAttempts.set(address, recent);
    return recent.length > WRONG_HIT_LIMIT;
  }

  function portalVisitorIsOwner(request, visitorId) {
    return Boolean(sessionFor(request)) || ownerDevicesDocument.devices.some((device) => device.id === visitorId);
  }

  function recordPortalPageActivity(request, visitorId, feature = null) {
    if (request.method !== "GET" || portalVisitorIsOwner(request, visitorId)) return false;
    if (portalActivityRateLimited(request)) return false;
    const at = new Date().toISOString();
    const event = {
      id: crypto.randomUUID(),
      visitorId,
      type: feature ? "feature-open" : "visit",
      featureId: feature?.id || null,
      path: feature?.path || "/home",
      at,
    };
    try {
      savePortalActivity({
        version: portalActivityDocument.version + 1,
        updatedAt: at,
        entries: [...portalActivityDocument.entries, event].slice(-MAX_PORTAL_ACTIVITY_ENTRIES),
      });
      return true;
    } catch (error) {
      console.error(`[portal] Could not record ${event.path}: ${error.message}`);
      return false;
    }
  }

  function recordRegisteredEntryActivity(request, visitorId, pathname) {
    const normalizedPath = pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
    const feature = registeredFeatureByEntry.get(normalizedPath) || null;
    const isPortalEntry = normalizedPath === PORTAL_ENTRY;
    if (!feature && !isPortalEntry) return false;
    return recordPortalPageActivity(request, visitorId, feature);
  }

  function forgetPortalVisitor(visitorId) {
    if (!PORTAL_VISITOR_ID_PATTERN.test(visitorId)) return;
    const remainingEntries = portalActivityDocument.entries.filter((entry) => entry.visitorId !== visitorId);
    if (remainingEntries.length !== portalActivityDocument.entries.length) {
      savePortalActivity({
        version: portalActivityDocument.version + 1,
        updatedAt: new Date().toISOString(),
        entries: remainingEntries,
      });
    }
    if (Object.prototype.hasOwnProperty.call(portalSettingsDocument.visitorLabels, visitorId)) {
      const visitorLabels = { ...portalSettingsDocument.visitorLabels };
      delete visitorLabels[visitorId];
      savePortalSettings({
        version: portalSettingsDocument.version + 1,
        updatedAt: new Date().toISOString(),
        announcement: portalSettingsDocument.announcement,
        features: portalSettingsDocument.features,
        visitorLabels,
      });
    }
  }

  function publicPortalAnnouncement() {
    const text = portalSettingsDocument.announcement.text;
    const enabled = portalSettingsDocument.announcement.enabled && Boolean(text);
    return { enabled, text: enabled ? text : "" };
  }

  function publicPortalFeatures() {
    return listPublicFeatures(featureRegistry).map((feature) => {
      const override = portalSettingsDocument.features[feature.id];
      return {
        ...feature,
        title: override?.title || feature.title,
        description: override?.description || feature.description,
        featured: override?.featured === true,
        accent: PORTAL_ACCENTS.has(override?.accent) ? override.accent : "default",
      };
    });
  }

  function ownerPortalSettings() {
    const featureSettings = {};
    for (const feature of featureRegistry.filter((candidate) => candidate.enabled)) {
      const override = portalSettingsDocument.features[feature.id];
      featureSettings[feature.id] = {
        title: override?.title || "",
        description: override?.description || "",
        featured: override?.featured === true,
        accent: PORTAL_ACCENTS.has(override?.accent) ? override.accent : "default",
      };
    }
    return {
      version: portalSettingsDocument.version,
      updatedAt: portalSettingsDocument.updatedAt,
      announcement: { ...portalSettingsDocument.announcement },
      features: featureSettings,
    };
  }

  function portalVisitorSummaries() {
    const summaries = new Map();
    for (const [id, label] of Object.entries(portalSettingsDocument.visitorLabels)) {
      summaries.set(id, {
        id,
        name: label.name,
        remark: label.remark,
        firstSeenAt: "",
        lastSeenAt: "",
        visitCount: 0,
        featureOpenCount: 0,
        totalEvents: 0,
        lastFeatureId: null,
        featureCounts: {},
      });
    }
    for (const entry of portalActivityDocument.entries) {
      const label = portalSettingsDocument.visitorLabels[entry.visitorId] || {};
      const summary = summaries.get(entry.visitorId) || {
        id: entry.visitorId,
        name: label.name || "",
        remark: label.remark || "",
        firstSeenAt: entry.at,
        lastSeenAt: entry.at,
        visitCount: 0,
        featureOpenCount: 0,
        totalEvents: 0,
        lastFeatureId: null,
        featureCounts: {},
      };
      if (!summary.firstSeenAt || entry.at < summary.firstSeenAt) summary.firstSeenAt = entry.at;
      if (!summary.lastSeenAt || entry.at >= summary.lastSeenAt) {
        summary.lastSeenAt = entry.at;
        if (entry.featureId) summary.lastFeatureId = entry.featureId;
      }
      summary.totalEvents += 1;
      if (entry.type === "visit") summary.visitCount += 1;
      if (entry.type === "feature-open") {
        summary.featureOpenCount += 1;
        summary.featureCounts[entry.featureId] = (summary.featureCounts[entry.featureId] || 0) + 1;
      }
      summaries.set(entry.visitorId, summary);
    }
    return [...summaries.values()]
      .map((summary) => ({
        ...summary,
        visitorId: summary.id,
        eventCount: summary.totalEvents,
      }))
      .sort((left, right) =>
        String(right.lastSeenAt).localeCompare(String(left.lastSeenAt)) || left.id.localeCompare(right.id),
      );
  }

  function ownerPortalSnapshot() {
    const features = publicPortalFeatures();
    const featureById = new Map(features.map((feature) => [feature.id, feature]));
    const entries = portalActivityDocument.entries.slice().reverse().map((entry) => {
      const label = portalSettingsDocument.visitorLabels[entry.visitorId] || {};
      const feature = entry.featureId ? featureById.get(entry.featureId) : null;
      return {
        ...entry,
        visitorName: label.name || "",
        visitorRemark: label.remark || "",
        featureTitle: feature?.title || "",
        feature: feature
          ? { id: feature.id, title: feature.title, path: feature.path }
          : null,
      };
    });
    return {
      settings: ownerPortalSettings(),
      credentials: {
        ownerUsername: settings.ownerUsername,
        siteUsername: settings.siteUsername,
      },
      features,
      visitors: portalVisitorSummaries(),
      activity: {
        version: portalActivityDocument.version,
        updatedAt: portalActivityDocument.updatedAt,
        limit: MAX_PORTAL_ACTIVITY_ENTRIES,
        entries,
      },
    };
  }

  function safeRegisteredEntry(entry) {
    if (typeof entry !== "string" || !entry.startsWith("/")) return null;
    const candidate = path.resolve(realPublicDir, `.${entry}`);
    const relative = path.relative(realPublicDir, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return candidate;
  }

  async function resolveRegisteredEntry(entry) {
    const candidate = safeRegisteredEntry(entry);
    if (!candidate) return null;
    try {
      const realCandidate = await fs.promises.realpath(candidate);
      const relative = path.relative(realPublicDir, realCandidate);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
      return realCandidate;
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    }
  }

  async function serveRegisteredPage(request, response, pathname) {
    if (request.method !== "GET" && request.method !== "HEAD") return false;

    if (pathname === "/") {
      const portalPath = await resolveRegisteredEntry(PORTAL_ENTRY);
      if (!portalPath) return false;
      const stats = await fs.promises.stat(portalPath);
      if (!stats.isFile()) return false;
      response.writeHead(302, {
        Location: "/home",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      response.end();
      return true;
    }

    const normalizedPath = pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
    const isLoginPage = normalizedPath === "/login";
    const feature = normalizedPath === "/home" || isLoginPage
      ? null
      : featureForPath(normalizedPath, featureRegistry);
    const entry = isLoginPage
      ? LOGIN_ENTRY
      : normalizedPath === "/home"
      ? PORTAL_ENTRY
      : feature?.entry;
    if (!entry) return false;

    const entryPath = await resolveRegisteredEntry(entry);
    if (!entryPath) return false;
    if (request.method === "GET" && !isLoginPage) {
      const visitor = portalVisitorFor(request);
      if (visitor.created) response.setHeader("Set-Cookie", portalVisitorCookie(visitor.id, request));
      recordPortalPageActivity(request, visitor.id, feature);
    }
    return serveFile(request, response, entryPath);
  }

  async function handleApi(request, response, pathname) {
    const siteAuthMatch = pathname.match(/^\/api\/(?:auth|site)\/(login|logout|status)\/?$/);
    if (siteAuthMatch) {
      const action = siteAuthMatch[1];
      if (request.method === "OPTIONS") {
        writeJson(response, 200, { ok: true }, {
          Allow: action === "login" ? "POST, OPTIONS" : action === "status" ? "GET, HEAD, OPTIONS" : "POST, OPTIONS",
          "Access-Control-Allow-Methods": action === "login" || action === "logout"
            ? "POST, OPTIONS"
            : "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "Accept, Content-Type, Authorization",
        });
        return true;
      }

      if (action === "status" && (request.method === "GET" || request.method === "HEAD")) {
        writeJson(response, 200, {
          // When enforcement is disabled, every request is effectively
          // authenticated from the caller's perspective.
          authenticated: siteAuthEnabled ? hasSiteAccess(request) : true,
        }, { Allow: "GET, HEAD, OPTIONS" });
        return true;
      }

      if (action === "logout" && request.method === "POST") {
        const session = siteSessionFor(request);
        if (session) {
          siteSessions.delete(session.token);
          closeSiteEventClients(session.token);
        }
        writeJson(response, 200, { authenticated: false }, {
          Allow: "POST, OPTIONS",
          "Set-Cookie": siteSessionCookie("", request, 0),
        });
        return true;
      }

      if (action === "login" && request.method === "POST") {
        if (isRateLimited(request, siteLoginAttempts)) {
          writeJson(response, 429, { error: "登录尝试次数过多，请稍后再试", code: "LOGIN_RATE_LIMITED" }, {
            Allow: "POST, OPTIONS",
          });
          return true;
        }

        try {
          const body = await readJsonBody(request);
          const submittedUsername = typeof body.username === "string"
            ? body.username
            : typeof body.account === "string"
              ? body.account
              : "";
          const submittedPassword = typeof body.password === "string" ? body.password : "";
          // Evaluate both comparisons before branching so a bad username does
          // not skip the password comparison and create an avoidable timing
          // distinction.
          const usernameMatches = safeEqual(submittedUsername, settings.siteUsername);
          const passwordMatches = safeEqual(submittedPassword, settings.sitePassword);
          if (!usernameMatches || !passwordMatches) {
            recordFailedLogin(request, siteLoginAttempts);
            writeJson(response, 401, {
              authenticated: false,
              error: "账号或密码不正确",
              code: "INVALID_CREDENTIALS",
            }, { Allow: "POST, OPTIONS" });
            return true;
          }

          clearFailedLogins(request, siteLoginAttempts);
          const token = crypto.randomBytes(32).toString("base64url");
          const sessionSeconds = settings.sessionHours * 60 * 60;
          const expiresAt = Date.now() + sessionSeconds * 1000;
          siteSessions.set(token, { expiresAt });
          writeJson(response, 200, {
            authenticated: true,
            expiresAt: new Date(expiresAt).toISOString(),
          }, {
            Allow: "POST, OPTIONS",
            "Set-Cookie": siteSessionCookie(token, request, sessionSeconds),
          });
        } catch (error) {
          writeJson(response, error.statusCode || 400, {
            authenticated: false,
            error: error.message || "登录失败",
            code: error.storageCode,
          }, { Allow: "POST, OPTIONS" });
        }
        return true;
      }

      const allowedMethods = action === "status" ? "GET, HEAD, OPTIONS" : "POST, OPTIONS";
      writeJson(response, 405, { error: `${action === "status" ? "GET" : "POST"} is required` }, {
        Allow: allowedMethods,
      });
      return true;
    }

    const featureCatalogPath = pathname === "/api/features" || pathname === "/api/features/";
    if (featureCatalogPath && (request.method === "GET" || request.method === "HEAD")) {
      writeJson(response, 200, {
        version: 1,
        announcement: publicPortalAnnouncement(),
        features: publicPortalFeatures(),
      }, { Allow: "GET, HEAD, OPTIONS" });
      return true;
    }
    if (featureCatalogPath && request.method === "OPTIONS") {
      writeJson(response, 200, { ok: true }, {
        Allow: "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Accept, Content-Type",
      });
      return true;
    }
    if (featureCatalogPath) {
      writeJson(response, 405, { error: "GET is required" }, { Allow: "GET, HEAD, OPTIONS" });
      return true;
    }

    const loveStarsMessagePath = enabledFeatureIds.has("love-stars") &&
      (pathname === "/api/love-stars/message" ||
      pathname === "/api/love-stars/message/");
    if (loveStarsMessagePath && request.method === "OPTIONS") {
      writeJson(response, 200, { ok: true }, {
        Allow: "GET, POST, OPTIONS",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return true;
    }
    if (loveStarsMessagePath && (request.method === "GET" || request.method === "HEAD")) {
      writeJson(response, 200, {
        messages: loveStarsMessagesDocument.messages.slice().reverse(),
      }, { Allow: "GET, POST, OPTIONS" });
      return true;
    }

    if (loveStarsMessagePath && request.method === "POST") {
      try {
        const body = await readJsonBody(request);
        const content = typeof body.content === "string" ? body.content.trim() : "";
        if (!content) {
          writeJson(response, 400, { success: false, error: "留言内容不能为空" });
          return true;
        }
        if (content.length > LOVE_STARS_MESSAGE_MAX_LENGTH) {
          writeJson(response, 400, {
            success: false,
            error: `留言不能超过 ${LOVE_STARS_MESSAGE_MAX_LENGTH} 字`,
          });
          return true;
        }
        const lowerContent = content.toLowerCase();
        if (LOVE_STARS_BLOCKED_WORDS.some((word) => lowerContent.includes(word.toLowerCase()))) {
          writeJson(response, 400, { success: false, error: "留言包含不合适的内容，换一句吧" });
          return true;
        }
        if (loveStarsMessageRateLimited(request)) {
          writeJson(response, 429, { success: false, error: "发送太快啦，歇几秒再试" });
          return true;
        }

        const previousIds = new Set(loveStarsMessagesDocument.messages.map((message) => message.id));
        let id = Date.now();
        while (previousIds.has(id)) id += 1;
        const now = new Date();
        const message = {
          id,
          content,
          created_at: now.toISOString().replace("T", " ").slice(0, 19),
        };
        const persisted = saveLoveStarsMessages({
          version: loveStarsMessagesDocument.version + 1,
          updatedAt: now.toISOString(),
          messages: [...loveStarsMessagesDocument.messages, message].slice(-LOVE_STARS_MESSAGE_MAX_COUNT),
        });
        writeJson(response, 200, { success: true, id: message.id, version: persisted.version });
      } catch (error) {
        writeJson(response, error.statusCode || 400, {
          success: false,
          error: error.message || "留言保存失败",
          code: error.storageCode,
        });
      }
      return true;
    }
    if (loveStarsMessagePath) {
      writeJson(response, 405, { success: false, error: "GET or POST is required" }, {
        Allow: "GET, POST, OPTIONS",
      });
      return true;
    }

    const wrongHitPath = enabledFeatureIds.has("wrong") &&
      (pathname === "/api/wrong/hit" || pathname === "/api/wrong/hit/");
    if (wrongHitPath) {
      if (request.method === "OPTIONS") {
        writeJson(response, 200, { ok: true }, {
          Allow: "POST, OPTIONS",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Visitor-Id",
        });
        return true;
      }
      if (request.method !== "POST") {
        writeJson(response, 405, { ok: false, error: "POST is required." }, { Allow: "POST, OPTIONS" });
        return true;
      }
      if (wrongHitRateLimited(request)) {
        writeJson(response, 429, { ok: false, error: "敲打太频繁，请稍后再试" });
        return true;
      }

      try {
        const body = await readJsonBody(request);
        let suppliedVisitorId;
        if (body && typeof body === "object" && !Array.isArray(body)) {
          for (const field of ["visitorId", "visitor", "id"]) {
            if (Object.prototype.hasOwnProperty.call(body, field)) {
              suppliedVisitorId = body[field];
              break;
            }
          }
        }
        if (suppliedVisitorId === undefined || suppliedVisitorId === null || suppliedVisitorId === "") {
          suppliedVisitorId = request.headers["x-visitor-id"];
        }
        if (suppliedVisitorId === undefined || suppliedVisitorId === null || suppliedVisitorId === "") {
          suppliedVisitorId = parseCookies(request.headers.cookie).get("qe_visitor");
        }

        let visitorId = suppliedVisitorId === undefined || suppliedVisitorId === null || suppliedVisitorId === ""
          ? crypto.randomUUID().replaceAll("-", "")
          : String(suppliedVisitorId).trim();
        if (!WRONG_VISITOR_ID_PATTERN.test(visitorId)) {
          writeJson(response, 400, {
            ok: false,
            error: "visitorId must be 4-128 ASCII letters, numbers, hyphens, or underscores.",
          });
          return true;
        }

        const currentVisitorHits = normalizeNonNegativeInteger(wrongCounterDocument.visitors[visitorId]);
        const currentTotalHits = normalizeNonNegativeInteger(wrongCounterDocument.totalHits);
        const visitorHits = currentVisitorHits >= Number.MAX_SAFE_INTEGER
          ? Number.MAX_SAFE_INTEGER
          : currentVisitorHits + 1;
        const totalHits = currentTotalHits >= Number.MAX_SAFE_INTEGER
          ? Number.MAX_SAFE_INTEGER
          : currentTotalHits + 1;
        const at = new Date().toISOString();
        const nextDocument = {
          version: Number.isSafeInteger(wrongCounterDocument.version) && wrongCounterDocument.version > 0
            ? wrongCounterDocument.version + 1
            : 2,
          totalHits,
          visitors: { ...wrongCounterDocument.visitors, [visitorId]: visitorHits },
          updatedAt: at,
          hitHistory: [{ visitorId, at }, ...wrongCounterDocument.hitHistory]
            .slice(0, WRONG_COUNTER_HISTORY_LIMIT),
        };
        const persisted = saveWrongCounter(nextDocument);
        writeJson(response, 200, {
          ok: true,
          visitorId,
          visitorHits: persisted.visitors[visitorId],
          totalHits: persisted.totalHits,
          total: persisted.totalHits,
          at,
        }, {
          Allow: "POST, OPTIONS",
          // Keep the anonymous visitor stable across visits without exposing it
          // to page scripts. The path is site-wide so API requests receive it.
          "Set-Cookie": `qe_visitor=${visitorId}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${requestIsSecure(request) ? "; Secure" : ""}`,
        });
      } catch (error) {
        writeJson(response, error.statusCode || 400, {
          ok: false,
          error: error.message || "敲打计数保存失败",
          code: error.storageCode,
        });
      }
      return true;
    }

    const wrongStatsPath = enabledFeatureIds.has("wrong") &&
      (pathname === "/api/wrong/stats" || pathname === "/api/wrong/stats/");
    if (wrongStatsPath) {
      if (request.method === "OPTIONS") {
        writeJson(response, 200, { ok: true }, {
          Allow: "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "X-Admin-Password, Authorization",
        });
        return true;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        writeJson(response, 405, { ok: false, error: "GET is required." }, { Allow: "GET, HEAD, OPTIONS" });
        return true;
      }

      const headerPassword = String(request.headers["x-admin-password"] || "");
      const authorization = String(request.headers.authorization || "");
      const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
      let queryPassword = "";
      try {
        queryPassword = new URL(request.url || "", "http://localhost").searchParams.get("password") || "";
      } catch {
        queryPassword = "";
      }
      const candidatePassword = headerPassword || bearerMatch?.[1] || queryPassword;
      if (!candidatePassword || !safeEqual(candidatePassword, settings.ownerPassword)) {
        writeJson(response, 401, { ok: false, error: "Admin password required." }, {
          Allow: "GET, HEAD, OPTIONS",
          "WWW-Authenticate": "X-Admin-Password",
        });
        return true;
      }

      writeJson(response, 200, wrongCounterSnapshot(wrongCounterDocument), {
        Allow: "GET, HEAD, OPTIONS",
      });
      return true;
    }

    if (pathname === "/api/health" && request.method === "GET") {
      writeJson(response, 200, {
        ok: true,
        service: "star-bottle",
        uptimeSeconds: Math.floor(process.uptime()),
      });
      return true;
    }

    if (pathname === "/api/music" && request.method === "GET") {
      try {
        writeJson(response, 200, { tracks: await readMusicTracks(realPublicDir) });
      } catch (error) {
        console.error(`Could not list background music: ${error.message}`);
        writeJson(response, 500, { error: "背景音乐列表读取失败" });
      }
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
        let openedNote = notesDocument.notes.find((note) => note.id === noteId);
        if (!openedNote) {
          writeJson(response, 404, { error: "Note not found" });
          return true;
        }

        let readChanged = false;
        if (openedNote.changeStatus === "unread") {
          const readAt = new Date().toISOString();
          const nextNotes = notesDocument.notes.map((note) => note.id === noteId
            ? { ...note, changeStatus: "read", readAt }
            : note);
          const persistedNotes = await saveNotes({
            version: notesDocument.version + 1,
            updatedAt: readAt,
            notes: nextNotes,
          });
          openedNote = persistedNotes.notes.find((note) => note.id === noteId);
          readChanged = true;
          broadcast("note", {
            note: openedNote,
            version: persistedNotes.version,
            updatedAt: persistedNotes.updatedAt,
          });
          broadcast("notes", persistedNotes);
        }

        if (activityRateLimited(request)) {
          writeJson(response, 429, {
            error: "Too many activity events",
            read: true,
            readChanged,
            note: openedNote,
          });
          return true;
        }
        if (ownerDevicesDocument.devices.some((device) => device.id === visitorId)) {
          writeJson(response, 200, {
            recorded: false,
            reason: "owner-device",
            read: true,
            readChanged,
            note: openedNote,
          });
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
        writeJson(response, 201, {
          recorded: true,
          read: true,
          readChanged,
          note: openedNote,
        });
      } catch (error) {
        writeJson(response, error.statusCode || 400, { error: error.message || "Could not record activity" });
      }
      return true;
    }

    if (pathname === "/api/events" && request.method === "GET") {
      const siteSession = siteAuthEnabled ? siteSessionFor(request) : null;
      if (siteAuthEnabled && !siteSession) {
        writeSiteAuthRequired(request, response, pathname);
        return true;
      }
      const clientId = crypto.randomUUID();
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "private, no-store, no-transform",
        Vary: "Cookie",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      });
      response.write(": connected\n\n");
      eventClients.set(clientId, { response, siteToken: siteSession?.token || null });
      sendEvent(response, "notes", notesDocument);
      sendEvent(response, "favorites", favoritesDocument);
      request.on("close", () => eventClients.delete(clientId));
      return true;
    }

    if (pathname === "/api/owner/status" && request.method === "GET") {
      writeJson(response, 200, { authenticated: Boolean(sessionFor(request)) });
      return true;
    }

    const ownerPortalPath = pathname === "/api/owner/portal" || pathname === "/api/owner/portal/";
    if (ownerPortalPath && request.method === "GET") {
      if (!sessionFor(request)) {
        writeJson(response, 401, { error: "Owner login required" });
        return true;
      }
      writeJson(response, 200, ownerPortalSnapshot(), { Allow: "GET" });
      return true;
    }
    if (ownerPortalPath) {
      writeJson(response, 405, { error: "GET is required" }, { Allow: "GET" });
      return true;
    }

    const ownerPortalSettingsPath = pathname === "/api/owner/portal/settings" ||
      pathname === "/api/owner/portal/settings/";
    if (ownerPortalSettingsPath && request.method === "PUT") {
      if (!sessionFor(request)) {
        writeJson(response, 401, { error: "Owner login required" });
        return true;
      }
      try {
        const body = await readJsonBody(request);
        if (!plainObject(body)) throw requestError("主页设置格式不正确");
        assertOnlyKeys(body, new Set(["announcement", "features"]), "主页设置");

        let announcement = { ...portalSettingsDocument.announcement };
        if (body.announcement !== undefined) {
          if (!plainObject(body.announcement)) throw requestError("公告设置格式不正确");
          assertOnlyKeys(body.announcement, new Set(["enabled", "text"]), "公告设置");
          if (body.announcement.enabled !== undefined && typeof body.announcement.enabled !== "boolean") {
            throw requestError("公告启用状态必须是 true 或 false");
          }
          if (body.announcement.text !== undefined && typeof body.announcement.text !== "string") {
            throw requestError("公告内容必须是文本");
          }
          if (
            typeof body.announcement.text === "string" &&
            body.announcement.text.trim().length > MAX_ANNOUNCEMENT_LENGTH
          ) {
            throw requestError(`公告不能超过 ${MAX_ANNOUNCEMENT_LENGTH} 个字符`);
          }
          announcement = {
            enabled: body.announcement.enabled ?? announcement.enabled,
            text: body.announcement.text === undefined
              ? announcement.text
              : body.announcement.text.trim(),
          };
          if (announcement.enabled && !announcement.text) throw requestError("启用公告前请填写公告内容");
        }

        const features = { ...portalSettingsDocument.features };
        if (body.features !== undefined) {
          if (!plainObject(body.features)) throw requestError("功能设置格式不正确");
          for (const [featureId, submitted] of Object.entries(body.features)) {
            if (!registeredFeatureIds.has(featureId)) throw requestError(`找不到功能：${featureId}`, 404);
            if (!plainObject(submitted)) throw requestError(`功能 ${featureId} 的设置格式不正确`);
            assertOnlyKeys(
              submitted,
              new Set(["title", "description", "featured", "accent"]),
              `功能 ${featureId} 的设置`,
            );
            const current = features[featureId] || {
              title: "",
              description: "",
              featured: false,
              accent: "default",
            };
            if (submitted.title !== undefined && typeof submitted.title !== "string") {
              throw requestError(`功能 ${featureId} 的名称必须是文本`);
            }
            if (typeof submitted.title === "string" && submitted.title.trim().length > MAX_FEATURE_TITLE_LENGTH) {
              throw requestError(`功能名称不能超过 ${MAX_FEATURE_TITLE_LENGTH} 个字符`);
            }
            if (submitted.description !== undefined && typeof submitted.description !== "string") {
              throw requestError(`功能 ${featureId} 的说明必须是文本`);
            }
            if (
              typeof submitted.description === "string" &&
              submitted.description.trim().length > MAX_FEATURE_DESCRIPTION_LENGTH
            ) {
              throw requestError(`功能说明不能超过 ${MAX_FEATURE_DESCRIPTION_LENGTH} 个字符`);
            }
            if (submitted.featured !== undefined && typeof submitted.featured !== "boolean") {
              throw requestError(`功能 ${featureId} 的重点状态必须是 true 或 false`);
            }
            if (submitted.accent !== undefined && !PORTAL_ACCENTS.has(submitted.accent)) {
              throw requestError(`功能 ${featureId} 的强调色无效`);
            }
            features[featureId] = {
              title: submitted.title === undefined ? current.title : submitted.title.trim(),
              description: submitted.description === undefined
                ? current.description
                : submitted.description.trim(),
              featured: submitted.featured ?? current.featured,
              accent: submitted.accent ?? current.accent,
            };
          }
        }

        const persisted = savePortalSettings({
          version: portalSettingsDocument.version + 1,
          updatedAt: new Date().toISOString(),
          announcement,
          features,
          visitorLabels: portalSettingsDocument.visitorLabels,
        });
        writeJson(response, 200, {
          saved: true,
          version: persisted.version,
          settings: ownerPortalSettings(),
          features: publicPortalFeatures(),
        }, { Allow: "PUT" });
      } catch (error) {
        writeJson(response, error.statusCode || 400, {
          error: error.message || "主页设置保存失败",
          code: error.storageCode,
        });
      }
      return true;
    }
    if (ownerPortalSettingsPath) {
      writeJson(response, 405, { error: "PUT is required" }, { Allow: "PUT" });
      return true;
    }

    const ownerCredentialsPath = pathname === "/api/owner/portal/credentials" ||
      pathname === "/api/owner/portal/credentials/";
    if (ownerCredentialsPath && request.method === "GET") {
      if (!sessionFor(request)) {
        writeJson(response, 401, { error: "Owner login required" });
        return true;
      }
      writeJson(response, 200, {
        ownerUsername: settings.ownerUsername,
        siteUsername: settings.siteUsername,
      }, { Allow: "GET, PUT, OPTIONS" });
      return true;
    }
    if (ownerCredentialsPath && request.method === "PUT") {
      if (!sessionFor(request)) {
        writeJson(response, 401, { error: "Owner login required" });
        return true;
      }
      try {
        const body = await readJsonBody(request);
        if (!plainObject(body)) throw requestError("账号配置格式不正确");
        assertOnlyKeys(body, new Set(["ownerUsername", "ownerPassword", "siteUsername", "sitePassword"]), "账号配置");
        const nextSettings = {
          ownerUsername: body.ownerUsername !== undefined ? body.ownerUsername : settings.ownerUsername,
          ownerPassword: body.ownerPassword !== undefined ? body.ownerPassword : settings.ownerPassword,
          siteUsername: body.siteUsername !== undefined ? body.siteUsername : settings.siteUsername,
          sitePassword: body.sitePassword !== undefined ? body.sitePassword : settings.sitePassword,
          sessionHours: settings.sessionHours,
        };
        // Throws with a friendly message when a value is invalid.
        normalizeSettingsDocument(nextSettings);
        // Compare against the *current* settings before saveSettings rewrites
        // `settings`, so a credential that actually changed clears its sessions.
        const siteChanged = (body.siteUsername !== undefined && body.siteUsername !== settings.siteUsername) ||
          (body.sitePassword !== undefined && body.sitePassword !== settings.sitePassword);
        const ownerChanged = (body.ownerUsername !== undefined && body.ownerUsername !== settings.ownerUsername) ||
          (body.ownerPassword !== undefined && body.ownerPassword !== settings.ownerPassword);
        const persisted = saveSettings(nextSettings);
        // Only invalidate sessions for a credential that actually changed, so
        // editing e.g. just the visitor password does not log the owner out.
        if (siteChanged) siteSessions.clear();
        if (ownerChanged) sessions.clear();
        writeJson(response, 200, {
          saved: true,
          ownerUsername: persisted.ownerUsername,
          siteUsername: persisted.siteUsername,
        }, { Allow: "GET, PUT, OPTIONS" });
      } catch (error) {
        writeJson(response, error.statusCode || 400, { error: error.message || "保存失败" });
      }
      return true;
    }
    if (ownerCredentialsPath) {
      writeJson(response, 405, { error: "GET or PUT is required" }, { Allow: "GET, PUT, OPTIONS" });
      return true;
    }

    const portalVisitorMatch = pathname.match(/^\/api\/owner\/portal\/visitors\/([A-Za-z0-9_-]{8,80})$/);
    if (portalVisitorMatch && request.method === "PUT") {
      if (!sessionFor(request)) {
        writeJson(response, 401, { error: "Owner login required" });
        return true;
      }
      try {
        const visitorId = portalVisitorMatch[1];
        const knownVisitor = portalActivityDocument.entries.some((entry) => entry.visitorId === visitorId) ||
          Object.prototype.hasOwnProperty.call(portalSettingsDocument.visitorLabels, visitorId);
        if (!knownVisitor) throw requestError("找不到这位访客", 404);
        const body = await readJsonBody(request);
        if (!plainObject(body)) throw requestError("访客备注格式不正确");
        assertOnlyKeys(body, new Set(["name", "remark"]), "访客备注");
        const current = portalSettingsDocument.visitorLabels[visitorId] || { name: "", remark: "" };
        if (body.name !== undefined && typeof body.name !== "string") {
          throw requestError("访客名称必须是文本");
        }
        if (typeof body.name === "string" && body.name.trim().length > MAX_VISITOR_NAME_LENGTH) {
          throw requestError(`访客名称不能超过 ${MAX_VISITOR_NAME_LENGTH} 个字符`);
        }
        if (body.remark !== undefined && typeof body.remark !== "string") {
          throw requestError("访客备注必须是文本");
        }
        if (typeof body.remark === "string" && body.remark.trim().length > MAX_VISITOR_REMARK_LENGTH) {
          throw requestError(`访客备注不能超过 ${MAX_VISITOR_REMARK_LENGTH} 个字符`);
        }
        const label = {
          name: body.name === undefined ? current.name : body.name.trim(),
          remark: body.remark === undefined ? current.remark : body.remark.trim(),
        };
        const visitorLabels = { ...portalSettingsDocument.visitorLabels };
        if (label.name || label.remark) visitorLabels[visitorId] = label;
        else delete visitorLabels[visitorId];
        const persisted = savePortalSettings({
          version: portalSettingsDocument.version + 1,
          updatedAt: new Date().toISOString(),
          announcement: portalSettingsDocument.announcement,
          features: portalSettingsDocument.features,
          visitorLabels,
        });
        const visitor = portalVisitorSummaries().find((candidate) => candidate.id === visitorId);
        writeJson(response, 200, {
          saved: true,
          version: persisted.version,
          visitor,
        }, { Allow: "PUT" });
      } catch (error) {
        writeJson(response, error.statusCode || 400, {
          error: error.message || "访客备注保存失败",
          code: error.storageCode,
        });
      }
      return true;
    }
    if (portalVisitorMatch) {
      writeJson(response, 405, { error: "PUT is required" }, { Allow: "PUT" });
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
        // The owner/editor login requires its own account (username + password),
        // separate from the visitor/site credential.
        const submittedOwnerAccount = typeof body.username === "string"
          ? body.username
          : typeof body.account === "string"
            ? body.account
            : "";
        const accountMatches = safeEqual(submittedOwnerAccount, settings.ownerUsername);
        const passwordMatches = safeEqual(body.password || "", settings.ownerPassword);
        if (!accountMatches || !passwordMatches) {
          recordFailedLogin(request);
          writeJson(response, 401, { error: "账号或密码不正确" });
          return true;
        }

        clearFailedLogins(request);
        const submittedVisitorId = typeof body.visitorId === "string" ? body.visitorId.trim() : "";
        const portalVisitorId = portalVisitorFor(request, { create: false }).id;
        await registerOwnerDevice(
          submittedVisitorId,
          typeof body.deviceLabel === "string" ? body.deviceLabel : "主人设备",
        );
        if (portalVisitorId && portalVisitorId !== submittedVisitorId) {
          await registerOwnerDevice(portalVisitorId, "功能中心");
        }
        forgetPortalVisitor(portalVisitorId);
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

    if (pathname === "/api/owner/notes" && request.method === "POST") {
      if (!sessionFor(request)) {
        writeJson(response, 401, { error: "主人登录已失效，请重新进入编辑室" });
        return true;
      }

      try {
        const body = await readJsonBody(request);
        if (notesDocument.notes.length >= MAX_NOTE_COUNT) {
          throw requestError(`星星数量不能超过 ${MAX_NOTE_COUNT} 颗`, 409);
        }
        const requestedId = typeof body.id === "string" ? body.id.trim() : "";
        const id = requestedId || nextNoteId(notesDocument.notes);
        if (!/^[a-z0-9-]{1,40}$/.test(id)) throw requestError("星星编号无效");
        if (notesDocument.notes.some((note) => note.id === id)) {
          throw requestError("这个星星编号已经存在", 409);
        }

        const now = new Date().toISOString();
        const customTemplate = notesDocument.notes.find((note) => note.emotion === "custom") || null;
        let nextNote = buildOwnerNote(body, id, null, customTemplate);
        nextNote = applyNoteChangeMetadata(nextNote, null, body, "added", now);
        const nextNotes = notesDocument.notes.map((note) => {
          if (nextNote.emotion !== "custom" || note.emotion !== "custom") return note;
          const synchronized = {
            ...note,
            emotionLabel: nextNote.emotionLabel,
            customPosition: nextNote.customPosition,
          };
          return noteContentChanged(note, synchronized)
            ? applyNoteChangeMetadata(synchronized, note, {}, "updated", now)
            : note;
        });
        nextNotes.push(nextNote);
        const persistedDocument = await saveNotes({
          version: notesDocument.version + 1,
          updatedAt: now,
          notes: nextNotes,
        });
        const persistedNote = persistedDocument.notes.find((note) => note.id === id);
        console.log(`[notes] Added ${id}; version ${persistedDocument.version}`);
        broadcast("note", {
          note: persistedNote,
          version: persistedDocument.version,
          updatedAt: persistedDocument.updatedAt,
        });
        broadcast("notes", persistedDocument);
        writeJson(response, 201, {
          saved: true,
          created: true,
          note: persistedNote,
          document: persistedDocument,
          version: persistedDocument.version,
          updatedAt: persistedDocument.updatedAt,
        });
      } catch (error) {
        writeJson(response, error.statusCode || 400, {
          error: error.message || "新增星星失败",
          code: error.storageCode,
        });
      }
      return true;
    }

    const ownerNoteMatch = pathname.match(/^\/api\/owner\/notes\/([a-z0-9-]{1,40})$/);
    if (ownerNoteMatch && request.method === "DELETE") {
      if (!sessionFor(request)) {
        writeJson(response, 401, { error: "主人登录已失效，请重新进入编辑室" });
        return true;
      }

      try {
        const id = ownerNoteMatch[1];
        if (notesDocument.notes.length <= MIN_NOTE_COUNT) {
          throw requestError("至少需要保留一颗星星", 409);
        }
        if (!notesDocument.notes.some((note) => note.id === id)) {
          throw requestError("没有找到这颗星星", 404);
        }
        const now = new Date().toISOString();
        const persistedDocument = await saveNotes({
          version: notesDocument.version + 1,
          updatedAt: now,
          notes: notesDocument.notes.filter((note) => note.id !== id),
        });

        let persistedFavorites = favoritesDocument;
        if (favoritesDocument.noteIds.includes(id)) {
          try {
            persistedFavorites = await queueFavoriteWrite(() => saveFavorites({
              version: favoritesDocument.version + 1,
              updatedAt: now,
              noteIds: favoritesDocument.noteIds.filter((noteId) => noteId !== id),
            }));
            broadcast("favorites", persistedFavorites);
          } catch (error) {
            console.error(`Could not remove deleted note ${id} from favorites: ${error.message}`);
          }
        }

        console.log(`[notes] Deleted ${id}; version ${persistedDocument.version}`);
        broadcast("notes", persistedDocument);
        writeJson(response, 200, {
          deleted: true,
          id,
          document: persistedDocument,
          favorites: persistedFavorites,
          version: persistedDocument.version,
          updatedAt: persistedDocument.updatedAt,
        });
      } catch (error) {
        writeJson(response, error.statusCode || 400, {
          error: error.message || "删除星星失败",
          code: error.storageCode,
        });
      }
      return true;
    }

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

        const now = new Date().toISOString();
        const currentNote = notesDocument.notes[noteIndex];
        const customTemplate = notesDocument.notes.find((note) => note.emotion === "custom") || null;
        const contentNote = buildOwnerNote(body, id, currentNote, customTemplate);
        const contentChanged = noteContentChanged(currentNote, contentNote);
        const nextNote = applyNoteChangeMetadata(
          contentNote,
          currentNote,
          body,
          contentChanged ? "updated" : "unchanged",
          now,
        );
        const nextNotes = notesDocument.notes.map((note, index) => {
          if (index === noteIndex) return nextNote;
          if (nextNote.emotion !== "custom" || note.emotion !== "custom") return note;
          const synchronized = {
            ...note,
            emotionLabel: nextNote.emotionLabel,
            customPosition: nextNote.customPosition,
          };
          return noteContentChanged(note, synchronized)
            ? applyNoteChangeMetadata(synchronized, note, {}, "updated", now)
            : note;
        });
        const nextDocument = {
          version: notesDocument.version + 1,
          updatedAt: now,
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
      const cacheControl = siteAuthEnabled
        ? extension === ".html" ? "private, no-store" : "private, max-age=3600"
        : extension === ".html" ? "no-cache" : "public, max-age=3600";
      response.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": stats.size,
        "Cache-Control": cacheControl,
        ...(siteAuthEnabled ? { Vary: "Cookie" } : {}),
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
    // Reject encoded dot segments before path.resolve can collapse them into a
    // registered entry and bypass the disabled-feature guard.
    const pathSegments = decodedPath.split("/");
    if (pathSegments.some((segment) => segment === "." || segment === "..")) return false;
    const normalizedDecodedPath = decodedPath.replace(/\/{2,}/g, "/");
    if (disabledFeatureEntries.has(normalizedDecodedPath) || disabledFeaturePaths.some((featurePath) =>
      normalizedDecodedPath === featurePath || normalizedDecodedPath.startsWith(`${featurePath}/`),
    )) return false;

    const candidate = path.resolve(realPublicDir, `.${normalizedDecodedPath}`);
    const relative = path.relative(realPublicDir, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
    try {
      const realCandidate = await fs.promises.realpath(candidate);
      const realRelative = path.relative(realPublicDir, realCandidate);
      if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) return false;
      if (
        request.method === "GET" &&
        (normalizedDecodedPath === PORTAL_ENTRY || registeredFeatureByEntry.has(normalizedDecodedPath))
      ) {
        const visitor = portalVisitorFor(request);
        if (visitor.created) response.setHeader("Set-Cookie", portalVisitorCookie(visitor.id, request));
        recordRegisteredEntryActivity(request, visitor.id, normalizedDecodedPath);
      }
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

      // CORS preflight carries no application data and can be handled before
      // a session is established.
      if (siteAuthEnabled && request.method !== "OPTIONS" &&
        !isPublicSitePath(pathname) && !isOwnerApiPath(pathname) && !hasSiteAccess(request)) {
        writeSiteAuthRequired(request, response, pathname);
        return;
      }

      if (pathname.startsWith("/api/")) {
        const handled = await handleApi(request, response, pathname);
        if (!handled) writeJson(response, 404, { error: "API endpoint not found" });
        return;
      }

      const registeredPage = await serveRegisteredPage(request, response, pathname);
      if (registeredPage) return;

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
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(token);
    }
    for (const [token, session] of siteSessions) {
      if (session.expiresAt <= now) siteSessions.delete(token);
    }
    for (const [clientId, client] of eventClients) {
      if (siteAuthEnabled && (!client.siteToken || !siteSessions.has(client.siteToken))) {
        closeEventClient(clientId, client);
        continue;
      }
      client.response.write(": heartbeat\n\n");
    }
    for (const attemptsByAddress of [loginAttempts, siteLoginAttempts]) {
      for (const [address, attempts] of attemptsByAddress) {
        const recent = attempts.filter((time) => now - time < LOGIN_WINDOW_MS);
        if (recent.length) attemptsByAddress.set(address, recent);
        else attemptsByAddress.delete(address);
      }
    }
    for (const [address, attempts] of activityAttempts) {
      const recent = attempts.filter((time) => now - time < 60_000);
      if (recent.length) activityAttempts.set(address, recent);
      else activityAttempts.delete(address);
    }
    for (const [address, attempts] of portalActivityAttempts) {
      const recent = attempts.filter((time) => now - time < PORTAL_ACTIVITY_WINDOW_MS);
      if (recent.length) portalActivityAttempts.set(address, recent);
      else portalActivityAttempts.delete(address);
    }
    for (const [address, attempts] of favoriteAttempts) {
      const recent = attempts.filter((time) => now - time < 60_000);
      if (recent.length) favoriteAttempts.set(address, recent);
      else favoriteAttempts.delete(address);
    }
    for (const [address, attempts] of loveStarsMessageAttempts) {
      const recent = attempts.filter((time) => now - time < LOVE_STARS_MESSAGE_WINDOW_MS);
      if (recent.length) loveStarsMessageAttempts.set(address, recent);
      else loveStarsMessageAttempts.delete(address);
    }
    for (const [address, attempts] of wrongHitAttempts) {
      const recent = attempts.filter((time) => now - time < WRONG_HIT_WINDOW_MS);
      if (recent.length) wrongHitAttempts.set(address, recent);
      else wrongHitAttempts.delete(address);
    }
  }, 20000);
  heartbeat.unref();

  function cleanup() {
    clearInterval(heartbeat);
    clearTimeout(reloadTimer);
    clearTimeout(favoritesReloadTimer);
    if (watcher) watcher.close();
    watcher = null;
    for (const [clientId, client] of eventClients) closeEventClient(clientId, client);
    eventClients.clear();
    sessions.clear();
    siteSessions.clear();
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
