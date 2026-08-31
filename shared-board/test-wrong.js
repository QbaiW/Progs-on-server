const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStarBottleServer } = require("./server");

const TEST_PASSWORD = "TestOwner!Password-2048";

function bundledNotes() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "data", "notes.json"), "utf8"));
}

async function startFixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-board-wrong-"));
  const source = bundledNotes();
  fs.writeFileSync(
    path.join(dataDir, "notes.json"),
    JSON.stringify({ ...source, notes: source.notes.slice(0, 1) }),
    "utf8",
  );

  const server = createStarBottleServer({
    dataDir,
    ownerPassword: TEST_PASSWORD,
    disableSiteAuth: true,
    watch: false,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${address.port}`, dataDir };
}

async function requestJson(baseUrl, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, body: await response.json() };
}

test("Wrong is registered and serves isolated static assets", async (t) => {
  const { baseUrl } = await startFixture(t);

  for (const pathname of ["/wrong", "/wrong/", "/wrong/index.html"]) {
    const response = await fetch(`${baseUrl}${pathname}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/html/);
    const html = await response.text();
    assert.match(html, /href="\/wrong\/styles\.css"/);
    assert.match(html, /src="\/wrong\/vendor\/matter\.min\.js"/);
    assert.match(html, /src="\/wrong\/script\.js"/);
    assert.match(html, /href="\/home"/);
  }

  const phrases = await fetch(`${baseUrl}/wrong/phrases.txt`);
  assert.equal(phrases.status, 200);
  assert.match(phrases.headers.get("content-type"), /^text\/plain/);
  assert.match(await phrases.text(), /对不起/);

  const matter = await fetch(`${baseUrl}/wrong/vendor/matter.min.js`);
  assert.equal(matter.status, 200);
  assert.match(matter.headers.get("content-type"), /^text\/javascript/);
  assert.match(await matter.text(), /Matter/);

  for (const asset of ["white-bear.png", "yellow-dog.png", "red-hammer.png"]) {
    const response = await fetch(`${baseUrl}/wrong/assets/${asset}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^image\/png/);
  }

  const catalog = await requestJson(baseUrl, "/api/features");
  assert.equal(catalog.response.status, 200);
  const wrong = catalog.body.features.find((feature) => feature.id === "wrong");
  assert.deepEqual(
    { path: wrong.path, title: wrong.title, entry: "entry" in wrong },
    { path: "/wrong", title: "严格教育现场", entry: false },
  );
});

test("Wrong hit and stats APIs use an independent counter file", async (t) => {
  const { baseUrl, dataDir } = await startFixture(t);

  const unauthorized = await requestJson(baseUrl, "/api/wrong/stats");
  assert.equal(unauthorized.response.status, 401);
  assert.equal(unauthorized.body.ok, false);

  const wrongPassword = await requestJson(baseUrl, "/api/wrong/stats", {
    headers: { "X-Admin-Password": "not-the-password" },
  });
  assert.equal(wrongPassword.response.status, 401);

  const initial = await requestJson(baseUrl, "/api/wrong/stats", {
    headers: { "X-Admin-Password": TEST_PASSWORD },
  });
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.ok, true);
  assert.equal(initial.body.totalHits, 0);
  assert.equal(initial.body.visitorCount, 0);
  assert.deepEqual(initial.body.hitHistory, []);

  const options = await requestJson(baseUrl, "/api/wrong/hit", { method: "OPTIONS" });
  assert.equal(options.response.status, 200);

  const invalid = await requestJson(baseUrl, "/api/wrong/hit", {
    method: "POST",
    body: { visitorId: "bad" },
  });
  assert.equal(invalid.response.status, 400);

  const first = await requestJson(baseUrl, "/api/wrong/hit", {
    method: "POST",
    body: { visitorId: "wrong-test-visitor" },
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.visitorId, "wrong-test-visitor");
  assert.equal(first.body.visitorHits, 1);
  assert.equal(first.body.totalHits, 1);
  assert.match(first.response.headers.get("set-cookie") || "", /qe_visitor=wrong-test-visitor/);

  const second = await requestJson(baseUrl, "/api/wrong/hit", {
    method: "POST",
    headers: { "X-Visitor-Id": "another-test-visitor" },
  });
  assert.equal(second.response.status, 200);
  assert.equal(second.body.visitorId, "another-test-visitor");
  assert.equal(second.body.total, 2);

  const third = await requestJson(baseUrl, "/api/wrong/hit/", {
    method: "POST",
    headers: { Cookie: "qe_visitor=wrong-test-visitor" },
  });
  assert.equal(third.response.status, 200);
  assert.equal(third.body.visitorHits, 2);
  assert.equal(third.body.totalHits, 3);

  const stats = await requestJson(baseUrl, "/api/wrong/stats/", {
    headers: { Authorization: `Bearer ${TEST_PASSWORD}` },
  });
  assert.equal(stats.response.status, 200);
  assert.equal(stats.body.totalHits, 3);
  assert.equal(stats.body.total, 3);
  assert.equal(stats.body.visitorCount, 2);
  assert.deepEqual(
    stats.body.visitors.map((visitor) => [visitor.id, visitor.hits]),
    [["wrong-test-visitor", 2], ["another-test-visitor", 1]],
  );
  assert.equal(stats.body.hitHistory.length, 3);
  assert.deepEqual(stats.body.hitHistory, stats.body.recentHits);
  assert.equal(stats.body.historyTruncated, false);

  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "wrong-counter.json"), "utf8"));
  assert.equal(stored.totalHits, 3);
  assert.equal(stored.visitors["wrong-test-visitor"], 2);
  assert.equal(fs.existsSync(path.join(dataDir, "state.json")), false);

  const notes = await requestJson(baseUrl, "/api/notes");
  assert.equal(notes.response.status, 200);
  assert.equal(notes.body.notes.length, 1);
  assert.equal((await fetch(`${baseUrl}/api/hit`)).status, 404);

  const wrongMethod = await requestJson(baseUrl, "/api/wrong/hit", { method: "PUT" });
  assert.equal(wrongMethod.response.status, 405);
  const statsMethod = await requestJson(baseUrl, "/api/wrong/stats", { method: "POST", body: {} });
  assert.equal(statsMethod.response.status, 405);
});
