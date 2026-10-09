const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStarBottleServer } = require("./server");

const TEST_PASSWORD = "TestOwner!Password-2048";
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

function bundledNotes() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "data", "notes.json"), "utf8"));
}

async function startFixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-board-envelopes-"));
  const source = bundledNotes();
  fs.writeFileSync(
    path.join(dataDir, "notes.json"),
    JSON.stringify({ ...source, notes: source.notes.slice(0, 1) }),
    "utf8",
  );

  // Uploads land under public/envelopes/uploads, so the fixture serves a throwaway copy.
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-board-envelopes-public-"));
  fs.cpSync(path.join(__dirname, "public", "envelopes"), path.join(publicDir, "envelopes"), {
    recursive: true,
  });

  const server = createStarBottleServer({
    dataDir,
    publicDir,
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
    fs.rmSync(publicDir, { recursive: true, force: true });
  });

  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${address.port}`, dataDir, publicDir };
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

async function postImage(baseUrl, contentType, bytes) {
  const response = await fetch(`${baseUrl}/api/envelopes/image`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: bytes,
  });
  return { response, body: await response.json() };
}

test("Envelopes is registered and serves its page with isolated assets", async (t) => {
  const { baseUrl } = await startFixture(t);

  const features = await requestJson(baseUrl, "/api/features");
  const feature = features.body.features.find((item) => item.id === "envelopes");
  assert.ok(feature, "envelopes feature should be registered");
  assert.equal(feature.path, "/envelopes");
  assert.equal(feature.title, "信封记录");

  for (const pathname of ["/envelopes", "/envelopes/", "/envelopes/index.html"]) {
    const response = await fetch(`${baseUrl}${pathname}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/html/);
    const html = await response.text();
    assert.match(html, /href="\/envelopes\/styles\.css"/);
    assert.match(html, /src="\/envelopes\/app\.js"/);
    assert.match(html, /href="\/home"/);
  }

  const styles = await fetch(`${baseUrl}/envelopes/styles.css`);
  assert.equal(styles.status, 200);
  assert.match(styles.headers.get("content-type"), /^text\/css/);

  const script = await fetch(`${baseUrl}/envelopes/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);
});

test("Envelopes memos can be created, listed, edited and deleted", async (t) => {
  const { baseUrl, dataDir } = await startFixture(t);

  const empty = await requestJson(baseUrl, "/api/envelopes");
  assert.equal(empty.response.status, 200);
  assert.deepEqual(empty.body.memos, []);

  const created = await requestJson(baseUrl, "/api/envelopes", {
    method: "POST",
    body: {
      title: "  概率  ",
      blocks: [
        { type: "text", text: "全概率公式" },
        { type: "text", text: "# 大标题", format: "title" },
        { type: "text", text: "**粗体**列表", format: "md" },
        { type: "text", text: "格式不认识的段落", format: "bogus" },
        { type: "image", url: "/envelopes/uploads/whatever.png" },
        { type: "text", text: "   " },
        { type: "image", url: "https://example.com/evil.png" },
      ],
    },
  });
  assert.equal(created.response.status, 201);
  const memo = created.body.memo;
  assert.match(memo.id, /^[A-Za-z0-9_-]{6,40}$/);
  assert.equal(memo.title, "概率");
  assert.deepEqual(memo.blocks, [
    { type: "text", text: "全概率公式", format: "text" },
    { type: "text", text: "# 大标题", format: "title" },
    { type: "text", text: "**粗体**列表", format: "md" },
    { type: "text", text: "格式不认识的段落", format: "text" },
    { type: "image", url: "/envelopes/uploads/whatever.png" },
  ]);
  assert.equal(memo.createdAt, memo.updatedAt);

  const listed = await requestJson(baseUrl, "/api/envelopes");
  assert.equal(listed.body.memos.length, 1);
  assert.equal(listed.body.memos[0].id, memo.id);

  const badKey = await requestJson(baseUrl, "/api/envelopes", {
    method: "POST",
    body: { title: "x", blocks: [], nope: 1 },
  });
  assert.equal(badKey.response.status, 400);

  const badBlocks = await requestJson(baseUrl, "/api/envelopes", {
    method: "POST",
    body: { title: "x", blocks: "nope" },
  });
  assert.equal(badBlocks.response.status, 400);

  const updated = await requestJson(baseUrl, `/api/envelopes/${memo.id}`, {
    method: "PUT",
    body: { title: "   ", blocks: [{ type: "text", text: "改过了", format: "subtitle" }] },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.memo.title, "未命名信封");
  assert.deepEqual(updated.body.memo.blocks, [
    { type: "text", text: "改过了", format: "subtitle" },
  ]);
  assert.equal(updated.body.memo.createdAt, memo.createdAt);

  const persisted = JSON.parse(
    fs.readFileSync(path.join(dataDir, "envelopes.json"), "utf8"),
  );
  assert.equal(persisted.memos.length, 1);
  assert.equal(persisted.memos[0].blocks[0].text, "改过了");

  const missing = await requestJson(baseUrl, "/api/envelopes/aaaaaaaaaaaa", {
    method: "PUT",
    body: { title: "x", blocks: [] },
  });
  assert.equal(missing.response.status, 404);

  const wrongMethod = await requestJson(baseUrl, `/api/envelopes/${memo.id}`);
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.response.headers.get("allow"), "PUT, DELETE, OPTIONS");

  const removed = await requestJson(baseUrl, `/api/envelopes/${memo.id}`, {
    method: "DELETE",
  });
  assert.equal(removed.response.status, 200);
  const afterDelete = await requestJson(baseUrl, "/api/envelopes");
  assert.deepEqual(afterDelete.body.memos, []);

  const removedAgain = await requestJson(baseUrl, `/api/envelopes/${memo.id}`, {
    method: "DELETE",
  });
  assert.equal(removedAgain.response.status, 404);
});

test("Envelopes image uploads require real image bytes and land in uploads/", async (t) => {
  const { baseUrl, publicDir } = await startFixture(t);

  const badType = await postImage(baseUrl, "text/plain", Buffer.from("hello"));
  assert.equal(badType.response.status, 400);
  assert.match(badType.body.error, /只支持/);

  const badBytes = await postImage(baseUrl, "image/png", Buffer.from("not a png"));
  assert.equal(badBytes.response.status, 400);
  assert.match(badBytes.body.error, /不像是图片/);

  const wrongMethod = await requestJson(baseUrl, "/api/envelopes/image");
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.response.headers.get("allow"), "POST, OPTIONS");

  const uploaded = await postImage(baseUrl, "image/png", TINY_PNG);
  assert.equal(uploaded.response.status, 201);
  assert.match(uploaded.body.url, /^\/envelopes\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*\.png$/);

  const served = await fetch(`${baseUrl}${uploaded.body.url}`);
  assert.equal(served.status, 200);
  assert.match(served.headers.get("content-type"), /^image\/png/);
  assert.equal(
    fs.existsSync(path.join(publicDir, "envelopes", "uploads", path.basename(uploaded.body.url))),
    true,
  );
});
