import assert from "node:assert/strict";
import test from "node:test";
import {
  createCanonicalCharacterProjection,
  hashCanonicalProjection,
} from "../sync-core/syncProjection.js";

import {
  SIDECAR_FILE_NAME,
  SIDECAR_SETTINGS_KEY,
  SidecarError,
  createEmptyMinimalSidecar,
  createFileSidecarStore,
  validateMinimalSidecar,
} from "../sidecar-settings.js";

const endpoint = "http://manager.example.test/api/sync/v1";
const baseHash = hashCanonicalProjection(createCanonicalCharacterProjection({ name: "Alice", description: "base" }));

function sidecarWithBindings() {
  const sidecar = createEmptyMinimalSidecar();
  sidecar.config.endpoint = endpoint;
  sidecar.bindings["character:manager-alice"] = { entityType: "character", managerId: "manager-alice", localId: "Alice.png", baseHash };
  sidecar.bindings["character:manager-bob"] = { managerId: "manager-bob", localId: "Bob.png", baseHash: null };
  sidecar.bindings["worldbook:manager-lore"] = { entityType: "worldbook", managerId: "manager-lore", localId: "Lore", baseHash: null };
  return sidecar;
}

test("minimal sidecar stores only endpoint and Manager UUID bindings", () => {
  const sidecar = createEmptyMinimalSidecar();
  sidecar.config.endpoint = endpoint;
  sidecar.bindings["character:manager-alice"] = {
    entityType: "character",
    managerId: "manager-alice",
    localId: "Alice.png",
    baseHash: null,
  };

  assert.deepEqual(validateMinimalSidecar(sidecar), sidecar);

  sidecar.bindings["character:manager-alice"].legacyRevision = 7;
  assert.throws(() => validateMinimalSidecar(sidecar), SidecarError);
});

test("Phase 7D schema and duplicate local bindings are rejected", () => {
  assert.throws(() => validateMinimalSidecar({ schemaVersion: 3, config: { serverKey: null, endpoint: null }, syncState: {}, repairs: {} }), SidecarError);
  const sidecar = sidecarWithBindings();
  sidecar.bindings["character:manager-other"] = { managerId: "manager-other", localId: "Alice.png", baseHash: null };
  assert.throws(() => validateMinimalSidecar(sidecar), /duplicate local binding/);
});

function fileFixture({ text = null, uploadStatus = 200 } = {}) {
  const disk = { text };
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push(`${options.method ?? "GET"} ${url}`);
    if (url === `/user/files/${SIDECAR_FILE_NAME}`) {
      assert.equal(options.cache, "no-store", "every read goes to disk");
      return disk.text === null ? new Response("", { status: 404 }) : new Response(disk.text);
    }
    if (url === "/api/files/upload") {
      assert.equal(options.headers["X-CSRF-Token"], "csrf");
      if (uploadStatus !== 200) return new Response("", { status: uploadStatus });
      const body = JSON.parse(options.body);
      assert.equal(body.name, SIDECAR_FILE_NAME);
      disk.text = Buffer.from(body.data, "base64").toString("utf8");
      return new Response(JSON.stringify({ path: `user/files/${SIDECAR_FILE_NAME}` }));
    }
    throw new Error(`Unexpected request ${url}`);
  };
  return { disk, calls, fetch, requestHeaders: () => ({ "X-CSRF-Token": "csrf" }) };
}

const onDisk = (disk) => JSON.parse(disk.text);
const binding = (id, localId) => ({ managerId: id, localId, baseHash: null });

test("file store reads legacy settings until the file exists, then migrates on the first update without touching settings", async () => {
  const f = fileFixture();
  const legacySettings = { [SIDECAR_SETTINGS_KEY]: sidecarWithBindings(), unrelated: true };
  const before = structuredClone(legacySettings);
  const store = createFileSidecarStore({ fetch: f.fetch, requestHeaders: f.requestHeaders, legacySettings });
  assert.deepEqual(await store.read(), sidecarWithBindings());
  assert.equal(f.calls.some((call) => call.startsWith("POST")), false, "reads never write");

  await store.update((sidecar) => { sidecar.bindings["character:new"] = binding("new", "凯尔.png"); });
  assert.deepEqual(onDisk(f.disk).bindings["character:new"], binding("new", "凯尔.png"), "UTF-8 survives base64");
  assert.equal(Object.keys(onDisk(f.disk).bindings).length, 4);
  assert.deepEqual(legacySettings, before, "settings are never written");

  legacySettings[SIDECAR_SETTINGS_KEY].bindings = {};
  assert.equal(Object.keys((await store.read()).bindings).length, 4, "once the file exists, settings are ignored");
});

test("file store reads an absent file without legacy state as empty", async () => {
  const f = fileFixture();
  const store = createFileSidecarStore({ fetch: f.fetch, requestHeaders: f.requestHeaders });
  assert.deepEqual(await store.read(), createEmptyMinimalSidecar());
  assert.equal(f.disk.text, null);
});

test("file store recomputes on fresh state when another tab wrote meanwhile, keeping both changes", async () => {
  const f = fileFixture({ text: JSON.stringify(createEmptyMinimalSidecar()) });
  const store = createFileSidecarStore({ fetch: f.fetch, requestHeaders: f.requestHeaders });
  let runs = 0;
  await store.update((sidecar) => {
    runs += 1;
    if (runs === 1) { // Another tab writes between this read and our write.
      const other = createEmptyMinimalSidecar();
      other.bindings["character:other"] = binding("other", "Other.png");
      f.disk.text = JSON.stringify(other);
    }
    sidecar.bindings["character:mine"] = binding("mine", "Mine.png");
  });
  assert.equal(runs, 2);
  assert.deepEqual(Object.keys(onDisk(f.disk).bindings).sort(), ["character:mine", "character:other"]);
});

test("file store gives up instead of overwriting state that keeps changing elsewhere", async () => {
  const f = fileFixture({ text: JSON.stringify(createEmptyMinimalSidecar()) });
  const store = createFileSidecarStore({ fetch: f.fetch, requestHeaders: f.requestHeaders });
  let external = 0;
  await assert.rejects(store.update((sidecar) => {
    const other = createEmptyMinimalSidecar();
    other.bindings[`character:other${++external}`] = binding(`other${external}`, `Other${external}.png`);
    f.disk.text = JSON.stringify(other);
    sidecar.bindings["character:mine"] = binding("mine", "Mine.png");
  }), /kept changing/);
  assert.equal(Object.hasOwn(onDisk(f.disk).bindings, "character:mine"), false);
});

test("file store never writes an invalid candidate, reports failed writes and invalid files", async () => {
  const f = fileFixture({ text: JSON.stringify(sidecarWithBindings()) });
  const store = createFileSidecarStore({ fetch: f.fetch, requestHeaders: f.requestHeaders });
  await assert.rejects(store.update((sidecar) => { sidecar.bindings["character:x"] = binding("x", "Alice.png"); }),
    /duplicate local binding/);
  assert.equal(f.calls.some((call) => call.startsWith("POST")), false);

  const failing = fileFixture({ uploadStatus: 500 });
  const failingStore = createFileSidecarStore({ fetch: failing.fetch, requestHeaders: failing.requestHeaders });
  await assert.rejects(failingStore.update((sidecar) => { sidecar.config.endpoint = endpoint; }), /HTTP 500/);
  assert.equal(failing.disk.text, null);

  const corrupt = fileFixture({ text: "{ not json" });
  await assert.rejects(createFileSidecarStore({ fetch: corrupt.fetch, requestHeaders: corrupt.requestHeaders }).read(), SidecarError);
});

test("file store serializes concurrent updates in one tab without losing either change", async () => {
  const f = fileFixture();
  const store = createFileSidecarStore({ fetch: f.fetch, requestHeaders: f.requestHeaders });
  await Promise.all([
    store.update((sidecar) => { sidecar.bindings["character:a"] = binding("a", "A.png"); }),
    store.update((sidecar) => { sidecar.bindings["character:b"] = binding("b", "B.png"); }),
  ]);
  assert.deepEqual(Object.keys(onDisk(f.disk).bindings).sort(), ["character:a", "character:b"]);
});
