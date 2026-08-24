/*
 * Behaviour coordinator for the DOM pet.
 *
 * This module is intentionally independent from app.js and scene internals.
 * app.js can forward its existing business events to the methods below and
 * scene.js can forward the three star-drag callbacks.  All state-owned timers
 * and animation frames are registered here, so a transition has one cleanup
 * path and a destroyed page cannot leave work behind.
 */

import PetView from "./pet-view.js";

export const PET_STATES = Object.freeze({
  PUSHING_NEW_NOTE: "PUSHING_NEW_NOTE",
  RETRIEVING_STAR: "RETRIEVING_STAR",
  ACCOMPANYING_READ: "ACCOMPANYING_READ",
  PLAYING_WITH_STAR: "PLAYING_WITH_STAR",
  IDLE_MAGIC: "IDLE_MAGIC",
  CODING: "CODING",
  IDLE: "IDLE",
});

export const PET_PRIORITY = Object.freeze({
  [PET_STATES.PUSHING_NEW_NOTE]: 0,
  [PET_STATES.RETRIEVING_STAR]: 1,
  [PET_STATES.ACCOMPANYING_READ]: 2,
  [PET_STATES.PLAYING_WITH_STAR]: 3,
  [PET_STATES.IDLE_MAGIC]: 4,
  [PET_STATES.CODING]: 4,
  [PET_STATES.IDLE]: 5,
});

const IDLE_ACTION_STATES = new Set([
  PET_STATES.IDLE_MAGIC,
  PET_STATES.CODING,
]);

const EMOTION_POSES = Object.freeze({
  joy: { pose: "wiggle", fragment: "heart" },
  baby: { pose: "wiggle", fragment: "heart" },
  anger: { pose: "arms-crossed", fragment: null },
  anxiety: { pose: "anxiety", fragment: null },
  sadness: { pose: "lying-down", fragment: null },
  custom: { pose: "idle", fragment: null },
});

const DEFAULT_TIMINGS = Object.freeze({
  pushTimeout: 60_000,
  playAfterMin: 10_000,
  playAfterMax: 15_000,
  playDuration: 3_000,
  // Idle wandering is deliberately slower than the expressive actions.  It
  // keeps the character present in the bottle scene without competing with
  // note, drag, or panel interactions.
  // The first walk begins after five seconds of genuine inactivity.  Keeping
  // both bounds equal also makes the behavior deterministic for reduced-motion
  // and test clocks while later walks still use their pause interval.
  wanderAfterMin: 5_000,
  wanderAfterMax: 5_000,
  wanderDurationMin: 1_800,
  wanderDurationMax: 3_200,
  wanderPauseMin: 2_400,
  wanderPauseMax: 5_000,
  // Coding belongs to the roaming cadence: four completed exploratory walks
  // are followed by one stationary work break.
  codingAfterWanders: 4,
  magicInactivity: 5_000,
  pushTravelDuration: 2_800,
  magicAfterMin: 60_000,
  magicAfterMax: 120_000,
  fragmentDuration: 1_250,
  retrieveDuration: 1_750,
  retrieveApproachDuration: 1_650,
  retrieveReturnDuration: 4_800,
  retrieveBehindDistance: 0.62,
  magicHeartDuration: 760,
  magicCardDuration: 1_050,
  magicArrayDuration: 1_650,
  // A completed heart arrangement should read as a deliberate interaction,
  // not a one-frame effect.  Keep it stable for five seconds, then ease the
  // stars back to their original positions before releasing the override.
  magicHeartHoldDuration: 5_000,
  magicHeartReturnDuration: 3_600,
  codingDuration: 8_000,
  codingPoseInterval: 420,
  settlePoll: 160,
});

const NOTE_CHANGE_REASONS = new Set(["added", "updated", "manual"]);
const VALID_SCENE_STATES = new Set(["floating", "physics", "contained", "exiting", "galaxy"]);

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function idOf(value) {
  if (value && typeof value === "object") return String(value.id || value.noteId || "");
  return String(value || "");
}

function clonePosition(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x), y = Number(value.y), z = Number(value.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

function lerpPosition(a, b, amount) {
  const from = clonePosition(a) || { x: 0, y: 0, z: 0 };
  const to = clonePosition(b) || from;
  const t = Math.max(0, Math.min(1, finite(amount)));
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    z: from.z + (to.z - from.z) * t,
  };
}

function distance(a, b) {
  const first = clonePosition(a), second = clonePosition(b);
  if (!first || !second) return Infinity;
  return Math.hypot(first.x - second.x, first.y - second.y, first.z - second.z);
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function noteCopy(note) {
  if (!note || typeof note !== "object") return null;
  const id = idOf(note);
  if (!id) return null;
  return {
    ...note,
    id,
    emotion: String(note.emotion || "joy"),
    changeStatus: note.changeStatus === "unread" ? "unread" : "read",
    changeReason: NOTE_CHANGE_REASONS.has(note.changeReason) ? note.changeReason : "",
    changeAt: typeof note.changeAt === "string" ? note.changeAt : "",
  };
}

function eventKey(note) {
  const copy = noteCopy(note);
  if (!copy) return "";
  // Include the fields that can change without a new changeAt in older data.
  return [
    copy.id,
    copy.changeAt,
    copy.changeReason,
    copy.changeStatus,
    copy.text || "",
    copy.emotion || "",
  ].join("|");
}

function defaultClock() {
  const root = typeof globalThis !== "undefined" ? globalThis : {};
  return {
    now: () => Date.now(),
    setTimeout: (callback, delay) => root.setTimeout(callback, delay),
    clearTimeout: (handle) => root.clearTimeout?.(handle),
    requestAnimationFrame: (callback) => {
      if (typeof root.requestAnimationFrame === "function") return root.requestAnimationFrame(callback);
      return root.setTimeout(() => callback(Date.now()), 16);
    },
    cancelAnimationFrame: (handle) => {
      if (typeof root.cancelAnimationFrame === "function") root.cancelAnimationFrame(handle);
      else root.clearTimeout?.(handle);
    },
  };
}

export class PetController {
  constructor(options = {}) {
    this.scene = options.scene || null;
    this.view = options.view || new PetView(options.viewOptions || {});
    this.clock = { ...defaultClock(), ...(options.clock || {}) };
    this.random = typeof options.random === "function" ? options.random : Math.random;
    this.timings = { ...DEFAULT_TIMINGS, ...(options.timings || {}) };
    this.onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : null;
    this.onEvent = typeof options.onEvent === "function" ? options.onEvent : null;
    this.noteElementResolver = typeof options.noteElementResolver === "function"
      ? options.noteElementResolver
      : () => null;
    this.safeMargin = finite(options.safeMargin, 52);
    this.retrievalThresholdMin = finite(options.retrievalThresholdMin, 0.9);
    this.retrievalThresholdMax = finite(options.retrievalThresholdMax, 1.4);
    if (this.retrievalThresholdMax < this.retrievalThresholdMin) {
      [this.retrievalThresholdMin, this.retrievalThresholdMax] = [this.retrievalThresholdMax, this.retrievalThresholdMin];
    }

    this.state = PET_STATES.IDLE;
    this.currentState = this.state;
    this.priority = PET_PRIORITY[this.state];
    this.stateContext = {};
    this.resumeState = null;
    this.token = null;
    this.destroyed = false;
    this._tokenSequence = 0;
    this._stateTimers = new Set();
    this._stateFrames = new Set();
    this._backgroundTimers = new Set();
    this._fragmentTimer = null;
    this._fragmentPose = null;
    this._fragmentEffect = null;
    this._claimedStarId = null;
    this._pushTarget = null;
    this._pushPositioned = false;
    this._retrieveTarget = null;
    this._playTarget = null;
    this._magicLocked = false;
    this._sceneSettled = false;
    this._uiBlocked = false;
    this._noteOpenId = null;
    this._readAnchorReleased = false;
    this._pendingRead = null;
    this._petDrag = null;
    this._retrieveQueue = [];
    this._retrieveActive = null;
    this._queuedClaimedStarIds = new Set();
    this._pushMotion = null;
    this._retrieveMotion = null;
    this._worldProjectionFollowingToken = null;
    this._lastActivityAt = this.clock.now();
    this._backgroundArmedAt = 0;
    this._showcaseDueAt = 0;
    this._wander = null;
    this._completedWandersSinceCoding = 0;
    this._lastWalkBounds = null;
    this._lastWorldPosition = null;
    this._petStarContactAt = new Map();
    this._onResize = () => this.resize();

    this.notesById = new Map();
    this.unreadQueue = [];
    this._queuedById = new Map();
    this._seenChangeKeys = new Set();
    this._seenChangeOrder = [];
    this._notesVersion = null;
    this._hasBaseline = false;
    this._sequence = 0;
    this.moodByNoteId = new Map();
    this.emotionValues = this.moodByNoteId;

    this._offViewClick = this.view?.onClick?.(() => this.petClick()) || null;
    this._offViewDrag = this.view?.onDrag?.((detail) => this._handlePetDrag(detail)) || null;
    this.view?.window?.addEventListener?.("resize", this._onResize, { passive: true });
    this._enterState(PET_STATES.IDLE, {}, { initial: true });
  }

  get stateId() { return this.state; }
  get isBusy() { return this.state !== PET_STATES.IDLE; }
  get cancelToken() { return this.token; }

  resize() {
    if (this.destroyed) return;
    if (this.state === PET_STATES.IDLE) {
      if (this._petDrag) {
        const current = clonePosition(this._lastWorldPosition);
        if (current) this._setProjectedWorldPosition(this._groundPoint(current.x, current.z, { allowOutside: true }));
        return;
      }
      this._stopIdleWander();
      this._positionPetHome();
      this._armBackgroundTimers();
      return;
    }
    if (this.state === PET_STATES.ACCOMPANYING_READ) {
      if (this._readAnchorReleased) {
        this.view?.moveNearPointer?.(this.view?.position || {}, { margin: 10 });
        return;
      }
      const target = this.view?.anchor?.target || this.stateContext?.element || this.noteElementResolver?.(this.stateContext?.note);
      if (target) this.view?.anchorToNote?.(target);
      return;
    }
    this.view?.moveNearPointer?.(this.view?.position || {}, { margin: this.safeMargin * 0.58 });
  }

  _emit(type, detail = {}) {
    try { this.onEvent?.({ type, ...detail }); } catch { /* observer errors cannot break pet logic */ }
  }

  _rememberChange(key) {
    if (!key || this._seenChangeKeys.has(key)) return false;
    this._seenChangeKeys.add(key);
    this._seenChangeOrder.push(key);
    while (this._seenChangeOrder.length > 512) this._seenChangeKeys.delete(this._seenChangeOrder.shift());
    return true;
  }

  _setTimer(callback, delay, token = this.token, background = false) {
    const bucket = background ? this._backgroundTimers : this._stateTimers;
    let handle = null;
    let completed = false;
    handle = this.clock.setTimeout(() => {
      completed = true;
      if (handle !== null) bucket.delete(handle);
      if (this.destroyed || (token && token.cancelled)) return;
      callback();
    }, Math.max(0, finite(delay)));
    if (!completed) bucket.add(handle);
    return handle;
  }

  _setFrame(callback, token = this.token) {
    let handle = null;
    let completed = false;
    handle = this.clock.requestAnimationFrame(() => {
      completed = true;
      if (handle !== null) this._stateFrames.delete(handle);
      if (this.destroyed || (token && token.cancelled)) return;
      // Browser RAF timestamps use a different epoch from Date.now(). Keep
      // controller animation math on the injected clock for real and fake
      // clock parity.
      callback(this.clock.now());
    });
    if (!completed) this._stateFrames.add(handle);
    return handle;
  }

  _clearStateWork() {
    for (const handle of this._stateTimers) this.clock.clearTimeout(handle);
    this._stateTimers.clear();
    for (const handle of this._stateFrames) this.clock.cancelAnimationFrame(handle);
    this._stateFrames.clear();
    if (this.token) this.token.cancelled = true;
    this.token = null;
    this.view?.clearEffects?.();
    this.view?.clearAnchor?.();
    if (this._fragmentTimer) this.clock.clearTimeout(this._fragmentTimer);
    this._fragmentTimer = null;
    this._fragmentPose = null;
    this._fragmentEffect = null;
    if (this._claimedStarId) {
      try { this.scene?.releaseStarVisual?.(this._claimedStarId, { snapToTarget: true }); } catch { /* scene may already be gone */ }
      this._claimedStarId = null;
    }
    try { this.scene?.clearHeartArrayOverride?.(); } catch { /* scene may already be gone */ }
    try { this.scene?.setStarDragEnabled?.(true); } catch { /* optional scene API */ }
    try { this.scene?.setInteractionLocked?.(false, "pet-magic"); } catch { /* optional scene API */ }
    this._magicLocked = false;
    this._drag = null;
    this._petDrag = null;
    this.view?.setWalking?.(false, "right");
    this._pushMotion = null;
    this._retrieveMotion = null;
    this._worldProjectionFollowingToken = null;
    this._wander = null;
    this._petStarContactAt.clear();
    try { this.view?.setWalking?.(false); } catch { /* optional renderer */ }
  }

  _canInterrupt(nextState, force = false) {
    if (force) return true;
    return PET_PRIORITY[nextState] <= this.priority;
  }

  _transition(nextState, context = {}, options = {}) {
    if (this.destroyed || !PET_PRIORITY.hasOwnProperty(nextState)) return false;
    const force = options.force === true;
    if (!this._canInterrupt(nextState, force)) return false;
    const previous = this.state;
    const previousContext = this.stateContext;
    if (!options.initial && previous === nextState && !options.replace) return true;

    // Queued visual claims belong to the retrieval transaction.  If a higher
    // priority action interrupts it, release every queued claim so a star
    // cannot remain frozen at a stale drag position indefinitely.
    if (previous === PET_STATES.RETRIEVING_STAR && nextState !== PET_STATES.RETRIEVING_STAR) {
      this._releaseQueuedRetrieveClaims();
    }

    if (!options.initial && previous !== PET_STATES.IDLE && PET_PRIORITY[nextState] < PET_PRIORITY[previous]) {
      this.resumeState = { state: previous, context: previousContext };
    }
    if (nextState !== PET_STATES.IDLE) this._cancelBackgroundTimers();
    this._clearStateWork();
    this.state = nextState;
    this.currentState = nextState;
    this.priority = PET_PRIORITY[nextState];
    this.stateContext = context || {};
    this._enterState(nextState, this.stateContext, options);
    try { this.onStateChange?.({ state: nextState, previous, priority: this.priority, context: this.stateContext }); } catch { /* observer errors are isolated */ }
    this._emit("state", { state: nextState, previous, context: this.stateContext });
    return true;
  }

  _releaseQueuedRetrieveClaims() {
    for (const noteId of this._queuedClaimedStarIds) {
      try { this.scene?.releaseStarVisual?.(noteId, { snapToTarget: true }); } catch { /* scene may already be gone */ }
    }
    this._queuedClaimedStarIds.clear();
    this._retrieveQueue = [];
  }

  _enterState(state, context = {}, options = {}) {
    this.token = { id: ++this._tokenSequence, cancelled: false };
    const token = this.token;
    switch (state) {
      case PET_STATES.PUSHING_NEW_NOTE:
        this._enterPush(context, token);
        break;
      case PET_STATES.RETRIEVING_STAR:
        this._enterRetrieve(context, token);
        break;
      case PET_STATES.ACCOMPANYING_READ:
        this._enterRead(context, token);
        break;
      case PET_STATES.PLAYING_WITH_STAR:
        this._enterPlay(context, token);
        break;
      case PET_STATES.IDLE_MAGIC:
        this._enterMagic(context, token);
        break;
      case PET_STATES.CODING:
        this._enterCoding(context, token);
        break;
      default:
        this._setWorldRendering(this._sceneSettled);
        this.view?.clearAnchor?.();
        this._setPose("idle");
        if (this._sceneSettled) {
          this._positionPetHome();
          this.view?.show?.();
          this._armBackgroundTimers();
        } else {
          // Before the bottle has opened there is no visible ground plane.
          // Keep the 2D sprite hidden instead of falling back to a viewport
          // corner where it reads like a floating widget.
          this.view?.hide?.();
        }
        break;
    }
    if (state !== PET_STATES.ACCOMPANYING_READ && this._sceneSettled) {
      this._startWorldProjectionFollow(token);
    }
  }

  _setPose(pose, options) {
    try { this.view?.setPose?.(pose, options); } catch { /* optional renderer */ }
    try { this.scene?.setPetSpritePose?.(pose, this.view?.getPoseAsset?.(pose)); } catch { /* optional scene API */ }
  }

  _setWalking(active, direction = "right") {
    try { this.view?.setWalking?.(active, direction); } catch { /* optional renderer */ }
    try { this.scene?.setPetWalking?.(active, direction); } catch { /* optional scene API */ }
  }

  _setWorldRendering(active) {
    const world = Boolean(active);
    try { this.view?.setWorldMode?.(world); } catch { /* optional renderer */ }
    try { this.scene?.setPetSpriteVisible?.(world); } catch { /* optional scene API */ }
  }

  _startWorldProjectionFollow(token) {
    if (!this._isTokenCurrent(token) || this._worldProjectionFollowingToken === token.id) return;
    this._worldProjectionFollowingToken = token.id;
    const tick = () => {
      if (!this._isTokenCurrent(token) || this.state === PET_STATES.ACCOMPANYING_READ || !this._sceneSettled) return;
      const point = clonePosition(this._lastWorldPosition);
      const projected = point && this.scene?.getWorldScreenPosition?.(point);
      if (projected && projected.visible !== false) this.view?.setProjectedPosition?.(projected);
      this._setFrame(tick, token);
    };
    this._setFrame(tick, token);
  }

  _enterPush(context, token) {
    this._setWorldRendering(true);
    this._pushTarget = context.note || context;
    this._pushPositioned = false;
    this.view?.show?.();
    this._setPose("pacing-right");
    this._setWalking(true, "right");
    this.view?.showExclamation?.();
    this._startPushTravel(token);
    this._updatePushVisual(token);
    this._setTimer(() => this._finishPush(true), this.timings.pushTimeout, token);
  }

  _startPushTravel(token) {
    const noteId = idOf(this._pushTarget);
    const scene = this.scene;
    const bounds = this._getWorldWalkBounds();
    const snapshot = scene?.getStarSnapshot?.(noteId);
    const star = clonePosition(snapshot?.position) || clonePosition(snapshot?.targetPosition);
    const from = clonePosition(this._lastWorldPosition) || (
      bounds ? scene?.getGalaxyGroundPoint?.(bounds.centerX, bounds.homeZ) : null
    );
    if (!from || !star || !scene?.getGalaxyGroundPoint) return;

    const awayX = from.x - star.x;
    const awayZ = from.z - star.z;
    const length = Math.hypot(awayX, awayZ) || 1;
    const target = this._groundPoint(
      star.x + (awayX / length) * 0.62,
      star.z + (awayZ / length) * 0.62,
      { allowOutside: true },
    );
    if (!target) return;
    const duration = Math.max(1, finite(this.timings.pushTravelDuration, 2_800));
    const startedAt = this.clock.now();
    this._pushMotion = { from, target, startedAt, duration, token };
    const tick = (now) => {
      const motion = this._pushMotion;
      if (!motion || motion.token !== token || !this._isTokenCurrent(token) || this.state !== PET_STATES.PUSHING_NEW_NOTE) return;
      const progress = Math.max(0, Math.min(1, (finite(now, this.clock.now()) - startedAt) / duration));
      const eased = progress * progress * (3 - 2 * progress);
      const point = this._groundPoint(
        motion.from.x + (motion.target.x - motion.from.x) * eased,
        motion.from.z + (motion.target.z - motion.from.z) * eased,
        { allowOutside: true },
      );
      if (point) {
        this._setProjectedWorldPosition(point);
        const direction = motion.target.x < motion.from.x ? "left" : "right";
        this._setWalking(true, direction);
        this._setPose(direction === "left" ? "pacing-left" : "pacing-right", { retrigger: false });
      }
      if (progress < 1) {
        motion.frame = this._setFrame(tick, token);
        return;
      }
      this._pushMotion = null;
      this._pushPositioned = true;
      this._setWalking(false, motion.target.x < motion.from.x ? "left" : "right");
      this._setPose("pull-scroll");
    };
    this._pushMotion.frame = this._setFrame(tick, token);
  }

  _updatePushVisual(token) {
    if (!this._isTokenCurrent(token) || this.state !== PET_STATES.PUSHING_NEW_NOTE || this.stateContext.finishing) return;
    const noteId = idOf(this._pushTarget);
    const screen = this.scene?.getStarScreenPosition?.(noteId);
    const snapshot = this.scene?.getStarSnapshot?.(noteId);
    const visible = screen && screen.visible !== false && (snapshot?.state ? snapshot.state === "floating" : true);
    if (visible) {
      if (!this._pushMotion && !this._pushPositioned) this._startPushTravel(token);
      // The unread companion walks on the galaxy plane. Do not draw a
      // viewport-to-star beam or teleport the sprite beside the message.
      if (this._pushPositioned) this.view?.showExclamation?.();
    } else {
      this.view?.clearEffect?.("unread-marker");
      this.view?.clearEffect?.("unread-band");
    }
    this._setFrame(() => this._updatePushVisual(token), token);
  }

  _finishPush(timedOut = false) {
    if (this.state !== PET_STATES.PUSHING_NEW_NOTE) return;
    const token = this.token;
    const target = idOf(this._pushTarget);
    if (timedOut) {
      this.stateContext.finishing = true;
      this.view?.clearEffects?.();
      this._setWalking(false);
      this._setPose("drop-scroll");
      this.view?.showScroll?.();
    }
    if (timedOut && target) this.moodByNoteId.set(target, finite(this.moodByNoteId.get(target), 0) - 1);
    if (target) this._removeQueued(target);
    const finish = () => {
      this._pushTarget = null;
      this._returnFromTransient({ startUnread: true });
    };
    if (timedOut) this._setTimer(finish, Math.min(700, finite(this.timings.fragmentDuration, 1250)), token);
    else finish();
  }

  _enterRetrieve(context, token) {
    this._setWorldRendering(true);
    const detail = context.detail || context;
    this._retrieveTarget = { ...detail, noteId: idOf(detail.noteId || detail.note) };
    const noteId = this._retrieveTarget.noteId;
    this._retrieveActive = this._retrieveTarget;
    this._queuedClaimedStarIds.delete(noteId);
    this.view?.show?.();
    const claimed = Boolean(this.scene?.claimStarVisual?.(noteId));
    if (!claimed) {
      this._setTimer(() => this._finishRetrieve(token), 120, token);
      return;
    }
    this._claimedStarId = noteId;
    const snapshot = this.scene?.getStarSnapshot?.(noteId) || {};
    const starStart = clonePosition(this._retrieveTarget.currentPosition) || clonePosition(snapshot.position);
    const starTarget = clonePosition(this._retrieveTarget.targetPosition) || clonePosition(snapshot.targetPosition);
    const bounds = this._getWorldWalkBounds();
    const petStart = clonePosition(this._lastWorldPosition) || (
      bounds ? this.scene?.getGalaxyGroundPoint?.(bounds.homeX, bounds.homeZ) : null
    );
    if (!starStart || !starTarget || !petStart) {
      this._setTimer(() => this._finishRetrieve(token), 120, token);
      return;
    }

    // The ray runs from the original star target through its dragged
    // position.  Stand on the continuation behind the displaced star, then
    // preserve that offset while pushing it home.
    const rayX = starStart.x - starTarget.x;
    const rayZ = starStart.z - starTarget.z;
    const rayLength = Math.hypot(rayX, rayZ) || 1;
    const unitX = rayX / rayLength;
    const unitZ = rayZ / rayLength;
    const behindDistance = Math.max(0.38, finite(this.timings.retrieveBehindDistance, 0.62));
    const petBehindStart = this._groundPoint(
      starStart.x + unitX * behindDistance,
      starStart.z + unitZ * behindDistance,
      { allowOutside: true },
    ) || petStart;
    const petBehindTarget = this._groundPoint(
      starTarget.x + unitX * behindDistance,
      starTarget.z + unitZ * behindDistance,
      { allowOutside: true },
    ) || petBehindStart;
    const approachDistance = Math.hypot(petBehindStart.x - petStart.x, petBehindStart.z - petStart.z);
    const approachDuration = Math.max(
      finite(this.timings.retrieveApproachDuration, 1_650),
      approachDistance * 620,
    );
    this._retrieveMotion = {
      noteId,
      phase: "approach",
      petStart,
      petBehindStart,
      petBehindTarget,
      starStart,
      starTarget,
      unitX,
      unitZ,
      startedAt: this.clock.now(),
      duration: approachDuration,
      token,
    };
    const approachDirection = petBehindStart.x < petStart.x ? "left" : "right";
    this._setWalking(true, approachDirection);
    this._setPose(approachDirection === "left" ? "pacing-left" : "pacing-right");
    const tick = (now) => {
      const motion = this._retrieveMotion;
      if (!motion || motion.token !== token || !this._isTokenCurrent(token) || this.state !== PET_STATES.RETRIEVING_STAR) return;
      const progress = Math.min(1, Math.max(0, (finite(now, this.clock.now()) - motion.startedAt) / motion.duration));
      const eased = progress * progress * (3 - 2 * progress);
      if (motion.phase === "approach") {
        const petPoint = this._groundPoint(
          motion.petStart.x + (motion.petBehindStart.x - motion.petStart.x) * eased,
          motion.petStart.z + (motion.petBehindStart.z - motion.petStart.z) * eased,
          { allowOutside: true },
        );
        if (petPoint) this._setProjectedWorldPosition(petPoint);
        if (progress < 1) {
          motion.frame = this._setFrame(tick, token);
          return;
        }
        motion.phase = "push";
        motion.startedAt = this.clock.now();
        motion.duration = Math.max(
          finite(this.timings.retrieveReturnDuration, 4_800),
          Math.hypot(motion.starTarget.x - motion.starStart.x, motion.starTarget.z - motion.starStart.z) * 1_350,
        );
        const pushDirection = motion.starTarget.x < motion.starStart.x ? "left" : "right";
        this._setWalking(true, pushDirection);
        // Use direction-specific push artwork so left/right movement is
        // visible in both the DOM sprite and the 3D galaxy sprite.
        this._setPose(pushDirection === "left" ? "push-left" : "push-right");
        motion.frame = this._setFrame(tick, token);
        return;
      }

      const starPosition = lerpPosition(motion.starStart, motion.starTarget, eased);
      try { this.scene?.setStarVisualPosition?.(noteId, starPosition); } catch { /* optional scene API */ }
      const petPoint = this._groundPoint(
        motion.petBehindStart.x + (motion.petBehindTarget.x - motion.petBehindStart.x) * eased,
        motion.petBehindStart.z + (motion.petBehindTarget.z - motion.petBehindStart.z) * eased,
        { allowOutside: true },
      );
      if (petPoint) this._setProjectedWorldPosition(petPoint);
      if (progress < 1) {
        motion.frame = this._setFrame(tick, token);
        return;
      }
      try { this.scene?.setStarVisualPosition?.(noteId, motion.starTarget); } catch { /* optional scene API */ }
      try { this.scene?.releaseStarVisual?.(noteId, { snapToTarget: true }); } catch { /* optional scene API */ }
      this._claimedStarId = null;
      this._retrieveMotion = null;
      this._setWalking(false);
      this.view?.showHeart?.();
      this._finishRetrieve(token);
    };
    this._retrieveMotion.frame = this._setFrame(tick, token);
  }

  _queueRetrieve(detail = {}) {
    const noteId = idOf(detail.noteId || detail.note);
    if (!noteId || noteId === idOf(this._retrieveActive?.noteId)) return false;
    const entry = { ...detail, noteId };
    const claimed = Boolean(this.scene?.claimStarVisual?.(noteId));
    if (claimed) {
      try { this.scene?.setStarVisualPosition?.(noteId, entry.currentPosition); } catch { /* optional scene API */ }
      this._queuedClaimedStarIds.add(noteId);
    }
    const existing = this._retrieveQueue.findIndex((candidate) => candidate.noteId === noteId);
    if (existing >= 0) this._retrieveQueue[existing] = entry;
    else this._retrieveQueue.push(entry);
    return true;
  }

  _nextRetrieve() {
    if (!this._retrieveQueue.length) return null;
    const origin = clonePosition(this._lastWorldPosition);
    this._retrieveQueue.sort((left, right) => {
      const leftPosition = clonePosition(left.currentPosition) || clonePosition(this.scene?.getStarSnapshot?.(left.noteId)?.position);
      const rightPosition = clonePosition(right.currentPosition) || clonePosition(this.scene?.getStarSnapshot?.(right.noteId)?.position);
      return distance(origin, leftPosition) - distance(origin, rightPosition);
    });
    return this._retrieveQueue.shift() || null;
  }

  _finishRetrieve(token) {
    if (!this._isTokenCurrent(token) || this.state !== PET_STATES.RETRIEVING_STAR) return;
    this._retrieveActive = null;
    const next = this._nextRetrieve();
    if (next) {
      this._transition(PET_STATES.RETRIEVING_STAR, { detail: next }, { force: true, replace: true });
      return;
    }
    this._returnFromTransient();
  }

  _enterRead(context, token) {
    this._setWorldRendering(false);
    this._readAnchorReleased = false;
    const note = noteCopy(context.note || context);
    this._noteOpenId = idOf(note);
    this.view?.show?.();
    const target = context.element || this.noteElementResolver?.(note) || null;
    this.view?.anchorToNote?.(target);
    // The paper unfolds from a tiny transformed state. Re-measure it after
    // that transition so the companion lands beside the finished paper,
    // rather than staying over the text at its initial collapsed position.
    if (target) {
      this._setTimer(() => {
        if (this._isTokenCurrent(token) && this.state === PET_STATES.ACCOMPANYING_READ && !this._readAnchorReleased) {
          this.view?.anchorToNote?.(target);
        }
      }, 820, token);
    }
    const emotion = note?.emotion || "joy";
    const style = EMOTION_POSES[emotion] || EMOTION_POSES.custom;
    this._setPose(style.pose);
    if (style.fragment) this.view?.showHeart?.();
    // Keep the note's emotion stable for the entire read.  Alternating image
    // requests here made a stale sprite briefly paint over the selected
    // expression, which looked like an unrelated emotion flashing in.
  }

  _schedulePoseLoop(poses, interval, token, index = 0) {
    if (!poses.length || !this._isTokenCurrent(token)) return;
    this._setPose(poses[index % poses.length]);
    this._setTimer(() => this._schedulePoseLoop(poses, interval, token, index + 1), interval, token);
  }

  _enterPlay(context, token) {
    this._setWorldRendering(true);
    this._playTarget = context.star || context;
    this.view?.show?.();
    this._setPose("hug-star");
    this._setTimer(() => {
      if (this.state !== PET_STATES.PLAYING_WITH_STAR) return;
      this._setPose("wiggle");
      this._transition(PET_STATES.IDLE, {}, { force: true });
    }, this.timings.playDuration, token);
    this._followPlayTarget(token);
  }

  _followPlayTarget(token) {
    if (!this._isTokenCurrent(token) || this.state !== PET_STATES.PLAYING_WITH_STAR) return;
    const id = idOf(this._playTarget?.noteId || this._playTarget?.note || this._playTarget);
    const screen = this.scene?.getStarScreenPosition?.(id);
    if (screen) {
      this.view?.setProjectedPosition?.(screen);
      this.view?.showLightBand?.(this.view?.position, screen, { key: "play-band" });
    }
    this._setFrame(() => this._followPlayTarget(token), token);
  }

  _enterMagic(context, token) {
    this._setWorldRendering(true);
    if (this._uiBlocked && !context.manual) {
      this._transition(PET_STATES.IDLE, {}, { force: true });
      return;
    }
    this._magicLocked = true;
    try { this.scene?.setStarDragEnabled?.(false); } catch { /* optional scene API */ }
    try { this.scene?.setInteractionLocked?.(true, "pet-magic"); } catch { /* optional scene API */ }
    this.view?.show?.();
    this._setPose("magic-wand");
    this._setTimer(() => {
      if (!this._isTokenCurrent(token)) return;
      const snapshot = this.scene?.getStarSnapshot?.(context.noteId) || null;
      const label = snapshot?.emotion ? String(snapshot.emotion) : "✦";
      this.view?.showCard?.(context.cardText || label);
      this._setTimer(() => this._runHeartArray(token), this.timings.magicCardDuration, token);
    }, this.timings.magicHeartDuration, token);
  }

  _runHeartArray(token) {
    if (!this._isTokenCurrent(token) || this.state !== PET_STATES.IDLE_MAGIC) return;
    const positions = this._heartPositions();
    if (!positions) {
      this._setTimer(() => this._finishMagic(token), this.timings.magicArrayDuration, token);
      return;
    }
    const startedAt = this.clock.now();
    const duration = Math.max(1, finite(this.timings.magicArrayDuration, 1650));
    const tick = (now) => {
      if (!this._isTokenCurrent(token)) return;
      const progress = Math.min(1, Math.max(0, (finite(now, this.clock.now()) - startedAt) / duration));
      try { this.scene?.setHeartArrayOverride?.(progress, positions); } catch { /* optional scene API */ }
      if (progress < 1) this._setFrame(tick, token);
      else this._holdHeartArray(token, positions);
    };
    this._setFrame(tick, token);
  }

  _holdHeartArray(token, positions) {
    if (!this._isTokenCurrent(token) || this.state !== PET_STATES.IDLE_MAGIC) return;
    this._setPose("big-heart");
    this.view?.showHeart?.();
    // Keep sending a settled progress value so scene adapters that lazily
    // create their override do not clear it while the hold timer is pending.
    try { this.scene?.setHeartArrayOverride?.(1, positions); } catch { /* optional scene API */ }
    this._setTimer(() => this._returnHeartArray(token, positions), this.timings.magicHeartHoldDuration, token);
  }

  _returnHeartArray(token, positions) {
    if (!this._isTokenCurrent(token) || this.state !== PET_STATES.IDLE_MAGIC) return;
    const startedAt = this.clock.now();
    const duration = Math.max(1, finite(this.timings.magicHeartReturnDuration, 3_600));
    const tick = (now) => {
      if (!this._isTokenCurrent(token) || this.state !== PET_STATES.IDLE_MAGIC) return;
      const progress = Math.min(1, Math.max(0, (finite(now, this.clock.now()) - startedAt) / duration));
      const eased = progress * progress * (3 - 2 * progress);
      try { this.scene?.setHeartArrayOverride?.(1 - eased, positions); } catch { /* optional scene API */ }
      if (progress < 1) this._setFrame(tick, token);
      else this._finishMagic(token);
    };
    this._setFrame(tick, token);
  }

  _finishMagic(token) {
    if (!this._isTokenCurrent(token)) return;
    try { this.scene?.clearHeartArrayOverride?.(); } catch { /* optional scene API */ }
    this._magicLocked = false;
    this._returnFromTransient();
  }

  _enterCoding(context, token) {
    this._setWorldRendering(true);
    if (this._uiBlocked && !context.manual) {
      this._transition(PET_STATES.IDLE, {}, { force: true });
      return;
    }
    this.view?.show?.();
    this._setWalking(false);
    this._schedulePoseLoop(
      ["coding-01", "coding-02"],
      Math.max(1, finite(this.timings.codingPoseInterval, 420)),
      token,
    );
    this._setTimer(() => {
      if (!this._isTokenCurrent(token) || this.state !== PET_STATES.CODING) return;
      this._returnFromTransient();
    }, this.timings.codingDuration, token);
  }

  _returnFromTransient({ startUnread = false } = {}) {
    this._transition(PET_STATES.IDLE, {}, { force: true });
    if (startUnread && this._startNextUnread()) return;
    if (this._pendingRead && this._noteOpenId === idOf(this._pendingRead.note)) {
      const pending = this._pendingRead;
      this._pendingRead = null;
      this._transition(PET_STATES.ACCOMPANYING_READ, pending, { force: true, replace: true });
      return;
    }
    const resume = this.resumeState;
    this.resumeState = null;
    if (!resume || resume.state === PET_STATES.PUSHING_NEW_NOTE || resume.state === PET_STATES.RETRIEVING_STAR) return;
    if (resume.state === PET_STATES.ACCOMPANYING_READ && !this._noteOpenId) return;
    if ((resume.state === PET_STATES.PLAYING_WITH_STAR || IDLE_ACTION_STATES.has(resume.state)) && (!this._sceneSettled || this._uiBlocked)) return;
    this._transition(resume.state, resume.context, { force: true, replace: true });
  }

  _heartPositions() {
    const snapshot = this.scene?.getStarSnapshot?.();
    let source = Array.isArray(snapshot)
      ? snapshot
      : Array.isArray(snapshot?.stars)
        ? snapshot.stars
        : Array.isArray(snapshot?.positions)
          ? snapshot.positions
          : [];
    if (!source.length) source = this._sceneStarSnapshots();
    const count = source.length || finite(this.scene?.starCount, 0);
    if (!count) return null;
    const center = clonePosition(this.scene?.getClusterCenter?.()) || { x: 0, y: 0, z: 0 };
    const bounds = this.scene?.getGalaxyBounds?.() || this.scene?.getClusterBounds?.();
    const observedX = source.reduce((max, star) => Math.max(max, Math.abs(finite(star?.position?.x ?? star?.x) - center.x)), 0);
    const observedZ = source.reduce((max, star) => Math.max(max, Math.abs(finite(star?.position?.z ?? star?.z) - center.z)), 0);
    const widthScale = finite(bounds?.width, finite(bounds?.halfWidth, observedX) * 2) / 1.9;
    const depthScale = finite(bounds?.depth, finite(bounds?.halfDepth, observedZ) * 2) / 1.55;
    // The heart is the payoff for clicking the pet.  Keep it comfortably
    // inside the galaxy while making it visibly larger than the old compact
    // arrangement.
    const scale = Math.max(0.35, Math.min(
      finite(this.scene?.heartScale, 1.75) || 1.75,
      widthScale > 0 ? widthScale : Infinity,
      depthScale > 0 ? depthScale : Infinity,
    ));
    const positions = [];
    for (let index = 0; index < count; index += 1) {
      const t = count === 1 ? 0 : index / (count - 1);
      const angle = Math.PI * 2 * t;
      // Parametric heart curve, normalized to the available galaxy width/depth.
      const x = 16 * Math.pow(Math.sin(angle), 3) / 17;
      const z = -(13 * Math.cos(angle) - 5 * Math.cos(2 * angle) - 2 * Math.cos(3 * angle) - Math.cos(4 * angle)) / 17;
      const row = Math.floor(index / Math.max(1, Math.ceil(Math.sqrt(count))));
      const jitter = (this.random() - 0.5) * 0.06;
      positions.push({ x: center.x + x * scale + jitter, y: center.y, z: center.z + z * scale + jitter });
    }
    return positions;
  }

  _isTokenCurrent(token) { return Boolean(token && this.token === token && !token.cancelled && !this.destroyed); }

  _normaliseNotesPayload(payload) {
    const object = Array.isArray(payload) ? { notes: payload } : (payload || {});
    const notes = Array.isArray(object.notes) ? object.notes.map(noteCopy).filter(Boolean) : [];
    return { notes, version: object.version, initial: object.initial === true };
  }

  notesSnapshot(payload = {}) {
    if (this.destroyed) return;
    const { notes, version, initial } = this._normaliseNotesPayload(payload);
    const shouldBaseline = initial || !this._hasBaseline;
    const next = new Map(notes.map((note) => [note.id, note]));
    if (shouldBaseline) {
      this.notesById = next;
      this._notesVersion = version ?? null;
      this._hasBaseline = true;
      this._removeDeletedQueue(next);
      this._armBackgroundTimers();
      this._emit("notes-baseline", { version, count: notes.length });
      return;
    }

    const previous = this.notesById;
    this._removeDeletedQueue(next);
    for (const note of notes) {
      const old = previous.get(note.id);
      const changed = !old || eventKey(old) !== eventKey(note);
      const unread = note.changeStatus === "unread";
      const meaningful = unread && (
        !old ||
        note.changeAt !== old.changeAt ||
        note.changeReason !== old.changeReason ||
        (old.changeStatus !== "unread" && note.changeStatus === "unread") ||
        note.text !== old.text ||
        note.emotion !== old.emotion
      );
      if (changed && meaningful && NOTE_CHANGE_REASONS.has(note.changeReason || "")) this._enqueueUnread(note, version);
    }
    this.notesById = next;
    this._notesVersion = version ?? this._notesVersion;
    this._startNextUnread();
    this._armBackgroundTimers();
    this._emit("notes", { version, count: notes.length });
  }

  _removeDeletedQueue(next) {
    for (const id of [...this.notesById.keys()]) {
      if (!next.has(id)) this._removeQueued(id);
    }
    if (this._pushTarget && !next.has(idOf(this._pushTarget))) {
      this._pushTarget = null;
      if (this.state === PET_STATES.PUSHING_NEW_NOTE) this._transition(PET_STATES.IDLE, {}, { force: true });
    }
    if (this._noteOpenId && !next.has(this._noteOpenId) && this.state === PET_STATES.ACCOMPANYING_READ) {
      this.noteClose(this._noteOpenId);
    }
    if (this._pendingRead && !next.has(idOf(this._pendingRead.note))) {
      this._pendingRead = null;
      this._noteOpenId = null;
    }
  }

  _enqueueUnread(note, version) {
    const copy = noteCopy(note);
    if (!copy) return;
    const key = eventKey(copy);
    if (!this._rememberChange(key)) return;
    if (this.state === PET_STATES.PUSHING_NEW_NOTE && idOf(this._pushTarget) === copy.id) {
      this._pushTarget = copy;
      this.stateContext.note = copy;
      return;
    }
    const entry = {
      note: copy,
      noteId: copy.id,
      version: Number.isFinite(Number(version)) ? Number(version) : null,
      order: timestamp(copy.changeAt) || finite(version, 0) || ++this._sequence,
      key,
    };
    const existing = this._queuedById.get(copy.id);
    if (existing) {
      existing.note = copy;
      existing.version = entry.version;
      existing.order = entry.order;
      existing.key = key;
    } else {
      this._queuedById.set(copy.id, entry);
      this.unreadQueue.push(entry);
    }
    this.unreadQueue.sort((a, b) => a.order - b.order || a.noteId.localeCompare(b.noteId));
  }

  _removeQueued(noteId) {
    const id = idOf(noteId);
    if (!id) return;
    this._queuedById.delete(id);
    this.unreadQueue = this.unreadQueue.filter((entry) => entry.noteId !== id);
  }

  _startNextUnread() {
    if (this.destroyed || !this._sceneSettled || this.state === PET_STATES.PUSHING_NEW_NOTE) return false;
    const next = this.unreadQueue.find((entry) => this.notesById.has(entry.noteId));
    if (!next) return false;
    this._removeQueued(next.noteId);
    return this._transition(PET_STATES.PUSHING_NEW_NOTE, { note: next.note }, { replace: true });
  }

  noteOpen(note, detail = {}) {
    if (this.destroyed) return;
    const copy = noteCopy(note);
    const id = idOf(copy);
    if (!id) return;
    // The paper is modal: keep the companion visible and draggable, but do
    // not let a tap/background timer start another interaction underneath it.
    this._uiBlocked = true;
    if (this.state === PET_STATES.PUSHING_NEW_NOTE) {
      if (id === idOf(this._pushTarget)) {
        this._removeQueued(id);
        this._pushTarget = null;
        this._pendingRead = null;
        this._noteOpenId = id;
        // Opening the exact paper being announced is an explicit completion
        // signal for P0, so it is the one intentional lower-priority
        // transition that may interrupt the messenger.
        this._transition(PET_STATES.ACCOMPANYING_READ, { note: copy, detail, element: detail.element }, { force: true, replace: true });
        return;
      }
      this._noteOpenId = id;
      this._pendingRead = { note: copy, detail, element: detail.element };
      return;
    }
    this._removeQueued(id);
    this._noteOpenId = id;
    const context = { note: copy, detail, element: detail.element };
    if (!this._transition(PET_STATES.ACCOMPANYING_READ, context, { replace: true })) this._pendingRead = context;
  }

  noteClose(noteId) {
    const id = idOf(noteId) || this._noteOpenId;
    if (this._pendingRead && (!id || id === idOf(this._pendingRead.note))) {
      this._pendingRead = null;
      this._noteOpenId = null;
      this._uiBlocked = false;
      this._readAnchorReleased = false;
      this._lastActivityAt = this.clock.now();
      this._showcaseDueAt = 0;
      this._armBackgroundTimers();
      return true;
    }
    if (this.state !== PET_STATES.ACCOMPANYING_READ || (id && this._noteOpenId && id !== this._noteOpenId)) return false;
    this._noteOpenId = null;
    this._uiBlocked = false;
    this._readAnchorReleased = false;
    this._lastActivityAt = this.clock.now();
    this._showcaseDueAt = 0;
    const resume = this.resumeState;
    this.resumeState = null;
    if (resume && resume.state !== PET_STATES.ACCOMPANYING_READ && resume.state !== PET_STATES.PUSHING_NEW_NOTE) {
      this._transition(resume.state, resume.context, { force: true });
    } else {
      this._transition(PET_STATES.IDLE, {}, { force: true });
      this._startNextUnread();
    }
    return true;
  }

  favoriteConfirmed(detail = {}) {
    if (this.destroyed || detail.confirmed === false || detail.success === false || detail.ok === false) return false;
    const id = idOf(detail.noteId || detail.note);
    if (!id) return false;
    if (this.priority <= PET_PRIORITY[PET_STATES.RETRIEVING_STAR]) return false;
    const note = this.notesById.get(id) || noteCopy(detail.note) || { id, emotion: "joy" };
    const style = EMOTION_POSES[note.emotion] || EMOTION_POSES.joy;
    this._runFragment(detail.favorite === false ? "cry-cover-face" : style.pose, detail.favorite === false ? "tears" : style.fragment, this.timings.fragmentDuration);
    return true;
  }

  _runFragment(pose, effect, duration) {
    if (this._fragmentTimer) this.clock.clearTimeout(this._fragmentTimer);
    this._fragmentPose = pose;
    this._fragmentEffect = effect;
    this.view?.clearEffect?.("fragment");
    this._setPose(pose, { retrigger: true });
    if (effect) this.view?.showEffect?.(effect, { key: "fragment" });
    this._fragmentTimer = this._setTimer(() => {
      this._fragmentTimer = null;
      if (this.state === PET_STATES.IDLE) this._setPose("idle");
      else if (this.state === PET_STATES.ACCOMPANYING_READ) this._setPose(EMOTION_POSES[this.stateContext.note?.emotion]?.pose || "idle");
    }, duration, this.token);
  }

  userActivity(detail = {}) {
    if (this.destroyed) return;
    this._lastActivityAt = this.clock.now();
    this._showcaseDueAt = 0;
    this._uiBlocked = Boolean(detail.blocked || detail.noteOpen || detail.editorOpen || detail.favoritesOpen || detail.modalOpen);
    // Unread notifications travel on the galaxy plane; pointer activity must
    // not teleport the companion beside the cursor.
    if (IDLE_ACTION_STATES.has(this.state) && !detail.internal) return;
    this._armBackgroundTimers();
  }

  _findGroundPointNearScreen(screen = {}) {
    const bounds = this._getWorldWalkBounds();
    const scene = this.scene;
    if (!bounds || !scene?.getGalaxyGroundPoint || !scene?.getWorldScreenPosition) return null;
    const targetX = finite(screen.x, NaN);
    const targetY = finite(screen.y, NaN);
    if (![targetX, targetY].every(Number.isFinite)) return null;
    let nearest = null;
    const columns = 9;
    const rows = 7;
    for (let ix = 0; ix < columns; ix += 1) {
      const tx = columns === 1 ? 0.5 : ix / (columns - 1);
      const x = bounds.minX + (bounds.maxX - bounds.minX) * tx;
      for (let iz = 0; iz < rows; iz += 1) {
        const tz = rows === 1 ? 0.5 : iz / (rows - 1);
        const z = bounds.minZ + (bounds.maxZ - bounds.minZ) * tz;
        const point = scene.getGalaxyGroundPoint(x, z);
        const projected = scene.getWorldScreenPosition(point);
        if (!projected || projected.visible === false) continue;
        const score = Math.hypot(finite(projected.x) - targetX, finite(projected.y) - targetY);
        if (!nearest || score < nearest.score) nearest = { point: clonePosition(point), score };
      }
    }
    return nearest?.point || null;
  }

  _projectPetDragToWorld(detail = {}, drag = this._petDrag) {
    const scene = this.scene;
    const start = clonePosition(drag?.worldStart);
    const startScreen = drag?.screenStart;
    const targetScreen = detail?.position || detail;
    if (!scene?.getGalaxyGroundPoint || !scene?.getWorldScreenPosition || !start || !startScreen || !targetScreen) return null;
    const direct = scene?.getGalaxyGroundPointFromScreen?.(
      targetScreen.x,
      targetScreen.y,
      { clamp: false },
    );
    if (direct) {
      const point = this._groundPoint(direct.x, direct.z, { allowOutside: true });
      const projected = scene.getWorldScreenPosition(point);
      if (projected && projected.visible !== false) return { ...projected, world: clonePosition(point) };
    }
    const base = this._groundPoint(start.x, start.z, { allowOutside: true });
    const baseScreen = scene.getWorldScreenPosition(base);
    if (!baseScreen) return null;
    const bounds = drag?.bounds || this._getWorldWalkBounds();
    const span = Math.max(0.04, Math.min(finite(bounds?.width, 1), finite(bounds?.depth, 1)) * 0.008);
    const xProbe = scene.getWorldScreenPosition(this._groundPoint(start.x + span, start.z, { allowOutside: true }));
    const zProbe = scene.getWorldScreenPosition(this._groundPoint(start.x, start.z + span, { allowOutside: true }));
    if (!xProbe || !zProbe) return null;
    const a = finite(xProbe.x) - finite(baseScreen.x);
    const b = finite(zProbe.x) - finite(baseScreen.x);
    const c = finite(xProbe.y) - finite(baseScreen.y);
    const d = finite(zProbe.y) - finite(baseScreen.y);
    const determinant = a * d - b * c;
    if (Math.abs(determinant) < 0.0001) return null;
    const screenDeltaX = finite(targetScreen.x) - finite(startScreen.x);
    const screenDeltaY = finite(targetScreen.y) - finite(startScreen.y);
    const worldDeltaX = (screenDeltaX * d - b * screenDeltaY) / determinant * span;
    const worldDeltaZ = (a * screenDeltaY - screenDeltaX * c) / determinant * span;
    const point = clonePosition(this._groundPoint(
      start.x + worldDeltaX,
      start.z + worldDeltaZ,
      { allowOutside: true },
    ));
    if (!point) return null;
    const projected = scene.getWorldScreenPosition(point);
    if (!projected || projected.visible === false) return null;
    return { ...projected, world: point };
  }

  _handlePetDrag(detail = {}) {
    if (this.destroyed) return false;
    const phase = String(detail.phase || detail.type || "");
    if (phase === "start") {
      // A heart arrangement or an active star handoff owns the scene.  Let a
      // normal note companion remain draggable so it can be moved out of the
      // paper's way, while preserving those higher-priority animations.
      if (
        this._magicLocked ||
        IDLE_ACTION_STATES.has(this.state) ||
        this.state === PET_STATES.RETRIEVING_STAR ||
        this.state === PET_STATES.PUSHING_NEW_NOTE ||
        this.state === PET_STATES.PLAYING_WITH_STAR
      ) return false;
      this._stopIdleWander();
      this._cancelBackgroundTimers();
      this._lastActivityAt = this.clock.now();
      this._showcaseDueAt = 0;
      const screenStart = {
        x: finite(detail.position?.x, this.view?.position?.x),
        y: finite(detail.position?.y, this.view?.position?.y),
      };
      const screenOnly = this.state === PET_STATES.ACCOMPANYING_READ;
      const bounds = this._getWorldWalkBounds();
      const worldStart = clonePosition(this._lastWorldPosition) || this._findGroundPointNearScreen(screenStart);
      this._petDrag = {
        screenStart,
        worldStart: screenOnly ? null : worldStart,
        bounds,
        startedAt: this.clock.now(),
        moved: false,
        wasAnchored: Boolean(this.view?.anchor),
        screenOnly,
      };
      this._setWalking(true, "right");
      return true;
    }

    const drag = this._petDrag;
    if (!drag) return false;
    if (phase === "move") {
      const hadMoved = drag.moved;
      drag.moved = drag.moved || Boolean(detail.moved) || Math.hypot(finite(detail.delta?.x), finite(detail.delta?.y)) >= 4;
      if (!hadMoved && drag.moved) {
        this.view?.clearAnchor?.();
        if (drag.screenOnly) this._readAnchorReleased = true;
      }
      this._lastActivityAt = this.clock.now();
      const projected = drag.screenOnly ? null : this._projectPetDragToWorld(detail, drag);
      const direction = finite(detail.delta?.x) < 0 ? "left" : "right";
      this._setWalking(true, direction);
      if (projected) {
        this._setProjectedWorldPosition(projected.world);
        return { position: projected };
      }
      return { position: detail.position || detail };
    }

    if (phase === "end" || phase === "cancel") {
      const projected = phase === "cancel" || drag.screenOnly ? null : this._projectPetDragToWorld(detail, drag);
      if (projected) {
        this._setProjectedWorldPosition(projected.world);
      } else if (drag.screenOnly && phase !== "cancel") {
        this.view?.setScreenPosition?.(detail.position || detail);
      }
      this._petDrag = null;
      this._setWalking(false, "right");
      if (this.state === PET_STATES.IDLE) {
        this._setPose("idle");
        const worldBounds = this._getWorldWalkBounds();
        const isOutside = !drag.screenOnly &&
          !this._isInsideWorldBounds(this._lastWorldPosition, worldBounds);
        if (isOutside) {
          // A user may deliberately pull the pet beyond the board. Start the
          // return walk promptly, while regular in-board roaming still waits
          // for the configured inactivity delay.
          this._cancelBackgroundTimers();
          this._scheduleIdleWander(220);
        } else {
          this._armBackgroundTimers();
        }
      } else if (this.state === PET_STATES.ACCOMPANYING_READ) {
        const emotion = this.stateContext?.note?.emotion || "joy";
        this._setPose(EMOTION_POSES[emotion]?.pose || "idle", { retrigger: false });
        if (!drag.moved && drag.wasAnchored) {
          const target = this.stateContext?.element || this.noteElementResolver?.(this.stateContext?.note);
          this.view?.anchorToNote?.(target);
        }
      }
      return true;
    }
    return false;
  }

  petDragStart(detail = {}) { return this._handlePetDrag({ ...detail, phase: "start" }); }
  petDragMove(detail = {}) { return this._handlePetDrag({ ...detail, phase: "move" }); }
  petDragEnd(detail = {}) { return this._handlePetDrag({ ...detail, phase: "end" }); }

  petClick() {
    if (this.destroyed || this._uiBlocked || this._magicLocked || this.priority <= PET_PRIORITY[PET_STATES.ACCOMPANYING_READ]) return false;
    if (!this._sceneSettled) return false;
    // A direct click replaces any background interaction queued for resume.
    this.resumeState = null;
    this._lastActivityAt = this.clock.now();
    this._showcaseDueAt = 0;
    return this._transition(PET_STATES.IDLE_MAGIC, { manual: true }, { force: true, replace: true });
  }

  scenePourChanged(detail = {}) {
    const phase = String(detail.phase || detail.state || "");
    this._sceneSettled = phase === "settled" || detail.settled === true;
    if (this._sceneSettled) {
      if (this.state !== PET_STATES.ACCOMPANYING_READ) this._setWorldRendering(true);
      if (this.state === PET_STATES.IDLE) this._positionPetHome();
      this.view?.show?.();
      this._startWorldProjectionFollow(this.token);
      this._startNextUnread();
      this._armBackgroundTimers();
    } else {
      if (this.state !== PET_STATES.ACCOMPANYING_READ) {
        this._setWorldRendering(false);
        this.view?.hide?.();
      }
      this._cancelBackgroundTimers();
      this._showcaseDueAt = 0;
      if (IDLE_ACTION_STATES.has(this.state)) this._transition(PET_STATES.IDLE, {}, { force: true });
    }
  }

  _threshold() {
    const span = this.retrievalThresholdMax - this.retrievalThresholdMin;
    return this.retrievalThresholdMin + Math.max(0, Math.min(1, this.random())) * span;
  }

  starDragStart(detail = {}) {
    if (this.destroyed || !detail || !detail.noteId || this._magicLocked) return false;
    if (detail.state && detail.state !== "floating") return false;
    if (this.state === PET_STATES.PUSHING_NEW_NOTE) return false;
    if (this.state === PET_STATES.RETRIEVING_STAR) {
      this._drag = { ...detail, noteId: idOf(detail.noteId), startedAt: this.clock.now(), threshold: this._threshold() };
      return true;
    }
    if (this.state === PET_STATES.PLAYING_WITH_STAR && idOf(this._playTarget?.noteId || this._playTarget) === idOf(detail.noteId)) {
      this._transition(PET_STATES.IDLE, {}, { force: true });
      this._runFragment("cry-cover-face", "tears", this.timings.fragmentDuration);
    }
    this._drag = { ...detail, noteId: idOf(detail.noteId), startedAt: this.clock.now(), threshold: this._threshold() };
    return true;
  }

  starDragMove(detail = {}) {
    if (this.destroyed || !this._drag || idOf(detail.noteId) !== this._drag.noteId) return false;
    this._drag = { ...this._drag, ...detail };
    return true;
  }

  starDragEnd(detail = {}) {
    if (this.destroyed || !detail || !detail.noteId) return false;
    if (this._magicLocked) return false;
    const id = idOf(detail.noteId);
    const drag = this._drag && this._drag.noteId === id ? { ...this._drag, ...detail } : { ...detail, noteId: id, threshold: this._threshold() };
    this._drag = null;
    if (detail.state && detail.state !== "floating") return false;
    const snapshot = this.scene?.getStarSnapshot?.(id);
    if (snapshot?.state && snapshot.state !== "floating") return false;
    const amount = finite(drag.distanceFromTarget, distance(drag.currentPosition, drag.targetPosition));
    if (amount <= finite(drag.threshold, this._threshold())) return false;
    if (this.state === PET_STATES.PUSHING_NEW_NOTE) return false;
    if (this.state === PET_STATES.RETRIEVING_STAR) return this._queueRetrieve(drag);
    return this._transition(PET_STATES.RETRIEVING_STAR, { detail: drag }, { force: true, replace: true });
  }

  onStarDragStart(detail) { return this.starDragStart(detail); }
  onStarDragMove(detail) { return this.starDragMove(detail); }
  onStarDragEnd(detail) { return this.starDragEnd(detail); }

  // Explicit aliases make the event bridge convenient for app.js and also
  // keep the controller usable with EventTarget-style integrations.
  handleEvent(eventOrType, ...args) {
    if (eventOrType && typeof eventOrType === "object") {
      const detail = eventOrType.detail ?? eventOrType.payload;
      return this.handle(eventOrType.type, detail);
    }
    return this.handle(eventOrType, ...args);
  }

  receive(eventOrType, ...args) { return this.handleEvent(eventOrType, ...args); }
  dispatch(type, ...args) { return this.handle(type, ...args); }
  enqueueEvent(type, ...args) { return this.handle(type, ...args); }

  _viewportSize() {
    const source = this.view?.window || (typeof globalThis !== "undefined" ? globalThis : {});
    return {
      width: Math.max(1, finite(source?.innerWidth, finite(this.scene?.layoutWidth, 640)) || 640),
      height: Math.max(1, finite(source?.innerHeight, finite(this.scene?.layoutHeight, 720)) || 720),
    };
  }

  _petSize() {
    const size = this.view?.getSize?.() || {};
    return {
      width: Math.max(1, finite(size.width, 120)),
      height: Math.max(1, finite(size.height, 120)),
    };
  }

  _sceneScreenPoints() {
    const scene = this.scene;
    const snapshots = this._sceneStarSnapshots();
    const points = [];
    for (const snapshot of snapshots) {
      const noteId = idOf(snapshot?.noteId || snapshot?.id || snapshot?.note);
      const screen = snapshot?.screenPosition || snapshot?.screen ||
        (noteId ? scene?.getStarScreenPosition?.(noteId) : null);
      const x = finite(screen?.x, NaN);
      const y = finite(screen?.y, NaN);
      if (!Number.isFinite(x) || !Number.isFinite(y) || screen?.visible === false) continue;
      points.push({
        x,
        y,
        state: String(snapshot?.state || ""),
      });
    }
    const floating = points.filter((point) => point.state === "floating");
    return floating.length ? floating : points;
  }

  _getWorldWalkBounds() {
    const source = this.scene?.getGalaxyGroundBounds?.({ inset: 0 });
    if (!source) return null;
    const minX = finite(source.minX, NaN);
    const maxX = finite(source.maxX, NaN);
    const minZ = finite(source.minZ, NaN);
    const maxZ = finite(source.maxZ, NaN);
    if (![minX, maxX, minZ, maxZ].every(Number.isFinite) || maxX <= minX || maxZ <= minZ) return null;
    const width = maxX - minX;
    const depth = maxZ - minZ;
    const centerX = finite(source.centerX, (minX + maxX) * 0.5);
    // Idle roaming may use the whole galaxy. Only reserve enough room for
    // the sprite's feet so autonomous motion cannot step beyond the board.
    const xInset = Math.max(0.18, Math.min(0.34, width * 0.025));
    const zInset = Math.max(0.16, Math.min(0.3, depth * 0.035));
    const walkMinX = minX + xInset;
    const walkMaxX = maxX - xInset;
    const walkMinZ = minZ + zInset;
    const walkMaxZ = maxZ - zInset;
    if (walkMaxX <= walkMinX || walkMaxZ <= walkMinZ) return null;
    // Camera yaw/pitch can change with the presentation state, so determine
    // the visually near edge from its projection instead of assuming that
    // larger world Z is always closer to the viewer.
    const lowProjection = this._projectGroundPosition?.(centerX, walkMinZ)?.projected;
    const highProjection = this._projectGroundPosition?.(centerX, walkMaxZ)?.projected;
    const frontZ = lowProjection && highProjection && lowProjection.y > highProjection.y
      ? walkMinZ
      : walkMaxZ;
    return {
      minX: walkMinX,
      maxX: walkMaxX,
      minZ: walkMinZ,
      maxZ: walkMaxZ,
      width: walkMaxX - walkMinX,
      depth: walkMaxZ - walkMinZ,
      centerX,
      homeX: walkMinX + (walkMaxX - walkMinX) * 0.1,
      homeZ: frontZ,
      frontZ,
      source,
    };
  }

  _isInsideWorldBounds(point, bounds = this._getWorldWalkBounds(), margin = 0) {
    const position = clonePosition(point);
    if (!position || !bounds) return false;
    const inset = Math.max(0, finite(margin));
    return position.x >= bounds.minX + inset &&
      position.x <= bounds.maxX - inset &&
      position.z >= bounds.minZ + inset &&
      position.z <= bounds.maxZ - inset;
  }

  _nearestPointInsideWorldBounds(point, bounds = this._getWorldWalkBounds(), margin = 0.18) {
    const position = clonePosition(point);
    if (!position || !bounds) return null;
    const maximumInset = Math.max(0, Math.min(bounds.width, bounds.depth) * 0.25);
    const inset = Math.max(0, Math.min(maximumInset, finite(margin, 0.18)));
    return {
      x: Math.min(bounds.maxX - inset, Math.max(bounds.minX + inset, position.x)),
      z: Math.min(bounds.maxZ - inset, Math.max(bounds.minZ + inset, position.z)),
    };
  }

  _groundPoint(x, z, options = {}) {
    const scene = this.scene;
    if (!scene?.getGalaxyGroundPoint) return null;
    const allowOutside = options.allowOutside === true;
    const groundOptions = allowOutside ? { clamp: false } : undefined;
    return scene.getGalaxyGroundPoint(x, z, groundOptions);
  }

  _projectGroundPosition(x, z, options = {}) {
    const point = this._groundPoint(x, z, options);
    const projected = point && this.scene?.getWorldScreenPosition?.(point);
    if (!point || !projected || projected.visible === false) return null;
    return { point, projected };
  }

  _setProjectedWorldPosition(point) {
    const projected = point && this.scene?.getWorldScreenPosition?.(point);
    if (!point || !projected || projected.visible === false) return false;
    this._lastWorldPosition = clonePosition(point);
    try { this.scene?.setPetWorldPosition?.(point, { enabled: true }); } catch { /* optional scene API */ }
    this.view?.setProjectedPosition?.(projected);
    return true;
  }

  _getWalkBounds() {
    const viewport = this._viewportSize();
    const size = this._petSize();
    const margin = Math.max(16, Math.min(48, this.safeMargin * 0.58));
    const halfWidth = size.width * 0.5;
    const minX = halfWidth + margin;
    const maxX = Math.max(minX, viewport.width - halfWidth - margin);
    const minY = size.height + margin;
    const maxY = Math.max(minY, viewport.height - margin);
    const points = this._sceneScreenPoints();

    let left;
    let right;
    let baseline;
    if (points.length) {
      const pointLeft = Math.min(...points.map((point) => point.x));
      const pointRight = Math.max(...points.map((point) => point.x));
      const pointBottom = Math.max(...points.map((point) => point.y));
      const pointCenter = (pointLeft + pointRight) * 0.5;
      const horizontalPadding = Math.max(size.width * 0.85, viewport.width * 0.045);
      const minimumSpan = Math.max(size.width * 2.2, viewport.width * 0.16);
      left = Math.min(pointLeft - horizontalPadding, pointCenter - minimumSpan * 0.5);
      right = Math.max(pointRight + horizontalPadding, pointCenter + minimumSpan * 0.5);
      baseline = pointBottom + size.height * 0.46;
    } else {
      // Before the bottle has settled there may be no projected stars.  Keep
      // the fallback in the lower scene field, rather than at the viewport's
      // right edge where it reads like a utility widget.
      const center = viewport.width * (viewport.width < 560 ? 0.5 : 0.34);
      const span = Math.max(size.width * 2.4, viewport.width * 0.18);
      left = center - span * 0.5;
      right = center + span * 0.5;
      baseline = viewport.height * 0.79;
    }

    left = Math.max(minX, Math.min(maxX, left));
    right = Math.max(left, Math.min(maxX, right));
    if (right - left < size.width * 1.2) {
      const center = Math.max(minX, Math.min(maxX, (left + right) * 0.5));
      left = Math.max(minX, center - size.width * 0.6);
      right = Math.min(maxX, center + size.width * 0.6);
    }
    const homeX = Math.max(minX, Math.min(maxX, (left + right) * 0.5));
    const homeY = Math.max(minY, Math.min(maxY, baseline));
    const verticalSpan = Math.min(size.height * 0.18, viewport.height * 0.055);
    return {
      left,
      right,
      top: Math.max(minY, homeY - verticalSpan),
      bottom: Math.min(maxY, homeY + verticalSpan),
      homeX,
      homeY,
      viewport,
      size,
    };
  }

  _positionPetHome() {
    const worldBounds = this._getWorldWalkBounds();
    if (worldBounds && this._sceneSettled) {
      const current = clonePosition(this._lastWorldPosition);
      const inside = this._isInsideWorldBounds(current, worldBounds);
      // Preserve a deliberate drag outside the board. The idle scheduler will
      // animate the return instead of snapping the pet to its home position.
      const projected = current
        ? this._projectGroundPosition(current.x, current.z, { allowOutside: !inside })
        : this._projectGroundPosition(worldBounds.homeX, worldBounds.homeZ);
      if (projected && this._setProjectedWorldPosition(projected.point)) {
        this._lastWalkBounds = worldBounds;
        return inside;
      }
    }
    const bounds = this._getWalkBounds();
    this._lastWalkBounds = bounds;
    this.view?.moveHome?.({
      x: bounds.homeX,
      y: bounds.homeY,
      width: bounds.viewport.width,
      height: bounds.viewport.height,
      margin: this.safeMargin * 0.58,
    });
    return true;
  }

  _randomBetween(minimum, maximum) {
    const low = finite(minimum, 0);
    const high = Math.max(low, finite(maximum, low));
    return low + Math.max(0, Math.min(1, this.random())) * (high - low);
  }

  _stopIdleWander() {
    if (!this._wander) return;
    const active = this._wander;
    active.cancelled = true;
    if (active.frame !== null && active.frame !== undefined) {
      this.clock.cancelAnimationFrame(active.frame);
      this._stateFrames.delete(active.frame);
    }
    this._wander = null;
    this._setWalking(false);
    if (this.state === PET_STATES.IDLE) this._setPose("idle");
  }

  _scheduleAfterAutonomousWander(wander, pause) {
    if (this.destroyed || this.state !== PET_STATES.IDLE || this._uiBlocked || !this._sceneSettled) return;
    // Returning after a player drag is corrective movement, not one of the
    // pet's voluntary walks, so it must not advance the work-break cadence.
    if (wander?.returning) {
      this._scheduleIdleWander(pause);
      return;
    }

    this._completedWandersSinceCoding += 1;
    const walksPerWorkBreak = Math.max(1, Math.floor(finite(this.timings.codingAfterWanders, 4)));
    if (this._completedWandersSinceCoding < walksPerWorkBreak) {
      this._scheduleIdleWander(pause);
      return;
    }

    this._completedWandersSinceCoding = 0;
    this._setTimer(() => {
      if (this.destroyed || this.state !== PET_STATES.IDLE || this._uiBlocked || !this._sceneSettled) return;
      this._transition(PET_STATES.CODING, { autonomous: true }, { force: true, replace: true });
    }, Math.max(0, finite(pause)), null, true);
  }

  _scheduleIdleWander(delay = null) {
    if (this.destroyed || !this._sceneSettled || this._uiBlocked || this.state !== PET_STATES.IDLE) return;
    const wait = delay === null
      ? this._randomBetween(this.timings.wanderAfterMin, this.timings.wanderAfterMax)
      : Math.max(0, finite(delay));
    this._setTimer(() => {
      if (this.destroyed || this.state !== PET_STATES.IDLE || this._uiBlocked || !this._sceneSettled) return;
      this._startIdleWander();
    }, wait, null, true);
  }

  _startIdleWander() {
    if (this.destroyed || this.state !== PET_STATES.IDLE || this._uiBlocked || !this._sceneSettled) return false;
    const worldBounds = this._getWorldWalkBounds();
    if (worldBounds) return this._startWorldWander(worldBounds);
    const bounds = this._getWalkBounds();
    this._lastWalkBounds = bounds;
    const from = {
      x: finite(this.view?.position?.x, bounds.homeX),
      y: finite(this.view?.position?.y, bounds.homeY),
    };
    const target = {
      x: bounds.left + this.random() * Math.max(0, bounds.right - bounds.left),
      y: bounds.top + this.random() * Math.max(0, bounds.bottom - bounds.top),
    };
    if (Math.hypot(target.x - from.x, target.y - from.y) < Math.max(24, bounds.size.width * 0.35)) {
      this._scheduleIdleWander(this._randomBetween(this.timings.wanderPauseMin, this.timings.wanderPauseMax));
      return false;
    }
    const duration = Math.max(1, this._randomBetween(this.timings.wanderDurationMin, this.timings.wanderDurationMax));
    const token = this.token;
    this._wander = { from, target, startedAt: this.clock.now(), duration, token, cancelled: false };
    const direction = target.x < from.x ? "left" : "right";
    this._setWalking(true, direction);
    this._setPose(direction === "left" ? "pacing-left" : "pacing-right");
    const tick = (now) => {
      const wander = this._wander;
      if (!wander || wander.cancelled || wander.token !== token || !this._isTokenCurrent(token) || this.state !== PET_STATES.IDLE || this._uiBlocked) return;
      const progress = Math.max(0, Math.min(1, (finite(now, this.clock.now()) - wander.startedAt) / wander.duration));
      const eased = progress * progress * (3 - 2 * progress);
      this.view?.setScreenPosition?.({
        x: wander.from.x + (wander.target.x - wander.from.x) * eased,
        y: wander.from.y + (wander.target.y - wander.from.y) * eased,
      });
      if (progress < 1) {
        wander.frame = this._setFrame(tick, token);
        return;
      }
      this._wander = null;
      this._setWalking(false, direction);
      this._setPose("idle");
      this._scheduleAfterAutonomousWander(
        wander,
        this._randomBetween(this.timings.wanderPauseMin, this.timings.wanderPauseMax),
      );
    };
    this._wander.frame = this._setFrame(tick, token);
    this._emit("wander-start", { from, target, duration });
    return true;
  }

  _startWorldWander(bounds) {
    const fallbackHome = this._groundPoint(bounds.centerX, bounds.homeZ);
    const from = clonePosition(this._lastWorldPosition) || fallbackHome;
    if (!from) return false;
    const returning = !this._isInsideWorldBounds(from, bounds);
    const returnPoint = returning
      ? this._nearestPointInsideWorldBounds(from, bounds)
      : null;
    const target = returning && returnPoint
      ? this._groundPoint(returnPoint.x, returnPoint.z)
      : this._groundPoint(
        bounds.minX + this.random() * (bounds.maxX - bounds.minX),
        bounds.minZ + this.random() * (bounds.maxZ - bounds.minZ),
      );
    if (!target) return false;
    const horizontalDistance = Math.hypot(target.x - from.x, target.z - from.z);
    if (!returning && horizontalDistance < 0.55) {
      this._scheduleIdleWander(this._randomBetween(this.timings.wanderPauseMin, this.timings.wanderPauseMax));
      return false;
    }
    const normalDuration = this._randomBetween(this.timings.wanderDurationMin, this.timings.wanderDurationMax);
    const duration = Math.max(1, returning ? Math.max(normalDuration, horizontalDistance * 720) : normalDuration);
    const token = this.token;
    this._wander = {
      from,
      target,
      startedAt: this.clock.now(),
      duration,
      token,
      cancelled: false,
      world: true,
      returning,
    };
    const direction = target.x < from.x ? "left" : "right";
    this._setWalking(true, direction);
    this._setPose(direction === "left" ? "pacing-left" : "pacing-right");
    const tick = (now) => {
      const wander = this._wander;
      if (!wander || wander.cancelled || wander.token !== token || !this._isTokenCurrent(token) || this.state !== PET_STATES.IDLE || this._uiBlocked) return;
      const progress = Math.max(0, Math.min(1, (finite(now, this.clock.now()) - wander.startedAt) / wander.duration));
      const eased = progress * progress * (3 - 2 * progress);
      const point = this._groundPoint(
        wander.from.x + (wander.target.x - wander.from.x) * eased,
        wander.from.z + (wander.target.z - wander.from.z) * eased,
        { allowOutside: true },
      );
      if (point) {
        this._setProjectedWorldPosition(point);
        const stepX = wander.target.x - wander.from.x;
        const stepZ = wander.target.z - wander.from.z;
        this._checkWorldStarContact(point, stepX, stepZ);
      }
      if (progress < 1) {
        wander.frame = this._setFrame(tick, token);
        return;
      }
      this._wander = null;
      this._lastWorldPosition = clonePosition(wander.target);
      this._setWalking(false, direction);
      this._setPose("idle");
      const pause = wander.returning
        ? Math.min(650, this._randomBetween(this.timings.wanderPauseMin, this.timings.wanderPauseMax))
        : this._randomBetween(this.timings.wanderPauseMin, this.timings.wanderPauseMax);
      this._scheduleAfterAutonomousWander(wander, pause);
    };
    this._wander.frame = this._setFrame(tick, token);
    this._emit("wander-start", { from, target, duration, world: true, returning });
    return true;
  }

  _checkWorldStarContact(point, directionX = 0, directionZ = 0) {
    if (!point || !this.scene?.pushStarVisual) return;
    const now = this.clock.now();
    const candidates = this._sceneStarSnapshots();
    const contactRadius = 0.46;
    const contactRadiusSquared = contactRadius * contactRadius;
    const directionLength = Math.hypot(directionX, directionZ) || 1;
    const moveX = directionX / directionLength;
    const moveZ = directionZ / directionLength;
    for (const candidate of candidates) {
      if (String(candidate?.state || "") !== "floating") continue;
      const noteId = idOf(candidate?.noteId || candidate?.id || candidate?.note);
      const star = clonePosition(candidate?.position);
      if (!noteId || !star) continue;
      const dx = star.x - point.x;
      const dz = star.z - point.z;
      const distanceSquared = dx * dx + dz * dz;
      if (distanceSquared > contactRadiusSquared) continue;
      const lastContact = finite(this._petStarContactAt.get(noteId), 0);
      if (now - lastContact < 700) continue;
      const distanceValue = Math.sqrt(distanceSquared) || 0.001;
      const normalX = dx / distanceValue;
      const normalZ = dz / distanceValue;
      // Push away from the pet with a small forward component, matching the
      // scene's existing floating-star impulse scale without changing the
      // target position or Cannon body.
      const strength = 0.12 + (1 - distanceValue / contactRadius) * 0.2;
      const impulse = {
        x: normalX * strength + moveX * 0.035,
        z: normalZ * strength + moveZ * 0.035,
      };
      if (this.scene.pushStarVisual(noteId, impulse)) {
        this._petStarContactAt.set(noteId, now);
        this._emit("star-push", { noteId, impulse, distance: distanceValue });
      }
    }
  }

  _cancelBackgroundTimers() {
    for (const handle of this._backgroundTimers) this.clock.clearTimeout(handle);
    this._backgroundTimers.clear();
    this._backgroundArmedAt = 0;
  }

  _armBackgroundTimers() {
    if (this.destroyed || !this._sceneSettled || this._uiBlocked || this.state !== PET_STATES.IDLE) return;
    // Re-arming is also used after user activity and scene updates.  Stop an
    // in-flight walk first so one event cannot leave duplicate wander loops.
    this._stopIdleWander();
    this._cancelBackgroundTimers();
    this._backgroundArmedAt = this.clock.now();
    const playDelay = finite(this.timings.playAfterMin) + Math.max(0, Math.min(1, this.random())) * Math.max(0, finite(this.timings.playAfterMax) - finite(this.timings.playAfterMin));
    if (this._showcaseDueAt <= 0) {
      const showcaseDelay = finite(this.timings.magicAfterMin) + Math.max(0, Math.min(1, this.random())) * Math.max(0, finite(this.timings.magicAfterMax) - finite(this.timings.magicAfterMin));
      this._showcaseDueAt = this.clock.now() + Math.max(0, showcaseDelay);
    }
    const showcaseDelay = Math.max(0, this._showcaseDueAt - this.clock.now());
    this._setTimer(() => {
      if (this.state !== PET_STATES.IDLE || this._uiBlocked || this.clock.now() - this._lastActivityAt < finite(this.timings.magicInactivity)) return this._armBackgroundTimers();
      const target = this._chooseNearbyStar();
      if (target) this._transition(PET_STATES.PLAYING_WITH_STAR, { star: target }, { force: true, replace: true });
    }, playDelay, null, true);
    // Heart magic remains a rare long-idle interaction.  Coding is scheduled
    // from completed autonomous walks, so it has a reliable 1:4 cadence.
    this._setTimer(() => {
      if (this.state !== PET_STATES.IDLE || this._uiBlocked || this.clock.now() - this._lastActivityAt < finite(this.timings.magicInactivity)) {
        this._showcaseDueAt = 0;
        return this._armBackgroundTimers();
      }
      this._showcaseDueAt = 0;
      this._transition(PET_STATES.IDLE_MAGIC, { autonomous: true }, { force: true, replace: true });
    }, showcaseDelay, null, true);
    this._scheduleIdleWander(this._randomBetween(this.timings.wanderAfterMin, this.timings.wanderAfterMax));
  }

  _chooseNearbyStar() {
    const center = clonePosition(this.scene?.getClusterCenter?.());
    const candidates = this._sceneStarSnapshots();
    const floating = candidates.filter((candidate) => candidate?.state === "floating" && candidate.noteId);
    if (!floating.length) return null;
    if (!center) return floating[Math.floor(Math.max(0, Math.min(0.999, this.random())) * floating.length)];
    floating.sort((a, b) => distance(a.position, center) - distance(b.position, center));
    return floating[Math.floor(Math.max(0, Math.min(0.999, this.random())) * Math.min(floating.length, 4))];
  }

  _sceneStarSnapshots() {
    const scene = this.scene;
    const direct = scene?.getFloatingStarSnapshots?.() || scene?.getStarSnapshots?.();
    if (Array.isArray(direct)) return direct;
    const debug = scene?.getDebugState?.(true);
    if (Array.isArray(debug?.positions)) {
      return debug.positions.map((position) => ({
        noteId: position.id,
        state: position.state,
        position: { x: position.x, y: position.y, z: position.z },
        screenPosition: scene?.getStarScreenPosition?.(position.id) || null,
      }));
    }
    // A scene adapter may expose only the note ids; screen lookup still lets
    // the controller choose a nearby floating candidate without private data.
    const candidates = [];
    for (const note of this.notesById.values()) {
      const snapshot = scene?.getStarSnapshot?.(note.id);
      if (snapshot) candidates.push(snapshot);
    }
    return candidates;
  }

  handle(type, ...args) {
    if (type === "noteOpen" && args.length === 1 && args[0] && typeof args[0] === "object" && args[0].note) {
      return this.noteOpen(args[0].note, args[0].detail || {});
    }
    if (type === "noteClose" && args.length === 1 && args[0] && typeof args[0] === "object" && (args[0].noteId || args[0].id)) {
      return this.noteClose(args[0].noteId || args[0].id);
    }
    const method = {
      noteOpen: "noteOpen",
      noteClose: "noteClose",
      favoriteConfirmed: "favoriteConfirmed",
      notesSnapshot: "notesSnapshot",
      userActivity: "userActivity",
      petClick: "petClick",
      petDragStart: "petDragStart",
      petDragMove: "petDragMove",
      petDragEnd: "petDragEnd",
      scenePourChanged: "scenePourChanged",
      onStarDragStart: "starDragStart",
      onStarDragMove: "starDragMove",
      onStarDragEnd: "starDragEnd",
      starDragStart: "starDragStart",
      starDragMove: "starDragMove",
      starDragEnd: "starDragEnd",
    }[type];
    return method && typeof this[method] === "function" ? this[method](...args) : false;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.view?.window?.removeEventListener?.("resize", this._onResize);
    this._clearStateWork();
    this._cancelBackgroundTimers();
    if (this._fragmentTimer) this.clock.clearTimeout(this._fragmentTimer);
    this._fragmentTimer = null;
    this._offViewClick?.();
    this._offViewDrag?.();
    for (const noteId of this._queuedClaimedStarIds) {
      try { this.scene?.releaseStarVisual?.(noteId, { snapToTarget: false }); } catch { /* optional scene API */ }
    }
    this._queuedClaimedStarIds.clear();
    try { this.scene?.clearPetWorldPosition?.(); } catch { /* optional scene API */ }
    this._offViewDrag?.();
    this.view?.destroy?.();
    this.notesById.clear();
    this.unreadQueue.length = 0;
    this._queuedById.clear();
    this.moodByNoteId.clear();
    this._petStarContactAt.clear();
  }
}

export default PetController;
