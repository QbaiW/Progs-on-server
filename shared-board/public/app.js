import { StarBottleScene } from "/scene.js?v=20260817-custom10";

const EMOTIONS = {
  joy: { label: "开心", color: "#ff863e", level: 1 },
  anger: { label: "生气", color: "#ffb773", level: 2 },
  anxiety: { label: "焦虑", color: "#ffdbb2", level: 3 },
  sadness: { label: "伤心", color: "#fff7e9", level: 4 },
  baby: { label: "宝宝！！", color: "#9edfff", level: 5 },
  custom: { label: "自定义状态", color: "#b9ff91", level: 6 },
};

const STAR_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const MAX_STAR_COUNT = 500;
const MUSIC_SETTINGS_KEY = "star-bottle-music-settings-v1";

const elements = {
  canvas: document.querySelector("#starCanvas"),
  loadingLayer: document.querySelector("#loadingLayer"),
  loadingText: document.querySelector("#loadingText"),
  syncState: document.querySelector("#syncState"),
  syncText: document.querySelector("#syncText"),
  musicPlayer: document.querySelector("#musicPlayer"),
  musicButton: document.querySelector("#musicButton"),
  musicPopover: document.querySelector("#musicPopover"),
  musicTrackName: document.querySelector("#musicTrackName"),
  musicPrevious: document.querySelector("#musicPrevious"),
  musicPlay: document.querySelector("#musicPlay"),
  musicNext: document.querySelector("#musicNext"),
  musicVolume: document.querySelector("#musicVolume"),
  emotionBubbles: document.querySelector("#emotionBubbles"),
  favoritesButton: document.querySelector("#favoritesButton"),
  favoritesPanel: document.querySelector("#favoritesPanel"),
  closeFavorites: document.querySelector("#closeFavorites"),
  favoriteCount: document.querySelector("#favoriteCount"),
  favoritesList: document.querySelector("#favoritesList"),
  emptyFavorites: document.querySelector("#emptyFavorites"),
  noteLayer: document.querySelector("#noteLayer"),
  noteBackdrop: document.querySelector("#noteBackdrop"),
  paperShape: document.querySelector("#paperShape"),
  noteCopy: document.querySelector("#noteCopy"),
  noteEmotion: document.querySelector("#noteEmotion"),
  noteChangeStatus: document.querySelector("#noteChangeStatus"),
  favoriteNoteButton: document.querySelector("#favoriteNoteButton"),
  closeNote: document.querySelector("#closeNote"),
  ownerTrigger: document.querySelector("#ownerTrigger"),
  ownerLogin: document.querySelector("#ownerLogin"),
  ownerLoginForm: document.querySelector("#ownerLoginForm"),
  ownerPassword: document.querySelector("#ownerPassword"),
  loginMessage: document.querySelector("#loginMessage"),
  editorPanel: document.querySelector("#editorPanel"),
  closeEditor: document.querySelector("#closeEditor"),
  editorSearchWrap: document.querySelector("#editorSearchWrap"),
  editorSearch: document.querySelector("#editorSearch"),
  addNoteButton: document.querySelector("#addNoteButton"),
  editorNoteList: document.querySelector("#editorNoteList"),
  noteEditorForm: document.querySelector("#noteEditorForm"),
  editorNoteId: document.querySelector("#editorNoteId"),
  editorEmotion: document.querySelector("#editorEmotion"),
  editorChangeStatus: document.querySelector("#editorChangeStatus"),
  editorChangeMeta: document.querySelector("#editorChangeMeta"),
  editorEmotionSelect: document.querySelector("#editorEmotionSelect"),
  editorCustomFields: document.querySelector("#editorCustomFields"),
  editorCustomLabel: document.querySelector("#editorCustomLabel"),
  editorCustomPosition: document.querySelector("#editorCustomPosition"),
  editorColor: document.querySelector("#editorColor"),
  editorColorValue: document.querySelector("#editorColorValue"),
  resetEditorColor: document.querySelector("#resetEditorColor"),
  editorText: document.querySelector("#editorText"),
  editorSaveState: document.querySelector("#editorSaveState"),
  saveNoteButton: document.querySelector("#saveNoteButton"),
  deleteNoteButton: document.querySelector("#deleteNoteButton"),
  editorNotesTab: document.querySelector("#editorNotesTab"),
  editorActivityTab: document.querySelector("#editorActivityTab"),
  editorDevicesTab: document.querySelector("#editorDevicesTab"),
  editorNotesView: document.querySelector("#editorNotesView"),
  editorActivityView: document.querySelector("#editorActivityView"),
  editorDevicesView: document.querySelector("#editorDevicesView"),
  activitySummary: document.querySelector("#activitySummary"),
  refreshActivityButton: document.querySelector("#refreshActivityButton"),
  clearActivityButton: document.querySelector("#clearActivityButton"),
  activityList: document.querySelector("#activityList"),
  emptyActivity: document.querySelector("#emptyActivity"),
  devicesSummary: document.querySelector("#devicesSummary"),
  refreshDevicesButton: document.querySelector("#refreshDevicesButton"),
  devicesList: document.querySelector("#devicesList"),
  emptyDevices: document.querySelector("#emptyDevices"),
  toast: document.querySelector("#toast"),
};

const state = {
  notes: [],
  noteById: new Map(),
  favorites: new Set(readFavorites()),
  favoritesVersion: 0,
  favoritePendingIds: new Set(),
  selectedNote: null,
  editorNote: null,
  scene: null,
  triggerClicks: [],
  activeEmotion: null,
  activityEntries: [],
  ownerDevices: [],
  visitorId: null,
  ownerToken: null,
  editorDirty: false,
  editorSaving: false,
  editorChangeStatusTouched: false,
  editorCreating: false,
  editorRevision: 0,
  music: {
    tracks: [],
    index: 0,
    audio: null,
    loading: false,
    settings: readMusicSettings(),
  },
};

function readFavorites() {
  try {
    const saved = JSON.parse(localStorage.getItem("star-bottle-favorites") || "[]");
    return Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function cacheFavorites() {
  try {
    localStorage.setItem("star-bottle-favorites", JSON.stringify([...state.favorites]));
  } catch { /* the server remains the source of truth */ }
}

const OWNER_TOKEN_KEY = "star-bottle-owner-token";
const FAVORITES_MIGRATION_KEY = "star-bottle-favorites-migrated-v1";

function readMusicSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(MUSIC_SETTINGS_KEY) || "{}");
    const volume = Number(saved.volume);
    return {
      volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0.38,
      trackUrl: typeof saved.trackUrl === "string" ? saved.trackUrl : "",
    };
  } catch {
    return { volume: 0.38, trackUrl: "" };
  }
}

function storeMusicSettings() {
  try {
    localStorage.setItem(MUSIC_SETTINGS_KEY, JSON.stringify(state.music.settings));
  } catch { /* playback still works without persistence */ }
}

function readOwnerToken() {
  try {
    const token = sessionStorage.getItem(OWNER_TOKEN_KEY) || "";
    return /^[A-Za-z0-9_-]{32,128}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

function storeOwnerToken(token) {
  state.ownerToken = /^[A-Za-z0-9_-]{32,128}$/.test(String(token || "")) ? String(token) : null;
  try {
    if (state.ownerToken) sessionStorage.setItem(OWNER_TOKEN_KEY, state.ownerToken);
    else sessionStorage.removeItem(OWNER_TOKEN_KEY);
  } catch { /* cookie authentication remains available */ }
}

async function readApiResult(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: `服务器返回了无法识别的结果（HTTP ${response.status}）` };
  }
}

async function ownerFetch(resource, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.ownerToken) headers.set("Authorization", `Bearer ${state.ownerToken}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(resource, {
      ...options,
      headers,
      cache: options.cache || "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (response.status === 401) storeOwnerToken(null);
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function readVisitorId() {
  const storageKey = "star-bottle-visitor-id";
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved && /^[A-Za-z0-9_-]{8,80}$/.test(saved)) return saved;
    const created = globalThis.crypto?.randomUUID?.() ||
      `visitor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    localStorage.setItem(storageKey, created);
    return created;
  } catch {
    return `visitor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

function currentDeviceLabel() {
  const userAgent = navigator.userAgent || "";
  const platform = /Windows/i.test(userAgent)
    ? "Windows"
    : /Android/i.test(userAgent)
      ? "Android"
      : /iPhone|iPad|iPod/i.test(userAgent)
        ? "iPhone/iPad"
        : /Mac OS/i.test(userAgent)
          ? "macOS"
          : "其他设备";
  const browser = /Edg\//i.test(userAgent)
    ? "Edge"
    : /Firefox\//i.test(userAgent)
      ? "Firefox"
      : /Chrome\//i.test(userAgent)
        ? "Chrome"
        : /Safari\//i.test(userAgent)
          ? "Safari"
          : "浏览器";
  return `${platform} · ${browser}`;
}

async function registerCurrentOwnerDevice() {
  state.visitorId ||= readVisitorId();
  const response = await ownerFetch("/api/owner/devices/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visitorId: state.visitorId, deviceLabel: currentDeviceLabel() }),
  });
  return response.ok;
}

function recordNoteOpen(note, detail = {}) {
  if (!note?.id) return;
  state.visitorId ||= readVisitorId();
  const source = ["pointer", "favorite", "direct"].includes(detail.source)
    ? detail.source
    : "direct";
  fetch("/api/activity/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ noteId: note.id, visitorId: state.visitorId, source }),
    keepalive: true,
  }).then(async (response) => {
    const result = await readApiResult(response);
    if (result.note?.id) installNotePatch(result.note);
  }).catch(() => {});
}

function setSync(label, kind = "") {
  elements.syncText.textContent = label;
  elements.syncState.className = `sync-state ${kind}`.trim();
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.remove("visible"), 2200);
}

function setPanel(panel, open) {
  panel.classList.toggle("open", open);
  panel.setAttribute("aria-hidden", String(!open));
}

function setMusicPopover(open) {
  elements.musicPopover.classList.toggle("open", open);
  elements.musicPopover.setAttribute("aria-hidden", String(!open));
  elements.musicButton.setAttribute("aria-expanded", String(open));
  if (open) loadMusicLibrary().catch(() => updateMusicUi());
}

function normalizeMusicTracks(payload) {
  if (!payload || !Array.isArray(payload.tracks)) throw new Error("背景音乐列表格式不正确");
  return payload.tracks.flatMap((track) => {
    const url = typeof track?.url === "string" ? track.url : "";
    if (!/^\/music\/[^?#]+$/i.test(url)) return [];
    return [{
      url,
      title: String(track.title || track.file || "背景音乐").trim() || "背景音乐",
    }];
  });
}

function ensureMusicAudio() {
  if (state.music.audio) return state.music.audio;
  const audio = new Audio();
  audio.preload = "metadata";
  audio.volume = state.music.settings.volume;
  audio.addEventListener("play", updateMusicUi);
  audio.addEventListener("pause", updateMusicUi);
  audio.addEventListener("ended", () => changeMusicTrack(1, true));
  audio.addEventListener("error", () => {
    updateMusicUi();
    if (state.music.tracks.length) showToast("这首背景音乐暂时无法播放");
  });
  state.music.audio = audio;
  return audio;
}

function updateMusicUi() {
  const music = state.music;
  const track = music.tracks[music.index];
  const playing = Boolean(music.audio && !music.audio.paused);
  elements.musicTrackName.textContent = music.loading
    ? "读取背景音乐"
    : track?.title || "暂无背景音乐";
  elements.musicButton.classList.toggle("playing", playing);
  elements.musicButton.title = track ? (playing ? "背景音乐播放中" : "背景音乐") : "暂无背景音乐";
  elements.musicPlay.textContent = playing ? "Ⅱ" : "▶";
  elements.musicPlay.title = playing ? "暂停" : "播放";
  elements.musicPlay.setAttribute("aria-label", playing ? "暂停背景音乐" : "播放背景音乐");
  elements.musicPrevious.disabled = !track;
  elements.musicPlay.disabled = !track;
  elements.musicNext.disabled = !track;
  elements.musicVolume.disabled = !track;
  elements.musicVolume.value = String(music.settings.volume);
}

async function selectMusicTrack(index, { autoplay = false } = {}) {
  const music = state.music;
  if (!music.tracks.length) {
    updateMusicUi();
    return false;
  }
  const audio = ensureMusicAudio();
  const wasPlaying = !audio.paused;
  music.index = (index + music.tracks.length) % music.tracks.length;
  const track = music.tracks[music.index];
  audio.pause();
  audio.src = track.url;
  audio.dataset.trackUrl = track.url;
  audio.load();
  music.settings.trackUrl = track.url;
  storeMusicSettings();
  updateMusicUi();
  if (autoplay || wasPlaying) {
    try {
      await audio.play();
    } catch {
      showToast("请再次点击播放背景音乐");
    }
  }
  return true;
}

async function loadMusicLibrary() {
  const music = state.music;
  if (music.loading) return;
  music.loading = true;
  updateMusicUi();
  try {
    const response = await fetch("/api/music", { cache: "no-store" });
    if (!response.ok) throw new Error("背景音乐列表读取失败");
    const payload = await response.json();
    const previousUrl = music.tracks[music.index]?.url || music.settings.trackUrl;
    music.tracks = normalizeMusicTracks(payload);
    ensureMusicAudio();
    if (music.tracks.length) {
      const savedIndex = music.tracks.findIndex((track) => track.url === previousUrl);
      await selectMusicTrack(savedIndex >= 0 ? savedIndex : 0);
    } else {
      music.audio.pause();
      music.audio.removeAttribute("src");
      delete music.audio.dataset.trackUrl;
      music.audio.load();
    }
  } catch (error) {
    music.tracks = [];
    showToast(error.message || "背景音乐暂时无法连接");
  } finally {
    music.loading = false;
    updateMusicUi();
  }
}

async function toggleMusicPlayback() {
  if (!state.music.tracks.length) await loadMusicLibrary();
  if (!state.music.tracks.length) {
    showToast("暂无背景音乐");
    return;
  }
  const audio = ensureMusicAudio();
  if (audio.dataset.trackUrl !== state.music.tracks[state.music.index].url) {
    await selectMusicTrack(state.music.index);
  }
  if (audio.paused) {
    try {
      await audio.play();
    } catch {
      showToast("请再次点击播放背景音乐");
    }
  } else {
    audio.pause();
  }
  updateMusicUi();
}

async function changeMusicTrack(direction, autoplay = false) {
  if (!state.music.tracks.length) await loadMusicLibrary();
  if (!state.music.tracks.length) return;
  await selectMusicTrack(state.music.index + direction, { autoplay });
}

function normalizeNotes(payload) {
  const source = Array.isArray(payload) ? payload : payload?.notes;
  if (!Array.isArray(source)) throw new Error("纸条数据格式不正确");
  return source.map((note, index) => {
    const emotion = EMOTIONS[note.emotion] ? note.emotion : "joy";
    return {
      id: String(note.id || `star-${index + 1}`),
      emotion,
      emotionLabel: emotion === "custom"
        ? String(note.emotionLabel || EMOTIONS.custom.label).trim().slice(0, 24) || EMOTIONS.custom.label
        : EMOTIONS[emotion].label,
      customPosition: emotion === "custom" && note.customPosition === "right" ? "right" : "left",
      text: (typeof note.text === "string" ? note.text : "未写内容的纸条").slice(0, 500),
      colorLevel: Number(note.colorLevel) || EMOTIONS[emotion].level || (emotion === "baby" ? 5 : Math.floor(index / 100) + 1),
      color: typeof note.color === "string" && STAR_COLOR_PATTERN.test(note.color)
        ? note.color.toLowerCase()
        : EMOTIONS[emotion].color,
      changeStatus: note.changeStatus === "unread" ? "unread" : "read",
      changeReason: ["added", "updated", "manual"].includes(note.changeReason) ? note.changeReason : "",
      changeAt: typeof note.changeAt === "string" ? note.changeAt : "",
      readAt: typeof note.readAt === "string" ? note.readAt : "",
    };
  });
}

function normalizeFavorites(payload) {
  if (!payload || !Array.isArray(payload.noteIds)) throw new Error("收藏数据格式不正确");
  const seen = new Set();
  const noteIds = payload.noteIds.flatMap((candidate) => {
    const id = typeof candidate === "string" ? candidate.trim() : "";
    if (!/^[a-z0-9-]{1,40}$/.test(id) || seen.has(id)) return [];
    seen.add(id);
    return [id];
  });
  return {
    version: Number.isSafeInteger(payload.version) && payload.version > 0 ? payload.version : 1,
    updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : "",
    noteIds,
  };
}

function installFavorites(payload, { force = false } = {}) {
  const document = normalizeFavorites(payload);
  if (!force && document.version < state.favoritesVersion) return false;
  state.favoritesVersion = document.version;
  state.favorites = new Set(document.noteIds);
  cacheFavorites();
  updateFavoriteUi();
  updateNoteFavoriteButton();
  return true;
}

function favoritesMigrationFinished() {
  try { return localStorage.getItem(FAVORITES_MIGRATION_KEY) === "1"; }
  catch { return true; }
}

function markFavoritesMigrationFinished() {
  try { localStorage.setItem(FAVORITES_MIGRATION_KEY, "1"); }
  catch { /* migration can safely be retried */ }
}

async function loadSharedFavorites() {
  const legacyIds = readFavorites().filter((id) => state.noteById.has(id));
  const response = await fetch("/api/favorites", { cache: "no-store" });
  const result = await readApiResult(response);
  if (!response.ok) throw new Error(result.error || "无法读取共享收藏");
  let document = normalizeFavorites(result);

  if (
    !favoritesMigrationFinished() &&
    document.version === 1 &&
    document.noteIds.length === 0 &&
    legacyIds.length > 0
  ) {
    const importResponse = await fetch("/api/favorites/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ noteIds: legacyIds }),
    });
    const imported = await readApiResult(importResponse);
    if (!importResponse.ok || imported.saved !== true || !imported.document) {
      throw new Error(imported.error || "旧收藏迁移失败");
    }
    document = normalizeFavorites(imported.document);
  }

  installFavorites(document);
  markFavoritesMigrationFinished();
}

function installNotes(notes) {
  const editingId = state.editorNote?.id;
  const selectedId = state.selectedNote?.id;
  state.notes = notes;
  state.noteById = new Map(notes.map((note) => [note.id, note]));
  if (editingId) state.editorNote = state.noteById.get(editingId) || null;
  if (selectedId) {
    state.selectedNote = state.noteById.get(selectedId) || null;
    if (state.selectedNote && elements.noteLayer.classList.contains("open")) {
      elements.paperShape.style.setProperty("--note-color", colorFor(state.selectedNote));
      elements.noteCopy.textContent = state.selectedNote.text;
      elements.noteEmotion.textContent = emotionFor(state.selectedNote).label;
      updateOpenNoteChangeStatus(state.selectedNote);
      updateNoteFavoriteButton();
    } else if (!state.selectedNote && elements.noteLayer.classList.contains("open")) {
      closeNote();
    }
  }
  if (editingId && !state.editorNote) clearEditorSelection("这颗星星已被删除");
  if (state.editorNote && !state.editorDirty && !state.editorSaving) {
    selectEditorNote(state.editorNote);
  }
  elements.addNoteButton.disabled = notes.length >= MAX_STAR_COUNT || state.editorCreating;
  elements.addNoteButton.title = notes.length >= MAX_STAR_COUNT
    ? `最多保留 ${MAX_STAR_COUNT} 颗星星`
    : "新增星星";
  cacheFavorites();
  const hasBabyStars = notes.some((note) => note.emotion === "baby");
  const babyBubble = elements.emotionBubbles.querySelector('[data-emotion="baby"]');
  if (babyBubble) babyBubble.hidden = !hasBabyStars;
  if (!hasBabyStars && state.activeEmotion === "baby") {
    state.activeEmotion = null;
    try { state.scene?.setEmotionFilter?.(null); } catch (error) { console.error("Could not clear scene filter:", error); }
    babyBubble?.classList.remove("active");
  }
  const customNotes = notes.filter((note) => note.emotion === "custom");
  const customBubble = elements.emotionBubbles.querySelector('[data-emotion="custom"]');
  if (customBubble) {
    const customNote = customNotes[0];
    customBubble.hidden = !customNote;
    if (customNote) {
      const customLabel = customNote.emotionLabel || EMOTIONS.custom.label;
      customBubble.setAttribute("aria-label", customLabel);
      customBubble.querySelector("span:last-child").textContent = customLabel;
      customBubble.style.setProperty("--bubble-color", colorFor(customNote));
    }
  }
  if (!customNotes.length && state.activeEmotion === "custom") {
    state.activeEmotion = null;
    try { state.scene?.setEmotionFilter?.(null); } catch (error) { console.error("Could not clear scene filter:", error); }
    customBubble?.classList.remove("active");
  }
  updateFavoriteUi();
  renderEditorList();
  try {
    state.scene?.updateNotes?.(notes);
  } catch (error) {
    // Data is already installed and may already be persisted; a render failure
    // must not be reported as a save failure.
    console.error("Could not refresh the 3D stars:", error);
  }
}

function installNotePatch(note) {
  const normalized = normalizeNotes({ notes: [note] })[0];
  if (!normalized || !state.noteById.has(normalized.id)) return;
  installNotes(state.notes.map((candidate) => candidate.id === normalized.id ? normalized : candidate));
}

function emotionFor(note) {
  const emotion = EMOTIONS[note?.emotion] || EMOTIONS.joy;
  return note?.emotion === "custom"
    ? { ...emotion, label: note.emotionLabel || emotion.label }
    : emotion;
}

function noteIsUnread(note) {
  return note?.changeStatus === "unread";
}

function noteChangeLabel(note) {
  if (!noteIsUnread(note)) return "已读";
  if (note.changeReason === "added") return "新增未读";
  if (note.changeReason === "updated") return "修改未读";
  return "未读";
}

function updateOpenNoteChangeStatus(note) {
  const unread = noteIsUnread(note);
  elements.noteChangeStatus.hidden = !unread;
  elements.noteChangeStatus.textContent = unread
    ? (note.changeReason === "added" ? "新星星" : "有更新")
    : "";
}

function colorFor(note) {
  return typeof note?.color === "string" && STAR_COLOR_PATTERN.test(note.color)
    ? note.color.toLowerCase()
    : emotionFor(note).color;
}

function updateFavoriteUi() {
  const favorites = [...state.favorites].map((id) => state.noteById.get(id)).filter(Boolean);
  elements.favoriteCount.textContent = String(favorites.length);
  elements.emptyFavorites.hidden = favorites.length > 0;
  elements.favoritesList.replaceChildren(...favorites.map((note) => {
    const emotion = emotionFor(note);
    const button = document.createElement("button");
    button.className = "favorite-item";
    button.type = "button";
    button.style.setProperty("--star-color", colorFor(note));
    button.innerHTML = `<span class="favorite-swatch"></span><span class="favorite-copy"><strong></strong><span></span></span><span class="favorite-arrow">›</span>`;
    button.querySelector("strong").textContent = note.text;
    button.querySelector(".favorite-copy span").textContent = `${emotion.label} · ${note.id}`;
    button.addEventListener("click", () => locateFavorite(note));
    return button;
  }));
}

async function locateFavorite(note) {
  setPanel(elements.favoritesPanel, false);
  setSync("寻找星星", "");
  try {
    const found = await state.scene?.focusStar?.(note.id);
    if (!found) openNote(note);
    setTimeout(() => setSync("只读浏览", "ready"), 2500);
  } catch {
    openNote(note);
  }
}

function openNote(note, detail = {}) {
  if (!note) return;
  recordNoteOpen(note, detail);
  state.selectedNote = note;
  const emotion = emotionFor(note);
  elements.paperShape.style.setProperty("--note-color", colorFor(note));
  elements.noteCopy.textContent = note.text;
  elements.noteEmotion.textContent = emotion.label;
  updateOpenNoteChangeStatus(note);
  updateNoteFavoriteButton();
  elements.noteLayer.classList.add("open");
  elements.noteLayer.setAttribute("aria-hidden", "false");
}

function closeNote() {
  elements.noteLayer.classList.remove("open");
  elements.noteLayer.setAttribute("aria-hidden", "true");
  state.selectedNote = null;
}

function updateNoteFavoriteButton() {
  const favorite = state.selectedNote && state.favorites.has(state.selectedNote.id);
  const pending = state.selectedNote && state.favoritePendingIds.has(state.selectedNote.id);
  elements.favoriteNoteButton.classList.toggle("active", Boolean(favorite));
  elements.favoriteNoteButton.querySelector("span").textContent = favorite ? "♥" : "♡";
  elements.favoriteNoteButton.disabled = Boolean(pending);
  elements.favoriteNoteButton.title = pending ? "正在同步收藏" : favorite ? "取消收藏" : "收藏这张纸条";
}

async function toggleSelectedFavorite() {
  if (!state.selectedNote) return;
  const id = state.selectedNote.id;
  if (state.favoritePendingIds.has(id)) return;
  const wasFavorite = state.favorites.has(id);
  const favorite = !wasFavorite;
  state.favoritePendingIds.add(id);
  if (favorite) state.favorites.add(id);
  else state.favorites.delete(id);
  cacheFavorites();
  updateNoteFavoriteButton();
  updateFavoriteUi();
  try {
    const response = await fetch(`/api/favorites/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ favorite }),
    });
    const result = await readApiResult(response);
    if (!response.ok) throw new Error(result.error || "收藏同步失败");
    if (result.saved !== true || !result.document || result.favorite !== favorite) {
      throw new Error("服务器没有确认收藏状态");
    }
    installFavorites(result.document);
    showToast(favorite ? "已收藏并同步到所有设备" : "已取消收藏并同步");
  } catch (error) {
    let restoredFromServer = false;
    try {
      const refreshResponse = await fetch("/api/favorites", { cache: "no-store" });
      const refreshResult = await readApiResult(refreshResponse);
      if (refreshResponse.ok) {
        const refreshed = normalizeFavorites(refreshResult);
        restoredFromServer = installFavorites(refreshed) || refreshed.version < state.favoritesVersion;
      }
    } catch { /* restore the local state below */ }
    if (!restoredFromServer) {
      if (wasFavorite) state.favorites.add(id);
      else state.favorites.delete(id);
      cacheFavorites();
      updateFavoriteUi();
    }
    showToast(`收藏同步失败：${error.message || "请稍后再试"}`);
  } finally {
    state.favoritePendingIds.delete(id);
    updateNoteFavoriteButton();
  }
}

function positionBubbles(positions) {
  if (!positions) return;
  document.querySelectorAll(".emotion-bubble").forEach((bubble) => {
    const position = positions[bubble.dataset.emotion];
    if (!position) return;
    bubble.style.setProperty("--bubble-x", `${position.x}px`);
    bubble.style.setProperty("--bubble-y", `${position.y}px`);
  });
}

function toggleEmotion(emotion) {
  state.activeEmotion = state.activeEmotion === emotion ? null : emotion;
  state.scene?.setEmotionFilter?.(state.activeEmotion);
  document.querySelectorAll(".emotion-bubble").forEach((bubble) => {
    bubble.classList.toggle("active", bubble.dataset.emotion === state.activeEmotion);
  });
}

async function ownerStatus() {
  try {
    const response = await ownerFetch("/api/owner/status");
    const result = await readApiResult(response);
    const authenticated = response.ok && result.authenticated === true;
    if (!authenticated) storeOwnerToken(null);
    return authenticated;
  } catch {
    return false;
  }
}

async function openOwnerAccess() {
  if (await ownerStatus()) {
    await registerCurrentOwnerDevice().catch(() => {});
    setPanel(elements.editorPanel, true);
    renderEditorList();
    setEditorView("notes");
    return;
  }
  elements.loginMessage.textContent = "";
  elements.ownerPassword.value = "";
  elements.ownerLogin.showModal();
  requestAnimationFrame(() => elements.ownerPassword.focus());
}

async function loginOwner(password) {
  state.visitorId ||= readVisitorId();
  const response = await fetch("/api/owner/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    credentials: "same-origin",
    body: JSON.stringify({
      password,
      visitorId: state.visitorId,
      deviceLabel: currentDeviceLabel(),
    }),
  });
  const result = await readApiResult(response);
  if (!response.ok) throw new Error(result.error || "密码不正确");
  if (result.authenticated !== true) throw new Error("服务器没有确认主人身份");
  storeOwnerToken(result.ownerToken);
}

function renderEditorList() {
  if (!elements.editorNoteList) return;
  const query = elements.editorSearch.value.trim().toLocaleLowerCase("zh-CN");
  const filtered = state.notes.filter((note) => {
    if (!query) return true;
    return note.id.toLowerCase().includes(query) ||
      note.text.toLocaleLowerCase("zh-CN").includes(query) ||
      noteChangeLabel(note).toLocaleLowerCase("zh-CN").includes(query);
  });
  elements.editorNoteList.replaceChildren(...filtered.map((note) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `editor-note-item${state.editorNote?.id === note.id ? " active" : ""}${noteIsUnread(note) ? " unread" : ""}`;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(state.editorNote?.id === note.id));
    button.dataset.noteId = note.id;
    button.title = `${noteChangeLabel(note)} · ${note.id}`;
    button.style.setProperty("--star-color", colorFor(note));
    const swatch = document.createElement("span");
    swatch.className = "favorite-swatch";
    const copy = document.createElement("span");
    copy.className = "editor-note-copy";
    const text = document.createElement("span");
    text.className = "editor-note-text";
    text.textContent = `${note.id}  ${note.text}`;
    const status = document.createElement("span");
    status.className = "editor-note-status";
    status.textContent = noteChangeLabel(note);
    copy.append(text, status);
    button.append(swatch, copy);
    button.addEventListener("click", () => selectEditorNote(note));
    return button;
  }));
}

function setEditorView(view) {
  const notes = view === "notes";
  const activity = view === "activity";
  const devices = view === "devices";
  elements.editorSearchWrap.hidden = !notes;
  elements.editorNotesView.hidden = !notes;
  elements.editorActivityView.hidden = !activity;
  elements.editorDevicesView.hidden = !devices;
  elements.editorNotesTab.classList.toggle("active", notes);
  elements.editorActivityTab.classList.toggle("active", activity);
  elements.editorDevicesTab.classList.toggle("active", devices);
  if (activity) loadActivity();
  if (devices) loadOwnerDevices();
}

function formatBeijingTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "未知时间");
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function renderActivity() {
  const entries = state.activityEntries;
  elements.activitySummary.textContent = `${entries.length} 次打开`;
  elements.emptyActivity.hidden = entries.length > 0;
  elements.activityList.replaceChildren(...entries.map((entry) => {
    const item = document.createElement("article");
    item.className = "activity-item";
    const note = entry.note || {};
    const emotionKey = EMOTIONS[entry.emotionAtOpen] ? entry.emotionAtOpen : note.emotion;
    const emotion = emotionFor({ emotion: emotionKey, emotionLabel: note.emotionLabel });
    const activityColor = typeof entry.colorAtOpen === "string" && STAR_COLOR_PATTERN.test(entry.colorAtOpen)
      ? entry.colorAtOpen
      : colorFor(note);
    const time = formatBeijingTime(entry.openedAt);
    const sourceLabel = entry.source === "favorite" ? "收藏定位" : entry.source === "pointer" ? "点击" : "打开";

    const heading = document.createElement("header");
    const id = document.createElement("strong");
    id.textContent = entry.noteId;
    const when = document.createElement("time");
    when.dateTime = entry.openedAt;
    when.textContent = time;
    heading.append(id, when);

    const copy = document.createElement("p");
    copy.textContent = entry.textAtOpen || note.text || "纸条内容已不存在";

    const meta = document.createElement("footer");
    const mood = document.createElement("span");
    mood.className = "activity-emotion";
    mood.style.setProperty("--star-color", activityColor);
    mood.textContent = emotion.label;
    const source = document.createElement("span");
    source.textContent = sourceLabel;
    const visitor = document.createElement("span");
    visitor.textContent = `访客 ${String(entry.visitorId || "").slice(0, 10)}`;
    visitor.title = entry.visitorId || "匿名访客";
    meta.append(mood, source, visitor);

    item.append(heading, copy, meta);
    return item;
  }));
}

async function loadActivity() {
  elements.activitySummary.textContent = "正在读取记录";
  try {
    const response = await ownerFetch("/api/owner/activity");
    const result = await readApiResult(response);
    if (response.status === 401) throw new Error("登录已失效，请重新进入编辑室");
    if (!response.ok) throw new Error(result.error || "记录读取失败");
    state.activityEntries = Array.isArray(result.entries) ? result.entries : [];
    renderActivity();
  } catch (error) {
    state.activityEntries = [];
    elements.activityList.replaceChildren();
    elements.emptyActivity.hidden = false;
    elements.emptyActivity.textContent = error.message;
    elements.activitySummary.textContent = "读取失败";
  }
}

async function clearActivity() {
  if (!window.confirm("确定清空所有打开记录吗？此操作不可恢复。")) return;
  elements.clearActivityButton.disabled = true;
  try {
    const response = await ownerFetch("/api/owner/activity", { method: "DELETE" });
    const result = await readApiResult(response);
    if (response.status === 401) throw new Error("登录已失效，请重新进入编辑室");
    if (!response.ok) throw new Error(result.error || "记录清空失败");
    state.activityEntries = [];
    renderActivity();
    showToast("打开记录已清空");
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.clearActivityButton.disabled = false;
  }
}

function renderOwnerDevices() {
  const devices = state.ownerDevices;
  elements.devicesSummary.textContent = `${devices.length} 台设备`;
  elements.emptyDevices.hidden = devices.length > 0;
  elements.devicesList.replaceChildren(...devices.map((device) => {
    const item = document.createElement("article");
    item.className = "activity-item device-item";
    const heading = document.createElement("header");
    const label = document.createElement("strong");
    label.textContent = device.label || "主人设备";
    const count = document.createElement("time");
    count.textContent = `进入 ${device.loginCount || 1} 次`;
    heading.append(label, count);

    const copy = document.createElement("p");
    copy.textContent = `首次：${formatBeijingTime(device.firstLoginAt)} · 最近：${formatBeijingTime(device.lastLoginAt)}`;

    const footer = document.createElement("footer");
    const id = document.createElement("span");
    id.textContent = `设备 ${String(device.id || "").slice(0, 12)}`;
    id.title = device.id || "";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary-button compact danger";
    remove.textContent = "移除名单";
    remove.addEventListener("click", () => removeOwnerDevice(device));
    footer.append(id, remove);
    item.append(heading, copy, footer);
    return item;
  }));
}

async function loadOwnerDevices() {
  elements.devicesSummary.textContent = "正在读取设备";
  try {
    const response = await ownerFetch("/api/owner/devices");
    const result = await readApiResult(response);
    if (response.status === 401) throw new Error("登录已失效，请重新进入编辑室");
    if (!response.ok) throw new Error(result.error || "设备读取失败");
    state.ownerDevices = Array.isArray(result.devices) ? result.devices : [];
    renderOwnerDevices();
  } catch (error) {
    state.ownerDevices = [];
    elements.devicesList.replaceChildren();
    elements.emptyDevices.hidden = false;
    elements.emptyDevices.textContent = error.message;
    elements.devicesSummary.textContent = "读取失败";
  }
}

async function removeOwnerDevice(device) {
  if (!window.confirm(`移除“${device.label || "这台设备"}”后，它打开星星会重新计入记录。继续吗？`)) return;
  try {
    const response = await ownerFetch(`/api/owner/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" });
    const result = await readApiResult(response);
    if (response.status === 401) throw new Error("登录已失效，请重新进入编辑室");
    if (!response.ok) throw new Error(result.error || "设备移除失败");
    state.ownerDevices = state.ownerDevices.filter((candidate) => candidate.id !== device.id);
    renderOwnerDevices();
    showToast("设备已从名单移除");
  } catch (error) {
    showToast(error.message);
  }
}

function setEditorSaveControl(message, buttonLabel, controlState, disabled) {
  elements.editorSaveState.textContent = message;
  elements.editorSaveState.dataset.state = controlState;
  elements.saveNoteButton.textContent = buttonLabel;
  elements.saveNoteButton.dataset.state = controlState;
  elements.saveNoteButton.disabled = disabled;
}

function updateCustomEditorFields(emotion, note = null) {
  const isCustom = emotion === "custom";
  elements.editorCustomFields.hidden = !isCustom;
  elements.editorCustomLabel.disabled = !isCustom;
  elements.editorCustomPosition.disabled = !isCustom;
  if (!isCustom) return;
  if (note?.emotion === "custom") {
    elements.editorCustomLabel.value = note.emotionLabel || EMOTIONS.custom.label;
    elements.editorCustomPosition.value = note.customPosition === "right" ? "right" : "left";
  } else {
    const configuredCustom = state.notes.find((candidate) => candidate.emotion === "custom");
    elements.editorCustomLabel.value = configuredCustom?.emotionLabel || EMOTIONS.custom.label;
    elements.editorCustomPosition.value = configuredCustom?.customPosition === "right" ? "right" : "left";
  }
  elements.editorEmotion.textContent = elements.editorCustomLabel.value.trim() || EMOTIONS.custom.label;
}

function updateEditorChangeMeta(note, status = note?.changeStatus) {
  if (!note) {
    elements.editorChangeMeta.textContent = "";
    elements.editorChangeMeta.dataset.state = "";
    return;
  }
  const preview = { ...note, changeStatus: status === "unread" ? "unread" : "read" };
  const reason = note.changeReason === "added"
    ? "新增"
    : note.changeReason === "updated"
      ? "内容修改"
      : note.changeReason === "manual"
        ? "主人设置"
        : "";
  const changedAt = note.changeAt ? formatBeijingTime(note.changeAt) : "";
  elements.editorChangeMeta.textContent = [noteChangeLabel(preview), reason, changedAt]
    .filter(Boolean)
    .join(" · ");
  elements.editorChangeMeta.dataset.state = preview.changeStatus;
}

function clearEditorSelection(message = "请选择一颗星星") {
  state.editorNote = null;
  state.editorDirty = false;
  state.editorSaving = false;
  state.editorCreating = false;
  state.editorChangeStatusTouched = false;
  state.editorRevision += 1;
  elements.editorNoteId.textContent = message;
  elements.editorEmotion.textContent = "";
  elements.editorEmotionSelect.disabled = true;
  elements.editorChangeStatus.disabled = true;
  elements.editorChangeStatus.value = "read";
  updateEditorChangeMeta(null);
  elements.editorCustomFields.hidden = true;
  elements.editorCustomLabel.disabled = true;
  elements.editorCustomPosition.disabled = true;
  elements.editorColor.disabled = true;
  elements.resetEditorColor.disabled = true;
  elements.editorText.disabled = true;
  elements.editorText.value = "";
  elements.deleteNoteButton.disabled = true;
  setEditorSaveControl(message, "请选择纸条", "idle", true);
  renderEditorList();
}

function selectEditorNote(note) {
  state.editorNote = note;
  state.editorDirty = false;
  state.editorCreating = false;
  state.editorChangeStatusTouched = false;
  state.editorRevision += 1;
  elements.editorNoteId.textContent = note.id;
  elements.editorEmotion.textContent = emotionFor(note).label;
  elements.editorEmotionSelect.value = note.emotion;
  elements.editorEmotionSelect.disabled = false;
  elements.editorChangeStatus.value = note.changeStatus === "unread" ? "unread" : "read";
  elements.editorChangeStatus.disabled = false;
  updateEditorChangeMeta(note);
  updateCustomEditorFields(note.emotion, note);
  setEditorColor(colorFor(note));
  elements.editorColor.disabled = false;
  elements.resetEditorColor.disabled = false;
  elements.editorText.disabled = false;
  elements.editorText.value = note.text;
  elements.deleteNoteButton.disabled = state.notes.length <= 1;
  elements.deleteNoteButton.title = state.notes.length <= 1 ? "至少保留一颗星星" : "删除这颗星星";
  setEditorSaveControl("当前内容已保存", "已保存", "saved", true);
  renderEditorList();
}

function markEditorDirty(contentChanged = false) {
  if (!state.editorNote) return;
  if (contentChanged && !state.editorChangeStatusTouched) {
    elements.editorChangeStatus.value = "unread";
    updateEditorChangeMeta(state.editorNote, "unread");
  }
  state.editorDirty = true;
  state.editorRevision += 1;
  if (state.editorSaving) {
    setEditorSaveControl("保存中，仍有新修改未保存", "正在保存…", "saving", true);
  } else {
    setEditorSaveControl("修改尚未保存", "保存修改", "dirty", false);
  }
}

function setEditorColor(color) {
  const normalized = typeof color === "string" && STAR_COLOR_PATTERN.test(color)
    ? color.toLowerCase()
    : EMOTIONS.joy.color;
  elements.editorColor.value = normalized;
  elements.editorColorValue.value = normalized.toUpperCase();
  elements.editorColorValue.textContent = normalized.toUpperCase();
  elements.editorColorValue.style.setProperty("--star-color", normalized);
}

function selectEditorEmotion(emotion) {
  const metadata = EMOTIONS[emotion] || EMOTIONS.joy;
  updateCustomEditorFields(emotion, emotion === "custom" ? state.editorNote : null);
  elements.editorEmotion.textContent = emotion === "custom"
    ? (elements.editorCustomLabel.value.trim() || metadata.label)
    : metadata.label;
  setEditorColor(metadata.color);
}

async function saveEditorNote() {
  if (!state.editorNote || state.editorSaving || !state.editorDirty) return;
  const noteId = state.editorNote.id;
  const submittedRevision = state.editorRevision;
  const submitted = {
    text: elements.editorText.value,
    emotion: elements.editorEmotionSelect.value,
    color: elements.editorColor.value,
    emotionLabel: elements.editorEmotionSelect.value === "custom"
      ? elements.editorCustomLabel.value.trim()
      : undefined,
    customPosition: elements.editorEmotionSelect.value === "custom"
      ? elements.editorCustomPosition.value
      : undefined,
    changeStatus: state.editorChangeStatusTouched
      ? elements.editorChangeStatus.value
      : undefined,
  };
  state.editorSaving = true;
  setEditorSaveControl("正在写入服务器并核对数据", "正在保存…", "saving", true);
  try {
    const response = await ownerFetch(`/api/owner/notes/${encodeURIComponent(noteId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submitted),
    });
    const result = await readApiResult(response);
    if (response.status === 401) {
      setPanel(elements.editorPanel, false);
      throw new Error("登录已失效，请重新进入编辑室");
    }
    if (!response.ok) throw new Error(result.error || "保存失败");
    if (result.saved !== true || !result.document) throw new Error("服务器未确认数据已经保存，请重试");
    const persistedNote = result.note;
    if (!persistedNote || persistedNote.id !== noteId) throw new Error("服务器没有返回已保存的纸条");
    if (
      persistedNote.text !== submitted.text ||
      persistedNote.emotion !== submitted.emotion ||
      String(persistedNote.color || "").toLowerCase() !== submitted.color.toLowerCase() ||
      (submitted.changeStatus !== undefined && persistedNote.changeStatus !== submitted.changeStatus) ||
      (submitted.emotion === "custom" && (
        persistedNote.emotionLabel !== submitted.emotionLabel ||
        persistedNote.customPosition !== submitted.customPosition
      ))
    ) {
      throw new Error("服务器返回的数据与当前修改不一致，请重试");
    }

    installNotes(normalizeNotes(result.document));
    const currentSelectionIsSavedNote = state.editorNote?.id === noteId;
    const changedWhileSaving = state.editorRevision !== submittedRevision;
    if (currentSelectionIsSavedNote && !changedWhileSaving) {
      selectEditorNote(state.noteById.get(noteId));
      state.editorDirty = false;
      setEditorSaveControl("保存成功，已同步到其他设备", "保存成功", "saved", true);
      showToast("纸条已保存并同步");
    } else if (currentSelectionIsSavedNote) {
      state.editorDirty = true;
      setEditorSaveControl("刚才的版本已保存，当前修改尚未保存", "保存修改", "dirty", false);
    } else {
      showToast(`${noteId} 已保存并同步`);
    }
  } catch (error) {
    const detail = String(error?.message || "保存失败");
    const message = error?.name === "AbortError"
      ? "保存超时，当前修改尚未保存"
      : error instanceof TypeError
        ? "无法连接服务器，当前修改尚未保存"
        : detail.startsWith("保存失败")
          ? detail
          : `保存失败：${detail}`;
    if (state.editorNote?.id === noteId) {
      state.editorDirty = true;
      setEditorSaveControl(message, "重新保存", "error", false);
    }
    showToast(message);
  } finally {
    state.editorSaving = false;
    if (!state.editorNote) {
      setEditorSaveControl("请选择一颗星星", "请选择纸条", "idle", true);
    } else if (state.editorDirty) {
      elements.saveNoteButton.disabled = false;
    }
  }
}

async function createEditorNote() {
  if (state.editorCreating || state.notes.length >= MAX_STAR_COUNT) return;
  if (state.editorDirty && !window.confirm("当前修改尚未保存。放弃这些修改并新增星星吗？")) return;

  const source = state.editorNote;
  const emotion = EMOTIONS[source?.emotion] ? source.emotion : "joy";
  const submitted = {
    text: "新星星的纸条",
    emotion,
    emotionLabel: emotion === "custom" ? source?.emotionLabel : undefined,
    customPosition: emotion === "custom" ? source?.customPosition : undefined,
  };
  state.editorCreating = true;
  elements.addNoteButton.disabled = true;
  elements.addNoteButton.classList.add("working");
  try {
    const response = await ownerFetch("/api/owner/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submitted),
    });
    const result = await readApiResult(response);
    if (response.status === 401) {
      setPanel(elements.editorPanel, false);
      throw new Error("登录已失效，请重新进入编辑室");
    }
    if (!response.ok || result.created !== true || !result.document || !result.note) {
      throw new Error(result.error || "新增星星失败");
    }
    state.editorCreating = false;
    installNotes(normalizeNotes(result.document));
    const created = state.noteById.get(result.note.id);
    if (!created) throw new Error("服务器没有返回新星星");
    selectEditorNote(created);
    elements.editorNoteList.scrollTop = elements.editorNoteList.scrollHeight;
    showToast("新星星已加入并标记为未读");
  } catch (error) {
    showToast(error.message || "新增星星失败");
  } finally {
    state.editorCreating = false;
    elements.addNoteButton.classList.remove("working");
    elements.addNoteButton.disabled = state.notes.length >= MAX_STAR_COUNT;
  }
}

async function deleteEditorNote() {
  const note = state.editorNote;
  if (!note || state.editorSaving || state.notes.length <= 1) return;
  const warning = state.editorDirty
    ? `“${note.id}”还有未保存修改，删除后无法恢复。确定删除吗？`
    : `确定删除星星“${note.id}”吗？此操作无法恢复。`;
  if (!window.confirm(warning)) return;

  elements.deleteNoteButton.disabled = true;
  try {
    const response = await ownerFetch(`/api/owner/notes/${encodeURIComponent(note.id)}`, {
      method: "DELETE",
    });
    const result = await readApiResult(response);
    if (response.status === 401) {
      setPanel(elements.editorPanel, false);
      throw new Error("登录已失效，请重新进入编辑室");
    }
    if (!response.ok || result.deleted !== true || !result.document) {
      throw new Error(result.error || "删除星星失败");
    }
    state.editorDirty = false;
    state.editorNote = null;
    installNotes(normalizeNotes(result.document));
    if (result.favorites) installFavorites(normalizeFavorites(result.favorites), { force: true });
    clearEditorSelection("星星已删除");
    showToast(`${note.id} 已删除并同步`);
  } catch (error) {
    elements.deleteNoteButton.disabled = false;
    showToast(error.message || "删除星星失败");
  }
}

function connectUpdates() {
  const events = new EventSource("/api/events");
  events.addEventListener("notes", (event) => {
    try { installNotes(normalizeNotes(JSON.parse(event.data))); } catch { /* keep current data */ }
  });
  events.addEventListener("favorites", (event) => {
    try { installFavorites(JSON.parse(event.data)); } catch { /* keep current favorites */ }
  });
  events.addEventListener("open", () => setSync("只读浏览", "ready"));
  events.onerror = () => setSync("正在重连", "");
}

function bindUi() {
  elements.musicButton.addEventListener("click", () => {
    setMusicPopover(!elements.musicPopover.classList.contains("open"));
  });
  elements.musicPrevious.addEventListener("click", () => {
    changeMusicTrack(-1, Boolean(state.music.audio && !state.music.audio.paused));
  });
  elements.musicPlay.addEventListener("click", toggleMusicPlayback);
  elements.musicNext.addEventListener("click", () => {
    changeMusicTrack(1, Boolean(state.music.audio && !state.music.audio.paused));
  });
  elements.musicVolume.addEventListener("input", () => {
    const volume = Math.min(1, Math.max(0, Number(elements.musicVolume.value) || 0));
    state.music.settings.volume = volume;
    if (state.music.audio) state.music.audio.volume = volume;
    storeMusicSettings();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!elements.musicPlayer.contains(event.target)) setMusicPopover(false);
  });
  elements.favoritesButton.addEventListener("click", () => setPanel(elements.favoritesPanel, true));
  elements.closeFavorites.addEventListener("click", () => setPanel(elements.favoritesPanel, false));
  elements.noteBackdrop.addEventListener("click", closeNote);
  elements.closeNote.addEventListener("click", closeNote);
  elements.favoriteNoteButton.addEventListener("click", toggleSelectedFavorite);
  elements.closeEditor.addEventListener("click", () => setPanel(elements.editorPanel, false));
  elements.editorSearch.addEventListener("input", renderEditorList);
  elements.addNoteButton.addEventListener("click", createEditorNote);
  elements.deleteNoteButton.addEventListener("click", deleteEditorNote);
  elements.editorEmotionSelect.addEventListener("change", () => {
    selectEditorEmotion(elements.editorEmotionSelect.value);
    markEditorDirty(true);
  });
  elements.editorChangeStatus.addEventListener("change", () => {
    state.editorChangeStatusTouched = true;
    updateEditorChangeMeta(state.editorNote, elements.editorChangeStatus.value);
    markEditorDirty(false);
  });
  elements.editorCustomLabel.addEventListener("input", () => {
    elements.editorEmotion.textContent = elements.editorCustomLabel.value.trim() || EMOTIONS.custom.label;
    markEditorDirty(true);
  });
  elements.editorCustomPosition.addEventListener("change", () => markEditorDirty(true));
  elements.editorColor.addEventListener("input", () => {
    setEditorColor(elements.editorColor.value);
    markEditorDirty(true);
  });
  elements.resetEditorColor.addEventListener("click", () => {
    selectEditorEmotion(elements.editorEmotionSelect.value);
    markEditorDirty(true);
  });
  elements.editorText.addEventListener("input", () => markEditorDirty(true));
  elements.noteEditorForm.addEventListener("submit", (event) => { event.preventDefault(); saveEditorNote(); });
  elements.saveNoteButton.addEventListener("click", (event) => { event.preventDefault(); saveEditorNote(); });
  elements.editorNotesTab.addEventListener("click", () => setEditorView("notes"));
  elements.editorActivityTab.addEventListener("click", () => setEditorView("activity"));
  elements.editorDevicesTab.addEventListener("click", () => setEditorView("devices"));
  elements.refreshActivityButton.addEventListener("click", loadActivity);
  elements.clearActivityButton.addEventListener("click", clearActivity);
  elements.refreshDevicesButton.addEventListener("click", loadOwnerDevices);

  document.querySelectorAll(".emotion-bubble").forEach((bubble) => {
    bubble.addEventListener("click", () => toggleEmotion(bubble.dataset.emotion));
  });

  elements.ownerTrigger.addEventListener("click", () => {
    const now = Date.now();
    state.triggerClicks = state.triggerClicks.filter((time) => now - time < 2600);
    state.triggerClicks.push(now);
    if (state.triggerClicks.length >= 4) {
      state.triggerClicks = [];
      openOwnerAccess();
    }
  });

  elements.ownerLoginForm.addEventListener("submit", async (event) => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    elements.loginMessage.textContent = "正在验证";
    try {
      await loginOwner(elements.ownerPassword.value);
      elements.ownerLogin.close();
      setPanel(elements.editorPanel, true);
      renderEditorList();
      setEditorView("notes");
    } catch (error) {
      elements.loginMessage.textContent = error.message;
      elements.ownerPassword.select();
    }
  });

  window.addEventListener("keydown", (event) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "s" &&
      elements.editorPanel.classList.contains("open")
    ) {
      event.preventDefault();
      saveEditorNote();
      return;
    }
    if (event.key === "Escape") {
      closeNote();
      setPanel(elements.favoritesPanel, false);
      setMusicPopover(false);
    }
  });
}

async function start() {
  bindUi();
  updateMusicUi();
  loadMusicLibrary().catch(() => updateMusicUi());
  state.visitorId = readVisitorId();
  state.ownerToken = readOwnerToken();
  try {
    const response = await fetch("/api/notes", { cache: "no-store" });
    if (!response.ok) throw new Error("无法读取纸条");
    installNotes(normalizeNotes(await response.json()));
    loadSharedFavorites().catch((error) => {
      updateFavoriteUi();
      showToast(`共享收藏暂时无法连接：${error.message}`);
    });

    state.scene = new StarBottleScene({
      canvas: elements.canvas,
      notes: state.notes,
      onSelect: openNote,
      onPour: () => elements.emotionBubbles.classList.add("visible"),
      onBubblePositions: positionBubbles,
    });
    if (typeof state.scene.init === "function") await state.scene.init();
    else await state.scene.ready;
    elements.loadingLayer.classList.add("hidden");
    setSync("只读浏览", "ready");
    connectUpdates();
  } catch (error) {
    elements.loadingText.textContent = error.message || "星光载入失败";
    setSync("载入失败", "error");
  }
}

start();
