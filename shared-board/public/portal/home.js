const elements = {
  grid: document.querySelector("#featureGrid"),
  status: document.querySelector("#portalStatus"),
  count: document.querySelector("#featureCount"),
};

const FEATURE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FEATURE_PATH_PATTERN = /^\/[a-z0-9]+(?:[\/-][a-z0-9]+)*$/;

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
  const fragment = document.createDocumentFragment();
  for (const feature of features) fragment.append(createFeatureItem(feature));
  elements.grid.replaceChildren(fragment);
  elements.count.textContent = `${features.length} 个可用功能`;
  elements.status.textContent = features.length ? "功能列表已同步" : "暂时没有可用功能";
  elements.status.dataset.state = features.length ? "ready" : "empty";
}

async function loadFeatures() {
  try {
    const response = await fetch("/api/features", {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const features = Array.isArray(payload?.features) ? payload.features.filter(isFeature) : [];
    if (!features.length) throw new Error("功能列表为空");
    renderFeatures(features);
  } catch {
    const fallbackCount = elements.grid.children.length;
    elements.count.textContent = `${fallbackCount} 个可用功能`;
    elements.status.textContent = "功能列表暂时无法同步，已显示本地入口";
    elements.status.dataset.state = "error";
  }
}

loadFeatures();
