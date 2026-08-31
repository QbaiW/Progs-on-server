const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStarBottleServer } = require("./server");

const PROJECT_DIR = __dirname;
const TEST_PASSWORD = "TestOwner!Password-2048";

function bundledNotes() {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, "data", "notes.json"), "utf8"));
}

function requestJson(baseUrl, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.cookie) headers.Cookie = options.cookie;
  return fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }).then(async (response) => ({
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  }));
}

test("bundled note data contains 400 notes split evenly across four emotions", () => {
  const document = bundledNotes();
  assert.equal(document.notes.length, 400);
  const counts = document.notes.reduce((result, note) => {
    result[note.emotion] = (result[note.emotion] || 0) + 1;
    return result;
  }, {});
  assert.deepEqual(counts, { joy: 100, anger: 100, anxiety: 100, sadness: 100 });
  assert.equal(new Set(document.notes.map((note) => note.id)).size, 400);
});

test("background music endpoint lists only supported files", async (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "star-bottle-music-"));
  const publicDirectory = path.join(temporaryDirectory, "public");
  const musicDirectory = path.join(publicDirectory, "music");
  fs.mkdirSync(musicDirectory, { recursive: true });
  fs.writeFileSync(path.join(temporaryDirectory, "notes.json"), JSON.stringify(bundledNotes()), "utf8");
  fs.writeFileSync(path.join(musicDirectory, "calm-night.mp3"), "test-audio", "utf8");
  fs.writeFileSync(path.join(musicDirectory, "second.ogg"), "test-audio", "utf8");
  fs.writeFileSync(path.join(musicDirectory, "ignore.txt"), "not-a-track", "utf8");

  const server = createStarBottleServer({
    dataDir: temporaryDirectory,
    publicDir: publicDirectory,
    ownerPassword: TEST_PASSWORD,
    disableSiteAuth: true,
    watch: false,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const listing = await requestJson(baseUrl, "/api/music");
  assert.equal(listing.status, 200);
  assert.deepEqual(
    new Set(listing.body.tracks.map((track) => track.file)),
    new Set(["calm-night.mp3", "second.ogg"]),
  );
  assert.equal(listing.body.tracks.find((track) => track.file === "calm-night.mp3").title, "calm night");

  const track = await fetch(`${baseUrl}/music/calm-night.mp3`);
  assert.equal(track.status, 200);
  assert.match(track.headers.get("content-type"), /^audio\/mpeg/);
});

test("viewers are read-only and an authenticated owner can edit a note", async (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "star-bottle-auth-"));
  const source = bundledNotes();
  fs.writeFileSync(
    path.join(temporaryDirectory, "notes.json"),
    JSON.stringify({ ...source, notes: source.notes.slice(0, 4) }, null, 2),
    "utf8",
  );

  const server = createStarBottleServer({
    dataDir: temporaryDirectory,
    ownerPassword: TEST_PASSWORD,
    disableSiteAuth: true,
    watch: false,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    assert.match(temporaryDirectory, /star-bottle-auth-/);
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const publicRead = await requestJson(baseUrl, "/api/notes");
  assert.equal(publicRead.status, 200);
  assert.equal(publicRead.body.notes.length, 4);

  const health = await requestJson(baseUrl, "/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.service, "star-bottle");

  const publicActivity = await requestJson(baseUrl, "/api/activity/open", {
    method: "POST",
    body: { noteId: "joy-01", visitorId: "visitor-test-001", source: "pointer" },
  });
  assert.equal(publicActivity.status, 201);

  const viewerActivity = await requestJson(baseUrl, "/api/owner/activity");
  assert.equal(viewerActivity.status, 401);
  const viewerDevices = await requestJson(baseUrl, "/api/owner/devices");
  assert.equal(viewerDevices.status, 401);

  const viewerWrite = await requestJson(baseUrl, "/api/notes/joy-01", {
    method: "PUT",
    body: { text: "viewer must not save this" },
  });
  assert.equal(viewerWrite.status, 401);

  const oldPublicWrite = await requestJson(baseUrl, "/api/state", {
    method: "PUT",
    body: { content: "old public write route" },
  });
  assert.equal(oldPublicWrite.status, 405);

  const wrongLogin = await requestJson(baseUrl, "/api/owner/login", {
    method: "POST",
    body: { password: "wrong password" },
  });
  assert.equal(wrongLogin.status, 401);

  const login = await requestJson(baseUrl, "/api/owner/login", {
    method: "POST",
    body: {
      password: TEST_PASSWORD,
      visitorId: "owner-device-test-01",
      deviceLabel: "测试设备",
    },
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const cookie = setCookie.split(";", 1)[0];

  const ownerDevices = await requestJson(baseUrl, "/api/owner/devices", { cookie });
  assert.equal(ownerDevices.status, 200);
  assert.equal(ownerDevices.body.devices.length, 1);
  assert.equal(ownerDevices.body.devices[0].label, "测试设备");

  const ownerDeviceActivity = await requestJson(baseUrl, "/api/activity/open", {
    method: "POST",
    body: { noteId: "joy-02", visitorId: "owner-device-test-01", source: "pointer" },
  });
  assert.equal(ownerDeviceActivity.status, 200);
  assert.equal(ownerDeviceActivity.body.recorded, false);

  const ownerStatus = await requestJson(baseUrl, "/api/owner/status", { cookie });
  assert.deepEqual(ownerStatus.body, { authenticated: true });

  const ownerWrite = await requestJson(baseUrl, "/api/notes/joy-01", {
    method: "PUT",
    cookie,
    body: { text: "owner edit", emotion: "sadness" },
  });
  assert.equal(ownerWrite.status, 200);
  assert.equal(ownerWrite.body.note.text, "owner edit");
  assert.equal(ownerWrite.body.note.emotion, "sadness");
  assert.equal(ownerWrite.body.note.colorLevel, 4);

  const refreshed = await requestJson(baseUrl, "/api/notes");
  assert.equal(refreshed.body.notes[0].text, "owner edit");
  assert.equal(refreshed.body.notes[0].emotion, "sadness");

  const ownerActivity = await requestJson(baseUrl, "/api/owner/activity", { cookie });
  assert.equal(ownerActivity.status, 200);
  assert.equal(ownerActivity.body.entries.length, 1);
  assert.equal(ownerActivity.body.entries[0].noteId, "joy-01");
  assert.equal(ownerActivity.body.entries[0].emotionAtOpen, "joy");

  const clearedActivity = await requestJson(baseUrl, "/api/owner/activity", {
    method: "DELETE",
    cookie,
  });
  assert.equal(clearedActivity.status, 200);
  const emptyActivity = await requestJson(baseUrl, "/api/owner/activity", { cookie });
  assert.deepEqual(emptyActivity.body.entries, []);

  const removedDevice = await requestJson(baseUrl, "/api/owner/devices/owner-device-test-01", {
    method: "DELETE",
    cookie,
  });
  assert.equal(removedDevice.status, 200);
  const activityAfterRemoval = await requestJson(baseUrl, "/api/activity/open", {
    method: "POST",
    body: { noteId: "joy-02", visitorId: "owner-device-test-01", source: "pointer" },
  });
  assert.equal(activityAfterRemoval.status, 201);

  const hiddenSettings = await fetch(`${baseUrl}/data/settings.json`);
  assert.equal(hiddenSettings.status, 404);
  const hiddenInstructions = await fetch(`${baseUrl}/OWNER-ACCESS.txt`);
  assert.equal(hiddenInstructions.status, 404);

  const logout = await requestJson(baseUrl, "/api/owner/logout", { method: "POST", cookie });
  assert.equal(logout.status, 200);
  const afterLogout = await requestJson(baseUrl, "/api/notes/joy-01", {
    method: "PUT",
    cookie,
    body: { text: "must remain blocked" },
  });
  assert.equal(afterLogout.status, 401);
});

test("owner can create, delete, and control a note's read status", async (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "star-bottle-status-"));
  const source = bundledNotes();
  fs.writeFileSync(
    path.join(temporaryDirectory, "notes.json"),
    JSON.stringify({ ...source, notes: source.notes.slice(0, 2) }, null, 2),
    "utf8",
  );

  const server = createStarBottleServer({
    dataDir: temporaryDirectory,
    ownerPassword: TEST_PASSWORD,
    disableSiteAuth: true,
    watch: false,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const login = await requestJson(baseUrl, "/api/owner/login", {
    method: "POST",
    body: { password: TEST_PASSWORD },
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];

  const created = await requestJson(baseUrl, "/api/owner/notes", {
    method: "POST",
    cookie,
    body: { text: "new status note", emotion: "joy" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.note.changeStatus, "unread");
  assert.equal(created.body.note.changeReason, "added");
  assert.equal(created.body.note.readAt, "");
  const noteId = created.body.note.id;

  const manuallyRead = await requestJson(baseUrl, `/api/owner/notes/${noteId}`, {
    method: "POST",
    cookie,
    body: { changeStatus: "read" },
  });
  assert.equal(manuallyRead.status, 200);
  assert.equal(manuallyRead.body.note.changeStatus, "read");
  assert.equal(manuallyRead.body.note.changeReason, "manual");
  assert.ok(manuallyRead.body.note.readAt);

  const manuallyUnread = await requestJson(baseUrl, `/api/owner/notes/${noteId}`, {
    method: "POST",
    cookie,
    body: { changeStatus: "unread" },
  });
  assert.equal(manuallyUnread.status, 200);
  assert.equal(manuallyUnread.body.note.changeStatus, "unread");
  assert.equal(manuallyUnread.body.note.changeReason, "manual");
  assert.equal(manuallyUnread.body.note.readAt, "");

  const opened = await requestJson(baseUrl, "/api/activity/open", {
    method: "POST",
    body: { noteId, visitorId: "status-reader-001", source: "pointer" },
  });
  assert.equal(opened.status, 201);
  assert.equal(opened.body.readChanged, true);
  assert.equal(opened.body.note.changeStatus, "read");
  assert.ok(opened.body.note.readAt);

  const automaticallyUnread = await requestJson(baseUrl, `/api/owner/notes/${noteId}`, {
    method: "POST",
    cookie,
    body: { text: "updated status note" },
  });
  assert.equal(automaticallyUnread.status, 200);
  assert.equal(automaticallyUnread.body.note.changeStatus, "unread");
  assert.equal(automaticallyUnread.body.note.changeReason, "updated");

  const updatedButRead = await requestJson(baseUrl, `/api/owner/notes/${noteId}`, {
    method: "POST",
    cookie,
    body: { text: "updated and acknowledged", changeStatus: "read" },
  });
  assert.equal(updatedButRead.status, 200);
  assert.equal(updatedButRead.body.note.changeStatus, "read");
  assert.equal(updatedButRead.body.note.changeReason, "updated");

  const favorite = await requestJson(baseUrl, `/api/favorites/${noteId}`, {
    method: "POST",
    body: { favorite: true },
  });
  assert.equal(favorite.status, 200);
  assert.equal(favorite.body.favorite, true);

  const deleted = await requestJson(baseUrl, `/api/owner/notes/${noteId}`, {
    method: "DELETE",
    cookie,
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted, true);
  assert.equal(deleted.body.document.notes.length, 2);
  assert.equal(deleted.body.favorites.noteIds.includes(noteId), false);
});
