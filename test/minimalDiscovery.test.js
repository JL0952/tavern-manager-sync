import assert from "node:assert/strict";
import test from "node:test";
import { discoverSillyTavern } from "../st-discovery.js";
import { scanSillyTavernEntities, createMinimalSillyTavernAdapter } from "../st-adapter.js";
import { hashCanonicalProjection } from "../sync-core/syncProjection.js";
const raw = { data: { name: "Fixture", description: "Canonical content" } };
const full = (avatar) => ({ avatar, json_data: JSON.stringify(raw) });

async function discover(shallow = false, incomplete = false) {
  const calls = [];
  const result = await discoverSillyTavern({ requestHeaders: () => ({}), fetch: async (path, options) => {
    calls.push([path, JSON.parse(options.body)]);
    const payload = path === "/api/characters/all" ? [full("A.png"), shallow ? { avatar: "B.png", shallow: true, name: "Wrong shallow name" } : full("B.png")]
      : path === "/api/characters/get" ? incomplete ? { avatar: "B.png", shallow: true } : full("B.png")
        : path === "/api/worldinfo/list" ? [{ file_id: "Lore" }]
          : { name: "Lore", entries: {} };
    return new Response(JSON.stringify(payload));
  } });
  return { result, calls };
}

test("full ST discovery: one Character list, no per-Character GET, one WB list plus one WB read", async () => {
  const { calls } = await discover();
  assert.deepEqual(calls.map(([path]) => path), ["/api/characters/all", "/api/worldinfo/list", "/api/worldinfo/get"]);
});

test("shallow ST discovery fetches only incomplete cards and hashes exactly the full canonical data", async () => {
  const { result, calls } = await discover(true);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.filter(c => c[0] === "/api/characters/get"), [["/api/characters/get", { avatar_url: "B.png" }]]);
  const scanned = scanSillyTavernEntities({ discovery: result, bindings: {} });
  assert.equal(scanned.get("character:A.png").contentHash, scanned.get("character:B.png").contentHash);
  assert.equal(scanned.get("character:B.png").canonical.card.description, raw.data.description);
});

test("an incomplete full read aborts discovery instead of computing a false hash or deleting bindings", async () => {
  await assert.rejects(discover(true, true), /Full Character data is unavailable/);
});

test("per-file reads run at most six at a time and keep list order", async () => {
  const names = Array.from({ length: 20 }, (_, index) => `Lore ${index}`);
  let active = 0;
  let peak = 0;
  const result = await discoverSillyTavern({ requestHeaders: () => ({}), fetch: async (path, options) => {
    const body = JSON.parse(options.body);
    if (path === "/api/characters/all") return new Response("[]");
    if (path === "/api/worldinfo/list") return new Response(JSON.stringify(names.map((name) => ({ file_id: name }))));
    active += 1;
    peak = Math.max(peak, active);
    // Later books answer sooner, so completion order differs from list order.
    await new Promise((resolve) => setTimeout(resolve, 40 - names.indexOf(body.name) * 2));
    active -= 1;
    return new Response(JSON.stringify({ name: body.name, entries: {} }));
  } });
  assert.equal(peak, 6);
  assert.deepEqual(result.worldbooks.map((book) => book.fileId), names);
});

test("after a failed read no further file is requested", async () => {
  const names = Array.from({ length: 20 }, (_, index) => `Lore ${index}`);
  const requested = [];
  await assert.rejects(discoverSillyTavern({ requestHeaders: () => ({}), fetch: async (path, options) => {
    const body = JSON.parse(options.body);
    if (path === "/api/characters/all") return new Response("[]");
    if (path === "/api/worldinfo/list") return new Response(JSON.stringify(names.map((name) => ({ file_id: name }))));
    requested.push(body.name);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return body.name === "Lore 0" ? new Response("", { status: 500 }) : new Response(JSON.stringify({ entries: {} }));
  } }), /HTTP 500/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(requested.length <= 6, `requested ${requested.length} files`);
});

test("Refresh and authoritative reread preserve the same bound WB reference when the WB file is missing", async () => {
  const rawCard = { data: { ...raw.data, extensions: { world: "Missing Lore" } } };
  const bindings = { "worldbook:remote-wb": { managerId: "remote-wb", localId: "Missing%20Lore", baseHash: null } };
  const discovery = { characters: [{ localId: "A.png", avatarFileName: "A.png", rawCard }], worldbooks: [] };
  const scanned = scanSillyTavernEntities({ discovery, bindings }).get("character:A.png");
  const adapter = createMinimalSillyTavernAdapter({
    readLocal: async () => ({ avatarFileName: "A.png", rawCard }),
    writeCharacter() {}, writeWorldbook() {}, createCharacter() {}, createWorldbook() {},
  });
  const reread = await adapter.refresh({ entityType: "character", localId: "A.png", bindings });
  assert.equal(scanned.canonical.relationship.worldBookId, "remote-wb");
  assert.equal(scanned.contentHash, hashCanonicalProjection(reread.canonical));
});

test("without the list route, discovery takes World Info ids from the settings list", async () => {
  const calls = [];
  const result = await discoverSillyTavern({ requestHeaders: () => ({}), worldbookList: "settings", fetch: async (path, options) => {
    calls.push(path);
    if (path === "/api/characters/all") return new Response("[]");
    if (path === "/api/settings/get") return new Response(JSON.stringify({ world_names: ["Lore", "Other Lore"] }));
    assert.equal(path, "/api/worldinfo/get");
    return new Response(JSON.stringify({ name: JSON.parse(options.body).name, entries: {} }));
  } });
  assert.deepEqual(calls, ["/api/characters/all", "/api/settings/get", "/api/worldinfo/get", "/api/worldinfo/get"]);
  assert.deepEqual(result.worldbooks.map((book) => [book.localId, book.fileId]), [["Lore", "Lore"], ["Other%20Lore", "Other Lore"]]);
});

test("an invalid settings World Info list aborts discovery", async () => {
  for (const world_names of [undefined, "Lore", [""], [7]]) {
    await assert.rejects(discoverSillyTavern({ requestHeaders: () => ({}), worldbookList: "settings", fetch: async (path) =>
      new Response(path === "/api/characters/all" ? "[]" : JSON.stringify({ world_names })) }), /Invalid World Info name list/);
  }
  await assert.rejects(discoverSillyTavern({ requestHeaders: () => ({}), worldbookList: "other" }), /Unknown World Info list source/);
});
