/*
 * DOM renderer for the little pet.  The renderer deliberately knows nothing
 * about notes, stars, or the scene state; the controller supplies poses and
 * screen coordinates.  Keeping this boundary small also means a missing
 * optional image can never prevent the star bottle from loading.
 */

const DEFAULT_ASSETS = Object.freeze({
  idle: "idle.png",
  // The anxiety companion is a deliberately different silhouette.  Keeping
  // it as its own pose prevents an anxiety note from looking like idle or
  // pacing when the note is opened.
  anxiety: "generated/anxious-pair-web.png",
  wiggle: "wiggle-01.png",
  "wiggle-01": "wiggle-01.png",
  "wiggle-02": "wiggle-02.png",
  "arms-crossed": "arms-crossed.png",
  // Action sprites are versioned independently from the app bundle so a
  // browser cannot keep displaying the earlier idle-image placeholders.
  "pacing-left": "pacing-left.png?v=20260819-actions2",
  "pacing-right": "pacing-right.png?v=20260819-actions2",
  "lying-down": "lying-down.png",
  "big-heart": "big-heart.png?v=20260819-actions2",
  "fist-bump": "fist-bump.png?v=20260819-actions2",
  "hug-star": "hug-star.png?v=20260819-actions2",
  "cry-cover-face": "cry-cover-face.png?v=20260819-actions2",
  "pull-scroll": "pull-scroll.png?v=20260819-actions2",
  "drop-scroll": "drop-scroll.png?v=20260819-actions2",
  "magic-wand": "magic-wand.png?v=20260819-actions2",
});

const POSE_ALIASES = Object.freeze({
  happy: "wiggle",
  joy: "wiggle",
  crying: "cry-cover-face",
  cry: "cry-cover-face",
  pull: "pull-scroll",
  drop: "drop-scroll",
  magic: "magic-wand",
});

const DEFAULT_STYLE_ID = "pet-view-inline-style";

function getDocument(candidate) {
  return candidate || (typeof document !== "undefined" ? document : null);
}

function asFinite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function slug(value) {
  return String(value || "idle")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
}

function px(value) {
  return `${Math.round(asFinite(value))}px`;
}

function rectFrom(value) {
  if (!value) return null;
  if (typeof value.getBoundingClientRect === "function") return value.getBoundingClientRect();
  if (typeof value === "object" && Number.isFinite(Number(value.left))) {
    return {
      left: asFinite(value.left),
      top: asFinite(value.top),
      right: asFinite(value.right, asFinite(value.left) + asFinite(value.width)),
      bottom: asFinite(value.bottom, asFinite(value.top) + asFinite(value.height)),
      width: asFinite(value.width, asFinite(value.right) - asFinite(value.left)),
      height: asFinite(value.height, asFinite(value.bottom) - asFinite(value.top)),
    };
  }
  return null;
}

export class PetView {
  constructor(options = {}) {
    this.document = getDocument(options.document);
    this.window = options.window || (this.document?.defaultView || (typeof window !== "undefined" ? window : null));
    this.root = options.root || null;
    this.layer = options.layer || null;
    this.assetBase = String(options.assetBase || "/pet/").replace(/\/?$/, "/");
    this.assets = { ...DEFAULT_ASSETS, ...(options.assets || {}) };
    this.fallbackText = options.fallbackText || "✦";
    this.pose = "idle";
    this.walking = false;
    this.walkDirection = "right";
    this.visible = false;
    this.position = { x: 0, y: 0 };
    this.scale = 1;
    this.depth = 0;
    this.worldMode = false;
    this.anchor = null;
    this.effects = new Map();
    this.destroyed = false;
    this._clickHandler = null;
    this._dragHandler = null;
    this._dragSession = null;
    this._suppressClick = false;
    this._imageRequestId = 0;
    this._loaded = new Map();
    this._onWindowPointerMove = (event) => this._onPointerMove(event);
    this._onWindowPointerUp = (event) => this._onPointerUp(event, false);
    this._onWindowPointerCancel = (event) => this._onPointerUp(event, true);

    if (!this.document) return;
    this.root ||= this.document.querySelector(options.rootSelector || ".experience") || this.document.body;
    this.layer ||= this.document.getElementById("petLayer");
    if (!this.layer) {
      this.layer = this.document.createElement("div");
      this.layer.id = "petLayer";
      this.root?.appendChild(this.layer);
    }
    this.layer.classList.add("pet-layer");
    this.layer.removeAttribute("aria-hidden");
    this._ensureStyles();
    this._buildDom();
    this.setPosition({
      x: (this.window?.innerWidth || 640) * 0.5,
      y: (this.window?.innerHeight || 720) * 0.78,
    });
    this.setPose("idle");
    this.setVisible(false);
  }

  _ensureStyles() {
    if (!this.document?.head || this.document.getElementById(DEFAULT_STYLE_ID)) return;
    const style = this.document.createElement("style");
    style.id = DEFAULT_STYLE_ID;
    style.textContent = `
      #petLayer.pet-layer { position: fixed; inset: 0; z-index: 8; pointer-events: none; overflow: hidden; }
      #petLayer .pet-character { position: fixed; left: 50%; top: 50%; width: clamp(76px, 10vmin, 112px); aspect-ratio: 1; --pet-scale: 1; transform: translate(-50%, -100%) scale(var(--pet-scale)); opacity: 0; visibility: hidden; pointer-events: none; will-change: left, top, transform; transition: opacity .2s ease, transform .25s ease; filter: drop-shadow(0 8px 12px rgba(0,0,0,.28)); }
      #petLayer .pet-character.is-visible { opacity: 1; visibility: visible; }
      #petLayer .pet-character.is-world-mode { opacity: 1; filter: none; }
      #petLayer .pet-character.is-world-mode .pet-image, #petLayer .pet-character.is-world-mode .pet-fallback, #petLayer .pet-character.is-world-mode .pet-effects { opacity: 0; visibility: hidden; }
      #petLayer .pet-character.is-dragging { cursor: grabbing; transition: opacity .2s ease; }
      #petLayer .pet-image, #petLayer .pet-fallback { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
      #petLayer .pet-image { display: none; }
      #petLayer .pet-image.is-loaded { display: block; }
      #petLayer .pet-fallback[hidden], #petLayer .pet-image[hidden] { display: none !important; }
      /* A missing optional sprite must not turn the character into a card. */
      #petLayer .pet-fallback { display: grid; place-items: center; color: #ffdbb2; font: 900 clamp(28px, 6vmin, 56px)/1 sans-serif; text-shadow: 0 0 14px rgba(255,183,115,.85), 0 4px 12px rgba(0,0,0,.45); }
      /* The WebGL sprite and this transparent control have different image
         bounds.  Keep a generous, slightly lower hit target so clicks land
         on the visible body even when a texture has transparent padding. */
      #petLayer .pet-hit-area { position: absolute; left: 8%; right: 8%; top: 18%; bottom: -10%; border: 0; border-radius: 46%; background: transparent; pointer-events: auto; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
      #petLayer .pet-hit-area:disabled { pointer-events: none; cursor: default; }
      #petLayer .pet-effects { position: absolute; inset: -45%; pointer-events: none; }
      #petLayer .pet-effect { position: absolute; display: grid; place-items: center; color: #ff8b79; font: 900 clamp(18px, 4vmin, 36px)/1 sans-serif; text-shadow: 0 3px 10px rgba(0,0,0,.25); animation: pet-effect-float 1.1s ease-out both; }
      #petLayer .pet-effect-heart { right: 2%; top: -6%; }
      #petLayer .pet-effect-tears { left: 8%; top: 28%; color: #72c9f2; letter-spacing: .28em; }
      #petLayer .pet-effect-exclamation { right: -3%; top: -22%; color: #ffd27b; font-size: clamp(28px, 6vmin, 52px); }
      #petLayer .pet-effect-scroll { right: -18%; bottom: 2%; color: #f4d3a6; font-size: clamp(18px, 4vmin, 32px); }
      #petLayer .pet-effect-card { left: 50%; top: -80%; min-width: 120px; max-width: 190px; padding: 8px 10px; border: 1px solid rgba(255,255,255,.3); border-radius: 7px; background: rgba(9,12,26,.88); color: #fff7e9; font: 600 11px/1.4 sans-serif; transform: translateX(-50%); }
      #petLayer .pet-effect-marker { position: fixed; min-width: 22px; height: 22px; border-radius: 50%; background: rgba(255,211,117,.9); color: #3b1e09; font: 900 16px/22px sans-serif; text-align: center; box-shadow: 0 0 0 4px rgba(255,211,117,.16), 0 0 18px rgba(255,168,85,.7); animation: pet-marker-pulse 1.2s ease-in-out infinite; }
      #petLayer .pet-light-band { position: fixed; height: 3px; transform-origin: 0 50%; border-radius: 3px; background: linear-gradient(90deg, rgba(255,210,136,.05), rgba(255,177,103,.9), rgba(255,235,183,.15)); box-shadow: 0 0 10px rgba(255,183,115,.75); }
      #petLayer .pet-character[data-pose="lying-down"] { transform: translate(-50%, -86%) scale(var(--pet-scale)) scaleX(1.15); }
      #petLayer .pet-character[data-pose="pacing-left"] { transform: translate(-54%, -100%) scale(var(--pet-scale)) rotate(-3deg); }
      #petLayer .pet-character[data-pose="pacing-right"] { transform: translate(-46%, -100%) scale(var(--pet-scale)) rotate(3deg); }
      #petLayer .pet-character.is-walking { animation: pet-walk-bob .48s ease-in-out infinite; }
      #petLayer .pet-character[data-pose="cry-cover-face"] { animation: pet-shake .55s ease-in-out infinite; }
      #petLayer .pet-character[data-pose="wiggle"], #petLayer .pet-character[data-pose="wiggle-01"], #petLayer .pet-character[data-pose="wiggle-02"] { animation: pet-wiggle .85s ease-in-out infinite; }
      #petLayer .pet-hit-area:focus-visible { outline: 2px solid #ffd7ad; outline-offset: 3px; }
      @keyframes pet-wiggle { 0%,100% { rotate: -2deg; } 50% { rotate: 2deg; translate: 0 -3px; } }
      @keyframes pet-walk-bob { 0%,100% { translate: 0 0; } 50% { translate: 0 -4px; } }
      @keyframes pet-shake { 0%,100% { translate: 0 0; } 25% { translate: -2px 1px; } 75% { translate: 2px 1px; } }
      @keyframes pet-effect-float { from { opacity: 0; transform: translateY(8px) scale(.75); } 22% { opacity: 1; } to { opacity: 0; transform: translateY(-25px) scale(1.08); } }
      @keyframes pet-marker-pulse { 50% { transform: scale(1.17); opacity: .7; } }
      @media (prefers-reduced-motion: reduce) { #petLayer .pet-character, #petLayer .pet-effect, #petLayer .pet-effect-marker { animation: none !important; transition: none !important; } }
    `;
    this.document.head.appendChild(style);
  }

  _buildDom() {
    this.character = this.document.createElement("div");
    this.character.className = "pet-character";

    this.image = this.document.createElement("img");
    this.image.className = "pet-image";
    this.image.alt = "";
    this.image.draggable = false;
    this.image.decoding = "async";
    // The pose loop can replace src before an older request finishes. Keep a
    // request id so a stale load/error event cannot paint the previous pose.

    this.fallback = this.document.createElement("span");
    this.fallback.className = "pet-fallback";
    this.fallback.setAttribute("aria-hidden", "true");
    this.fallback.textContent = this.fallbackText;

    this.effectsLayer = this.document.createElement("div");
    this.effectsLayer.className = "pet-effects";
    this.effectsLayer.setAttribute("aria-hidden", "true");

    this.hitArea = this.document.createElement("button");
    this.hitArea.className = "pet-hit-area";
    this.hitArea.type = "button";
    this.hitArea.tabIndex = 0;
    this.hitArea.setAttribute("aria-label", "小鸡毛");
    this.hitArea.addEventListener("click", (event) => {
      event.stopPropagation();
      if (this._suppressClick) {
        this._suppressClick = false;
        return;
      }
      this._clickHandler?.(event);
    });
    this.hitArea.addEventListener("pointerdown", (event) => this._onPointerDown(event));
    // Pointer capture is not equally reliable when an invisible DOM control
    // is moving over a WebGL canvas. Window-level capture keeps the drag alive
    // after the pointer leaves the hit target and guarantees cleanup on up.
    this.window?.addEventListener?.("pointermove", this._onWindowPointerMove, { capture: true, passive: false });
    this.window?.addEventListener?.("pointerup", this._onWindowPointerUp, { capture: true, passive: false });
    this.window?.addEventListener?.("pointercancel", this._onWindowPointerCancel, { capture: true, passive: false });

    this.character.append(this.image, this.fallback, this.effectsLayer, this.hitArea);
    this.layer.appendChild(this.character);
  }

  onClick(handler) {
    this._clickHandler = typeof handler === "function" ? handler : null;
    return () => { this._clickHandler = null; };
  }

  onDrag(handler) {
    this._dragHandler = typeof handler === "function" ? handler : null;
    return () => { this._dragHandler = null; };
  }

  setInteractionEnabled(enabled = true) {
    const active = Boolean(enabled);
    if (!this.hitArea) return;
    this.hitArea.disabled = !active;
    this.hitArea.setAttribute("aria-disabled", String(!active));
    if (!active && this._dragSession) this._cancelPointerDrag();
  }

  cancelDrag() { this._cancelPointerDrag(); }

  _pointerPosition(event, session = this._dragSession) {
    const x = asFinite(event?.clientX, this.position.x) - asFinite(session?.offsetX);
    const y = asFinite(event?.clientY, this.position.y) - asFinite(session?.offsetY);
    return { x, y };
  }

  _clampDragPosition(position = {}) {
    const viewportWidth = asFinite(this.window?.innerWidth, 0);
    const viewportHeight = asFinite(this.window?.innerHeight, 0);
    const rect = this.character?.getBoundingClientRect?.() || {};
    const halfWidth = Math.max(12, asFinite(rect.width, 100) * 0.5);
    const height = Math.max(24, asFinite(rect.height, 100));
    const margin = 6;
    const x = viewportWidth
      ? Math.min(Math.max(asFinite(position.x, this.position.x), halfWidth + margin), Math.max(halfWidth + margin, viewportWidth - halfWidth - margin))
      : asFinite(position.x, this.position.x);
    const y = viewportHeight
      ? Math.min(Math.max(asFinite(position.y, this.position.y), height + margin), Math.max(height + margin, viewportHeight - margin))
      : asFinite(position.y, this.position.y);
    return { ...position, x, y };
  }

  _onPointerDown(event) {
    if (this.destroyed || !this.hitArea || this.hitArea.disabled || this._dragSession) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const session = {
      pointerId: event.pointerId,
      startX: asFinite(event.clientX),
      startY: asFinite(event.clientY),
      offsetX: asFinite(event.clientX) - this.position.x,
      offsetY: asFinite(event.clientY) - this.position.y,
      moved: false,
      started: false,
    };
    const result = this._dragHandler?.({
      phase: "start",
      event,
      pointerId: event.pointerId,
      position: { ...this.position },
      x: this.position.x,
      y: this.position.y,
    });
    if (result === false) return;
    this._dragSession = session;
    this.character?.classList.add("is-dragging");
    try { this.hitArea?.setPointerCapture?.(event.pointerId); } catch { /* window listeners keep the drag active */ }
    // Do not cancel the pointer's default click synthesis here.  A short
    // press should still reach the button's click handler; once movement
    // crosses the drag threshold, pointermove/up cancel it below.
    event.stopPropagation?.();
  }

  _onPointerMove(event) {
    const session = this._dragSession;
    if (!session || event.pointerId !== session.pointerId) return;
    const dx = asFinite(event.clientX) - session.startX;
    const dy = asFinite(event.clientY) - session.startY;
    if (!session.moved && Math.hypot(dx, dy) < 4) return;
    session.moved = true;
    const raw = this._clampDragPosition(this._pointerPosition(event, session));
    const result = this._dragHandler?.({
      phase: "move",
      event,
      pointerId: event.pointerId,
      position: raw,
      x: raw.x,
      y: raw.y,
      start: { x: session.startX, y: session.startY },
      delta: { x: dx, y: dy },
    });
    if (result === false) return;
    const next = result && typeof result === "object" && result.position
      ? result.position
      : raw;
    this.setPosition(this._clampDragPosition(next));
    event.preventDefault?.();
    event.stopPropagation?.();
  }

  _onPointerUp(event, cancelled = false) {
    const session = this._dragSession;
    if (!session || event.pointerId !== session.pointerId) return;
    this._dragSession = null;
    this.character?.classList.remove("is-dragging");
    try { this.hitArea?.releasePointerCapture?.(event.pointerId); } catch { /* capture may already be gone */ }
    if (session.moved) {
      this._suppressClick = true;
      this.window?.setTimeout?.(() => { this._suppressClick = false; }, 250);
    }
    const position = this._clampDragPosition(this._pointerPosition(event, session));
    this._dragHandler?.({
      phase: cancelled ? "cancel" : "end",
      event,
      pointerId: event.pointerId,
      position,
      x: position.x,
      y: position.y,
      moved: session.moved,
      start: { x: session.startX, y: session.startY },
      delta: { x: asFinite(event.clientX) - session.startX, y: asFinite(event.clientY) - session.startY },
    });
    if (session.moved || cancelled) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
  }

  _cancelPointerDrag() {
    const session = this._dragSession;
    if (!session) return;
    this._dragSession = null;
    this.character?.classList.remove("is-dragging");
    this._dragHandler?.({ phase: "cancel", pointerId: session.pointerId, moved: session.moved, position: { ...this.position } });
  }

  setPose(nextPose, options = {}) {
    if (this.destroyed) return;
    const requested = String(nextPose || "idle");
    const normalized = POSE_ALIASES[requested] || requested;
    this.pose = normalized;
    if (!this.character) return;
    this.character.dataset.pose = slug(normalized);
    this.image.dataset.pose = normalized;
    this.character.classList.remove("pet-pose-change");
    // Force a small CSS transition when a pose is repeated.
    if (options.retrigger !== false) {
      void this.character.offsetWidth;
      this.character.classList.add("pet-pose-change");
    }
    const source = this.assets[normalized] || this.assets[requested];
    if (!source) {
      this._imageRequestId += 1;
      this.image.removeAttribute("src");
      this.image.classList.remove("is-loaded");
      this.fallback.hidden = false;
      return;
    }
    const url = /^([a-z]+:)?\/\//i.test(String(source)) || String(source).startsWith("/")
      ? String(source)
      : `${this.assetBase}${String(source).replace(/^\//, "")}`;
    if (this.image.dataset.src !== url) {
      const requestId = ++this._imageRequestId;
      this.image.dataset.src = url;
      this.image.classList.remove("is-loaded");
      this.fallback.hidden = this._loaded.get(normalized) === true;
      this.image.onload = () => {
        if (requestId !== this._imageRequestId || this.image.dataset.src !== url) return;
        this._loaded.set(normalized, true);
        this.image.classList.add("is-loaded");
        this.fallback.hidden = true;
      };
      this.image.onerror = () => {
        if (requestId !== this._imageRequestId || this.image.dataset.src !== url) return;
        this._loaded.set(normalized, false);
        this.image.classList.remove("is-loaded");
        this.fallback.hidden = false;
      };
      this.image.src = url;
    } else if (this._loaded.get(normalized) === true) {
      this.image.classList.add("is-loaded");
      this.fallback.hidden = true;
    }
  }

  getPoseAsset(pose = this.pose) {
    const requested = String(pose || "idle");
    const normalized = POSE_ALIASES[requested] || requested;
    const source = this.assets[normalized] || this.assets[requested];
    if (!source) return "";
    return /^([a-z]+:)?\/\//i.test(String(source)) || String(source).startsWith("/")
      ? String(source)
      : `${this.assetBase}${String(source).replace(/^\//, "")}`;
  }

  setWorldMode(active = false) {
    this.worldMode = Boolean(active);
    this.character?.classList.toggle("is-world-mode", this.worldMode);
  }

  /** Toggle a renderer-level walk hook; path timing remains controller-owned. */
  setWalking(active = false, direction = this.walkDirection) {
    this.walking = Boolean(active);
    this.walkDirection = String(direction).toLowerCase() === "left" ? "left" : "right";
    if (!this.character) return;
    this.character.classList.toggle("is-walking", this.walking);
    this.character.dataset.walkDirection = this.walkDirection;
  }

  setVisible(visible = true) {
    this.visible = Boolean(visible);
    this.character?.classList.toggle("is-visible", this.visible);
    if (this.layer) this.layer.dataset.visible = String(this.visible);
  }

  show() { this.setVisible(true); }
  hide() { this.setVisible(false); }

  setPosition(position = {}) {
    if (this.destroyed || !this.character) return;
    const x = asFinite(position.x, this.position.x);
    const y = asFinite(position.y, this.position.y);
    this.position = { x, y };
    if (Number.isFinite(Number(position.scale))) this.setScale(position.scale);
    if (Number.isFinite(Number(position.depth))) this.setDepth(position.depth);
    this.character.style.left = px(x);
    this.character.style.top = px(y);
    this.character.style.setProperty("--pet-x", px(x));
    this.character.style.setProperty("--pet-y", px(y));
  }

  setScreenPosition(position = {}) { this.setPosition(position); }

  setProjectedPosition(position = {}) { this.setPosition(position); }

  setScale(scale = 1) {
    const value = Math.max(0.68, Math.min(1.24, asFinite(scale, 1)));
    this.scale = value;
    this.character?.style.setProperty("--pet-scale", String(value));
  }

  setDepth(depth = 0) {
    this.depth = asFinite(depth, this.depth);
    if (this.character) this.character.dataset.depth = String(Math.round(this.depth * 100) / 100);
  }

  moveNearPointer(position = {}, options = {}) {
    const viewportWidth = asFinite(options.width, this.window?.innerWidth || 0);
    const viewportHeight = asFinite(options.height, this.window?.innerHeight || 0);
    const margin = asFinite(options.margin, 52);
    const width = this.character?.getBoundingClientRect?.().width || 100;
    const height = this.character?.getBoundingClientRect?.().height || 100;
    const x = Math.min(Math.max(asFinite(position.x, this.position.x), margin + width / 2), Math.max(margin + width / 2, viewportWidth - margin - width / 2));
    const y = Math.min(Math.max(asFinite(position.y, this.position.y), margin + height), Math.max(margin + height, viewportHeight - margin));
    this.setPosition({ x, y, scale: position.scale, depth: position.depth });
  }

  moveHome(options = {}) {
    const viewportWidth = asFinite(options.width, this.window?.innerWidth || 0);
    const viewportHeight = asFinite(options.height, this.window?.innerHeight || 0);
    const width = this.character?.getBoundingClientRect?.().width || 100;
    const height = this.character?.getBoundingClientRect?.().height || 100;
    this.setScale(1);
    this.setDepth(0);
    this.moveNearPointer({
      // Keep the initial resting place in the bottle's lower field.  The
      // controller may supply a measured scene anchor; this fallback avoids
      // the old bottom-right "floating widget" placement on first paint.
      x: asFinite(options.x, viewportWidth * 0.34),
      y: asFinite(options.y, viewportHeight * 0.79),
    }, {
      ...options,
      width: viewportWidth,
      height: viewportHeight,
      margin: options.margin ?? 16,
    });
  }

  getSize() {
    const rect = this.character?.getBoundingClientRect?.();
    return {
      width: asFinite(rect?.width, 100),
      height: asFinite(rect?.height, 100),
    };
  }

  anchorToNote(target, options = {}) {
    const resolved = typeof target === "string"
      ? this.document?.querySelector?.(target)
      : target || this.document?.querySelector?.(".unfolded-note");
    const rect = rectFrom(resolved);
    if (!rect) return false;
    const viewportWidth = asFinite(options.width, this.window?.innerWidth || 0);
    const viewportHeight = asFinite(options.height, this.window?.innerHeight || 0);
    const petRect = this.character?.getBoundingClientRect?.() || { width: 100, height: 100 };
    const petWidth = Math.max(1, asFinite(petRect.width, 100));
    const petHeight = Math.max(1, asFinite(petRect.height, 100));
    const gap = Math.max(8, asFinite(options.gap, 16));
    const margin = Math.max(8, asFinite(options.margin, 10));
    const viewport = {
      width: viewportWidth || Math.max(rect.right, this.window?.innerWidth || 0),
      height: viewportHeight || Math.max(rect.bottom, this.window?.innerHeight || 0),
    };
    // Put the companion beside the unfolded paper.  The old anchor used the
    // paper's right edge as the pet center, which placed the hit area over the
    // message text and made the note feel impossible to read or drag.
    const candidates = [
      { x: rect.right + petWidth * 0.5 + gap, y: rect.top + rect.height * 0.78 },
      { x: rect.left - petWidth * 0.5 - gap, y: rect.top + rect.height * 0.78 },
      { x: rect.right + petWidth * 0.5 + gap, y: rect.top + petHeight + gap },
      { x: rect.left - petWidth * 0.5 - gap, y: rect.top + petHeight + gap },
      { x: rect.left - petWidth * 0.3, y: rect.top - gap },
      { x: rect.right + petWidth * 0.3, y: rect.top - gap },
      { x: rect.left + rect.width * 0.18, y: rect.top - gap },
    ];
    const clamp = (candidate) => ({
      x: Math.min(Math.max(candidate.x, petWidth / 2 + margin), Math.max(petWidth / 2 + margin, viewport.width - petWidth / 2 - margin)),
      y: Math.min(Math.max(candidate.y, petHeight + margin), Math.max(petHeight + margin, viewport.height - margin)),
    });
    const overlap = (candidate) => {
      const left = candidate.x - petWidth / 2;
      const right = candidate.x + petWidth / 2;
      const top = candidate.y - petHeight;
      const bottom = candidate.y;
      const width = Math.max(0, Math.min(right, rect.right) - Math.max(left, rect.left));
      const height = Math.max(0, Math.min(bottom, rect.bottom) - Math.max(top, rect.top));
      return width * height;
    };
    const xCenter = rect.left + rect.width * 0.5;
    const yCenter = rect.top + rect.height * 0.5;
    const chosen = candidates
      .map(clamp)
      .sort((a, b) => {
        const overlapDelta = overlap(a) - overlap(b);
        if (Math.abs(overlapDelta) > 1) return overlapDelta;
        return Math.hypot(a.x - xCenter, a.y - yCenter) - Math.hypot(b.x - xCenter, b.y - yCenter);
      })[0] || clamp({ x: rect.right + petWidth * 0.5 + gap, y: rect.bottom });
    const x = chosen.x;
    const y = chosen.y;
    this.anchor = { target: resolved, options: { ...options } };
    this.setPosition({ x, y, scale: 1, depth: 0 });
    this.character.style.setProperty("--pet-anchor-gap", px(gap));
    return true;
  }

  clearAnchor() {
    this.anchor = null;
    if (this.character) this.character.style.removeProperty("--pet-anchor-gap");
  }

  _appendEffect(name, text, className, options = {}) {
    if (!this.effectsLayer) return null;
    const key = String(name);
    this.clearEffect(key);
    const effect = this.document.createElement("span");
    effect.className = `pet-effect ${className || `pet-effect-${slug(key)}`}`;
    effect.dataset.effect = key;
    effect.setAttribute("aria-hidden", "true");
    effect.textContent = text;
    if (options.text) effect.textContent = String(options.text);
    if (options.style && typeof options.style === "object") {
      for (const [property, value] of Object.entries(options.style)) effect.style.setProperty(property, String(value));
    }
    this.effectsLayer.appendChild(effect);
    this.effects.set(key, effect);
    return effect;
  }

  showEffect(name, options = {}) {
    const key = String(name || "heart");
    const defaults = {
      heart: ["♥", "pet-effect-heart"],
      tears: ["••", "pet-effect-tears"],
      exclamation: ["!", "pet-effect-exclamation"],
      scroll: ["▤", "pet-effect-scroll"],
      card: [String(options.text || "✦"), "pet-effect-card"],
    };
    const [text, className] = defaults[key] || [String(options.text || "✦"), `pet-effect-${slug(key)}`];
    return this._appendEffect(options.key || key, text, className, options);
  }

  showHeart(options = {}) { return this.showEffect("heart", options); }
  showTears(options = {}) { return this.showEffect("tears", options); }
  showExclamation(options = {}) { return this.showEffect("exclamation", options); }
  showScroll(options = {}) { return this.showEffect("scroll", options); }

  showCard(text, options = {}) {
    return this.showEffect("card", { ...options, text: text || options.text || "✦" });
  }

  showMarker(position, options = {}) {
    if (!this.layer || !this.document) return null;
    const key = options.key || "marker";
    let marker = this.effects.get(key);
    if (!marker || (marker.isConnected === false && !marker.parentNode)) {
      marker = this.document.createElement("span");
      marker.className = "pet-effect-marker";
      marker.dataset.effect = key;
      marker.setAttribute("aria-hidden", "true");
      marker.textContent = options.text || "!";
      this.layer.appendChild(marker);
      this.effects.set(key, marker);
    }
    marker.style.left = px(asFinite(position?.x));
    marker.style.top = px(asFinite(position?.y));
    return marker;
  }

  showLightBand(from, to, options = {}) {
    if (!this.layer || !from || !to) return null;
    const key = options.key || "light-band";
    const x1 = asFinite(from.x), y1 = asFinite(from.y);
    const x2 = asFinite(to.x), y2 = asFinite(to.y);
    const distance = Math.hypot(x2 - x1, y2 - y1);
    let band = this.effects.get(key);
    if (!band || (band.isConnected === false && !band.parentNode)) {
      band = this.document.createElement("span");
      band.className = "pet-light-band";
      band.dataset.effect = key;
      band.setAttribute("aria-hidden", "true");
      this.layer.appendChild(band);
      this.effects.set(key, band);
    }
    band.style.left = px(x1);
    band.style.top = px(y1);
    band.style.width = px(distance);
    band.style.transform = `rotate(${Math.atan2(y2 - y1, x2 - x1)}rad)`;
    return band;
  }

  clearEffect(name) {
    const key = String(name || "");
    const effect = this.effects.get(key);
    if (!effect) return;
    effect.remove?.();
    this.effects.delete(key);
  }

  clearEffects() {
    for (const effect of this.effects.values()) effect.remove?.();
    this.effects.clear();
    this.effectsLayer?.replaceChildren?.();
    if (this.layer) this.layer.querySelectorAll(".pet-effect-marker, .pet-light-band").forEach((node) => node.remove());
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._cancelPointerDrag();
    this._clickHandler = null;
    this._dragHandler = null;
    this.window?.removeEventListener?.("pointermove", this._onWindowPointerMove, true);
    this.window?.removeEventListener?.("pointerup", this._onWindowPointerUp, true);
    this.window?.removeEventListener?.("pointercancel", this._onWindowPointerCancel, true);
    if (this.image) {
      this.image.onload = null;
      this.image.onerror = null;
    }
    this.setWalking(false);
    this.clearEffects();
    this.character?.remove();
    this.character = null;
    this.image = null;
    this.fallback = null;
    this.effectsLayer = null;
    this.hitArea = null;
  }
}

export { DEFAULT_ASSETS as PET_ASSETS };
export default PetView;
