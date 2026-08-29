const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  FEATURE_REGISTRY,
  createFeatureRegistry,
  featureForPath,
  listPublicFeatures,
} = require("./lib/feature-registry");
const { createStarBottleServer } = require("./server");

const TEST_PASSWORD = "TestOwner!Password-2048";

function bundledNotes() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "data", "notes.json"), "utf8"));
}

async function startFixture(t, options = {}) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "star-bottle-portal-"));
  const publicDirectory = path.join(temporaryDirectory, "public");
  fs.mkdirSync(publicDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(temporaryDirectory, "notes.json"),
    JSON.stringify({ ...bundledNotes(), notes: bundledNotes().notes.slice(0, 1) }),
    "utf8",
  );
  fs.mkdirSync(path.join(publicDirectory, "portal"), { recursive: true });
  fs.writeFileSync(path.join(publicDirectory, "portal", "home.html"), "HOME PAGE", "utf8");
  fs.writeFileSync(path.join(publicDirectory, "index.html"), "STAR BOTTLE PAGE", "utf8");
  if (options.demo) fs.writeFileSync(path.join(publicDirectory, "demo.html"), "DEMO PAGE", "utf8");
  if (options.disabled) fs.writeFileSync(path.join(publicDirectory, "disabled-demo.html"), "DISABLED PAGE", "utf8");

  const server = createStarBottleServer({
    dataDir: temporaryDirectory,
    publicDir: publicDirectory,
    ownerPassword: TEST_PASSWORD,
    watch: false,
    featureRegistry: options.featureRegistry,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("feature registry validates routes and exposes only public metadata", () => {
  assert.equal(featureForPath("/star-bottle/")?.id, "star-bottle");
  assert.equal(featureForPath("/missing"), null);
  const publicFeatures = listPublicFeatures();
  assert.deepEqual(Object.keys(publicFeatures[0]).sort(), [
    "description",
    "enabled",
    "icon",
    "id",
    "order",
    "path",
    "title",
  ]);
  assert.equal("entry" in publicFeatures[0], false);
  assert.throws(
    () => createFeatureRegistry([{ ...FEATURE_REGISTRY[0], path: "/../private", id: "private" }]),
    /safe URL path/,
  );
  assert.throws(
    () => createFeatureRegistry([{ ...FEATURE_REGISTRY[0], path: "/api/demo", id: "api-demo" }]),
    /reserved URL path/,
  );
  assert.throws(
    () => createFeatureRegistry([FEATURE_REGISTRY[0], { ...FEATURE_REGISTRY[0] }]),
    /duplicate id/,
  );
  assert.throws(
    () => createFeatureRegistry([
      FEATURE_REGISTRY[0],
      { ...FEATURE_REGISTRY[0], id: "another-feature", path: "/another-feature" },
    ]),
    /duplicate entry/,
  );
  assert.throws(
    () => createFeatureRegistry([
      { ...FEATURE_REGISTRY[0], id: "first-feature", path: "/first-feature", entry: "/nested//first.html" },
      { ...FEATURE_REGISTRY[0], id: "second-feature", path: "/second-feature", entry: "/nested/first.html" },
    ]),
    /duplicate entry/,
  );
});

test("portal and legacy feature routes are served through the registry", async (t) => {
  const baseUrl = await startFixture(t);

  const home = await fetch(`${baseUrl}/home`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type"), /^text\/html/);
  assert.equal(await home.text(), "HOME PAGE");

  const homeSlash = await fetch(`${baseUrl}/home/`);
  assert.equal(homeSlash.status, 200);
  assert.equal(await homeSlash.text(), "HOME PAGE");

  const starBottle = await fetch(`${baseUrl}/star-bottle`);
  assert.equal(starBottle.status, 200);
  assert.equal(await starBottle.text(), "STAR BOTTLE PAGE");

  const starBottleSlash = await fetch(`${baseUrl}/star-bottle/`);
  assert.equal(starBottleSlash.status, 200);
  assert.equal(await starBottleSlash.text(), "STAR BOTTLE PAGE");

  const root = await fetch(`${baseUrl}/`, { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/home");

  const legacy = await fetch(`${baseUrl}/index.html`);
  assert.equal(legacy.status, 200);
  assert.equal(await legacy.text(), "STAR BOTTLE PAGE");

  const registry = await fetch(`${baseUrl}/api/features`);
  assert.equal(registry.status, 200);
  const payload = await registry.json();
  assert.equal(payload.version, 1);
  assert.deepEqual(payload.features.map((feature) => feature.id), ["star-bottle", "love-stars", "wrong"]);
  assert.equal(payload.features[0].path, "/star-bottle");
  assert.equal("entry" in payload.features[0], false);

  const registrySlash = await fetch(`${baseUrl}/api/features/`);
  assert.equal(registrySlash.status, 200);
  assert.deepEqual((await registrySlash.json()).features.map((feature) => feature.id), [
    "star-bottle",
    "love-stars",
    "wrong",
  ]);

  const registryHead = await fetch(`${baseUrl}/api/features`, { method: "HEAD" });
  assert.equal(registryHead.status, 200);
  assert.equal(await registryHead.text(), "");

  const registryOptions = await fetch(`${baseUrl}/api/features`, { method: "OPTIONS" });
  assert.equal(registryOptions.status, 200);
  assert.match(registryOptions.headers.get("allow") || "", /GET/);

  const missing = await fetch(`${baseUrl}/does-not-exist`);
  assert.equal(missing.status, 404);
});

test("a new registered extensionless route needs no server route branch", async (t) => {
  const demo = {
    id: "demo",
    title: "Demo",
    description: "Demo feature",
    icon: "D",
    path: "/demo",
    entry: "/demo.html",
    order: 20,
    enabled: true,
  };
  const baseUrl = await startFixture(t, {
    demo: true,
    featureRegistry: [...FEATURE_REGISTRY, demo],
  });

  const page = await fetch(`${baseUrl}/demo`);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "DEMO PAGE");

  const registry = await fetch(`${baseUrl}/api/features`);
  const payload = await registry.json();
  assert.deepEqual(payload.features.map((feature) => feature.id), ["star-bottle", "demo", "love-stars", "wrong"]);
});

test("disabled features are hidden and their registered entry is not directly reachable", async (t) => {
  const disabled = {
    id: "disabled-demo",
    title: "Disabled demo",
    description: "Hidden feature",
    icon: "D",
    path: "/disabled-demo",
    entry: "/disabled-demo.html",
    order: 20,
    enabled: false,
  };
  const baseUrl = await startFixture(t, {
    disabled: true,
    featureRegistry: [...FEATURE_REGISTRY, disabled],
  });

  assert.equal((await fetch(`${baseUrl}/disabled-demo`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/disabled-demo.html`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/disabled-demo%2F..%2Fdisabled-demo.html`)).status, 404);
  const payload = await (await fetch(`${baseUrl}/api/features`)).json();
  assert.deepEqual(payload.features.map((feature) => feature.id), ["star-bottle", "love-stars", "wrong"]);
});
