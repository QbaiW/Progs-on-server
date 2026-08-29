(() => {
  "use strict";

  const fallbackPhrases = [
    "对不起，我真的知道错啦！",
    "宝宝原谅我这一次嘛！",
    "我以后一定乖乖听话！",
    "别生气啦，我会改的！",
    "是我不对，给你道歉！",
    "宝宝的小本本别记我啦！",
    "我保证不会再犯啦！",
    "求求宝宝消消气！",
    "我愿意认真写检讨！",
    "这次真的长记性了！",
    "给我一次改正的机会吧！",
    "我错啦，抱抱和好嘛！",
    "宝宝说得对，是我粗心了！",
    "我会用行动好好补偿！",
    "别敲啦，我已经反省啦！",
    "以后都先听宝宝的！",
    "我发誓会更懂事一点！",
    "请收下我诚恳的道歉！",
    "宝宝笑一个就原谅我吧！",
    "QE 已经深刻认识错误啦！"
  ];

  const bubbleColors = ["#fffefa", "#fff0a8", "#d9f3e4", "#d8ecfa", "#ffdcd5"];
  const app = document.querySelector(".app");
  const stage = document.querySelector("#stage");
  const scene = document.querySelector("#scene");
  const dog = document.querySelector(".dog");
  const countElement = document.querySelector("#hit-count");
  const bubbleLayer = document.querySelector("#bubble-layer");
  const burstLayer = document.querySelector("#burst-layer");
  const soundButton = document.querySelector("#sound-toggle");
  const resetButton = document.querySelector("#reset-button");
  const phraseStatus = document.querySelector("#phrase-status");
  const adminTrigger = document.querySelector("#admin-trigger");
  const adminModal = document.querySelector("#admin-modal");
  const adminClose = document.querySelector("#admin-close");
  const adminForm = document.querySelector("#admin-form");
  const adminPasswordInput = document.querySelector("#admin-password");
  const adminError = document.querySelector("#admin-error");
  const adminLock = document.querySelector("#admin-lock");
  const adminStats = document.querySelector("#admin-stats");
  const adminRefresh = document.querySelector("#admin-refresh");
  const adminStatus = document.querySelector("#admin-status");
  const sharedTotal = document.querySelector("#shared-total");
  const sharedOther = document.querySelector("#shared-other");
  const sharedVisitors = document.querySelector("#shared-visitors");
  const visitorList = document.querySelector("#visitor-list");
  const hitHistoryList = document.querySelector("#hit-history-list");
  const hitHistoryNote = document.querySelector("#hit-history-note");
  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  let count = 0;
  let phrases = [...fallbackPhrases];
  let phraseBag = [];
  let pendingStrikes = 0;
  let strikeLoopRunning = false;
  let soundEnabled = true;
  let audioContext = null;
  let bubbleSerial = 0;
  let hiddenAt = null;
  let lastFrameTime = performance.now();
  let physicsAccumulator = 0;
  let boundaryBodies = [];
  let sharedHitQueue = Promise.resolve();
  let sharedVisitorHits = 0;
  let adminClickCount = 0;
  let adminClickTimer = null;
  let adminPassword = "";
  let adminPreviousFocus = null;
  let adminStatsLoading = false;
  const visitorId = getVisitorId();

  const bubbles = new Map();
  const { Engine, Bodies, Body, Composite } = Matter;
  const engine = Engine.create({ enableSleeping: false });
  engine.gravity.x = 0;
  engine.gravity.y = -0.34;
  engine.gravity.scale = 0.001;

  updateCounter();
  updateSoundButton();
  loadPhrases();
  rebuildBoundaries();

  const resizeObserver = new ResizeObserver(() => {
    rebuildBoundaries();
    keepBubblesInBounds();
  });
  resizeObserver.observe(stage);

  stage.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    stage.focus({ preventScroll: true });
    ensureAudio();
    enqueueStrike();
  });

  stage.addEventListener("keydown", (event) => {
    if (event.target !== stage) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    ensureAudio();
    enqueueStrike();
  });

  soundButton.addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    if (soundEnabled) ensureAudio();
    updateSoundButton();
  });

  resetButton.addEventListener("click", () => {
    count = 0;
    pendingStrikes = 0;
    updateCounter();
    [...bubbles.values()].forEach((bubble) => popBubble(bubble, true));
  });

  adminTrigger.addEventListener("click", () => {
    adminClickCount += 1;
    window.clearTimeout(adminClickTimer);
    adminClickTimer = window.setTimeout(() => {
      adminClickCount = 0;
    }, 3000);

    if (adminClickCount >= 4) {
      adminClickCount = 0;
      window.clearTimeout(adminClickTimer);
      openAdminModal();
    }
  });

  adminClose.addEventListener("click", closeAdminModal);
  adminModal.addEventListener("click", (event) => {
    if (event.target.matches("[data-admin-close]")) closeAdminModal();
  });

  adminForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = adminPasswordInput.value.trim();
    if (!password || adminStatsLoading) return;
    adminError.textContent = "";
    adminStatus.textContent = "正在读取…";
    adminStatsLoading = true;
    try {
      const data = await fetchSharedStats(password);
      adminPassword = password;
      adminLock.hidden = true;
      adminStats.hidden = false;
      renderSharedStats(data);
      adminStatus.textContent = "已更新";
    } catch (error) {
      adminError.textContent = error?.message || "暂时无法读取统计";
      adminStatus.textContent = "";
    } finally {
      adminStatsLoading = false;
    }
  });

  adminRefresh.addEventListener("click", async () => {
    if (!adminPassword || adminStatsLoading) return;
    adminStatsLoading = true;
    adminStatus.textContent = "正在刷新…";
    try {
      renderSharedStats(await fetchSharedStats(adminPassword));
      adminStatus.textContent = "已更新";
    } catch (error) {
      adminStatus.textContent = error?.message || "暂时无法读取统计";
    } finally {
      adminStatsLoading = false;
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !adminModal.hidden) {
      event.preventDefault();
      closeAdminModal();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenAt = performance.now();
      return;
    }

    if (hiddenAt !== null) {
      const pausedFor = performance.now() - hiddenAt;
      bubbles.forEach((bubble) => {
        bubble.expiresAt += pausedFor;
      });
      hiddenAt = null;
      lastFrameTime = performance.now();
      physicsAccumulator = 0;
    }
  });

  requestAnimationFrame(tickPhysics);

  async function loadPhrases() {
    try {
      const response = await fetch(`/wrong/phrases.txt?v=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const lines = (await response.text())
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const unique = [...new Set(lines)];
      if (unique.length > 0) phrases = unique;
    } catch {
      // file:// pages cannot fetch sibling text files in most browsers.
    }

    phraseBag = [];
  }

  function getVisitorId() {
    const storageKey = "qe-visitor-id";
    const valid = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{3,127}$/.test(value);
    try {
      const existing = window.localStorage.getItem(storageKey);
      if (valid(existing)) return existing;
      let generated = "";
      if (window.crypto?.randomUUID) {
        generated = window.crypto.randomUUID().replaceAll("-", "");
      } else if (window.crypto?.getRandomValues) {
        const bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        generated = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      }
      if (!valid(generated)) generated = `v${Date.now()}${Math.random().toString(36).slice(2, 12)}`;
      window.localStorage.setItem(storageKey, generated);
      return generated;
    } catch {
      return `v${Date.now()}${Math.random().toString(36).slice(2, 12)}`;
    }
  }

  function recordSharedHit() {
    // Keep visual actions independent from the network and serialize rapid hits.
    sharedHitQueue = sharedHitQueue
      .then(async () => {
        const response = await fetch("/api/wrong/hit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          body: JSON.stringify({ visitorId })
        });
        if (!response.ok) return;
        const data = await response.json();
        if (data && data.ok && Number.isFinite(Number(data.visitorHits))) {
          sharedVisitorHits = Number(data.visitorHits);
        }
      })
      .catch(() => {
        // file:// previews and offline sessions still support local play.
      });
  }

  async function fetchSharedStats(password) {
    let response;
    try {
      response = await fetch("/api/wrong/stats", {
        method: "GET",
        headers: { "X-Admin-Password": password },
        credentials: "same-origin",
        cache: "no-store"
      });
    } catch {
      throw new Error("请先通过 START.cmd 打开网站");
    }

    let data = null;
    try { data = await response.json(); } catch { }
    if (!response.ok || !data?.ok) {
      if (response.status === 401) throw new Error("密码不正确");
      throw new Error(data?.error || "暂时无法读取统计");
    }
    return data;
  }

  function renderSharedStats(data) {
    const visitors = Array.isArray(data.visitors) ? data.visitors : [];
    const total = Math.max(0, Number(data.totalHits ?? data.total) || 0);
    const current = visitors.find((entry) => entry && entry.id === visitorId);
    const currentHits = Math.max(0, Number(current?.hits) || sharedVisitorHits || 0);
    const otherHits = Math.max(0, total - currentHits);

    sharedTotal.textContent = String(total);
    sharedOther.textContent = String(otherHits);
    sharedVisitors.textContent = String(Number(data.visitorCount) || visitors.length);
    visitorList.replaceChildren();
    renderHitHistory(data, visitors);

    if (visitors.length === 0) {
      const empty = document.createElement("li");
      empty.className = "visitor-empty";
      empty.textContent = "还没有敲打记录";
      visitorList.appendChild(empty);
      return;
    }

    visitors.slice(0, 100).forEach((entry, index) => {
      const row = document.createElement("li");
      const label = document.createElement("span");
      const hits = document.createElement("strong");
      const isCurrent = entry && entry.id === visitorId;
      row.className = `visitor-row${isCurrent ? " is-current" : ""}`;
      label.textContent = isCurrent ? "本访客" : `访客 ${String(index + 1).padStart(2, "0")}`;
      hits.textContent = `${Math.max(0, Number(entry?.hits) || 0)} 次`;
      row.append(label, hits);
      visitorList.appendChild(row);
    });

    if (visitors.length > 100) {
      const more = document.createElement("li");
      more.className = "visitor-empty";
      more.textContent = `仅显示前 100 位访客（共 ${visitors.length} 位）`;
      visitorList.appendChild(more);
    }
  }

  function renderHitHistory(data, visitors) {
    const rawSource = data?.recentHits ?? data?.hitHistory;
    const source = rawSource === null || rawSource === undefined
      ? []
      : (Array.isArray(rawSource) ? rawSource : [rawSource]);
    const history = source
      .map(normalizeHitRecord)
      .filter(Boolean)
      .sort((left, right) => right.date.getTime() - left.date.getTime());

    hitHistoryList.replaceChildren();
    if (history.length === 0) {
      const empty = document.createElement("li");
      empty.className = "history-empty";
      empty.textContent = "暂无时间记录";
      hitHistoryList.appendChild(empty);
      hitHistoryNote.textContent = "本地时间 · 等待新记录";
      return;
    }

    const visitorIndex = new Map();
    visitors.forEach((entry, index) => {
      if (entry?.id) visitorIndex.set(String(entry.id), index);
    });

    history.slice(0, 500).forEach((record) => {
      const row = document.createElement("li");
      const time = document.createElement("time");
      const visitor = document.createElement("span");
      const isCurrent = record.visitorId && record.visitorId === visitorId;
      const knownIndex = record.visitorId ? visitorIndex.get(record.visitorId) : undefined;

      row.className = `hit-history-row${isCurrent ? " is-current" : ""}`;
      time.dateTime = record.date.toISOString();
      time.textContent = formatHitTime(record.date);
      visitor.className = "hit-history-visitor";
      if (isCurrent) {
        visitor.textContent = "本访客";
      } else if (Number.isInteger(knownIndex)) {
        visitor.textContent = `访客 ${String(knownIndex + 1).padStart(2, "0")}`;
      } else {
        visitor.textContent = "匿名访客";
      }
      row.append(time, visitor);
      hitHistoryList.appendChild(row);
    });

    if (history.length > 500) {
      const more = document.createElement("li");
      more.className = "history-empty";
      more.textContent = `仅显示最近 500 条（共 ${history.length} 条）`;
      hitHistoryList.appendChild(more);
    }
    hitHistoryNote.textContent = `本地时间 · 共 ${history.length} 条`;
  }

  function normalizeHitRecord(entry) {
    if (typeof entry === "string") {
      const date = new Date(entry);
      return Number.isNaN(date.getTime()) ? null : { date, visitorId: "" };
    }
    if (!entry || typeof entry !== "object") return null;

    const rawTime = entry.at ?? entry.timestamp ?? entry.time ?? entry.createdAt ?? entry.updatedAt;
    if (rawTime === null || rawTime === undefined || rawTime === "") return null;
    const date = new Date(rawTime);
    if (Number.isNaN(date.getTime())) return null;
    const rawVisitorId = entry.visitorId ?? entry.visitor ?? entry.id ?? "";
    return {
      date,
      visitorId: rawVisitorId === null || rawVisitorId === undefined ? "" : String(rawVisitorId)
    };
  }

  function formatHitTime(date) {
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }).format(date);
    } catch {
      return date.toLocaleString();
    }
  }

  function openAdminModal() {
    adminPreviousFocus = document.activeElement;
    adminPassword = "";
    adminPasswordInput.value = "";
    adminError.textContent = "";
    adminStatus.textContent = "";
    adminLock.hidden = false;
    adminStats.hidden = true;
    adminModal.hidden = false;
    app.setAttribute("inert", "");
    document.body.classList.add("modal-open");
    window.setTimeout(() => adminPasswordInput.focus(), 0);
  }

  function closeAdminModal() {
    adminModal.hidden = true;
    app.removeAttribute("inert");
    adminPassword = "";
    adminPasswordInput.value = "";
    document.body.classList.remove("modal-open");
    if (adminPreviousFocus && typeof adminPreviousFocus.focus === "function") {
      adminPreviousFocus.focus({ preventScroll: true });
    }
  }

  function updateCounter() {
    countElement.textContent = String(count);
  }

  function updateSoundButton() {
    const label = soundEnabled ? "关闭音效" : "开启音效";
    soundButton.setAttribute("aria-label", label);
    soundButton.setAttribute("aria-pressed", String(soundEnabled));
    soundButton.dataset.tooltip = label;
    soundButton.querySelector("span").textContent = soundEnabled ? "♫" : "♩";
  }

  function enqueueStrike() {
    pendingStrikes += 1;
    if (!strikeLoopRunning) runStrikeQueue();
  }

  async function runStrikeQueue() {
    strikeLoopRunning = true;

    while (pendingStrikes > 0) {
      pendingStrikes -= 1;
      await performStrike();
    }

    strikeLoopRunning = false;
  }

  async function performStrike() {
    const reduced = reducedMotionQuery.matches;
    stage.classList.remove("is-striking", "is-impacting");
    void scene.offsetWidth;
    stage.classList.add("is-striking");

    await wait(reduced ? 38 : 185);
    stage.classList.add("is-impacting");
    count += 1;
    updateCounter();
    spawnBubble(nextPhrase());
    recordSharedHit();
    playImpactSound();

    await wait(reduced ? 58 : 195);
    stage.classList.remove("is-striking", "is-impacting");
    await wait(reduced ? 18 : 35);
  }

  function nextPhrase() {
    if (phraseBag.length === 0) phraseBag = shuffle([...phrases]);
    return phraseBag.pop() || fallbackPhrases[0];
  }

  function shuffle(items) {
    for (let index = items.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [items[index], items[randomIndex]] = [items[randomIndex], items[index]];
    }
    return items;
  }

  function spawnBubble(text) {
    const stageRect = stage.getBoundingClientRect();
    const dogRect = dog.getBoundingClientRect();
    const startX = dogRect.left - stageRect.left + dogRect.width * 0.57;
    const startY = dogRect.top - stageRect.top + dogRect.height * 0.28;
    const element = document.createElement("button");
    const id = `bubble-${bubbleSerial += 1}`;

    element.type = "button";
    element.id = id;
    element.className = "apology-bubble";
    element.textContent = text;
    element.setAttribute("aria-label", `戳破气泡：${text}`);
    element.style.setProperty("--bubble-color", bubbleColors[(bubbleSerial - 1) % bubbleColors.length]);
    element.style.transform = `translate3d(${startX}px, ${startY}px, 0)`;
    bubbleLayer.appendChild(element);

    const rect = element.getBoundingClientRect();
    const width = Math.ceil(rect.width);
    const height = Math.ceil(rect.height);
    const body = Bodies.rectangle(startX, startY, width, height, {
      angle: reducedMotionQuery.matches ? 0 : (Math.random() - 0.5) * 0.12,
      chamfer: { radius: Math.min(height * 0.48, 28) },
      density: 0.00075,
      friction: 0.025,
      frictionAir: 0.012,
      inertia: Infinity,
      restitution: 0.66,
      slop: 0.03,
      label: id
    });

    Body.setVelocity(body, {
      x: (Math.random() - 0.5) * 2.5,
      y: reducedMotionQuery.matches ? -1.5 : -2.8 - Math.random() * 1.2
    });
    Body.setAngularVelocity(body, 0);
    Composite.add(engine.world, body);

    const bubble = {
      id,
      body,
      element,
      width,
      height,
      createdAt: performance.now(),
      expiresAt: performance.now() + 45000 + Math.random() * 25000,
      popping: false
    };
    bubbles.set(id, bubble);

    element.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      popBubble(bubble);
    });

    requestAnimationFrame(() => element.classList.add("is-ready"));
    phraseStatus.textContent = text;

    const limit = window.innerWidth <= 640 ? 22 : 38;
    if (bubbles.size > limit) {
      const oldest = [...bubbles.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) popBubble(oldest, true);
    }
  }

  function popBubble(bubble, quiet = false) {
    if (!bubble || bubble.popping) return;
    bubble.popping = true;
    bubbles.delete(bubble.id);
    Composite.remove(engine.world, bubble.body);

    const position = bubble.body.position;
    const lastTransform = bubble.element.style.transform;
    bubble.element.style.setProperty("--last-transform", lastTransform);
    bubble.element.style.transform = lastTransform;
    bubble.element.classList.add("is-popping");

    if (!reducedMotionQuery.matches) createBurst(position.x, position.y);
    if (!quiet) playPopSound();

    window.setTimeout(() => bubble.element.remove(), 240);
  }

  function createBurst(x, y) {
    const burst = document.createElement("span");
    burst.className = "burst";
    burst.style.left = `${x}px`;
    burst.style.top = `${y}px`;

    for (let index = 0; index < 7; index += 1) {
      const spark = document.createElement("i");
      const angle = (Math.PI * 2 * index) / 7;
      const distance = 24 + Math.random() * 20;
      spark.style.setProperty("--spark-x", `${Math.cos(angle) * distance}px`);
      spark.style.setProperty("--spark-y", `${Math.sin(angle) * distance}px`);
      spark.style.setProperty("--spark-color", bubbleColors[index % bubbleColors.length]);
      burst.appendChild(spark);
    }

    burstLayer.appendChild(burst);
    window.setTimeout(() => burst.remove(), 360);
  }

  function tickPhysics(now) {
    const elapsed = Math.min(50, Math.max(0, now - lastFrameTime));
    const fixedStep = 1000 / 60;
    lastFrameTime = now;

    if (!document.hidden) {
      physicsAccumulator += elapsed;
      while (physicsAccumulator >= fixedStep) {
        Engine.update(engine, fixedStep);
        physicsAccumulator -= fixedStep;
      }
      bubbles.forEach((bubble) => {
        const { x, y } = bubble.body.position;
        const angle = reducedMotionQuery.matches ? 0 : bubble.body.angle;
        const transform = `translate3d(${x - bubble.width / 2}px, ${y - bubble.height / 2}px, 0) rotate(${angle}rad)`;
        bubble.element.style.transform = transform;
        bubble.element.style.setProperty("--last-transform", transform);

        if (now >= bubble.expiresAt) popBubble(bubble, true);
      });
    }

    requestAnimationFrame(tickPhysics);
  }

  function rebuildBoundaries() {
    const width = Math.max(stage.clientWidth, 320);
    const height = Math.max(stage.clientHeight, 260);
    const thickness = 80;

    if (boundaryBodies.length) Composite.remove(engine.world, boundaryBodies);
    boundaryBodies = [
      Bodies.rectangle(-thickness / 2 + 4, height / 2, thickness, height * 2, { isStatic: true }),
      Bodies.rectangle(width + thickness / 2 - 4, height / 2, thickness, height * 2, { isStatic: true }),
      Bodies.rectangle(width / 2, -thickness / 2 + 10, width * 2, thickness, { isStatic: true }),
      Bodies.rectangle(width / 2, height + thickness / 2, width * 2, thickness, { isStatic: true })
    ];
    Composite.add(engine.world, boundaryBodies);
  }

  function keepBubblesInBounds() {
    const width = stage.clientWidth;
    const height = stage.clientHeight;

    bubbles.forEach((bubble) => {
      Body.setPosition(bubble.body, {
        x: Math.max(bubble.width / 2 + 4, Math.min(width - bubble.width / 2 - 4, bubble.body.position.x)),
        y: Math.max(bubble.height / 2 + 14, Math.min(height - bubble.height / 2 - 4, bubble.body.position.y))
      });
    });
  }

  function ensureAudio() {
    if (!soundEnabled) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!audioContext) audioContext = new AudioContextClass();
    if (audioContext.state === "suspended") audioContext.resume();
  }

  function playImpactSound() {
    if (!soundEnabled || !audioContext || audioContext.state !== "running") return;
    const now = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();

    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(128, now);
    oscillator.frequency.exponentialRampToValueAtTime(62, now + 0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.13, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.16);
  }

  function playPopSound() {
    if (!soundEnabled || !audioContext || audioContext.state !== "running") return;
    const now = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(520, now);
    oscillator.frequency.exponentialRampToValueAtTime(880, now + 0.045);
    gain.gain.setValueAtTime(0.07, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.08);
  }

  function wait(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }
})();
