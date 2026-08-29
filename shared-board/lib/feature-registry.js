"use strict";

const FEATURE_DEFINITIONS = require("../config/features");

const PUBLIC_FIELDS = Object.freeze([
  "id",
  "title",
  "description",
  "icon",
  "path",
  "order",
  "enabled",
]);

const FEATURE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FEATURE_PATH_PATTERN = /^\/[a-z0-9]+(?:[\/-][a-z0-9]+)*$/;
const RESERVED_PATH_PREFIXES = Object.freeze([
  "/api",
  "/features",
  "/home",
  "/music",
  "/pet",
  "/portal",
  "/shared",
  "/vendor",
]);

function fail(message) {
  throw new TypeError(`Invalid feature registry: ${message}`);
}

function normalizeFeaturePath(value, label = "path") {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required`);
  let pathname = value.trim();
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  pathname = pathname.replace(/\/{2,}/g, "/");
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  if (!FEATURE_PATH_PATTERN.test(pathname) || pathname.includes("..")) {
    fail(`${label} must be a safe URL path`);
  }
  if (RESERVED_PATH_PREFIXES.some((prefix) =>
    pathname === prefix || pathname.startsWith(`${prefix}/`),
  )) {
    fail(`${label} uses a reserved URL path`);
  }
  return pathname;
}

function normalizeEntry(value) {
  if (typeof value !== "string" || !value.trim()) fail("entry is required");
  let entry = value.trim();
  if (!entry.startsWith("/")) entry = `/${entry}`;
  entry = entry.replace(/\/{2,}/g, "/");
  if (
    entry.includes("\\") ||
    entry.includes("\0") ||
    entry.includes("?") ||
    entry.includes("#") ||
    entry.includes("%") ||
    entry.split("/").some((segment) => segment === "." || segment === "..") ||
    !entry.toLowerCase().endsWith(".html")
  ) {
    fail("entry must point to an HTML file inside public");
  }
  return entry;
}

function normalizeFeature(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`feature ${index + 1} must be an object`);
  }

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!FEATURE_ID_PATTERN.test(id)) fail(`feature ${index + 1} has an invalid id`);

  const path = normalizeFeaturePath(raw.path, `feature ${id} path`);
  const entry = normalizeEntry(raw.entry);
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  const icon = typeof raw.icon === "string" ? raw.icon.trim() : "";
  if (!title || title.length > 120) fail(`feature ${id} has an invalid title`);
  if (description.length > 500) fail(`feature ${id} has an invalid description`);
  if (icon.length > 32) fail(`feature ${id} has an invalid icon`);

  const order = Number.isSafeInteger(raw.order) ? raw.order : 1000 + index;
  if (order < 0 || order > 1_000_000) fail(`feature ${id} has an invalid order`);

  return Object.freeze({
    id,
    title,
    description,
    icon,
    path,
    entry,
    order,
    enabled: raw.enabled !== false,
  });
}

function createFeatureRegistry(features = FEATURE_DEFINITIONS) {
  if (!Array.isArray(features)) fail("registry must be an array");
  const normalized = features.map(normalizeFeature);
  const ids = new Set();
  const paths = new Set();
  const entries = new Set();

  for (const feature of normalized) {
    if (ids.has(feature.id)) fail(`duplicate id ${feature.id}`);
    if (paths.has(feature.path)) fail(`duplicate path ${feature.path}`);
    if (entries.has(feature.entry)) fail(`duplicate entry ${feature.entry}`);
    ids.add(feature.id);
    paths.add(feature.path);
    entries.add(feature.entry);
  }

  return Object.freeze(normalized.slice().sort((left, right) =>
    left.order - right.order || left.id.localeCompare(right.id),
  ));
}

const FEATURE_REGISTRY = createFeatureRegistry();

function publicFeature(feature) {
  const result = {};
  for (const field of PUBLIC_FIELDS) result[field] = feature[field];
  return Object.freeze(result);
}

function listPublicFeatures(registry = FEATURE_REGISTRY) {
  return createFeatureRegistry(registry)
    .filter((feature) => feature.enabled)
    .map(publicFeature);
}

function featureForPath(pathname, registry = FEATURE_REGISTRY) {
  if (typeof pathname !== "string") return null;
  const normalized = pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
  return createFeatureRegistry(registry).find((feature) =>
    feature.enabled && feature.path === normalized,
  ) || null;
}

module.exports = {
  FEATURE_REGISTRY,
  PUBLIC_FIELDS,
  RESERVED_PATH_PREFIXES,
  createFeatureRegistry,
  featureForPath,
  listPublicFeatures,
};
