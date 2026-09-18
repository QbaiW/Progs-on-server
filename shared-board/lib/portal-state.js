"use strict";

const COPY_FIELDS = require("../public/portal/copy.json");
const MAX_PORTAL_ACTIVITY_ENTRIES = 5000;
const MAX_ANNOUNCEMENT_LENGTH = 500;
const MAX_FEATURE_TITLE_LENGTH = 120;
const MAX_FEATURE_DESCRIPTION_LENGTH = 500;
const MAX_VISITOR_NAME_LENGTH = 80;
const MAX_VISITOR_REMARK_LENGTH = 300;
const PORTAL_VISITOR_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const PORTAL_ACTIVITY_TYPES = new Set(["visit", "feature-open"]);
const PORTAL_ACCENTS = new Set(["default", "warm", "green", "rose", "sky"]);

function timestamp(value, fallback = "") {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : fallback;
}

function version(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function cleanText(value, maximum) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function emptyPortalSettingsDocument() {
  const copy = Object.fromEntries(COPY_FIELDS.map(([key, , value]) => [key, value]));
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    announcement: { enabled: false, text: "" },
    copy,
    featureOrder: [],
    features: {},
    visitorLabels: {},
  };
}

function normalizePortalSettingsDocument(raw, featureIds = null) {
  const fallback = emptyPortalSettingsDocument();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const validFeatureIds = featureIds instanceof Set ? featureIds : null;
  const features = Object.create(null);
  if (raw.features && typeof raw.features === "object" && !Array.isArray(raw.features)) {
    for (const [id, feature] of Object.entries(raw.features)) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || (validFeatureIds && !validFeatureIds.has(id))) continue;
      if (!feature || typeof feature !== "object" || Array.isArray(feature)) continue;
      const title = cleanText(feature.title, MAX_FEATURE_TITLE_LENGTH);
      const description = cleanText(feature.description, MAX_FEATURE_DESCRIPTION_LENGTH);
      const accent = PORTAL_ACCENTS.has(feature.accent) ? feature.accent : "default";
      features[id] = {
        action: cleanText(feature.action, 120),
        title,
        description,
        featured: feature.featured === true,
        accent,
      };
    }
  }

  const visitorLabels = Object.create(null);
  if (raw.visitorLabels && typeof raw.visitorLabels === "object" && !Array.isArray(raw.visitorLabels)) {
    for (const [visitorId, label] of Object.entries(raw.visitorLabels)) {
      if (!PORTAL_VISITOR_ID_PATTERN.test(visitorId) || !label || typeof label !== "object" || Array.isArray(label)) continue;
      const name = cleanText(label.name, MAX_VISITOR_NAME_LENGTH);
      const remark = cleanText(label.remark, MAX_VISITOR_REMARK_LENGTH);
      if (name || remark) visitorLabels[visitorId] = { name, remark };
    }
  }

  return {
    version: version(raw.version),
    updatedAt: timestamp(raw.updatedAt, fallback.updatedAt),
    announcement: {
      enabled: raw.announcement?.enabled === true,
      text: cleanText(raw.announcement?.text, MAX_ANNOUNCEMENT_LENGTH),
    },
    copy: Object.fromEntries(COPY_FIELDS.map(([key, , defaultValue]) => [
      key,
      typeof raw.copy?.[key] === "string" ? cleanText(raw.copy[key], 500) : defaultValue,
    ])),
    featureOrder: Array.isArray(raw.featureOrder) ? [...new Set(raw.featureOrder.filter(id => typeof id === "string" && (!validFeatureIds || validFeatureIds.has(id))))] : [],
    features,
    visitorLabels,
  };
}

function emptyPortalActivityDocument() {
  return { version: 1, updatedAt: new Date().toISOString(), entries: [] };
}

function normalizePortalActivityDocument(raw, featurePaths = null) {
  const fallback = emptyPortalActivityDocument();
  if (!raw || !Array.isArray(raw.entries)) return fallback;
  const entries = raw.entries.slice(-MAX_PORTAL_ACTIVITY_ENTRIES).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const id = typeof entry.id === "string" ? entry.id.trim().slice(0, 64) : "";
    const visitorId = typeof entry.visitorId === "string" ? entry.visitorId.trim() : "";
    const type = PORTAL_ACTIVITY_TYPES.has(entry.type) ? entry.type : "";
    const at = timestamp(entry.at);
    if (!id || !PORTAL_VISITOR_ID_PATTERN.test(visitorId) || !type || !at) return [];
    const featureId = type === "feature-open" && typeof entry.featureId === "string"
      ? entry.featureId.trim()
      : null;
    if (type === "feature-open" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(featureId || "")) return [];
    const storedFeaturePath = typeof entry.path === "string" ? entry.path.trim().slice(0, 200) : "";
    const registeredFeaturePath = featurePaths instanceof Map ? featurePaths.get(featureId) : "";
    const path = type === "visit"
      ? "/home"
      : registeredFeaturePath || storedFeaturePath;
    if (!/^\/[a-z0-9]+(?:[\/-][a-z0-9]+)*$/.test(path)) return [];
    return [{ id, visitorId, type, featureId, path, at }];
  });
  return {
    version: version(raw.version),
    updatedAt: timestamp(raw.updatedAt, fallback.updatedAt),
    entries,
  };
}

module.exports = {
  MAX_ANNOUNCEMENT_LENGTH,
  MAX_FEATURE_DESCRIPTION_LENGTH,
  MAX_FEATURE_TITLE_LENGTH,
  MAX_PORTAL_ACTIVITY_ENTRIES,
  MAX_VISITOR_NAME_LENGTH,
  MAX_VISITOR_REMARK_LENGTH,
  PORTAL_ACCENTS,
  PORTAL_ACTIVITY_TYPES,
  PORTAL_VISITOR_ID_PATTERN,
  emptyPortalActivityDocument,
  emptyPortalSettingsDocument,
  normalizePortalActivityDocument,
  normalizePortalSettingsDocument,
};
