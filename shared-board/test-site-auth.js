const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStarBottleServer } = require("./server");

const SITE_USERNAME = "QbaiW";
const SITE_PASSWORD = "TestSite!Password-2048";

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
    ownerPassword: SITE_PASSWORD,
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

test("owner session does not bypass the site account gate", async (t) => {
  const baseUrl = await startFixture(t);
  const ownerLogin = await requestJson(baseUrl, "/api/owner/login", {
    method: "POST",
    body: { password: SITE_PASSWORD },
  });
  assert.equal(ownerLogin.response.status, 200);
  const ownerCookie = cookieFrom(ownerLogin.response);
  assert.match(ownerCookie, /^star_bottle_owner=/);

  const page = await requestJson(baseUrl, "/home", { cookie: ownerCookie });
  assert.equal(page.response.status, 302);
  const api = await requestJson(baseUrl, "/api/notes", { cookie: ownerCookie });
  assert.equal(api.response.status, 401);
});

test("site login does not reset owner login throttling", async (t) => {
  const baseUrl = await startFixture(t);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const ownerLogin = await requestJson(baseUrl, "/api/owner/login", {
      method: "POST",
      body: { password: `wrong-owner-password-${attempt}` },
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
    body: { password: SITE_PASSWORD },
  });
  assert.equal(throttledOwnerLogin.response.status, 429);
});
