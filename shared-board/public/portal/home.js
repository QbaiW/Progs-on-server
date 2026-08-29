const FEATURE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FEATURE_PATH_PATTERN = /^\/[a-z0-9]+(?:[\/-][a-z0-9]+)*$/;
const VISITOR_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const ACCENTS = new Set(["default", "warm", "green", "rose", "sky"]);
const OWNER_TRIGGER_COUNT = 4;
const OWNER_TRIGGER_WINDOW_MS = 2600;

const elements = {
  grid: document.querySelector("#featureGrid"),
  status: document.querySelector("#portalStatus"),
  count: document.querySelector("#featureCount"),
  announcement: document.querySelector("#portalAnnouncement"),
  announcementText: document.querySelector("#announcementText"),
  ownerTrigger: document.querySelector("#ownerTrigger"),
  loginDialog: document.querySelector("#ownerLoginDialog"),
  loginForm: document.querySelector("#ownerLoginForm"),
  ownerPassword: document.querySelector("#ownerPassword"),
  loginButton: document.querySelector("#ownerLoginButton"),
  loginStatus: document.querySelector("#ownerLoginStatus"),
  workspaceDialog: document.querySelector("#ownerWorkspaceDialog"),
  workspaceStatus: document.querySelector("#ownerWorkspaceStatus"),
  refreshButton: document.querySelector("#ownerRefreshButton"),
  logoutButton: document.querySelector("#ownerLogoutButton"),
  tabs: [...document.querySelectorAll("[data-owner-tab]")],
  panels: [...document.querySelectorAll("[data-owner-panel]")],
  metrics: document.querySelector("#ownerMetrics"),
  activityUpdated: document.querySelector("#ownerActivityUpdated"),
  activityList: document.querySelector("#ownerActivityList"),
  activityEmpty: document.querySelector("#ownerActivityEmpty"),
  visitorCount: document.querySelector("#ownerVisitorCount"),
  visitorList: document.querySelector("#ownerVisitorList"),
  visitorEmpty: document.querySelector("#ownerVisitorEmpty"),
  settingsForm: document.querySelector("#ownerSettingsForm"),
  announcementEnabled: document.querySelector("#announcementEnabled"),
  announcementInput: document.querySelector("#announcementInput"),
  featureSettings: document.querySelector("#ownerFeatureSettings"),
  settingsSaveButton: document.querySelector("#ownerSettingsSaveButton"),
  settingsStatus: document.querySelector("#ownerSettingsStatus"),
};

const state = {
  features: [],
  ownerPortal: null,
  triggerTimes: [],
  ownerLoading: false,
};

class ApiError extends Error {
  constructor(message, status, payload = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

function isFeature(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    FEATURE_ID_PATTERN.test(value.id || "") &&
    typeof value.title === "string" &&
    value.title.trim() &&
    typeof value.description === "string" &&
    typeof value.icon === "string" &&
    FEATURE_PATH_PATTERN.test(value.path || "") &&
    value.enabled !== false,
  );
}

function normalizeFeature(value) {
  return {
    id: value.id,
    title: value.title.trim().slice(0, 120),
    description: value.description.trim().slice(0, 500),
    icon: value.icon.slice(0, 12),
    path: value.path,
    order: Number.isFinite(value.order) ? value.order : Number.MAX_SAFE_INTEGER,
    enabled: true,
    featured: value.featured === true,
    accent: ACCENTS.has(value.accent) ? value.accent : "default",
  };
}

function createArtwork(feature) {
  const artwork = document.createElement("span");
  artwork.className = `feature-art feature-art-${feature.id}`;
  artwork.setAttribute("aria-hidden", "true");

  if (feature.id === "star-bottle") {
    const stars = document.createElement("span");
    stars.className = "feature-art-stars";
    const bottle = document.createElement("span");
    bottle.className = "feature-art-bottle";
    for (let index = 0; index < 5; index += 1) bottle.append(document.createElement("i"));
    artwork.append(stars, bottle);
    return artwork;
  }

  if (feature.id === "love-stars") {
    const binary = document.createElement("span");
    binary.className = "feature-art-binary";
    binary.append(document.createElement("i"), document.createElement("i"));
    const dust = document.createElement("span");
    dust.className = "feature-art-dust";
    artwork.append(dust, binary);
    return artwork;
  }

  if (feature.id === "wrong") {
    const bear = document.createElement("img");
    bear.src = "/wrong/assets/white-bear.png";
    bear.alt = "";
    bear.loading = "lazy";
    bear.className = "feature-art-bear";
    const hammer = document.createElement("img");
    hammer.src = "/wrong/assets/red-hammer.png";
    hammer.alt = "";
    hammer.loading = "lazy";
    hammer.className = "feature-art-hammer";
    artwork.append(bear, hammer);
    return artwork;
  }

  const fallbackIcon = document.createElement("span");
  fallbackIcon.className = "feature-art-fallback";
  fallbackIcon.textContent = feature.icon || feature.title.slice(0, 1);
  artwork.append(fallbackIcon);
  return artwork;
}

function createFeatureItem(feature) {
  const item = document.createElement("li");
  item.className = "feature-item";
  item.dataset.featureId = feature.id;
  item.dataset.accent = feature.accent;
  if (feature.featured) item.classList.add("is-featured");

  const link = document.createElement("a");
  link.className = "feature-card";
  link.href = feature.path;

  const content = document.createElement("span");
  content.className = "feature-content";

  const heading = document.createElement("span");
  heading.className = "feature-heading";
  const icon = document.createElement("span");
  icon.className = "feature-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = feature.icon || "•";
  const title = document.createElement("strong");
  title.textContent = feature.title;
  heading.append(icon, title);
  if (feature.featured) {
    const badge = document.createElement("span");
    badge.className = "featured-label";
    badge.textContent = "重点";
    heading.append(badge);
  }

  const description = document.createElement("span");
  description.className = "feature-description";
  description.textContent = feature.description;

  const action = document.createElement("span");
  action.className = "feature-action";
  const arrow = document.createElement("span");
  arrow.textContent = "→";
  arrow.setAttribute("aria-hidden", "true");
  action.append("进入", arrow);

  content.append(heading, description, action);
  link.append(createArtwork(feature), content);
  item.append(link);
  return item;
}

function renderFeatures(features) {
  const sortedFeatures = features.slice().sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const fragment = document.createDocumentFragment();
  for (const feature of sortedFeatures) fragment.append(createFeatureItem(feature));
  state.features = sortedFeatures;
  elements.grid.replaceChildren(fragment);
  elements.count.textContent = `${sortedFeatures.length} 个可用功能`;
  elements.status.textContent = sortedFeatures.length ? "功能列表已同步" : "暂时没有可用功能";
  elements.status.dataset.state = sortedFeatures.length ? "ready" : "empty";
}

function renderAnnouncement(announcement) {
  const text = typeof announcement?.text === "string" ? announcement.text.trim().slice(0, 500) : "";
  const visible = announcement?.enabled === true && Boolean(text);
  elements.announcementText.textContent = text;
  elements.announcement.hidden = !visible;
}

async function loadFeatures({ quiet = false } = {}) {
  try {
    const response = await fetch("/api/features", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const features = Array.isArray(payload?.features)
      ? payload.features.filter(isFeature).map(normalizeFeature)
      : [];
    if (!features.length) throw new Error("功能列表为空");
    renderAnnouncement(payload.announcement);
    renderFeatures(features);
  } catch {
    if (!state.features.length) state.features = fallbackFeatures();
    if (!quiet) {
      const fallbackCount = elements.grid.children.length;
      elements.count.textContent = `${fallbackCount} 个可用功能`;
      elements.status.textContent = "功能列表暂时无法同步，已显示本地入口";
      elements.status.dataset.state = "error";
    }
  }
}

function fallbackFeatures() {
  return [...elements.grid.querySelectorAll(".feature-item")].flatMap((item, index) => {
    const link = item.querySelector(".feature-card");
    const title = item.querySelector(".feature-heading strong")?.textContent?.trim();
    const description = item.querySelector(".feature-description")?.textContent?.trim();
    const id = item.dataset.featureId || "";
    if (!link || !title || !description || !FEATURE_ID_PATTERN.test(id)) return [];
    return [{
      id,
      title,
      description,
      icon: item.querySelector(".feature-icon")?.textContent || "•",
      path: new URL(link.href, window.location.href).pathname,
      order: index,
      enabled: true,
      featured: item.classList.contains("is-featured"),
      accent: ACCENTS.has(item.dataset.accent) ? item.dataset.accent : "default",
    }];
  });
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: `服务器返回了无法识别的结果（HTTP ${response.status}）` };
  }
}

async function requestJson(resource, options = {}) {
  const response = await fetch(resource, {
    cache: "no-store",
    credentials: "same-origin",
    ...options,
  });
  const payload = await parseJsonResponse(response);
  if (!response.ok) throw new ApiError(payload.error || `请求失败（HTTP ${response.status}）`, response.status, payload);
  return payload;
}

async function ownerRequest(resource, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  const response = await fetch(resource, {
    cache: "no-store",
    credentials: "same-origin",
    ...options,
    headers,
  });
  const payload = await parseJsonResponse(response);
  if (!response.ok) throw new ApiError(payload.error || `请求失败（HTTP ${response.status}）`, response.status, payload);
  return payload;
}

function setStatus(element, message = "", stateName = "") {
  element.textContent = message;
  if (stateName) element.dataset.state = stateName;
  else delete element.dataset.state;
}

function showDialog(dialog, focusTarget) {
  for (const openDialog of document.querySelectorAll("dialog[open]")) {
    if (openDialog !== dialog) openDialog.close();
  }
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => focusTarget?.focus());
}

function showOwnerLogin(message = "") {
  setStatus(elements.loginStatus, message, message ? "error" : "");
  elements.ownerPassword.value = "";
  showDialog(elements.loginDialog, elements.ownerPassword);
}

function friendlyError(error, fallback) {
  if (error instanceof ApiError && error.status === 401) return "登录已失效，请重新输入管理密码。";
  if (error instanceof TypeError) return "暂时无法连接服务器，请稍后再试。";
  return error?.message || fallback;
}

function formatTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function shortVisitorId(visitorId) {
  if (visitorId.length <= 18) return visitorId;
  return `${visitorId.slice(0, 10)}…${visitorId.slice(-6)}`;
}

function appendMetric(fragment, label, value) {
  const wrapper = document.createElement("div");
  const term = document.createElement("dt");
  const detail = document.createElement("dd");
  term.textContent = label;
  detail.textContent = String(value);
  wrapper.append(term, detail);
  fragment.append(wrapper);
}

function renderOverview(portal) {
  const entries = Array.isArray(portal.activity?.entries) ? portal.activity.entries : [];
  const visitors = Array.isArray(portal.visitors) ? portal.visitors : [];
  const eventTotal = visitors.reduce((total, visitor) => {
    const count = Number(visitor?.totalEvents ?? visitor?.eventCount);
    return total + (Number.isFinite(count) && count > 0 ? Math.floor(count) : 0);
  }, 0);
  const visits = entries.filter((entry) => entry?.type === "visit").length;
  const featureOpens = entries.filter((entry) => entry?.type === "feature-open").length;
  const metricFragment = document.createDocumentFragment();
  appendMetric(metricFragment, "访客", visitors.length);
  appendMetric(metricFragment, "累计活动", eventTotal || entries.length);
  appendMetric(metricFragment, "列表内访问", visits);
  appendMetric(metricFragment, "列表内打开", featureOpens);
  elements.metrics.replaceChildren(metricFragment);

  const visitorMap = new Map(visitors.map((visitor) => [visitor.id ?? visitor.visitorId, visitor]));
  const featureMap = new Map(state.features.map((feature) => [feature.id, feature]));
  const activityFragment = document.createDocumentFragment();
  for (const entry of entries.slice(0, 120)) {
    if (!entry || typeof entry !== "object") continue;
    const visitorId = typeof entry.visitorId === "string" ? entry.visitorId : "未知访客";
    const visitor = visitorMap.get(visitorId);
    const identity = visitor?.name?.trim() || shortVisitorId(visitorId);
    const feature = featureMap.get(entry.featureId);
    const actionText = entry.type === "feature-open"
      ? `打开 ${entry.featureTitle || entry.feature?.title || feature?.title || entry.featureId || entry.path || "功能"}`
      : "进入功能中心";

    const item = document.createElement("li");
    item.className = "activity-entry";
    const copy = document.createElement("div");
    const action = document.createElement("strong");
    const visitorLabel = document.createElement("span");
    action.textContent = actionText;
    visitorLabel.textContent = identity;
    visitorLabel.title = visitorId;
    copy.append(action, visitorLabel);
    const time = document.createElement("time");
    time.dateTime = typeof entry.at === "string" ? entry.at : "";
    time.textContent = formatTime(entry.at);
    item.append(copy, time);
    activityFragment.append(item);
  }
  elements.activityList.replaceChildren(activityFragment);
  elements.activityEmpty.hidden = Boolean(elements.activityList.children.length);
  elements.activityUpdated.textContent = portal.activity?.updatedAt
    ? `更新于 ${formatTime(portal.activity.updatedAt)}`
    : "";
}

function createVisitorForm(visitor, index) {
  const visitorId = typeof visitor.id === "string"
    ? visitor.id
    : typeof visitor.visitorId === "string"
      ? visitor.visitorId
      : "";
  const form = document.createElement("form");
  form.className = "visitor-entry";
  form.dataset.visitorId = visitorId;

  const header = document.createElement("div");
  header.className = "visitor-heading";
  const title = document.createElement("strong");
  title.dataset.visitorTitle = "";
  title.textContent = visitor.name?.trim() || shortVisitorId(visitorId);
  title.title = visitorId;
  const meta = document.createElement("span");
  const count = Number(visitor.totalEvents ?? visitor.eventCount);
  const eventCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  meta.textContent = `${eventCount} 次活动 · ${formatTime(visitor.lastSeenAt)}`;
  header.append(title, meta);

  const nameId = `visitorName${index}`;
  const nameLabel = document.createElement("label");
  nameLabel.htmlFor = nameId;
  nameLabel.textContent = "称呼";
  const name = document.createElement("input");
  name.id = nameId;
  name.name = "name";
  name.maxLength = 80;
  name.value = typeof visitor.name === "string" ? visitor.name : "";

  const remarkId = `visitorRemark${index}`;
  const remarkLabel = document.createElement("label");
  remarkLabel.htmlFor = remarkId;
  remarkLabel.textContent = "备注";
  const remark = document.createElement("textarea");
  remark.id = remarkId;
  remark.name = "remark";
  remark.maxLength = 300;
  remark.rows = 2;
  remark.value = typeof visitor.remark === "string" ? visitor.remark : "";

  const actions = document.createElement("div");
  actions.className = "visitor-actions";
  const save = document.createElement("button");
  save.className = "quiet-button";
  save.type = "submit";
  save.textContent = "保存备注";
  const status = document.createElement("p");
  status.className = "form-status";
  status.dataset.visitorStatus = "";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  actions.append(save, status);

  const nameField = document.createElement("div");
  nameField.className = "form-field";
  nameField.append(nameLabel, name);
  const remarkField = document.createElement("div");
  remarkField.className = "form-field visitor-remark-field";
  remarkField.append(remarkLabel, remark);
  form.append(header, nameField, remarkField, actions);
  return form;
}

function renderVisitors(portal) {
  const visitors = Array.isArray(portal.visitors) ? portal.visitors : [];
  const fragment = document.createDocumentFragment();
  visitors.forEach((visitor, index) => {
    const visitorId = visitor?.id ?? visitor?.visitorId;
    if (typeof visitorId === "string" && VISITOR_ID_PATTERN.test(visitorId)) {
      fragment.append(createVisitorForm(visitor, index));
    }
  });
  elements.visitorList.replaceChildren(fragment);
  elements.visitorCount.textContent = `${elements.visitorList.children.length} 位访客`;
  elements.visitorEmpty.hidden = Boolean(elements.visitorList.children.length);
}

function createLabeledControl(labelText, control) {
  const wrapper = document.createElement("label");
  wrapper.htmlFor = control.id;
  const label = document.createElement("span");
  label.textContent = labelText;
  wrapper.append(label, control);
  return wrapper;
}

function createFeatureSettings(feature, saved = {}) {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "feature-settings";
  fieldset.dataset.featureSettingsId = feature.id;
  const legend = document.createElement("legend");
  legend.textContent = feature.title;
  fieldset.append(legend);

  const title = document.createElement("input");
  title.id = `featureTitle-${feature.id}`;
  title.name = "title";
  title.maxLength = 120;
  title.value = typeof saved.title === "string" ? saved.title : "";
  title.placeholder = feature.title;

  const description = document.createElement("textarea");
  description.id = `featureDescription-${feature.id}`;
  description.name = "description";
  description.maxLength = 500;
  description.rows = 3;
  description.value = typeof saved.description === "string" ? saved.description : "";
  description.placeholder = feature.description;

  const accent = document.createElement("select");
  accent.id = `featureAccent-${feature.id}`;
  accent.name = "accent";
  const accentOptions = [
    ["default", "默认"],
    ["warm", "暖橙"],
    ["green", "绿"],
    ["rose", "玫红"],
    ["sky", "天蓝"],
  ];
  for (const [value, label] of accentOptions) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    accent.append(option);
  }
  accent.value = ACCENTS.has(saved.accent) ? saved.accent : feature.accent;

  const featured = document.createElement("input");
  featured.id = `featureFeatured-${feature.id}`;
  featured.name = "featured";
  featured.type = "checkbox";
  featured.checked = typeof saved.featured === "boolean" ? saved.featured : feature.featured;
  const featuredLabel = document.createElement("label");
  featuredLabel.className = "checkbox-label";
  featuredLabel.htmlFor = featured.id;
  featuredLabel.append(featured, document.createTextNode("设为重点"));

  const row = document.createElement("div");
  row.className = "feature-settings-row";
  row.append(
    createLabeledControl("卡片标题", title),
    createLabeledControl("强调色", accent),
    featuredLabel,
  );
  fieldset.append(row, createLabeledControl("卡片说明", description));
  return fieldset;
}

function renderSettings(portal) {
  const settings = portal.settings && typeof portal.settings === "object" ? portal.settings : {};
  const announcement = settings.announcement && typeof settings.announcement === "object"
    ? settings.announcement
    : {};
  elements.announcementEnabled.checked = announcement.enabled === true;
  elements.announcementInput.value = typeof announcement.text === "string" ? announcement.text : "";

  const savedFeatures = settings.features && typeof settings.features === "object" && !Array.isArray(settings.features)
    ? settings.features
    : {};
  const fragment = document.createDocumentFragment();
  for (const feature of state.features) fragment.append(createFeatureSettings(feature, savedFeatures[feature.id]));
  elements.featureSettings.replaceChildren(fragment);
}

function renderOwnerPortal(portal) {
  const snapshotFeatures = Array.isArray(portal.features)
    ? portal.features.filter(isFeature).map(normalizeFeature)
    : [];
  if (snapshotFeatures.length) renderFeatures(snapshotFeatures);
  renderAnnouncement(portal.settings?.announcement);
  state.ownerPortal = portal;
  renderOverview(portal);
  renderVisitors(portal);
  renderSettings(portal);
}

async function loadOwnerPortal({ open = false } = {}) {
  if (state.ownerLoading) return;
  state.ownerLoading = true;
  elements.ownerTrigger.setAttribute("aria-busy", "true");
  if (elements.workspaceDialog.open) setStatus(elements.workspaceStatus, "正在刷新…");
  try {
    const portal = await ownerRequest("/api/owner/portal");
    renderOwnerPortal(portal);
    setStatus(elements.workspaceStatus, "数据已更新", "success");
    if (open) showDialog(elements.workspaceDialog, elements.tabs[0]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      showOwnerLogin();
    } else if (open) {
      showOwnerLogin(friendlyError(error, "管理数据读取失败。"));
    } else {
      setStatus(elements.workspaceStatus, friendlyError(error, "管理数据读取失败。"), "error");
    }
  } finally {
    state.ownerLoading = false;
    elements.ownerTrigger.removeAttribute("aria-busy");
  }
}

function handleOwnerTrigger() {
  const now = Date.now();
  state.triggerTimes = state.triggerTimes.filter((time) => now - time <= OWNER_TRIGGER_WINDOW_MS);
  state.triggerTimes.push(now);
  if (state.triggerTimes.length < OWNER_TRIGGER_COUNT) return;
  state.triggerTimes = [];
  void loadOwnerPortal({ open: true });
}

async function handleOwnerLogin(event) {
  event.preventDefault();
  const password = elements.ownerPassword.value;
  if (!password) return;
  elements.loginButton.disabled = true;
  setStatus(elements.loginStatus, "正在验证…");
  try {
    const result = await requestJson("/api/owner/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        password,
        deviceLabel: "功能中心",
      }),
    });
    if (result.authenticated !== true) throw new Error("服务器没有确认管理身份。 ");
    elements.ownerPassword.value = "";
    elements.loginDialog.close();
    await loadOwnerPortal({ open: true });
  } catch (error) {
    const message = error instanceof ApiError && error.status === 401
      ? "密码不正确，请重新输入。"
      : friendlyError(error, "登录失败，请稍后再试。 ");
    setStatus(elements.loginStatus, message, "error");
    elements.ownerPassword.select();
  } finally {
    elements.loginButton.disabled = false;
  }
}

function activateOwnerTab(name, { focus = false } = {}) {
  for (const tab of elements.tabs) {
    const active = tab.dataset.ownerTab === name;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus();
  }
  for (const panel of elements.panels) panel.hidden = panel.dataset.ownerPanel !== name;
}

function handleTabKeydown(event) {
  const currentIndex = elements.tabs.indexOf(event.currentTarget);
  if (currentIndex < 0) return;
  let nextIndex = null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % elements.tabs.length;
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + elements.tabs.length) % elements.tabs.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = elements.tabs.length - 1;
  if (nextIndex === null) return;
  event.preventDefault();
  activateOwnerTab(elements.tabs[nextIndex].dataset.ownerTab, { focus: true });
}

async function handleVisitorSave(event) {
  const form = event.target.closest("form.visitor-entry");
  if (!form) return;
  event.preventDefault();
  const visitorId = form.dataset.visitorId || "";
  if (!VISITOR_ID_PATTERN.test(visitorId)) return;
  const submit = form.querySelector("button[type='submit']");
  const status = form.querySelector("[data-visitor-status]");
  const name = form.elements.name.value.trim();
  const remark = form.elements.remark.value.trim();
  submit.disabled = true;
  setStatus(status, "正在保存…");
  try {
    const result = await ownerRequest(`/api/owner/portal/visitors/${encodeURIComponent(visitorId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, remark }),
    });
    const saved = result.visitor || { visitorId, name, remark };
    const visitor = state.ownerPortal?.visitors?.find((candidate) => (candidate.id ?? candidate.visitorId) === visitorId);
    if (visitor) {
      visitor.name = saved.name || "";
      visitor.remark = saved.remark || "";
    }
    form.elements.name.value = typeof saved.name === "string" ? saved.name : name;
    form.elements.remark.value = typeof saved.remark === "string" ? saved.remark : remark;
    form.querySelector("[data-visitor-title]").textContent = saved.name?.trim() || shortVisitorId(visitorId);
    setStatus(status, name || remark ? "已保存" : "备注已清除", "success");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      elements.workspaceDialog.close();
      showOwnerLogin("登录已失效，请重新输入管理密码。 ");
    } else {
      setStatus(status, friendlyError(error, "备注保存失败。 "), "error");
    }
  } finally {
    submit.disabled = false;
  }
}

function collectFeatureSettings() {
  const features = {};
  for (const fieldset of elements.featureSettings.querySelectorAll("[data-feature-settings-id]")) {
    const id = fieldset.dataset.featureSettingsId;
    if (!FEATURE_ID_PATTERN.test(id)) continue;
    const accent = fieldset.querySelector("[name='accent']").value;
    features[id] = {
      title: fieldset.querySelector("[name='title']").value.trim(),
      description: fieldset.querySelector("[name='description']").value.trim(),
      featured: fieldset.querySelector("[name='featured']").checked,
      accent: ACCENTS.has(accent) ? accent : "default",
    };
  }
  return features;
}

async function handleSettingsSave(event) {
  event.preventDefault();
  elements.settingsSaveButton.disabled = true;
  setStatus(elements.settingsStatus, "正在保存…");
  try {
    const result = await ownerRequest("/api/owner/portal/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        announcement: {
          enabled: elements.announcementEnabled.checked,
          text: elements.announcementInput.value.trim(),
        },
        features: collectFeatureSettings(),
      }),
    });
    if (state.ownerPortal && result.settings) state.ownerPortal.settings = result.settings;
    await loadFeatures({ quiet: true });
    if (state.ownerPortal) renderSettings(state.ownerPortal);
    setStatus(elements.settingsStatus, "主页设置已保存", "success");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      elements.workspaceDialog.close();
      showOwnerLogin("登录已失效，请重新输入管理密码。 ");
    } else {
      setStatus(elements.settingsStatus, friendlyError(error, "主页设置保存失败。 "), "error");
    }
  } finally {
    elements.settingsSaveButton.disabled = false;
  }
}

async function logoutOwner() {
  elements.logoutButton.disabled = true;
  try {
    await ownerRequest("/api/owner/logout", { method: "POST" });
  } catch { /* the workspace still closes if the network request fails */ }
  state.ownerPortal = null;
  elements.workspaceDialog.close();
  elements.ownerTrigger.focus();
  elements.status.textContent = "已退出管理";
  elements.status.dataset.state = "ready";
  elements.logoutButton.disabled = false;
}

function bindDialogs() {
  for (const button of document.querySelectorAll("[data-close-dialog]")) {
    button.addEventListener("click", () => document.querySelector(`#${button.dataset.closeDialog}`)?.close());
  }
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  }
}

function bindOwnerUi() {
  elements.ownerTrigger.addEventListener("click", handleOwnerTrigger);
  elements.loginForm.addEventListener("submit", handleOwnerLogin);
  elements.refreshButton.addEventListener("click", () => void loadOwnerPortal());
  elements.logoutButton.addEventListener("click", () => void logoutOwner());
  elements.visitorList.addEventListener("submit", handleVisitorSave);
  elements.settingsForm.addEventListener("submit", handleSettingsSave);
  for (const tab of elements.tabs) {
    tab.addEventListener("click", () => activateOwnerTab(tab.dataset.ownerTab));
    tab.addEventListener("keydown", handleTabKeydown);
  }
  bindDialogs();
}

function start() {
  state.features = fallbackFeatures();
  bindOwnerUi();
  void loadFeatures();
}

start();
