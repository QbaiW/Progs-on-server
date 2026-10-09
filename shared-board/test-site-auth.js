const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStarBottleServer } = require("./server");

const SITE_USERNAME = "Yuna";
const SITE_PASSWORD = "TestSite!Password-2048";
const OWNER_USERNAME = "QbaiW";
const OWNER_PASSWORD = "TestOwner!Password-4096";

function bundledNotes() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "data", "notes.json"), "utf8"));
}

async function startFixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "star-bottle-site-auth-"));
  const source = bundledNotes();
  fs.writeFileSync(
    path.join(dataDir, "notes.json"),
    JSON.stringify({ ...source, notes: source.notes.slice(0, 2) }),
    "utf8",
  );

  const server = createStarBottleServer({
    dataDir,
    ownerUsername: OWNER_USERNAME,
    ownerPassword: OWNER_PASSWORD,
    siteUsername: SITE_USERNAME,
    sitePassword: SITE_PASSWORD,
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
  return `http://127.0.0.1:${server.address().port}`;
}

async function requestJson(baseUrl, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.cookie) headers.Cookie = options.cookie;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: options.redirect || "manual",
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON page/asset */ }
  return { response, text, body };
}

function cookieFrom(response) {
  const value = response.headers.get("set-cookie") || "";
  return value.split(";", 1)[0];
}

test("site gate blocks pages, direct assets, and business APIs before login", async (t) => {
  const baseUrl = await startFixture(t);

  const page = await requestJson(baseUrl, "/home?from=private");
  assert.equal(page.response.status, 302);
  assert.match(page.response.headers.get("location") || "", /^\/login\?return=/);
  assert.equal(page.response.headers.get("set-cookie"), null);

  for (const pathname of ["/index.html", "/portal/home.html", "/styles.css", "/love-stars/main.js", "/wrong/assets/white-bear.png"]) {
    const blocked = await requestJson(baseUrl, pathname);
    assert.equal(blocked.response.status, 302, pathname);
    assert.match(blocked.response.headers.get("location") || "", /^\/login\?return=/, pathname);
  }

  const api = await requestJson(baseUrl, "/api/notes");
  assert.equal(api.response.status, 401);
  assert.equal(api.response.headers.get("content-type").startsWith("application/json"), true);
  assert.equal(api.body.code, "SITE_LOGIN_REQUIRED");

  for (const pathname of ["/login", "/login.html", "/login.css", "/login.js"]) {
    const asset = await requestJson(baseUrl, pathname);
    assert.equal(asset.response.status, 200, pathname);
  }

  const status = await requestJson(baseUrl, "/api/site/status");
  assert.deepEqual(status.body, { authenticated: false });
});

test("site login requires both credentials and unlocks every registered feature", async (t) => {
  const baseUrl = await startFixture(t);

  const malformed = await requestJson(baseUrl, "/api/site/login", {
    method: "POST",
    body: { username: SITE_USERNAME },
  });
  assert.equal(malformed.response.status, 401);
  assert.equal(cookieFrom(malformed.response), "");

  const wrongAccount = await requestJson(baseUrl, "/api/site/login", {
    method: "POST",
    body: { username: "qbaiw", password: SITE_PASSWORD },
  });
  assert.equal(wrongAccount.response.status, 401);

  const login = await requestJson(baseUrl, "/api/site/login", {
    method: "POST",
    body: { username: SITE_USERNAME, password: SITE_PASSWORD },
  });
  assert.equal(login.response.status, 200);
  assert.deepEqual(login.body.authenticated, true);
  const cookieHeader = login.response.headers.get("set-cookie") || "";
  assert.match(cookieHeader, /star_bottle_access=[A-Za-z0-9_-]{32,128}/);
  assert.match(cookieHeader, /Path=\//i);
  assert.match(cookieHeader, /HttpOnly/i);
  assert.match(cookieHeader, /SameSite=Strict/i);
  const cookie = cookieFrom(login.response);
  assert.match(cookie, /^star_bottle_access=/);

  for (const pathname of ["/home", "/star-bottle", "/love-stars", "/wrong", "/api/features", "/api/notes", "/api/music"]) {
    const allowed = await requestJson(baseUrl, pathname, { cookie });
    assert.equal(allowed.response.status, 200, pathname);
  }

  const authenticatedPage = await requestJson(baseUrl, "/home", { cookie });
  assert.equal(authenticatedPage.response.headers.get("cache-control"), "private, no-store");
  assert.equal(authenticatedPage.response.headers.get("vary"), "Cookie");
  const authenticatedAsset = await requestJson(baseUrl, "/styles.css", { cookie });
  assert.equal(authenticatedAsset.response.headers.get("cache-control"), "private, max-age=3600");
  assert.equal(authenticatedAsset.response.headers.get("vary"), "Cookie");

  const status = await requestJson(baseUrl, "/api/auth/status", { cookie });
  assert.deepEqual(status.body, { authenticated: true });

  const eventController = new AbortController();
  try {
    const eventResponse = await fetch(`${baseUrl}/api/events`, {
      headers: { Cookie: cookie },
      signal: eventController.signal,
    });
    assert.equal(eventResponse.status, 200);
    assert.equal(eventResponse.headers.get("cache-control"), "private, no-store, no-transform");
    assert.equal(eventResponse.headers.get("vary"), "Cookie");
    const eventReader = eventResponse.body.getReader();
    const firstEvent = await eventReader.read();
    assert.equal(firstEvent.done, false);

    const logout = await requestJson(baseUrl, "/api/auth/logout", { method: "POST", cookie });
    assert.equal(logout.response.status, 200);
    assert.match(logout.response.headers.get("set-cookie") || "", /star_bottle_access=;/);

    let eventStreamClosed = false;
    for (let chunk = 0; chunk < 10 && !eventStreamClosed; chunk += 1) {
      const nextEvent = await Promise.race([
        eventReader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("SSE did not close after logout")), 1000)),
      ]);
      eventStreamClosed = nextEvent.done;
    }
    assert.equal(eventStreamClosed, true);
  } finally {
    eventController.abort();
  }

  const afterLogout = await requestJson(baseUrl, "/api/notes", { cookie });
  assert.equal(afterLogout.response.status, 401);
});

test("管理员会话拥有用户级的全部权限，用户会话进不了管理面", async (t) => {
  const baseUrl = await startFixture(t);
  const ownerLogin = await requestJson(baseUrl, "/api/owner/login", {
    method: "POST",
    body: { username: OWNER_USERNAME, password: OWNER_PASSWORD },
  });
  assert.equal(ownerLogin.response.status, 200);
  const ownerCookie = cookieFrom(ownerLogin.response);
  assert.match(ownerCookie, /^star_bottle_owner=/);

  // 管理员 = 用户级功能 + 管理面：站点门直接放行，不需要另外的 site 会话。
  for (const pathname of ["/home", "/star-bottle", "/api/notes", "/api/features"]) {
    const allowed = await requestJson(baseUrl, pathname, { cookie: ownerCookie });
    assert.equal(allowed.response.status, 200, pathname);
  }
  const ownerPortal = await requestJson(baseUrl, "/api/owner/portal", { cookie: ownerCookie });
  assert.equal(ownerPortal.response.status, 200);
  const siteStatus = await requestJson(baseUrl, "/api/site/status", { cookie: ownerCookie });
  assert.deepEqual(siteStatus.body, { authenticated: true });

  // 反过来不成立：用户级会话只是用户级。
  const siteLogin = await requestJson(baseUrl, "/api/site/login", {
    method: "POST",
    body: { username: SITE_USERNAME, password: SITE_PASSWORD },
  });
  assert.equal(siteLogin.response.status, 200);
  assert.equal(siteLogin.body.owner, false);
  const siteCookie = cookieFrom(siteLogin.response);
  assert.match(siteCookie, /^star_bottle_access=/);
  assert.equal((await requestJson(baseUrl, "/api/owner/status", { cookie: siteCookie })).body.authenticated, false);
  assert.equal((await requestJson(baseUrl, "/api/owner/portal", { cookie: siteCookie })).response.status, 401);
});

test("用管理员账号走站点登录时顺带建立管理会话", async (t) => {
  const baseUrl = await startFixture(t);
  const login = await requestJson(baseUrl, "/api/site/login", {
    method: "POST",
    body: { username: OWNER_USERNAME, password: OWNER_PASSWORD },
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.body.authenticated, true);
  assert.equal(login.body.owner, true);
  const cookies = login.response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.match(cookies[0], /^star_bottle_access=/);
  assert.match(cookies[1], /^star_bottle_owner=/);

  const cookieHeader = cookies.map((value) => value.split(";", 1)[0]).join("; ");
  assert.equal((await requestJson(baseUrl, "/api/owner/status", { cookie: cookieHeader })).body.authenticated, true);
  assert.equal((await requestJson(baseUrl, "/api/owner/portal", { cookie: cookieHeader })).response.status, 200);
  assert.equal((await requestJson(baseUrl, "/api/notes", { cookie: cookieHeader })).response.status, 200);

  // 退出登录要把管理身份一起清掉，否则 owner 会话仍然能访问站点。
  const logout = await requestJson(baseUrl, "/api/site/logout", { method: "POST", cookie: cookieHeader });
  assert.equal(logout.response.status, 200);
  const cleared = logout.response.headers.getSetCookie();
  assert.match(cleared.find((value) => value.startsWith("star_bottle_owner=")) || "", /star_bottle_owner=;/);
  assert.equal((await requestJson(baseUrl, "/api/owner/status", { cookie: cookieHeader })).body.authenticated, false);
  assert.equal((await requestJson(baseUrl, "/home", { cookie: cookieHeader })).response.status, 302);
});

test("owner APIs are reachable with an owner session alone (no site login)", async (t) => {
  const baseUrl = await startFixture(t);
  const ownerLogin = await requestJson(baseUrl, "/api/owner/login", {
    method: "POST",
    body: { username: OWNER_USERNAME, password: OWNER_PASSWORD },
  });
  assert.equal(ownerLogin.response.status, 200);
  const ownerCookie = cookieFrom(ownerLogin.response);

  // Owner APIs are protected by the owner session, not the visitor/site gate, so
  // an expired site session cannot loop the owner login dialog forever.
  const portal = await requestJson(baseUrl, "/api/owner/portal", { cookie: ownerCookie });
  assert.equal(portal.response.status, 200);
  const creds = await requestJson(baseUrl, "/api/owner/portal/credentials", { cookie: ownerCookie });
  assert.equal(creds.response.status, 200);
});

test("a credential change only logs out the role that changed", async (t) => {
  const baseUrl = await startFixture(t);
  const ownerLogin = await requestJson(baseUrl, "/api/owner/login", {
    method: "POST",
    body: { username: OWNER_USERNAME, password: OWNER_PASSWORD },
  });
  assert.equal(ownerLogin.response.status, 200);
  const ownerCookie = cookieFrom(ownerLogin.response);

  // Change only the user creds; the owner session must stay valid.
  const saved = await requestJson(baseUrl, "/api/owner/portal/credentials", {
    method: "PUT",
    cookie: ownerCookie,
    body: { siteUsername: "Yuna", sitePassword: "NewVisitorPass9" },
  });
  assert.equal(saved.response.status, 200);
  const portalAfter = await requestJson(baseUrl, "/api/owner/portal", { cookie: ownerCookie });
  assert.equal(portalAfter.response.status, 200);
});

test("site login does not reset owner login throttling", async (t) => {
  const baseUrl = await startFixture(t);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const ownerLogin = await requestJson(baseUrl, "/api/owner/login", {
      method: "POST",
      body: { username: OWNER_USERNAME, password: `wrong-owner-password-${attempt}` },
    });
    assert.equal(ownerLogin.response.status, 401);
  }

  const siteLogin = await requestJson(baseUrl, "/api/site/login", {
    method: "POST",
    body: { username: SITE_USERNAME, password: SITE_PASSWORD },
  });
  assert.equal(siteLogin.response.status, 200);

  const throttledOwnerLogin = await requestJson(baseUrl, "/api/owner/login", {
    method: "POST",
    body: { username: OWNER_USERNAME, password: OWNER_PASSWORD },
  });
  assert.equal(throttledOwnerLogin.response.status, 429);
});
