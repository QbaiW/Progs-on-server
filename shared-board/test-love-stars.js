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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-board-love-stars-"));
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
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    dataDir,
  };
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: options.body === undefined ? options.headers : {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, body: await response.json() };
}

test("love-stars is registered and serves both canonical route forms", async (t) => {
  const { baseUrl } = await startFixture(t);

  for (const pathname of ["/love-stars", "/love-stars/"]) {
    const response = await fetch(`${baseUrl}${pathname}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/html/);
    const html = await response.text();
    assert.match(html, /href="\/love-stars\/style\.css"/);
    assert.match(html, /src="\/love-stars\/main\.js"/);
    assert.match(html, /href="\/home"/);
  }

  const stylesheet = await fetch(`${baseUrl}/love-stars/style.css`);
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get("content-type"), /^text\/css/);
  const script = await fetch(`${baseUrl}/love-stars/main.js`);
  assert.equal(script.status, 200);
  assert.match(await script.text(), /\/api\/love-stars\/message/);

  const messageHead = await fetch(`${baseUrl}/api/love-stars/message`, { method: "HEAD" });
  assert.equal(messageHead.status, 200);
  assert.match(messageHead.headers.get("content-type"), /^application\/json/);

  const catalog = await requestJson(baseUrl, "/api/features");
  assert.equal(catalog.response.status, 200);
  const feature = catalog.body.features.find((candidate) => candidate.id === "love-stars");
  assert.equal(feature.path, "/love-stars");
  assert.equal("entry" in feature, false);
});

test("love-stars messages use an isolated API and data file", async (t) => {
  const { baseUrl, dataDir } = await startFixture(t);

  const initial = await requestJson(baseUrl, "/api/love-stars/message");
  assert.equal(initial.response.status, 200);
  assert.deepEqual(initial.body, { messages: [] });

  const optionsResponse = await fetch(`${baseUrl}/api/love-stars/message/`, { method: "OPTIONS" });
  assert.equal(optionsResponse.status, 200);
  assert.match(optionsResponse.headers.get("allow") || "", /POST/);

  const empty = await requestJson(baseUrl, "/api/love-stars/message", {
    method: "POST",
    body: { content: "   " },
  });
  assert.equal(empty.response.status, 400);
  assert.equal(empty.body.success, false);

  const tooLong = await requestJson(baseUrl, "/api/love-stars/message", {
    method: "POST",
    body: { content: "星".repeat(201) },
  });
  assert.equal(tooLong.response.status, 400);

  const saved = await requestJson(baseUrl, "/api/love-stars/message", {
    method: "POST",
    body: { content: "  独立的七夕留言  " },
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.success, true);
  assert.equal(Number.isSafeInteger(saved.body.id), true);

  const rateLimited = await requestJson(baseUrl, "/api/love-stars/message/", {
    method: "POST",
    body: { content: "第二条太快的留言" },
  });
  assert.equal(rateLimited.response.status, 429);

  const refreshed = await requestJson(baseUrl, "/api/love-stars/message/");
  assert.equal(refreshed.response.status, 200);
  assert.equal(refreshed.body.messages.length, 1);
  assert.equal(refreshed.body.messages[0].content, "独立的七夕留言");

  const stored = JSON.parse(
    fs.readFileSync(path.join(dataDir, "love-stars-messages.json"), "utf8"),
  );
  assert.equal(stored.messages.length, 1);
  assert.equal(stored.messages[0].content, "独立的七夕留言");

  const notes = await requestJson(baseUrl, "/api/notes");
  assert.equal(notes.response.status, 200);
  assert.equal(notes.body.notes.length, 1);
  const favorites = await requestJson(baseUrl, "/api/favorites");
  assert.equal(favorites.response.status, 200);
  assert.deepEqual(favorites.body.noteIds, []);
  assert.equal((await fetch(`${baseUrl}/api/message`)).status, 404);
});
