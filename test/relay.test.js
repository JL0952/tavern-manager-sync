import assert from "node:assert/strict";
import test from "node:test";
import { createRelayService, relayBase, relayStatus } from "../relay-service.js";
import { createStRelayGateway } from "../st-relay.js";
import { relayContentHash } from "../sync-core/relayContent.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const fileText = (value) => JSON.stringify(value, null, 4);

// SillyTavern's side, as the gateway reads it: { presets, themes, regex }.
function fakeSt() {
  const files = { presets: new Map(), themes: new Map(), regex: new Map() };
  const calls = { writes: [], downloads: [] };
  return {
    files, calls,
    add(type, name, value, contents = fileText(value)) { files[type].set(name, { name, contents, value }); },
    async list() {
      return Object.fromEntries(Object.entries(files).map(([type, map]) => [type, [...map.values()].map((item) => structuredClone(item))]));
    },
    // SillyTavern sanitizes preset names; the fake renames "bad:name".
    async writePreset(name, value, { select }) {
      calls.writes.push(["presets", name, select]);
      const saved = name.replace(":", "-");
      files.presets.set(saved, { name: saved, contents: fileText(value), value: structuredClone(value) });
    },
    async writeTheme(name, value) {
      calls.writes.push(["themes", name]);
      files.themes.set(name, { name, contents: fileText({ ...value, name }), value: { ...value, name } });
    },
    downloadRegex(scripts) { calls.downloads.push(structuredClone(scripts)); },
  };
}

// Manager's relay API, holding files as text and recording requests.
function fakeManager() {
  const items = { presets: [], themes: [], regex: [] };
  const requests = [];
  let sequence = 0;
  return {
    items, requests,
    add(type, name, value, { contents = fileText(value), contentHash = relayContentHash(type, value) } = {}) {
      items[type].push({ id: `m${++sequence}`, type, name, size: contents.length, contentHash, source: "file", updatedAt: "2026-10-03T00:00:00.000Z", contents });
    },
    async fetch(url, options = {}) {
      const parsed = new URL(url);
      const method = options.method ?? "GET";
      const [type, id] = parsed.pathname.replace("/api/relay/v1/", "").split("/").map(decodeURIComponent);
      requests.push({ method, type, id, query: Object.fromEntries(parsed.searchParams), headers: options.headers ?? {} });
      const list = items[type];
      if (method === "GET" && !id) return json({ items: list.map(({ contents: _contents, ...item }) => item) });
      if (method === "GET") {
        const item = list.find((candidate) => candidate.id === id);
        return item ? new Response(item.contents) : json({ error: { code: "relay_not_found", message: "Gone." } }, 404);
      }
      const name = parsed.searchParams.get("name");
      const existing = list.find((item) => item.name === name);
      const onConflict = parsed.searchParams.get("onConflict");
      if (existing && onConflict === "fail") {
        return json({ error: { code: "relay_name_conflict", message: `A file named "${name}" already exists.`, existing } }, 409);
      }
      const item = { id: existing?.id ?? `m${++sequence}`, type, name, size: options.body.length,
        contentHash: options.headers["X-Content-Hash"], source: options.headers["X-Relay-Source"], updatedAt: "2026-10-04T00:00:00.000Z", contents: options.body };
      if (existing) list.splice(list.indexOf(existing), 1, item);
      else list.push(item);
      return json({ outcome: existing ? "replaced" : "created", item }, existing ? 200 : 201);
    },
  };
}

function fixture({ endpoint = "http://127.0.0.1:3000/api/sync/v1" } = {}) {
  const st = fakeSt();
  const managerApi = fakeManager();
  const service = createRelayService({
    st,
    fetch: (...args) => managerApi.fetch(...args),
    sidecarStore: { read: async () => ({ schemaVersion: 1, config: { endpoint }, bindings: {} }) },
  });
  return { st, manager: managerApi, service };
}

const statuses = (rows) => Object.fromEntries(rows.map((row) => [row.name, row.status]));

test("the relay API is found beside the sync API", () => {
  assert.equal(relayBase("http://192.168.1.5:3000/api/sync/v1"), "http://192.168.1.5:3000/api/relay/v1");
  assert.equal(relayStatus({ contentHash: "a" }, { contentHash: "a" }), "same");
  assert.equal(relayStatus({ contentHash: "a" }, { contentHash: "b" }), "different");
  assert.equal(relayStatus({ contentHash: "a" }, undefined), "st_only");
  assert.equal(relayStatus(undefined, { contentHash: "a" }), "manager_only");
});

test("files pair by name; formatting and a kept copy's theme name do not count as differences", async () => {
  const f = fixture();
  f.st.add("presets", "Daily", { temperature: 1 });
  f.manager.add("presets", "Daily", { temperature: 1 }, { contents: '{"temperature":1}' });
  f.st.add("presets", "Long", { temperature: 1 });
  f.manager.add("presets", "Long", { temperature: 0.7 });
  f.st.add("presets", "Mine", { temperature: 1 });
  f.manager.add("presets", "Theirs", { temperature: 1 });
  f.st.add("themes", "Night (2)", { name: "Night (2)", blur: 1 });
  f.manager.add("themes", "Night (2)", { name: "Night", blur: 1 });

  const rows = await f.service.refresh();
  assert.deepEqual(statuses(rows.presets), { Daily: "same", Long: "different", Mine: "st_only", Theirs: "manager_only" });
  assert.deepEqual(statuses(rows.themes), { "Night (2)": "same" });
  assert.deepEqual(rows.regex, []);
  const daily = rows.presets.find((row) => row.name === "Daily");
  assert.deepEqual(Object.keys(daily).sort(), ["local", "manager", "name", "status", "type"]);
  assert.equal(daily.manager.size, 17);
});

test("Push creates or, once confirmed, replaces Manager's copy; an equal file is not sent", async () => {
  const f = fixture();
  f.st.add("presets", "New", { temperature: 1 }, '{\n  "temperature": 1\n}');
  f.st.add("presets", "Changed", { temperature: 1 });
  f.manager.add("presets", "Changed", { temperature: 0.5 });
  f.st.add("presets", "Equal", { a: 1 });
  f.manager.add("presets", "Equal", { a: 1 });

  assert.deepEqual(await f.service.push({ type: "presets", name: "New" }), { type: "presets", name: "New", status: "pushed" });
  const created = f.manager.items.presets.find((item) => item.name === "New");
  assert.equal(created.contents, '{\n  "temperature": 1\n}', "the file goes as SillyTavern saved it");
  assert.equal(created.source, "sillytavern");
  assert.equal(created.contentHash, relayContentHash("presets", { temperature: 1 }));

  await assert.rejects(f.service.push({ type: "presets", name: "Changed" }), { code: "overwrite_confirmation_required" });
  assert.equal((await f.service.push({ type: "presets", name: "Changed", confirmOverwrite: true })).status, "pushed");
  assert.equal(f.manager.requests.at(-1).query.onConflict, "replace");
  assert.equal(f.manager.items.presets.find((item) => item.name === "Changed").contentHash, relayContentHash("presets", { temperature: 1 }));

  const uploads = f.manager.requests.filter((request) => request.method === "POST").length;
  assert.equal((await f.service.push({ type: "presets", name: "Equal" })).status, "unchanged");
  assert.equal(f.manager.requests.filter((request) => request.method === "POST").length, uploads);
  await assert.rejects(f.service.push({ type: "presets", name: "Nowhere" }), /no longer in SillyTavern or Manager/);
});

test("Pull writes a preset and selects it, saves a theme under its Manager name, and downloads regex", async () => {
  const f = fixture();
  f.manager.add("presets", "Remote", { temperature: 0.3 });
  f.manager.add("themes", "Night (2)", { name: "Night", blur: 2 });
  f.manager.add("regex", "Trim", { id: "x", scriptName: "Trim", findRegex: "/\\s+$/" });

  assert.deepEqual(await f.service.pull({ type: "presets", name: "Remote" }), { type: "presets", name: "Remote", status: "pulled", reloadNeeded: false });
  assert.deepEqual(f.st.files.presets.get("Remote").value, { temperature: 0.3 });
  assert.equal((await f.service.pull({ type: "themes", name: "Night (2)" })).reloadNeeded, true);
  assert.equal(f.st.files.themes.get("Night (2)").value.name, "Night (2)", "never written over the theme called Night");
  assert.equal((await f.service.pull({ type: "regex", name: "Trim" })).status, "downloaded");
  assert.deepEqual(f.st.calls.downloads, [[{ id: "x", scriptName: "Trim", findRegex: "/\\s+$/" }]]);
  assert.deepEqual(f.st.calls.writes, [["presets", "Remote", true], ["themes", "Night (2)"]]);
});

test("Pull overwrites a different SillyTavern copy only once confirmed, and checks what it wrote", async () => {
  const f = fixture();
  f.st.add("presets", "Shared", { temperature: 1 });
  f.manager.add("presets", "Shared", { temperature: 0.2 });
  await assert.rejects(f.service.pull({ type: "presets", name: "Shared" }), { code: "overwrite_confirmation_required" });
  assert.deepEqual(f.st.calls.writes, []);
  assert.equal((await f.service.pull({ type: "presets", name: "Shared", confirmOverwrite: true })).status, "pulled");

  f.manager.add("presets", "bad:name", { temperature: 0.9 });
  await assert.rejects(f.service.pull({ type: "presets", name: "bad:name" }), /does not show the same content under that name/);

  f.manager.add("presets", "Tampered", { temperature: 1 }, { contentHash: relayContentHash("presets", { temperature: 2 }) });
  await assert.rejects(f.service.pull({ type: "presets", name: "Tampered" }), /does not match its recorded content/);
  f.manager.add("presets", "Broken", null, { contents: "{oops", contentHash: relayContentHash("presets", {}) });
  await assert.rejects(f.service.pull({ type: "presets", name: "Broken" }), /not valid JSON/);
});

test("Push All sends only files Manager lacks, after one confirmation, and leaves a name Manager gained meanwhile", async () => {
  const f = fixture();
  for (const name of ["A", "B", "C"]) f.st.add("themes", name, { name, blur: 1 });
  f.st.add("themes", "Both", { name: "Both", blur: 1 });
  f.manager.add("themes", "Both", { name: "Both", blur: 9 });

  const declined = await f.service.pushAll({ type: "themes", confirm: async () => false });
  assert.deepEqual(declined, { type: "themes", total: 3, cancelled: true, results: [] });
  assert.equal(f.manager.requests.filter((request) => request.method === "POST").length, 0);

  // Another device pushes "B" while this batch runs.
  const managerFetch = f.manager.fetch;
  f.manager.fetch = async (url, options) => {
    if (options?.method === "POST" && new URL(url).searchParams.get("name") === "B") {
      f.manager.add("themes", "B", { name: "B", blur: 5 });
    }
    return managerFetch(url, options);
  };
  const asked = [];
  const progress = [];
  const result = await f.service.pushAll({ type: "themes", confirm: async (plan) => { asked.push(plan); return true; },
    onProgress: ({ done }) => progress.push(done) });
  assert.deepEqual(asked, [{ type: "themes", count: 3 }]);
  assert.deepEqual(progress, [1, 2, 3]);
  assert.deepEqual(result.results.map(({ name, status }) => [name, status]), [["A", "pushed"], ["B", "skipped"], ["C", "pushed"]]);
  assert.equal(f.manager.items.themes.find((item) => item.name === "Both").contentHash, relayContentHash("themes", { blur: 9 }), "Both is untouched");
});

test("Pull All brings in only Manager-only files without selecting, rechecks once, and can stop", async () => {
  const f = fixture();
  for (const name of ["One", "Two", "bad:three"]) f.manager.add("presets", name, { temperature: name.length });
  f.st.add("presets", "Local", { temperature: 1 });
  f.manager.add("presets", "Local", { temperature: 0 });

  const result = await f.service.pullAll({ type: "presets" });
  assert.equal(result.reloadNeeded, true);
  assert.deepEqual(result.results.map(({ name, status }) => [name, status]), [["bad:three", "failed"], ["One", "pulled"], ["Two", "pulled"]]);
  assert.match(result.results[0].message, /does not show the same content/);
  assert.ok(f.st.calls.writes.every(([, , select]) => select === false));
  assert.deepEqual(f.st.files.presets.get("Local").value, { temperature: 1 }, "a different local copy is never overwritten");

  const g = fixture();
  for (const name of ["A", "B", "C"]) g.manager.add("themes", name, { name, blur: 1 });
  let done = 0;
  const stopped = await g.service.pullAll({ type: "themes", onProgress: () => { done += 1; }, isCancelled: () => done >= 1 });
  assert.equal(stopped.cancelled, true);
  assert.deepEqual(stopped.results.map(({ name }) => name), ["A"]);
});

test("Pull All of regex scripts downloads one file for the Regex panel's Import", async () => {
  const f = fixture();
  f.manager.add("regex", "Hide", { id: "1", scriptName: "Hide" });
  f.manager.add("regex", "Trim", { id: "2", scriptName: "Trim" });
  f.st.add("regex", "Trim", { id: "local", scriptName: "Trim" });
  const result = await f.service.pullAll({ type: "regex" });
  assert.deepEqual(result.results.map(({ name, status }) => [name, status]), [["Hide", "downloaded"]]);
  assert.deepEqual(f.st.calls.downloads, [[{ id: "1", scriptName: "Hide" }]]);
  assert.equal(result.reloadNeeded, undefined);
});

test("without an endpoint nothing is requested", async () => {
  const f = fixture({ endpoint: null });
  await assert.rejects(f.service.refresh(), /Configure a Manager endpoint first/);
  await assert.rejects(f.service.pushAll({ type: "styles" }), /Unknown file type/);
  assert.equal(f.manager.requests.length, 0);
});

// SillyTavern's own side of the relay.
function gatewayFixture({ settings, regex = [] } = {}) {
  const requests = [];
  const events = [];
  const saved = [];
  const downloads = [];
  const context = {
    extensionSettings: { regex },
    eventTypes: { OAI_PRESET_IMPORT_READY: "oai_preset_import_ready" },
    eventSource: { emit: async (...args) => events.push(args) },
    getPresetManager: (apiId) => apiId === "openai" ? { savePreset: async (...args) => saved.push(args) } : null,
  };
  const gateway = createStRelayGateway({
    requestHeaders: () => ({ "X-CSRF-Token": "synthetic" }),
    getContext: () => context,
    download: (...args) => downloads.push(args),
    fetch: async (path, options) => {
      requests.push({ path, body: JSON.parse(options.body), headers: options.headers });
      return path === "/api/settings/get" ? json(settings) : new Response("OK");
    },
  });
  return { gateway, requests, events, saved, downloads, context };
}

test("SillyTavern's presets are its saved files, themes and regex scripts are written as it writes them", async () => {
  const presetText = '{\n    "temperature": 1\n}';
  const { gateway, requests } = gatewayFixture({
    settings: { openai_setting_names: ["Daily"], openai_settings: [presetText], themes: [{ name: "Night", blur: 1 }, { blur: 2 }] },
    regex: [{ id: "1", scriptName: "Trim" }, { id: "2", scriptName: "Trim" }, { id: "3" }],
  });
  const files = await gateway.list();
  assert.deepEqual(files.presets, [{ name: "Daily", contents: presetText, value: { temperature: 1 } }]);
  assert.deepEqual(files.themes, [{ name: "Night", contents: fileText({ name: "Night", blur: 1 }), value: { name: "Night", blur: 1 } }]);
  assert.deepEqual(files.regex.map(({ name, contents }) => [name, contents]),
    [["Trim", fileText({ id: "1", scriptName: "Trim" })], ["Trim (2)", fileText({ id: "2", scriptName: "Trim" })]]);
  assert.equal(requests[0].headers["X-CSRF-Token"], "synthetic");

  const broken = gatewayFixture({ settings: { openai_setting_names: ["A"], openai_settings: [], themes: [] } });
  await assert.rejects(broken.gateway.list(), /do not list presets and themes/);
});

test("a pulled preset is announced like an import, saved through the preset manager, and selected only alone", async () => {
  const { gateway, events, saved } = gatewayFixture();
  await gateway.writePreset("Remote", { temperature: 1 }, { select: true });
  await gateway.writePreset("Batch", { temperature: 2 }, { select: false });
  assert.deepEqual(events, [
    ["oai_preset_import_ready", { data: { temperature: 1 }, presetName: "Remote" }],
    ["oai_preset_import_ready", { data: { temperature: 2 }, presetName: "Batch" }],
  ]);
  assert.deepEqual(saved, [["Remote", { temperature: 1 }, { skipUpdate: false }], ["Batch", { temperature: 2 }, { skipUpdate: true }]]);
});

test("a pulled theme is saved under its Manager name; regex scripts download as SillyTavern exports them", async () => {
  const { gateway, requests, downloads } = gatewayFixture();
  await gateway.writeTheme("Night (2)", { name: "Night", blur: 1 });
  assert.deepEqual(requests.at(-1), { path: "/api/themes/save", body: { name: "Night (2)", blur: 1 }, headers: requests.at(-1).headers });

  gateway.downloadRegex([{ id: "1", scriptName: "Trim: end" }]);
  gateway.downloadRegex([{ id: "1", scriptName: "A" }, { id: "2", scriptName: "B" }]);
  assert.deepEqual(downloads[0], [fileText({ id: "1", scriptName: "Trim: end" }), "regex-Trim- end.json", "application/json"]);
  assert.equal(downloads[1][0], fileText([{ id: "1", scriptName: "A" }, { id: "2", scriptName: "B" }]));
  assert.match(downloads[1][1], /^regex-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/);
  assert.throws(() => gateway.downloadRegex([]), /at least one/);
});
