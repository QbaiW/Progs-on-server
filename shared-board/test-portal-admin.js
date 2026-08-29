const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStarBottleServer } = require("./server");

const TEST_PASSWORD = "PortalOwner!2048";

function bundledNotes() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "data", "notes.json"), "utf8"));
}

async function startFixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-board-portal-admin-"));
  const notes = bundledNotes();
  fs.writeFileSync(
    path.join(dataDir, "notes.json"),
    JSON.stringify({ ...notes, notes: notes.notes.slice(0, 1) }),
    "utf8",
  );
  if (options.portalActivity) {
    fs.writeFileSync(
      path.join(dataDir, "portal-activity.json"),
      JSON.stringify(options.portalActivity),
      "utf8",
    );
  }
  const server = createStarBottleServer({
    dataDir,
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
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    dataDir,
  };
}

async function requestJson(baseUrl, pathname, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.cookie) headers.Cookie = options.cookie;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
}

function responseCookie(headers, name) {
  const cookie = (headers.get("set-cookie") || "")
    .split(/,(?=[^;,]+=)/)
    .map((value) => value.trim().split(";")[0])
    .find((value) => value.startsWith(`${name}=`));
  return cookie || "";
}

function portalVisitorId(cookie) {
  assert.match(cookie, /^myuan_portal_visitor=portal_[A-Za-z0-9_-]+$/);
  return cookie.slice(cookie.indexOf("=") + 1);
}

async function login(baseUrl, cookie = "") {
  const result = await requestJson(baseUrl, "/api/owner/login", {
    method: "POST",
    cookie,
    body: { password: TEST_PASSWORD },
  });
  assert.equal(result.status, 200);
  const ownerCookie = responseCookie(result.headers, "star_bottle_owner");
  assert.match(ownerCookie, /^star_bottle_owner=/);
  return ownerCookie;
}

test("registered page requests create server-owned portal activity", async (t) => {
  const { baseUrl, dataDir } = await startFixture(t);

  const removedClientEndpoint = await requestJson(baseUrl, "/api/portal/activity", {
    method: "POST",
    body: { visitorId: "forged_visitor", type: "visit", path: "/home" },
  });
  assert.equal(removedClientEndpoint.status, 404);

  const home = await fetch(`${baseUrl}/home`);
  assert.equal(home.status, 200);
  const visitorCookie = responseCookie(home.headers, "myuan_portal_visitor");
  const visitorId = portalVisitorId(visitorCookie);

  const starBottle = await fetch(`${baseUrl}/star-bottle`, {
    headers: { Cookie: visitorCookie },
  });
  assert.equal(starBottle.status, 200);
  const directEntry = await fetch(`${baseUrl}/wrong/index.html`, {
    headers: { Cookie: visitorCookie },
  });
  assert.equal(directEntry.status, 200);

  assert.equal(fs.existsSync(path.join(dataDir, "portal-activity.json")), true);
  assert.equal(fs.existsSync(path.join(dataDir, "activity.json")), false);

  const unauthorized = await requestJson(baseUrl, "/api/owner/portal");
  assert.equal(unauthorized.status, 401);
  const ownerCookie = await login(baseUrl);
  const snapshot = await requestJson(baseUrl, "/api/owner/portal", { cookie: ownerCookie });
  assert.equal(snapshot.status, 200);
  assert.deepEqual(snapshot.body.activity.entries.map((entry) => [entry.type, entry.path]), [
    ["feature-open", "/wrong"],
    ["feature-open", "/star-bottle"],
    ["visit", "/home"],
  ]);
  const visitor = snapshot.body.visitors.find((candidate) => candidate.id === visitorId);
  assert.equal(visitor.visitCount, 1);
  assert.equal(visitor.featureOpenCount, 2);
});

test("owner can edit public presentation and visitor labels without changing routes", async (t) => {
  const { baseUrl } = await startFixture(t);
  const home = await fetch(`${baseUrl}/home`);
  const visitorCookie = responseCookie(home.headers, "myuan_portal_visitor");
  const visitorId = portalVisitorId(visitorCookie);
  const ownerCookie = await login(baseUrl);

  const forbiddenField = await requestJson(baseUrl, "/api/owner/portal/settings", {
    method: "PUT",
    cookie: ownerCookie,
    body: { features: { "star-bottle": { path: "/hijacked" } } },
  });
  assert.equal(forbiddenField.status, 400);

  const saved = await requestJson(baseUrl, "/api/owner/portal/settings", {
    method: "PUT",
    cookie: ownerCookie,
    body: {
      announcement: { enabled: true, text: "今晚有新内容。" },
      features: {
        "star-bottle": {
          title: "今晚的星星瓶",
          description: "打开看看新纸条。",
          featured: true,
          accent: "green",
        },
      },
    },
  });
  assert.equal(saved.status, 200);

  const catalog = await requestJson(baseUrl, "/api/features");
  assert.deepEqual(catalog.body.announcement, { enabled: true, text: "今晚有新内容。" });
  const starBottle = catalog.body.features.find((feature) => feature.id === "star-bottle");
  assert.equal(starBottle.title, "今晚的星星瓶");
  assert.equal(starBottle.description, "打开看看新纸条。");
  assert.equal(starBottle.featured, true);
  assert.equal(starBottle.accent, "green");
  assert.equal(starBottle.path, "/star-bottle");
  assert.equal("entry" in starBottle, false);
  assert.equal((await fetch(`${baseUrl}/star-bottle`, { headers: { Cookie: ownerCookie } })).status, 200);
  assert.equal((await fetch(`${baseUrl}/hijacked`)).status, 404);

  const label = await requestJson(baseUrl, `/api/owner/portal/visitors/${visitorId}`, {
    method: "PUT",
    cookie: ownerCookie,
    body: { name: "圆圆", remark: "手机浏览器" },
  });
  assert.equal(label.status, 200);
  assert.equal(label.body.visitor.name, "圆圆");
  assert.equal(label.body.visitor.remark, "手机浏览器");

  const snapshot = await requestJson(baseUrl, "/api/owner/portal", { cookie: ownerCookie });
  assert.equal(snapshot.body.visitors.find((visitor) => visitor.id === visitorId).name, "圆圆");
  assert.equal(snapshot.body.activity.entries.find((entry) => entry.visitorId === visitorId).visitorName, "圆圆");
  assert.deepEqual(snapshot.body.features.map((feature) => feature.id), [
    "star-bottle",
    "love-stars",
    "wrong",
  ]);
});

test("owner portal visitors are removed from anonymous activity", async (t) => {
  const { baseUrl, dataDir } = await startFixture(t);
  const home = await fetch(`${baseUrl}/home`);
  const visitorCookie = responseCookie(home.headers, "myuan_portal_visitor");
  const visitorId = portalVisitorId(visitorCookie);
  const ownerCookie = await login(baseUrl, visitorCookie);

  assert.equal((await fetch(`${baseUrl}/home`, {
    headers: { Cookie: `${visitorCookie}; ${ownerCookie}` },
  })).status, 200);
  assert.equal((await fetch(`${baseUrl}/star-bottle`, {
    headers: { Cookie: visitorCookie },
  })).status, 200);

  const snapshot = await requestJson(baseUrl, "/api/owner/portal", { cookie: ownerCookie });
  assert.equal(snapshot.body.visitors.some((visitor) => visitor.id === visitorId), false);
  assert.equal(snapshot.body.activity.entries.some((entry) => entry.visitorId === visitorId), false);
  const ownerDevices = JSON.parse(fs.readFileSync(path.join(dataDir, "owner-devices.json"), "utf8"));
  assert.equal(ownerDevices.devices.some((device) => device.id === visitorId), true);
});

test("removed feature history survives restart and later activity writes", async (t) => {
  const retiredAt = "2026-08-28T12:00:00.000Z";
  const retiredEvent = {
    id: "retired-event-1",
    visitorId: "portal_retired_visitor",
    type: "feature-open",
    featureId: "retired-feature",
    path: "/retired-feature",
    at: retiredAt,
  };
  const { baseUrl, dataDir } = await startFixture(t, {
    portalActivity: { version: 8, updatedAt: retiredAt, entries: [retiredEvent] },
  });
  const ownerCookie = await login(baseUrl);
  const before = await requestJson(baseUrl, "/api/owner/portal", { cookie: ownerCookie });
  assert.equal(before.body.activity.entries.some((entry) => entry.id === retiredEvent.id), true);

  await fetch(`${baseUrl}/home`);
  const after = await requestJson(baseUrl, "/api/owner/portal", { cookie: ownerCookie });
  assert.equal(after.body.activity.entries.some((entry) => entry.id === retiredEvent.id), true);
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, "portal-activity.json"), "utf8"));
  assert.equal(persisted.entries.some((entry) => entry.id === retiredEvent.id), true);
});

test("forwarded address spoofing does not bypass owner login throttling", async (t) => {
  const { baseUrl } = await startFixture(t);
  for (let index = 0; index < 10; index += 1) {
    const failed = await requestJson(baseUrl, "/api/owner/login", {
      method: "POST",
      headers: { "X-Forwarded-For": `198.51.100.${index + 1}, 203.0.113.10` },
      body: { password: "incorrect-password" },
    });
    assert.equal(failed.status, 401);
  }
  const limited = await requestJson(baseUrl, "/api/owner/login", {
    method: "POST",
    headers: { "X-Forwarded-For": "198.51.100.200, 203.0.113.10" },
    body: { password: "incorrect-password" },
  });
  assert.equal(limited.status, 429);

  const nginx = fs.readFileSync(path.join(__dirname, "nginx-star-bottle.conf.example"), "utf8");
  assert.match(nginx, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.match(nginx, /proxy_set_header CF-Connecting-IP "";/);
  const portalScript = fs.readFileSync(path.join(__dirname, "public", "portal", "home.js"), "utf8");
  assert.doesNotMatch(portalScript, /sessionStorage|ownerToken|\/api\/portal\/activity/);
});
