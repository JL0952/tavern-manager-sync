import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";
import { CANONICAL_PROJECTION_VERSION, hashCanonicalProjection as hash } from "../sync-core/syncProjection.js";
import { createMinimalSyncService, classify, creatorNotesPreview } from "../minimal-service.js";
import { createMinimalSillyTavernAdapter, scanSillyTavernEntities, readEmbeddedManagerId } from "../st-adapter.js";
import { validateMinimalSidecar } from "../sidecar-settings.js";
import { needsSillyTavern, requireFromSillyTavern, stRoot } from "./sillyTavern.js";
const clone = structuredClone;
const char = (description = "same", world = null) => ({ avatarFileName: "Local.png",
  rawCard: { spec: "chara_card_v3", spec_version: "3.0", data: { name: "A", description,
    extensions: world ? { world } : {} } } });
const wb = (content = "same", name = "Lore") => ({ fileId: name,
  rawWorldBook: { name, entries: { 1: { uid: "1", key: ["lore"], content } } } });
const canonical = (type, raw) => [...scanSillyTavernEntities({ bindings: {}, discovery: {
  characters: type === "character" ? [{ localId: "x", ...raw }] : [],
  worldbooks: type === "worldbook" ? [{ localId: "x", ...raw }] : [],
} }).values()][0].canonical;

function fixture() {
  let state = { schemaVersion: 1, config: { endpoint: "http://synthetic.test/api/sync/v1" }, bindings: {} };
  const locals = new Map();
  const remotes = new Map();
  const calls = { manager: [], localReads: [], writes: [], creates: [], avatars: [] };
  // Pictures by Manager id and by ST avatar file. Every ST card has one.
  const managerAvatars = new Map();
  const stAvatars = new Map();
  let seq = 0;
  const store = { async read() { return clone(state); }, async update(fn) {
    const draft = clone(state); await fn(draft); validateMinimalSidecar(draft); state = draft;
  } };
  const gateway = {
    async readLocal({ entityType, localId }) {
      calls.localReads.push(`${entityType}:${localId}`);
      const raw = locals.get(`${entityType}:${localId}`);
      if (!raw) throw Object.assign(new Error("Missing local"), { code: "missing_local" });
      return clone(raw);
    },
    async writeCharacter({ avatarFileName, update }) {
      calls.writes.push(`character:${encodeURIComponent(avatarFileName)}`);
      const raw = locals.get(`character:${encodeURIComponent(avatarFileName)}`).rawCard;
      const { data, avatar, ...mirrors } = clone(update);
      Object.assign(raw, mirrors);
      raw.data = { ...raw.data, ...clone(update.data), extensions: { ...raw.data.extensions, ...update.data.extensions } };
      if (raw.data.extensions.world === "__@@UNSET@@__") delete raw.data.extensions.world;
    },
    async writeWorldbook({ fileId, rawWorldBook }) {
      calls.writes.push(`worldbook:${encodeURIComponent(fileId)}`);
      locals.set(`worldbook:${encodeURIComponent(fileId)}`, { fileId, rawWorldBook: clone(rawWorldBook) });
    },
    async createCharacter({ canonical, reservedLocalIds }) {
      let name;
      do { name = `New${++seq}.png`; } while (reservedLocalIds.includes(encodeURIComponent(name)));
      calls.creates.push(`character:${name}`);
      locals.set(`character:${encodeURIComponent(name)}`, { avatarFileName: name, rawCard: { data: clone(canonical.card) } });
      return name;
    },
    async createWorldbook({ name, rawWorldBook, reservedLocalIds }) {
      let fileId = name;
      for (let n = 2; locals.has(`worldbook:${encodeURIComponent(fileId)}`) || reservedLocalIds.includes(encodeURIComponent(fileId)); n++) fileId = `${name} (${n})`;
      calls.creates.push(`worldbook:${fileId}`);
      locals.set(`worldbook:${encodeURIComponent(fileId)}`, { fileId, rawWorldBook: clone(rawWorldBook) });
      return fileId;
    },
    async readAvatar({ avatarFileName }) {
      if (!locals.has(`character:${encodeURIComponent(avatarFileName)}`)) {
        throw Object.assign(new Error("Missing local"), { code: "missing_local" });
      }
      return stAvatars.get(avatarFileName) ?? new Blob([`default:${avatarFileName}`], { type: "image/png" });
    },
    async writeAvatar({ avatarFileName, image }) {
      calls.avatars.push(`ST ${avatarFileName}`);
      stAvatars.set(avatarFileName, image);
    },
    async listWorldbooks() {
      return [...locals].filter(([k]) => k.startsWith("worldbook:")).map(([k, raw]) => ({
        localId: k.slice(10), displayName: raw.rawWorldBook.name || raw.fileId,
      }));
    },
  };
  const adapter = createMinimalSillyTavernAdapter(gateway);
  function resource(type, id, value) { return { type, id, revision: 1, canonical: clone(value), contentHash: hash(value) }; }
  const fetch = async (url, options) => {
    const path = new URL(url).pathname.replace("/api/sync/v1/", "");
    const method = options?.method ?? "GET";
    calls.manager.push(`${method} ${path}`);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (path === "manifest") {
      const entries = [...remotes.values()].map(({ canonical, ...r }) => ({ ...r,
        displayName: r.type === "character" ? canonical.card.name : canonical.worldbook.name }));
      return json({ projectionVersion: CANONICAL_PROJECTION_VERSION, characters: entries.filter(x => x.type === "character"), worldbooks: entries.filter(x => x.type === "worldbook") });
    }
    const [coll, encoded, attachment] = path.split("/");
    const type = coll === "characters" ? "character" : "worldbook";
    const id = encoded && decodeURIComponent(encoded);
    const k = `${type}:${id}`;
    if (attachment === "avatar") {
      if (method === "PUT") {
        if (!remotes.has(k)) return json({}, 404);
        calls.avatars.push(`Manager ${id}`);
        managerAvatars.set(id, options.body);
        return json({ apiVersion: "sync/v1", avatar: { outcome: "updated" } });
      }
      const image = managerAvatars.get(id);
      return image ? new Response(image, { headers: { "content-type": image.type } })
        : json({ error: { code: "sync_avatar_not_found" } }, 404);
    }
    if (method === "POST") {
      const r = resource(type, `new-${++seq}`, JSON.parse(options.body).canonical);
      remotes.set(`${type}:${r.id}`, r);
      return json({ entity: r }, 201);
    }
    if (!remotes.has(k)) return json({}, 404);
    if (method === "PUT") {
      const body = JSON.parse(options.body);
      if (body.baseRevision !== remotes.get(k).revision) return json({}, 409);
      remotes.set(k, { ...resource(type, id, body.canonical), revision: remotes.get(k).revision + 1 });
    }
    return json({ entity: remotes.get(k) });
  };
  const service = createMinimalSyncService({ sidecarStore: store, fetch });
  function bind(type, id, localId, baseHash = null) { state.bindings[`${type}:${id}`] = { managerId: id, localId, baseHash }; }
  function local(type, id, raw) {
    const value = clone(raw);
    if (type === "character") value.avatarFileName = decodeURIComponent(id);
    else value.fileId = decodeURIComponent(id);
    locals.set(`${type}:${id}`, value);
  }
  function remote(type, id, value) { remotes.set(`${type}:${id}`, resource(type, id, value)); }
  function discovery() {
    return { characters: [...locals].filter(([k]) => k.startsWith("character:")).map(([k, r]) => ({ localId: k.slice(10), ...clone(r) })),
      worldbooks: [...locals].filter(([k]) => k.startsWith("worldbook:")).map(([k, r]) => ({ localId: k.slice(10), ...clone(r) })) };
  }
  return { store, locals, remotes, calls, managerAvatars, stAvatars, gateway, adapter, service, fetch, bind, local, remote, discovery };
}

test("classify has exactly four hash outcomes, including no BASE", () => {
  for (const [l, m, b, expected] of [
    ["a", "a", null, "synced"], ["a", "a", "b", "synced"],
    ["b", "a", "a", "st_changed"], ["a", "b", "a", "manager_changed"],
    ["b", "c", "a", "different"], ["a", "b", null, "different"],
  ]) assert.equal(classify(l, m, b), expected);
});

test("a BASE from an older projection cannot classify a change; equal hashes rebaseline without changing UUID/local IDs", async () => {
  for (const equal of [true, false]) {
    const f = fixture(); const raw = char(); const current = canonical("character", raw);
    const oldBase = `sha256:${"0".repeat(64)}`;
    f.local("character", "Local.png", raw);
    const remote = clone(current);
    if (!equal) remote.card.extensions.depth_prompt.prompt = "Remote note";
    f.remote("character", "remote", remote); f.bind("character", "remote", "Local.png", oldBase);
    const { rows } = await f.service.refresh({ discovery: f.discovery() });
    assert.equal(rows[0].status, equal ? "synced" : "different");
    const binding = (await f.store.read()).bindings["character:remote"];
    assert.deepEqual(binding, { managerId: "remote", localId: "Local.png", baseHash: equal ? hash(current) : oldBase });
    assert.equal(f.calls.writes.length + f.calls.creates.length, 0);
  }
});

for (const mode of ["bound", "create", "recreate"]) for (const prompt of ["Remote note", ""]) {
  test(`Pull ${mode} mirrors root/data, ${prompt ? "sets" : "clears"} note and passes untouched ST readFromV2`, needsSillyTavern, async () => {
    const f = fixture(); const old = char("Old description");
    Object.assign(old.rawCard, { name: "stale root", description: "stale root", tags: ["old"], fav: false, talkativeness: 0.1 });
    Object.assign(old.rawCard.data.extensions, { depth_prompt: { prompt: "old note", depth: 8, role: "system" }, fav: true, talkativeness: 0.8 });
    const source = canonical("character", char("Remote description"));
    source.card.name = "Remote name"; source.card.tags = ["tag"];
    source.card.extensions.depth_prompt = { prompt, depth: 0, role: "user" };
    f.remote("character", "remote", source);
    if (mode === "bound") f.local("character", "Local.png", old);
    if (mode !== "create") f.bind("character", "remote", "Local.png");
    const result = await f.service.pull({ entityType: "character", managerId: "remote", adapter: f.adapter });
    const raw = f.locals.get(`character:${result.localId}`).rawCard;
    assert.deepEqual(raw.data.extensions.depth_prompt, source.card.extensions.depth_prompt);
    for (const field of ["name", "description", "personality", "scenario", "first_mes", "mes_example", "tags"]) {
      assert.deepEqual(raw[field], raw.data[field], field);
    }
    if (mode === "bound") { assert.equal(raw.fav, true); assert.equal(raw.talkativeness, 0.8); }
    const sourceCode = await readFile(join(stRoot, "src", "endpoints", "characters.js"), "utf8");
    const start = sourceCode.indexOf("function readFromV2(char)");
    const body = sourceCode.slice(start, sourceCode.indexOf("function charaFormatData", start));
    assert.match(body, /console.warn/); // Native warnings remain intact.
    const warnings = [];
    const _ = requireFromSillyTavern("lodash");
    vm.runInNewContext(`${body}; readFromV2(card);`, { _, card: clone(raw), humanizedDateTime: () => "synthetic date", console: { warn: (...args) => warnings.push(args) } });
    assert.deepEqual(warnings, []);
    assert.equal((await f.store.read()).bindings["character:remote"].baseHash, hash(source));
  });
}

test("WB Pull create/update and Push keep comment and false/0/null semantic fields", async () => {
  const f = fixture(); const raw = wb();
  Object.assign(raw.rawWorldBook.entries[1], { comment: "Title", useProbability: false, probability: 0, depth: 0,
    role: null, scanDepth: 0, caseSensitive: false, matchWholeWords: null, cooldown: 0, delay: null, groupWeight: 0 });
  const source = canonical("worldbook", raw);
  f.remote("worldbook", "remote", source);
  const result = await f.service.pull({ entityType: "worldbook", managerId: "remote", adapter: f.adapter });
  assert.deepEqual(canonical("worldbook", f.locals.get(`worldbook:${result.localId}`)), source);
  f.remotes.get("worldbook:remote").canonical.worldbook.entries[0].comment = "New title";
  f.remotes.get("worldbook:remote").contentHash = hash(f.remotes.get("worldbook:remote").canonical);
  await f.service.pull({ entityType: "worldbook", managerId: "remote", adapter: f.adapter });
  const local = f.locals.get(`worldbook:${result.localId}`);
  local.rawWorldBook.entries[1].comment = "ST edited title";
  await f.service.push({ entityType: "worldbook", localId: result.localId, confirmOverwrite: true, adapter: f.adapter });
  assert.deepEqual(f.remotes.get("worldbook:remote").canonical, canonical("worldbook", local));
});

test("non-portable WB source stops Push/Pull before any content write", async () => {
  for (const field of ["automationId", "characterFilter", "futureSemantic"]) {
    const f = fixture(); const raw = wb();
    raw.rawWorldBook.entries[1][field] = field === "characterFilter" ? { tags: ["sensitive"] } : "sensitive";
    f.local("worldbook", "Lore", raw);
    await assert.rejects(f.service.push({ entityType: "worldbook", localId: "Lore", adapter: f.adapter }), { code: "unsupported_worldbook_fields" });
    assert.equal(f.calls.manager.length, 0); assert.equal(f.calls.writes.length + f.calls.creates.length, 0);
    f.remote("worldbook", "remote", canonical("worldbook", wb()));
    f.remotes.get("worldbook:remote").diagnostics = [{ code: "unsupported_nonportable_automation_id" }];
    await assert.rejects(f.service.pull({ entityType: "worldbook", managerId: "remote", adapter: f.adapter }), { code: "unsupported_worldbook_fields" });
    assert.equal(f.calls.writes.length + f.calls.creates.length, 0);
  }
});

test("Refresh discovers unequal unbound rows without pairing and uses one manifest, zero resource GETs", async () => {
  const f = fixture(); const value = canonical("character", char());
  f.local("character", "Local.png", char("local")); f.remote("character", "remote", value);
  const { rows } = await f.service.refresh({ discovery: f.discovery() });
  assert.deepEqual(rows.map(r => r.status).sort(), ["manager_only", "st_only"]);
  assert.deepEqual(f.calls.manager, ["GET manifest"]);
  assert.deepEqual((await f.store.read()).bindings, {});
});

test("Refresh converges equal BASE, preserves one-sided bindings and deletes only dead bindings", async () => {
  const f = fixture(); const value = canonical("character", char());
  f.local("character", "Local.png", char()); f.remote("character", "both", value);
  f.remote("character", "remote-only", value); f.local("character", "Only.png", char());
  f.bind("character", "both", "Local.png"); f.bind("character", "remote-only", "Gone.png");
  f.bind("character", "gone", "Only.png"); f.bind("character", "dead", "Dead.png");
  const result = await f.service.refresh({ discovery: f.discovery() });
  assert.deepEqual(result.rows.map(r => r.status).sort(), ["manager_only", "st_only", "synced"]);
  assert.equal((await f.store.read()).bindings["character:both"].baseHash, hash(value));
  assert.equal(Object.keys((await f.store.read()).bindings).length, 3);
});

for (const direction of ["push", "pull"]) for (const mode of ["unbound", "bound", "missing"]) {
  test(`${direction}: ${mode} counterpart uses source binding and verifies BASE`, async () => {
    const f = fixture(); const source = canonical("character", char("source"));
    if (direction === "push") {
      f.local("character", "Local.png", char("source"));
      if (mode === "bound") f.remote("character", "remote", canonical("character", char("old")));
    } else {
      f.remote("character", "remote", source);
      if (mode === "bound") f.local("character", "Local.png", char("old"));
    }
    if (mode !== "unbound") f.bind("character", "remote", "Local.png");
    const result = await f.service[direction]({ entityType: "character", adapter: f.adapter,
      ...(direction === "push" ? { localId: "Local.png" } : { managerId: "remote" }),
      ...(direction === "push" && mode === "bound" ? { confirmOverwrite: true } : {}) });
    assert.equal(result.status, direction === "push" ? "pushed" : "pulled");
    const bindings = Object.values((await f.store.read()).bindings);
    assert.deepEqual(bindings, [{ managerId: result.managerId, localId: result.localId, baseHash: hash(source) }]);
    if (mode === "bound") assert.equal(direction === "push" ? result.managerId : result.localId, direction === "push" ? "remote" : "Local.png");
    else assert.equal(direction === "push" ? f.calls.manager.some(c => c === "POST characters") : f.calls.creates.length === 1, true);
    if (direction === "pull") assert.equal(result.frontendChanges.at(-1).created, mode !== "bound");
  });
}

test("arbitrary targets and corrupt conflicting bindings are rejected before writes", async () => {
  const f = fixture(); f.local("character", "Local.png", char()); f.remote("character", "a", canonical("character", char()));
  await assert.rejects(f.service.push({ entityType: "character", localId: "Local.png", managerId: "a", adapter: f.adapter }), /only a local source/);
  await assert.rejects(f.service.pull({ entityType: "character", managerId: "a", localId: "Local.png", adapter: f.adapter }), /only a Manager source/);
  f.bind("character", "a", "Local.png"); f.bind("character", "b", "Local.png");
  await assert.rejects(f.service.pull({ entityType: "character", managerId: "a", adapter: f.adapter }), /duplicate local binding/);
  await assert.rejects(f.service.push({ entityType: "character", localId: "Local.png", adapter: f.adapter }), /duplicate local binding/);
  assert.deepEqual(f.calls.writes, []); assert.deepEqual(f.calls.creates, []);
  assert.equal(f.calls.manager.some(c => /^(POST|PUT)/.test(c)), false);
});

test("Push refuses an existing different Manager entity until explicitly confirmed", async () => {
  const f = fixture();
  const local = canonical("character", char("local"));
  f.local("character", "Local.png", char("local"));
  f.remote("character", "remote", canonical("character", char("manager")));
  f.bind("character", "remote", "Local.png", hash(canonical("character", char("base"))));

  await assert.rejects(f.service.push({ entityType: "character", localId: "Local.png", adapter: f.adapter }),
    error => error.code === "overwrite_confirmation_required");
  assert.equal(f.calls.manager.some(call => call.startsWith("PUT")), false);
  assert.equal((await f.store.read()).bindings["character:remote"].baseHash, hash(canonical("character", char("base"))));

  await f.service.push({ entityType: "character", localId: "Local.png", adapter: f.adapter, confirmOverwrite: true });
  assert.equal(f.remotes.get("character:remote").contentHash, hash(local));
});

function linkedFixture({ localBook = false, boundBook = false } = {}) {
  const f = fixture(); const book = canonical("worldbook", wb("manager"));
  f.remote("worldbook", "book", book);
  f.remote("character", "a", { ...canonical("character", char()), relationship: { worldBookId: "book" } });
  f.remote("character", "b", { ...canonical("character", char("second")), relationship: { worldBookId: "book" } });
  if (localBook) f.local("worldbook", "Lore", wb("local"));
  if (boundBook) f.bind("worldbook", "book", "Lore");
  return f;
}

test("two Characters reuse the same bound WB even when its content differs", async () => {
  const f = linkedFixture({ localBook: true, boundBook: true });
  for (const managerId of ["a", "b"]) await f.service.pull({ entityType: "character", managerId, adapter: f.adapter });
  assert.equal(f.calls.creates.filter(c => c.startsWith("worldbook:")).length, 0);
  assert.equal(f.calls.writes.filter(c => c.startsWith("worldbook:")).length, 0);
  assert.equal((await f.store.read()).bindings["worldbook:book"].localId, "Lore");
});

test("Character Pull creates an absent WB and returns both UI refreshes", async () => {
  const f = linkedFixture();
  const result = await f.service.pull({ entityType: "character", managerId: "a", adapter: f.adapter });
  assert.deepEqual(result.frontendChanges.map(c => [c.entityType, c.created]), [["worldbook", true], ["character", true]]);
  assert.equal(Object.keys((await f.store.read()).bindings).length, 2);
});

for (const same of [true, false]) test(`same-name WB always asks; Use existing sets ${same ? "equal" : "null"} BASE`, async () => {
  const f = linkedFixture({ localBook: true });
  if (same) f.local("worldbook", "Lore", wb("manager"));
  const source = { entityType: "character", managerId: "a", adapter: f.adapter };
  await assert.rejects(f.service.pull(source), e => e.code === "worldbook_name_conflict" && e.details.candidates.length === 1);
  assert.deepEqual(f.calls.creates, []); assert.deepEqual(f.calls.writes, []);
  assert.deepEqual((await f.store.read()).bindings, {});
  await f.service.pull({ ...source, worldbookChoice: { managerId: "book", mode: "use_existing", localId: "Lore" } });
  assert.equal((await f.store.read()).bindings["worldbook:book"].baseHash, same ? f.remotes.get("worldbook:book").contentHash : null);
  assert.equal(f.calls.writes.includes("worldbook:Lore"), false);
});

test("Use existing rejects a WB owned by another UUID before any content write", async () => {
  const f = linkedFixture({ localBook: true }); f.bind("worldbook", "other", "Lore");
  await assert.rejects(f.service.pull({ entityType: "character", managerId: "a", adapter: f.adapter,
    worldbookChoice: { managerId: "book", mode: "use_existing", localId: "Lore" } }), /already bound/);
  assert.deepEqual(f.calls.creates, []); assert.deepEqual(f.calls.writes, []);
});

test("duplicate WB gets a unique local name; Cancel makes no changes", async () => {
  const f = linkedFixture({ localBook: true }); f.local("worldbook", encodeURIComponent("Lore (2)"), wb());
  const source = { entityType: "character", managerId: "a", adapter: f.adapter };
  await assert.rejects(f.service.pull({ ...source, worldbookChoice: { managerId: "book", mode: "cancel" } }), e => e.code === "cancelled");
  assert.deepEqual(f.calls.creates, []); assert.deepEqual(f.calls.writes, []);
  await f.service.pull({ ...source, worldbookChoice: { managerId: "book", mode: "import_duplicate" } });
  assert.equal((await f.store.read()).bindings["worldbook:book"].localId, encodeURIComponent("Lore (3)"));
  assert.equal(f.locals.get("worldbook:Lore").rawWorldBook.entries[1].content, "local");
});

test("ST-only Character Push creates linked WB first using ordinary Push", async () => {
  const f = fixture(); f.local("worldbook", "Lore", wb()); f.local("character", "Local.png", char("same", "Lore"));
  await f.service.push({ entityType: "character", localId: "Local.png", adapter: f.adapter });
  assert.deepEqual(f.calls.manager.filter(c => c.startsWith("POST")), ["POST worldbooks", "POST characters"]);
  assert.equal(Object.keys((await f.store.read()).bindings).length, 2);
});

test("read errors never mean absent counterpart and verification failures never update BASE", async () => {
  const f = fixture(); f.remote("character", "a", canonical("character", char())); f.bind("character", "a", "Local.png");
  const broken = { ...f.adapter, async refresh() { throw new Error("Read failed"); } };
  await assert.rejects(f.service.pull({ entityType: "character", managerId: "a", adapter: broken }), /Read failed/);
  assert.deepEqual(f.calls.creates, []);
  f.local("character", "Local.png", char("different"));
  await assert.rejects(f.service.pull({ entityType: "character", managerId: "a", adapter: { ...f.adapter, async writeExisting() {} } }), /verification failed/);
  assert.equal((await f.store.read()).bindings["character:a"].baseHash, null);
});

test("Sync All runs only the two directional changes using the same functions", async () => {
  const f = fixture(); const base = hash(canonical("character", char("base")));
  for (const [id, l, r, b] of [["same", "same", "same", null], ["push", "local", "base", base],
    ["pull", "base", "remote", base], ["different", "local", "remote", base]]) {
    f.local("character", `${id}.png`, char(l)); f.remote("character", id, canonical("character", char(r)));
    f.bind("character", id, `${id}.png`, b);
  }
  f.local("character", "only.png", char("only")); f.remote("character", "only", canonical("character", char()));
  await assert.rejects(f.service.syncAll({ discovery: f.discovery(), adapter: f.adapter }),
    error => error.code === "overwrite_confirmation_required");
  assert.equal(f.calls.manager.some(call => call.startsWith("PUT")), false);
  const { results, frontendChanges } = await f.service.syncAll({ discovery: f.discovery(), adapter: f.adapter, confirmOverwrite: true });
  assert.equal(results.filter(r => r.status === "skipped").length, 4);
  assert.equal(results.filter(r => r.status === "pushed").length, 1);
  assert.equal(results.filter(r => r.status === "pulled").length, 1);
  // Push refreshes ST too: it embeds the Manager id in the pushed card.
  assert.deepEqual(frontendChanges, [{ entityType: "character", localId: "push.png", created: false },
    { entityType: "character", localId: "pull.png", created: false, avatarChanged: false }]);
  assert.deepEqual(f.calls.creates, []);
});

test("Manager error bodies reach the user, and Sync All names the entity that failed", async () => {
  const f = fixture(); const base = hash(canonical("character", char("base")));
  f.local("character", "push.png", char("local")); f.remote("character", "push", canonical("character", char("base")));
  f.bind("character", "push", "push.png", base);
  f.local("character", "new.png", char("new"));
  const json = (body, status) => new Response(JSON.stringify(body), { status });
  const service = createMinimalSyncService({ sidecarStore: f.store, fetch: async (url, options) =>
    options.method === "PUT" ? json({ error: { code: "sync_revision_conflict", entityType: "character", id: "push" } }, 409)
      : options.method === "POST" ? json({ error: "Request body too large.", limit: "10mb" }, 413)
        : f.fetch(url, options) });
  const conflict = "Manager PUT returned HTTP 409: sync_revision_conflict.";

  await assert.rejects(service.push({ entityType: "character", localId: "push.png", adapter: f.adapter, confirmOverwrite: true }),
    error => error.code === "sync_revision_conflict" && error.message === conflict && error.details.id === "push");
  await assert.rejects(service.push({ entityType: "character", localId: "new.png", adapter: f.adapter }),
    error => error.code === "sync_error" && error.message === "Manager POST returned HTTP 413: Request body too large.");

  const { results } = await service.syncAll({ discovery: f.discovery(), adapter: f.adapter, confirmOverwrite: true });
  assert.deepEqual(results.filter(r => r.status === "failed"),
    [{ status: "failed", entityType: "character", displayName: "A", message: conflict }]);
  assert.equal((await f.store.read()).bindings["character:push"].baseHash, base);
});

const withId = (raw, id) => { const value = clone(raw); value.rawCard.data.extensions.tavern_manager = { id }; return value; };
const bindingsOf = async (f) => (await f.store.read()).bindings;
const statusOf = (rows, localId) => rows.find(r => r.localId === localId)?.status;

test("embedded Manager id links a manually imported card; unequal content links with null BASE", async () => {
  for (const equal of [true, false]) {
    const f = fixture();
    f.remote("character", "m1", canonical("character", char()));
    f.local("character", "Imported.png", withId(char(equal ? "same" : "edited"), "m1"));
    const { rows, claimed } = await f.service.refresh({ discovery: f.discovery() });
    assert.equal(claimed, 1);
    assert.equal(statusOf(rows, "Imported.png"), equal ? "synced" : "different");
    assert.deepEqual((await bindingsOf(f))["character:m1"], { managerId: "m1", localId: "Imported.png",
      baseHash: equal ? f.remotes.get("character:m1").contentHash : null });
    assert.equal(f.calls.writes.length + f.calls.creates.length, 0, "linking never writes card content");
  }
});

test("several cards with one embedded id: equal sha256 picks one, otherwise none is linked", async () => {
  const f = fixture(); f.remote("character", "m1", canonical("character", char()));
  f.local("character", "Copy1.png", withId(char(), "m1")); f.local("character", "Copy2.png", withId(char("edited"), "m1"));
  let { rows } = await f.service.refresh({ discovery: f.discovery() });
  assert.equal((await bindingsOf(f))["character:m1"].localId, "Copy1.png");
  assert.equal(statusOf(rows, "Copy2.png"), "duplicate");

  const g = fixture(); g.remote("character", "m1", canonical("character", char()));
  g.local("character", "Copy1.png", withId(char("a"), "m1")); g.local("character", "Copy2.png", withId(char("b"), "m1"));
  ({ rows } = await g.service.refresh({ discovery: g.discovery() }));
  assert.deepEqual(await bindingsOf(g), {});
  assert.deepEqual([statusOf(rows, "Copy1.png"), statusOf(rows, "Copy2.png")], ["duplicate", "duplicate"]);
});

test("embedded id already bound to a live card marks the import Duplicate; a deleted card is replaced", async () => {
  for (const liveBound of [true, false]) {
    const f = fixture(); f.remote("character", "m1", canonical("character", char()));
    if (liveBound) f.local("character", "Pulled.png", char());
    f.bind("character", "m1", "Pulled.png");
    f.local("character", "Imported.png", withId(char(), "m1"));
    const { rows } = await f.service.refresh({ discovery: f.discovery() });
    assert.equal((await bindingsOf(f))["character:m1"].localId, liveBound ? "Pulled.png" : "Imported.png");
    assert.equal(statusOf(rows, "Imported.png"), liveBound ? "duplicate" : "synced");
  }
});

test("embedded id unknown to Manager stays ST only and never falls back to a hash match", async () => {
  const f = fixture(); f.remote("character", "other", canonical("character", char()));
  f.local("character", "Imported.png", withId(char(), "deleted-in-manager"));
  const { rows } = await f.service.refresh({ discovery: f.discovery() });
  assert.deepEqual(await bindingsOf(f), {});
  assert.equal(statusOf(rows, "Imported.png"), "st_only");
});

test("legacy cards link only on a sha256 unique among unbound entities on both sides, never by name", async () => {
  const cases = [
    ["unique equal hash", (f) => { f.local("character", "Old.png", char()); f.remote("character", "m1", canonical("character", char())); }, 1],
    ["same name, different content", (f) => { f.local("character", "Old.png", char("x")); f.remote("character", "m1", canonical("character", char("y"))); }, 0],
    ["two equal ST cards", (f) => { f.local("character", "Old.png", char()); f.local("character", "Old2.png", char());
      f.remote("character", "m1", canonical("character", char())); }, 0],
    ["two equal Manager cards", (f) => { f.local("character", "Old.png", char());
      f.remote("character", "m1", canonical("character", char())); f.remote("character", "m2", canonical("character", char())); }, 0],
    ["an equal card carrying an unusable id still counts", (f) => { f.local("character", "Old.png", char());
      f.local("character", "Tagged.png", withId(char(), "gone")); f.remote("character", "m1", canonical("character", char())); }, 0],
    // Two differing copies of m1 make the id rule ambiguous; m1 must still not be handed to a legacy card.
    ["Manager card owned by an embedded id is not a legacy target", (f) => { f.local("character", "Old.png", char());
      f.local("character", "Tagged1.png", withId(char("a"), "m1")); f.local("character", "Tagged2.png", withId(char("b"), "m1"));
      f.remote("character", "m1", canonical("character", char())); }, 0],
  ];
  for (const [label, setup, expected] of cases) {
    const f = fixture(); setup(f);
    const { claimed } = await f.service.refresh({ discovery: f.discovery() });
    const legacy = Object.values(await bindingsOf(f)).filter(b => b.localId === "Old.png");
    assert.equal(legacy.length, expected, label);
    if (expected) assert.equal(claimed, 1, label);
  }
});

test("legacy linking binds WorldBooks first so linked Characters hash equal, and reuses stale bindings", async () => {
  const f = fixture();
  const book = canonical("worldbook", wb());
  f.remote("worldbook", "book", book);
  f.remote("character", "hero", { ...canonical("character", char()), relationship: { worldBookId: "book" } });
  f.local("worldbook", "Lore", wb()); f.local("character", "Hero.png", char("same", "Lore"));
  f.bind("character", "hero", "Deleted.png"); // ST file was deleted; Manager card is linkable again.
  const { rows, claimed } = await f.service.refresh({ discovery: f.discovery() });
  assert.equal(claimed, 2);
  assert.deepEqual((await bindingsOf(f))["worldbook:book"].localId, "Lore");
  assert.deepEqual((await bindingsOf(f))["character:hero"].localId, "Hero.png");
  assert.deepEqual(rows.map(r => r.status), ["synced", "synced"]);
});

test("Push and Pull embed the Manager id outside the hash; an existing equal id is not rewritten", async () => {
  const f = fixture(); f.local("character", "Local.png", char());
  const pushed = await f.service.push({ entityType: "character", localId: "Local.png", adapter: f.adapter });
  const local = f.locals.get("character:Local.png").rawCard;
  assert.equal(readEmbeddedManagerId(local), pushed.managerId);
  assert.deepEqual(pushed.frontendChanges, [{ entityType: "character", localId: "Local.png", created: false }]);
  assert.equal(hash(canonical("character", { avatarFileName: "Local.png", rawCard: local })), f.remotes.get(`character:${pushed.managerId}`).contentHash);

  const writes = f.calls.writes.length;
  const again = await f.service.push({ entityType: "character", localId: "Local.png", adapter: f.adapter });
  assert.deepEqual(again.frontendChanges, []);
  assert.equal(f.calls.writes.length, writes, "already-embedded id needs no ST write");

  for (const mode of ["create", "bound"]) {
    const g = fixture(); g.remote("character", "m1", canonical("character", char()));
    if (mode === "bound") { g.local("character", "Local.png", char("old")); g.bind("character", "m1", "Local.png"); }
    const pulled = await g.service.pull({ entityType: "character", managerId: "m1", adapter: g.adapter });
    assert.equal(readEmbeddedManagerId(g.locals.get(`character:${pulled.localId}`).rawCard), "m1", mode);
  }
});

test("Push makes the ST picture the Manager avatar and Pull writes Manager's into ST, outside the hash", async () => {
  const f = fixture(); f.local("character", "Local.png", char());
  f.stAvatars.set("Local.png", new Blob(["st picture"], { type: "image/png" }));
  const pushed = await f.service.push({ entityType: "character", localId: "Local.png", adapter: f.adapter });
  assert.deepEqual(pushed.warnings, []);
  assert.equal(await f.managerAvatars.get(pushed.managerId).text(), "st picture");

  f.managerAvatars.set(pushed.managerId, new Blob(["manager picture"], { type: "image/jpeg" }));
  const pulled = await f.service.pull({ entityType: "character", managerId: pushed.managerId, adapter: f.adapter });
  const written = f.stAvatars.get("Local.png");
  assert.equal(written.type, "image/jpeg");
  assert.equal(await written.text(), "manager picture");
  assert.equal(pulled.frontendChanges.at(-1).avatarChanged, true);
  assert.deepEqual(pulled.warnings, []);
  assert.equal((await f.store.read()).bindings[`character:${pushed.managerId}`].baseHash, hash(canonical("character", char())));
});

test("a Manager Character without an avatar leaves the ST picture alone", async () => {
  const f = fixture(); f.remote("character", "remote", canonical("character", char()));
  const result = await f.service.pull({ entityType: "character", managerId: "remote", adapter: f.adapter });
  assert.deepEqual(f.calls.avatars, []);
  assert.equal(result.frontendChanges.at(-1).avatarChanged, false);
  assert.deepEqual(result.warnings, []);
});

test("an avatar that fails to transfer is a warning; the verified content and BASE stay", async () => {
  const f = fixture(); f.local("character", "Local.png", char());
  const service = createMinimalSyncService({ sidecarStore: f.store, fetch: async (url, options) =>
    new URL(url).pathname.endsWith("/avatar") ? new Response("{}", { status: 500 }) : f.fetch(url, options) });
  const pushed = await service.push({ entityType: "character", localId: "Local.png", adapter: f.adapter });
  assert.equal(pushed.status, "pushed");
  assert.match(pushed.warnings[0], /^A: avatar not sent \(Manager PUT returned HTTP 500/);
  const base = hash(canonical("character", char()));
  assert.equal((await f.store.read()).bindings[`character:${pushed.managerId}`].baseHash, base);

  const pulled = await service.pull({ entityType: "character", managerId: pushed.managerId, adapter: f.adapter });
  assert.equal(pulled.status, "pulled");
  assert.match(pulled.warnings[0], /^A: avatar not written \(Manager GET returned HTTP 500/);
  assert.equal(pulled.frontendChanges.at(-1).avatarChanged, false);

  f.managerAvatars.set(pushed.managerId, new Blob(["manager picture"], { type: "image/png" }));
  const failingSt = { ...f.adapter, async writeAvatar() { throw new Error("edit-avatar returned HTTP 400."); } };
  const rejected = await f.service.pull({ entityType: "character", managerId: pushed.managerId, adapter: failingSt });
  assert.deepEqual(rejected.warnings, ["A: avatar not written (edit-avatar returned HTTP 400.)"]);
  assert.equal((await f.store.read()).bindings[`character:${pushed.managerId}`].baseHash, base);
});

test("Refresh rows carry creator notes: Manager's preview first, else the ST card's", async () => {
  const f = fixture();
  const withNotes = (notes, description = "same") => {
    const raw = char(description); raw.rawCard.data.creator_notes = notes; return raw;
  };
  f.local("character", "Bound.png", withNotes("<p>ST notes</p>"));
  f.remote("character", "bound", canonical("character", withNotes("<p>ST notes</p>")));
  f.remotes.get("character:bound").creatorNotes = "Manager notes";
  f.bind("character", "bound", "Bound.png");
  f.local("character", "Only.png", withNotes("<b>Only</b> &amp; ST", "only"));
  f.local("character", "Plain.png", char("plain"));
  f.local("worldbook", "Lore", wb());
  const { rows } = await f.service.refresh({ discovery: f.discovery() });
  const byLocal = Object.fromEntries(rows.map(row => [row.localId, row]));
  assert.equal(byLocal["Bound.png"].creatorNotes, "Manager notes");
  assert.equal(byLocal["Only.png"].creatorNotes, "Only & ST");
  assert.equal(byLocal["Plain.png"].creatorNotes, "");
  assert.equal(Object.hasOwn(byLocal.Lore, "creatorNotes"), false);
});

test("the creator notes preview is built like Manager's manifest preview", () => {
  assert.equal(creatorNotesPreview("<p>Made by <b>me</b> &amp; friends</p>\n\n<br>Second&nbsp;line"), "Made by me & friends Second line");
  const long = creatorNotesPreview("word ".repeat(100));
  assert.equal(Array.from(long).length, 160);
  assert.ok(long.endsWith("…"));
  assert.equal(creatorNotesPreview(undefined), "");
});

test("an unsyncable Character is its own row: Refresh goes on, Push refuses it, Pull rebuilds it", async () => {
  const f = fixture(); const base = hash(canonical("character", char("base")));
  const broken = char("broken");
  broken.rawCard.data.extensions.depth_prompt = { prompt: "note", depth: -1, role: "system" };
  f.local("character", "Broken.png", broken); f.local("character", "Fine.png", char("fine"));
  f.remote("character", "remote", canonical("character", char("manager")));
  f.bind("character", "remote", "Broken.png", base);

  const { rows } = await f.service.refresh({ discovery: f.discovery() });
  const row = rows.find(r => r.localId === "Broken.png");
  assert.equal(row.status, "error");
  assert.equal(row.managerId, "remote");
  assert.match(row.error, /Character's Note/);
  assert.equal(rows.find(r => r.localId === "Fine.png").status, "st_only");
  assert.deepEqual((await f.store.read()).bindings["character:remote"], { managerId: "remote", localId: "Broken.png", baseHash: base });

  await assert.rejects(f.service.push({ entityType: "character", localId: "Broken.png", adapter: f.adapter, confirmOverwrite: true }),
    error => error.code === "unsyncable_local" && /Character's Note/.test(error.message));
  assert.equal(f.calls.manager.some(c => /^(POST|PUT)/.test(c)), false);

  const result = await f.service.pull({ entityType: "character", managerId: "remote", adapter: f.adapter });
  assert.equal(result.localId, "Broken.png");
  assert.deepEqual(f.locals.get("character:Broken.png").rawCard.data.extensions.depth_prompt,
    f.remotes.get("character:remote").canonical.card.extensions.depth_prompt);
  const after = await f.service.refresh({ discovery: f.discovery() });
  assert.equal(after.rows.find(r => r.localId === "Broken.png").status, "synced");
});

test("Pull rebuilds a WorldBook that has no entries object", async () => {
  const f = fixture();
  f.local("worldbook", "Lore", { rawWorldBook: { name: "Lore" } });
  f.remote("worldbook", "book", canonical("worldbook", wb()));
  f.bind("worldbook", "book", "Lore");
  const { rows } = await f.service.refresh({ discovery: f.discovery() });
  assert.equal(rows[0].status, "error");
  await f.service.pull({ entityType: "worldbook", managerId: "book", adapter: f.adapter });
  assert.deepEqual(canonical("worldbook", f.locals.get("worldbook:Lore")), f.remotes.get("worldbook:book").canonical);
});

test("a Manager without the avatar route is a warning, never taken as having no avatar", async () => {
  const f = fixture(); f.local("character", "Local.png", char());
  // What Express answers for a route an older Manager does not have.
  const service = createMinimalSyncService({ sidecarStore: f.store, fetch: async (url, options) =>
    new URL(url).pathname.endsWith("/avatar")
      ? new Response(`<pre>Cannot ${options?.method ?? "GET"}</pre>`, { status: 404, headers: { "content-type": "text/html" } })
      : f.fetch(url, options) });
  const pushed = await service.push({ entityType: "character", localId: "Local.png", adapter: f.adapter });
  assert.deepEqual(pushed.warnings, ["A: avatar not sent (this Manager has no avatar sync; restart or update Manager)"]);
  const pulled = await service.pull({ entityType: "character", managerId: pushed.managerId, adapter: f.adapter });
  assert.deepEqual(pulled.warnings, ["A: avatar not written (this Manager has no avatar sync; restart or update Manager)"]);
  assert.equal(pulled.frontendChanges.at(-1).avatarChanged, false);
});

// Push All and Pull All.
const charNamed = (name, world = null) => {
  const value = char(name, world);
  value.rawCard.data.name = name;
  return value;
};

async function runAll(f, action, { answer = true, cancelAfter = Infinity, discovery = f.discovery() } = {}) {
  const asked = [];
  const progress = [];
  const result = await f.service[action]({ discovery, adapter: f.adapter,
    confirm: async (counts) => { asked.push(counts); return answer; },
    onProgress: ({ done }) => progress.push(done),
    isCancelled: () => progress.length >= cancelAfter });
  return { result, asked, progress };
}

const outcome = (result) => Object.fromEntries(result.results.map((entry) => [entry.displayName, entry]));

test("Push All sends every ST-only entity, WorldBooks first, and binds them without Manager rereads", async () => {
  const f = fixture();
  f.local("character", "Linked.png", charNamed("Linked", "Lore"));
  f.local("worldbook", "Lore", wb());
  f.local("character", "Plain.png", charNamed("Plain"));
  f.stAvatars.set("Plain.png", new Blob(["plain picture"], { type: "image/png" }));
  // Already in Manager: Push All leaves both sides alone.
  f.local("character", "Bound.png", charNamed("Bound"));
  f.remote("character", "m1", canonical("character", charNamed("Bound edited in Manager")));
  f.bind("character", "m1", "Bound.png");

  const { result, asked, progress } = await runAll(f, "pushAll");
  assert.deepEqual(asked, [{ characters: 2, worldbooks: 1 }]);
  assert.deepEqual(progress, [1, 2, 3]);
  assert.deepEqual(f.calls.manager.filter((call) => call.startsWith("POST")), ["POST worldbooks", "POST characters", "POST characters"]);
  assert.deepEqual(f.calls.manager.filter((call) => call.startsWith("GET ") && call !== "GET manifest"), [],
    "a created entity is not read back from Manager");
  const results = outcome(result);
  assert.deepEqual(Object.values(results).map((entry) => entry.status), ["pushed", "pushed", "pushed"]);

  const { bindings } = await f.store.read();
  const bookId = results.Lore.managerId;
  assert.equal(f.remotes.get(`character:${results.Linked.managerId}`).canonical.relationship.worldBookId, bookId);
  for (const name of ["Lore", "Linked", "Plain"]) {
    const { entityType, managerId, localId } = results[name];
    assert.deepEqual(bindings[`${entityType}:${managerId}`],
      { managerId, localId, baseHash: f.remotes.get(`${entityType}:${managerId}`).contentHash });
  }
  assert.deepEqual(bindings["character:m1"], { managerId: "m1", localId: "Bound.png", baseHash: null });
  assert.equal(f.remotes.get("character:m1").revision, 1);
  assert.equal(readEmbeddedManagerId(f.locals.get("character:Plain.png").rawCard), results.Plain.managerId);
  assert.equal(await f.managerAvatars.get(results.Plain.managerId).text(), "plain picture");
  assert.deepEqual(result.frontendChanges.map((change) => [change.localId, change.created]).sort(),
    [["Linked.png", false], ["Plain.png", false]]);
});

test("Push All fails only a Character whose WorldBook is not in Manager; a declined Push All writes nothing", async () => {
  const f = fixture();
  f.local("character", "Orphan.png", charNamed("Orphan", "Missing Lore"));
  f.local("character", "Plain.png", charNamed("Plain"));
  const declined = await runAll(f, "pushAll", { answer: false });
  assert.equal(declined.result.cancelled, true);
  assert.deepEqual(f.calls.manager.filter((call) => !call.startsWith("GET")), []);
  assert.deepEqual((await f.store.read()).bindings, {});

  const { result } = await runAll(f, "pushAll");
  const results = outcome(result);
  assert.equal(results.Orphan.status, "failed");
  assert.match(results.Orphan.message, /linked WorldBook is not in Manager/);
  assert.equal(results.Plain.status, "pushed");
  assert.deepEqual(f.calls.manager.filter((call) => call.startsWith("POST")), ["POST characters"]);
});

test("Push All writes bindings in checkpoints, not once per entity", async () => {
  const f = fixture();
  for (let index = 0; index < 45; index += 1) f.local("character", `C${index}.png`, charNamed(`C${index}`));
  let updates = 0;
  const update = f.store.update;
  f.store.update = async (fn) => { updates += 1; return update(fn); };
  const { result } = await runAll(f, "pushAll");
  assert.equal(result.results.filter((entry) => entry.status === "pushed").length, 45);
  assert.equal(Object.keys((await f.store.read()).bindings).length, 45);
  assert.ok(updates <= 4, `${updates} sync state writes for 45 entities`);
});

test("stopping Push All keeps what finished; a binding another tab changed fails only its item", async () => {
  const f = fixture();
  for (let index = 0; index < 8; index += 1) f.local("character", `C${index}.png`, charNamed(`C${index}`));
  const { result } = await runAll(f, "pushAll", { cancelAfter: 1 });
  assert.equal(result.cancelled, true);
  assert.ok(result.results.length < 8, `${result.results.length} of 8 ran`);
  const bound = Object.values((await f.store.read()).bindings).map((binding) => binding.localId).sort();
  assert.deepEqual(bound, result.results.filter((entry) => entry.status === "pushed").map((entry) => entry.localId).sort());

  const g = fixture();
  g.local("character", "Mine.png", charNamed("Mine"));
  g.local("character", "Other.png", charNamed("Other"));
  const update = g.store.update;
  let first = true;
  g.store.update = async (fn) => {
    if (first) { first = false; g.bind("character", "other-tab", "Mine.png"); }
    return update(fn);
  };
  const conflicted = outcome((await runAll(g, "pushAll")).result);
  assert.equal(conflicted.Mine.status, "failed");
  assert.match(conflicted.Mine.message, /Another tab or device changed this binding/);
  assert.equal(conflicted.Other.status, "pushed");
  const { bindings } = await g.store.read();
  assert.equal(bindings["character:other-tab"].localId, "Mine.png");
  assert.equal(Object.values(bindings).filter((binding) => binding.localId === "Mine.png").length, 1);
});

test("Pull All copies Manager-only entities, skips a same-name WorldBook with its Characters, and never rereads Manager", async () => {
  const f = linkedFixture();
  f.remote("worldbook", "taken", canonical("worldbook", wb("theirs", "Taken")));
  f.remote("character", "c", { ...canonical("character", charNamed("Uses Taken")), relationship: { worldBookId: "taken" } });
  f.remote("character", "d", canonical("character", charNamed("Plain")));
  f.managerAvatars.set("d", new Blob(["manager picture"], { type: "image/png" }));
  f.local("worldbook", "Taken", wb("mine", "Taken"));
  // Already in ST: Pull All leaves it alone.
  f.local("character", "Bound.png", charNamed("Bound"));
  f.remote("character", "m1", canonical("character", charNamed("Bound edited in Manager")));
  f.bind("character", "m1", "Bound.png");

  const { result, asked } = await runAll(f, "pullAll");
  assert.deepEqual(asked, [{ characters: 4, worldbooks: 2 }]);
  const statuses = result.results.map((entry) => [entry.entityType, entry.managerId ?? entry.displayName, entry.status]);
  assert.deepEqual(statuses.filter(([type]) => type === "worldbook"), [["worldbook", "book", "pulled"], ["worldbook", "Taken", "skipped"]]);
  assert.deepEqual(statuses.filter(([type]) => type === "character").map(([, id, status]) => `${id}:${status}`).sort(),
    ["Uses Taken:skipped", "a:pulled", "b:pulled", "d:pulled"]);
  assert.match(outcome(result)["Uses Taken"].message, /Its WorldBook "Taken" is not in SillyTavern/);
  assert.match(outcome(result).Taken.message, /already named "Taken"; Pull it individually/);

  const reads = f.calls.manager.filter((call) => call.startsWith("GET ") && call !== "GET manifest" && !call.endsWith("/avatar"));
  assert.deepEqual([...reads].sort(), ["GET characters/a", "GET characters/b", "GET characters/c", "GET characters/d",
    "GET worldbooks/book", "GET worldbooks/taken"], "one Manager read per entity");

  const { bindings } = await f.store.read();
  for (const id of ["a", "b", "d"]) assert.equal(bindings[`character:${id}`].baseHash, f.remotes.get(`character:${id}`).contentHash);
  assert.equal(bindings["worldbook:book"].baseHash, f.remotes.get("worldbook:book").contentHash);
  assert.equal(bindings["worldbook:taken"], undefined);
  const bookLocal = bindings["worldbook:book"].localId;
  assert.equal(f.locals.get(`character:${bindings["character:a"].localId}`).rawCard.data.extensions.world, decodeURIComponent(bookLocal));
  assert.equal(await f.stAvatars.get(bindings["character:d"].localId).text(), "manager picture");
  assert.equal(f.calls.writes.some((write) => write === "worldbook:Taken" || write === "character:Bound.png"), false);
  assert.deepEqual(bindings["character:m1"], { managerId: "m1", localId: "Bound.png", baseHash: null });
  assert.ok(result.frontendChanges.every((change) => change.created));
  assert.equal(result.frontendChanges.length, 4);
});

test("Pull All leaves a bound ST copy that reappeared after Refresh alone; a declined Pull All writes nothing", async () => {
  const f = fixture();
  f.remote("character", "m2", canonical("character", charNamed("Back")));
  f.bind("character", "m2", "Back.png");
  const discovery = f.discovery();
  const declined = await runAll(f, "pullAll", { answer: false, discovery });
  assert.equal(declined.result.cancelled, true);
  assert.deepEqual(f.calls.creates, []);

  f.local("character", "Back.png", charNamed("Back, edited in ST"));
  const { result } = await runAll(f, "pullAll", { discovery });
  assert.equal(result.results[0].status, "skipped");
  assert.match(result.results[0].message, /reappeared after Refresh/);
  assert.deepEqual(f.calls.creates, []);
  assert.deepEqual(f.calls.writes, []);
});
