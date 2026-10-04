import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSyncPanel } from "../panel.js";

const extensionRoot = fileURLToPath(new URL("..", import.meta.url));


class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.value = ""; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(event, fn) { this.listeners[event] = fn; }
  setAttribute(name, value) { this.attributes = { ...this.attributes, [name]: value }; }
  set innerHTML(html) { this.children = [...html.matchAll(/data-role="([^"]+)"/g)].map(([, role]) => {
    const child = new Element(["endpoint", "password", "search"].includes(role) ? "input" : "div"); child.dataset.role = role; return child;
  }); }
  descendants() { return this.children.flatMap(c => [c, ...c.descendants()]); }
  querySelector(selector) { const role = selector.match(/data-role="([^"]+)"/)?.[1]; return this.descendants().find(c => c.dataset.role === role); }
  querySelectorAll(selector) { return this.descendants().filter(c => c.tagName === selector); }
  click() { return this.disabled || this.hidden ? undefined : this.listeners.click?.({ target: this }); }
  input(value) { this.value = value; return this.listeners.input?.({ target: this }); }
  text() { return [this.textContent, ...this.children.map(child => child.text())].filter(Boolean).join(" "); }
}

const tagImportSetting = { ASK: 1, NONE: 2, ALL: 3, ONLY_EXISTING: 4 };

async function uiFixture() {
  const container = new Element("div"); const calls = []; const reconciled = []; const events = []; const confirmations = [];
  const listeners = new Map(); const wiring = {};
  let nextRows = [];
  let onAction = () => ({ status: "pulled", frontendChanges: [] });
  let confirmation = true;
  let tagSetting = tagImportSetting.ASK;
  const batchesSeen = [];
  // A batch's service asks the popup through `confirm` before it changes anything.
  let onBatch = async (path, { confirm, onProgress }) => {
    const counts = { characters: 2, worldbooks: 1 };
    if (!(await confirm(counts))) return { ...counts, cancelled: true, results: [], frontendChanges: [] };
    onProgress({ done: 3, total: 3 });
    return { ...counts, cancelled: false, results: [
      { status: path === "/push-all" ? "pushed" : "pulled", entityType: "worldbook", displayName: "Lore" },
      { status: "skipped", entityType: "character", displayName: "Kept", message: "Pull it individually." },
      { status: "failed", entityType: "character", displayName: "Broken", message: "HTTP 500." },
    ], frontendChanges: [{ entityType: "worldbook", localId: "Lore", created: true }] };
  };
  let emitOnSave = true;
  // The file relay: rows per type, and what each action answers.
  let relayRows = { presets: [], themes: [], regex: [] };
  let relayFailure = null;
  let onRelay = async (method, args) => {
    if (method === "push") return { type: args.type, name: args.name, status: "pushed" };
    if (method === "pull") {
      return args.type === "regex"
        ? { type: args.type, name: args.name, status: "downloaded" }
        : { type: args.type, name: args.name, status: "pulled", reloadNeeded: args.type === "themes" };
    }
    if (!(await args.confirm({ type: args.type, count: 2 }))) return { type: args.type, total: 2, cancelled: true, results: [] };
    args.onProgress({ type: args.type, done: 2, total: 2 });
    const done = method === "pushAll" ? "pushed" : args.type === "regex" ? "downloaded" : "pulled";
    return { type: args.type, total: 2, results: [{ name: "Daily", status: done }, { name: "Broken", status: "failed", message: "HTTP 500." }],
      ...(method === "pullAll" && args.type !== "regex" ? { reloadNeeded: true } : {}) };
  };
  const relay = Object.fromEntries(["push", "pull", "pushAll", "pullAll"].map((method) => [method, async (args) => {
    calls.push({ path: `/relay/${method}`, body: args });
    return onRelay(method, args);
  }]));
  relay.refresh = async (types) => {
    calls.push({ path: "/relay/refresh", body: types });
    if (relayFailure) throw new Error(relayFailure);
    return Object.fromEntries((types ?? Object.keys(relayRows)).map((type) => [type, relayRows[type]]));
  };
  const adapter = { synthetic: "adapter" };
  const record = (path, { adapter: given, ...body }) => {
    assert.equal(given, adapter, "every content action uses the native ST adapter");
    calls.push({ path, body });
    return onAction(path, body);
  };
  const recordBatch = (path, { adapter: given, ...body }) => {
    assert.equal(given, adapter, "every batch uses the native ST adapter");
    calls.push({ path, body });
    batchesSeen.push(body);
    return onBatch(path, body);
  };
  const service = {
    getConfiguration: async () => ({ endpoint: "http://synthetic.test/api/sync/v1", configured: true }),
    configure: async (body) => { calls.push({ path: "/config", body }); return { endpoint: body.endpoint, configured: true, signedIn: Boolean(body.password) }; },
    refresh: async ({ discovery }) => { calls.push({ path: "/refresh", body: discovery }); return { rows: nextRows }; },
    push: async (args) => record("/push", args),
    pull: async (args) => record("/pull", args),
    syncAll: async (args) => record("/sync-all", args),
    pushAll: async (args) => recordBatch("/push-all", args),
    pullAll: async (args) => recordBatch("/pull-all", args),
    renameLocal: async (body) => { calls.push({ path: "/rename", body }); return {}; },
  };
  const managerFetch = async () => { throw new Error("no Manager in this test"); };
  const source = (await readFile(`${extensionRoot}/index.js`, "utf8")).replace(/^import [^;]*;\n/gm, "");
  const context = { document: { readyState: "complete", getElementById: id => id === "extensions_settings" ? container : null,
    createElement: tag => new Element(tag) },
    eventSource: {
      on: (name, fn) => { events.push(name); listeners.set(name, [...(listeners.get(name) ?? []), fn]); },
      removeListener: (name, fn) => listeners.set(name, (listeners.get(name) ?? []).filter(x => x !== fn)),
    },
    event_types: { CHARACTER_RENAMED: "rename", SETTINGS_UPDATED: "settings_updated" },
    getRequestHeaders: () => ({ "X-CSRF-Token": "synthetic" }), uuidv4: () => "uuid",
    getContext: () => ({
      POPUP_TYPE: { CONFIRM: 2 }, POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
      powerUserSettings: { tag_import_setting: tagSetting },
      callGenericPopup: async (content, type, input, options) => {
        assert.equal(type, 2);
        confirmations.push({ text: content.text(), okButton: options.okButton, content });
        return (typeof confirmation === "function" ? confirmation(content) : confirmation) ? 1 : 0;
      },
    }),
    tag_import_setting: tagImportSetting,
    extension_settings: { synthetic: true },
    saveSettings: async () => { if (emitOnSave) for (const fn of listeners.get("settings_updated") ?? []) await fn(); },
    worldInfoCache: new Map(), reloadEditor() {}, updateWorldInfoList() {}, encodeLocalId: encodeURIComponent,
    createSillyTavernFrontendReconciler: () => ({
      reconcile: async change => { reconciled.push(change); },
      reconcileAll: async (changes, options) => { reconciled.push({ batch: changes, ...options }); },
    }),
    discoverSillyTavern: async () => ({ characters: [], worldbooks: [] }),
    createFileSidecarStore: (options) => { wiring.store = options; return { synthetic: "store" }; },
    createNativeStGateway: (options) => { wiring.gateway = options; return { synthetic: "gateway" }; },
    createMinimalSillyTavernAdapter: (gateway) => { wiring.adapterGateway = gateway; return adapter; },
    createManagerFetch: (options) => { wiring.managerFetch = options; return managerFetch; },
    createMinimalSyncService: (options) => { wiring.service = options; return service; },
    createStRelayGateway: (options) => { wiring.stRelay = options; return { synthetic: "st-relay" }; },
    createRelayService: (options) => { wiring.relay = options; return relay; },
    download: () => {},
    createSyncPanel,
  };
  vm.runInNewContext(source, context);
  await Promise.resolve();
  const panel = container.children[0];
  return { panel, calls, reconciled, events, confirmations, wiring, context, listeners, batchesSeen,
    rows(value) { nextRows = value; }, action(fn) { onAction = fn; }, batch(fn) { onBatch = fn; },
    confirm(value) { confirmation = value; }, emitOnSave(value) { emitOnSave = value; },
    tagSetting(value) { tagSetting = value; },
    relayRows(value) { relayRows = { ...relayRows, ...value }; }, relayAction(fn) { onRelay = fn; },
    relayFail(text) { relayFailure = text; },
    async tab(label) { await panel.querySelectorAll("button").find(b => b.textContent === label && b.className.startsWith("tms-tab")).click(); },
    rowTexts() { return this.field("rows").children.map(row => row.children[0].children[0].text()); },
    field(role) { return panel.querySelector(`[data-role="${role}"]`); },
    button(label) { return panel.querySelectorAll("button").find(b => b.textContent === label); },
  };
}

test("extension runs sync in the browser: no server-plugin bridge, only relative imports", async () => {
  // Tests run in Node and are never loaded by SillyTavern.
  const files = (await readdir(extensionRoot, { recursive: true }))
    .filter(file => file.endsWith(".js") && !file.startsWith("test/"));
  assert.equal(files.includes("bridge.js"), false);
  for (const file of files) {
    const source = await readFile(`${extensionRoot}/${file}`, "utf8");
    assert.doesNotMatch(source, /\/api\/plugins\//, file);
    for (const [, specifier] of source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gm)) {
      assert.match(specifier, /^\.{1,2}\//, `${file} imports ${specifier}`);
    }
  }
});

test("index wires the sync-state file, CSRF headers and UUIDs into the moved sync modules", async () => {
  const ui = await uiFixture();
  assert.equal(ui.wiring.store.legacySettings, ui.context.extension_settings);
  assert.equal(ui.wiring.store.requestHeaders, ui.context.getRequestHeaders);
  assert.equal(ui.wiring.service.sidecarStore.synthetic, "store");
  assert.equal(ui.wiring.gateway.requestHeaders, ui.context.getRequestHeaders);
  assert.equal(ui.wiring.gateway.uuid, ui.context.uuidv4);
  assert.equal(ui.wiring.adapterGateway.synthetic, "gateway");
  assert.equal(ui.wiring.relay.sidecarStore, ui.wiring.service.sidecarStore, "the relay uses the same Manager endpoint");
  assert.equal(ui.wiring.managerFetch.sidecarStore, ui.wiring.service.sidecarStore, "the token comes from the same sync state");
  assert.equal(typeof ui.wiring.service.fetch, "function");
  assert.equal(ui.wiring.relay.fetch, ui.wiring.service.fetch, "sync and relay requests both carry the Manager token");
  assert.equal(ui.wiring.relay.st.synthetic, "st-relay");
  assert.equal(ui.wiring.stRelay.requestHeaders, ui.context.getRequestHeaders);
  assert.equal(ui.wiring.stRelay.getContext, ui.context.getContext);
  assert.equal(ui.wiring.stRelay.download, ui.context.download);
  assert.equal(ui.field("endpoint").value, "http://synthetic.test/api/sync/v1");
  assert.deepEqual(ui.events, ["rename"]); // No edit listener can feed reconciliation back into sync.
});

test("sync state never saves ST settings, which every stale tab overwrites wholesale", async () => {
  for (const file of ["index.js", "panel.js", "relay-service.js", "st-relay.js"]) {
    const source = await readFile(`${extensionRoot}/${file}`, "utf8");
    assert.doesNotMatch(source, /saveSettings|createSettingsSidecarStore|\/api\/settings\/save/, file);
  }
});

test("Save and Character rename call the service directly", async () => {
  const ui = await uiFixture();
  ui.field("endpoint").value = " http://synthetic.test/api/sync/v1 ";
  await ui.button("Save").click();
  await ui.listeners.get("rename")[0]("Old Name.png", "New Name.png");
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls)), [
    { path: "/config", body: { endpoint: "http://synthetic.test/api/sync/v1", password: "" } },
    { path: "/rename", body: { oldLocalId: "Old%20Name.png", newLocalId: "New%20Name.png" } },
  ]);
});

test("Save signs in with a typed password once and never keeps it in the field", async () => {
  const ui = await uiFixture();
  assert.equal(ui.field("password").placeholder, "Only if Manager is on another device");
  ui.field("password").value = "synthetic pass";
  await ui.button("Save").click();
  assert.deepEqual(ui.calls.at(-1), { path: "/config", body: { endpoint: "http://synthetic.test/api/sync/v1", password: "synthetic pass" } });
  assert.equal(ui.field("password").value, "");
  assert.equal(ui.field("password").placeholder, "Signed in");
  assert.equal(ui.field("message").textContent, "Endpoint saved and signed in to Manager.");
});

test("extension declares scoped ST-themed CSS and an independently scrollable entity list", async () => {
  const manifest = JSON.parse(await readFile(`${extensionRoot}/manifest.json`, "utf8"));
  const css = await readFile(`${extensionRoot}/style.css`, "utf8");
  const source = await readFile(`${extensionRoot}/panel.js`, "utf8");
  assert.equal(manifest.css, "style.css");
  assert.match(source, /class="text_pole"/);
  assert.match(source, /class="inline-drawer"/);
  for (const variable of ["--SmartThemeBodyColor", "--SmartThemeBlurTintColor", "--SmartThemeBorderColor", "--mainFontFamily"]) {
    assert.match(css, new RegExp(variable));
  }
  assert.match(css, /#tavern_manager_sync \.tms-entity-list\s*\{[^}]*max-height:\s*18rem;[^}]*overflow-y:\s*auto;/s);
  assert.doesNotMatch(css, /(?:color|background(?:-color)?|border-color):\s*(?:#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i);
});

test("search filters display names case-insensitively within the open tab, and clearing restores rows", async () => {
  const ui = await uiFixture();
  ui.rows([
    { entityType: "character", localId: "alpha-local", managerId: "alpha-manager", displayName: "Alpha Hero", status: "synced" },
    { entityType: "worldbook", localId: "beta-local", managerId: null, displayName: "Beta Lore", status: "st_only" },
    { entityType: "character", localId: null, managerId: "gamma-manager", displayName: "Gamma Guide", status: "manager_only" },
  ]);
  await ui.button("Refresh").click();
  assert.deepEqual(ui.rowTexts(), ["Alpha Hero Synced", "Gamma Guide Manager only"]);

  ui.field("search").input("ALPHA");
  assert.deepEqual(ui.rowTexts(), ["Alpha Hero Synced"]);

  ui.field("search").input("missing");
  assert.equal(ui.field("rows").children.length, 0);
  assert.equal(ui.field("rows").textContent, "No matching entries.");
  ui.field("search").input("");
  assert.equal(ui.field("rows").children.length, 2);
  await ui.tab("WorldBooks");
  assert.deepEqual(ui.rowTexts(), ["Beta Lore ST only"]);
});

test("rows show a creator-notes line, search it, and an unsyncable row offers only Pull", async () => {
  const ui = await uiFixture();
  ui.rows([
    { entityType: "character", localId: "a", managerId: null, displayName: "Hero", creatorNotes: "Space version", status: "st_only" },
    { entityType: "character", localId: "b", managerId: null, displayName: "Hero", creatorNotes: "", status: "st_only" },
    { entityType: "character", localId: "c", managerId: "remote", displayName: "Broken", creatorNotes: "Has notes",
      error: "Character's Note depth must be an integer.", status: "error" },
  ]);
  await ui.button("Refresh").click();
  const [notes, plain, broken] = ui.field("rows").children.map(row => row.children[0].children);
  assert.equal(notes[1].className, "tms-entity-notes");
  assert.equal(notes[1].textContent, "Space version");
  assert.equal(notes[1].title, "Space version");
  assert.equal(plain.length, 1, "no notes, no line");
  assert.equal(broken[0].textContent, "Broken");
  assert.equal(broken[0].children[0].textContent, "Cannot sync");
  assert.equal(broken[0].children[0].className, "tms-badge tms-badge-problem");
  assert.equal(broken[1].className, "tms-entity-error");
  assert.equal(broken[1].textContent, "Character's Note depth must be an integer.");
  assert.deepEqual(ui.field("rows").children[2].children.slice(1).map(b => b.textContent), ["Pull"]);

  ui.field("search").input("space");
  assert.deepEqual(ui.field("rows").children.map(row => row.children[0].children[1]?.textContent), ["Space version"]);
});

test("avatar warnings follow the result message", async () => {
  const ui = await uiFixture();
  ui.rows([{ entityType: "character", localId: "local", managerId: "remote", displayName: "Bound", status: "different" }]);
  await ui.button("Refresh").click();
  ui.action(() => ({ status: "pulled", frontendChanges: [], warnings: ["Bound: avatar not written (HTTP 500)"] }));
  await ui.button("Pull").click();
  assert.equal(ui.field("message").textContent, "Pulled. Bound: avatar not written (HTTP 500)");
  ui.action(() => ({ results: [{ status: "pushed", warnings: ["A: avatar not sent (x)"] }, { status: "skipped" }], frontendChanges: [] }));
  await ui.button("Sync All").click();
  assert.match(ui.field("message").textContent, /skipped\. A: avatar not sent \(x\)$/);
});

test("real UI handlers send only each row's source; Manager-only Pull and ST-only Push are reachable", async () => {
  const ui = await uiFixture();
  ui.rows([{ entityType: "character", managerId: "remote", localId: null, displayName: "Remote", status: "manager_only" },
    { entityType: "character", localId: "local", managerId: null, displayName: "Local", status: "st_only" }]);
  await ui.button("Refresh").click();
  assert.equal(ui.panel.querySelectorAll("select").length, 0);
  await ui.button("Pull").click(); await ui.button("Push").click();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.filter(c => ["/pull", "/push"].includes(c.path)))), [
    { path: "/pull", body: { entityType: "character", managerId: "remote" } },
    { path: "/push", body: { entityType: "character", localId: "local" } },
  ]);
});

test("every Push is confirmed first; a row Manager has is sent as one confirmed overwrite", async () => {
  const ui = await uiFixture();
  ui.rows([{ entityType: "character", localId: "local", managerId: "remote", displayName: "Bound <b>", status: "st_changed" }]);
  await ui.button("Refresh").click();
  ui.action(() => ({ status: "pushed", frontendChanges: [] }));
  await ui.button("Push").click();
  const requests = ui.calls.filter(call => call.path === "/push").map(call => call.body);
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [
    { entityType: "character", localId: "local", confirmOverwrite: true },
  ]);
  assert.equal(ui.confirmations.length, 1);
  assert.equal(ui.confirmations[0].okButton, "Push");
  // Names are text, never markup.
  assert.match(ui.confirmations[0].text, /Push Character "Bound <b>"\? Manager's copy will be replaced .*avatar included/);
  assert.match(ui.confirmations[0].text, /linked WorldBook is not in Manager yet, that WorldBook is pushed too/);
});

test("an ST-only Push asks to create, and asks again only if Manager unexpectedly needs an overwrite", async () => {
  const ui = await uiFixture();
  ui.rows([{ entityType: "worldbook", localId: "Lore", managerId: null, displayName: "Lore", status: "st_only" }]);
  await ui.button("Refresh").click();
  await ui.tab("WorldBooks");
  let pushes = 0;
  ui.action((path) => {
    if (path === "/push" && ++pushes === 1) {
      throw Object.assign(new Error("confirmation needed"), { code: "overwrite_confirmation_required" });
    }
    return { status: "pushed", frontendChanges: [] };
  });
  await ui.button("Push").click();
  const requests = ui.calls.filter(call => call.path === "/push").map(call => call.body);
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [
    { entityType: "worldbook", localId: "Lore" },
    { entityType: "worldbook", localId: "Lore", confirmOverwrite: true },
  ]);
  assert.deepEqual(ui.confirmations.map(c => c.text), [
    'Push WorldBook "Lore" to Manager as a new WorldBook?',
    "Push will overwrite existing Manager content with the SillyTavern version. Continue?",
  ]);
});

test("declining a Push confirmation sends nothing", async () => {
  for (const [status, managerId] of [["st_only", null], ["st_changed", "remote"]]) {
    const ui = await uiFixture(); ui.confirm(false);
    ui.rows([{ entityType: "character", localId: "local", managerId, displayName: "Bound", status }]);
    await ui.button("Refresh").click();
    await ui.button("Push").click();
    assert.equal(ui.calls.filter(call => call.path === "/push").length, 0);
    assert.equal(ui.field("message").textContent, "Push cancelled.");
  }
});

test("Sync All retries only after one overwrite confirmation", async () => {
  const ui = await uiFixture();
  let attempts = 0;
  ui.action((path) => {
    if (path === "/sync-all" && ++attempts === 1) {
      throw Object.assign(new Error("confirmation needed"), { code: "overwrite_confirmation_required" });
    }
    return { results: [], frontendChanges: [] };
  });
  await ui.button("Sync All").click();
  const requests = ui.calls.filter(call => call.path === "/sync-all").map(call => call.body);
  assert.equal(requests.length, 2);
  assert.equal(Object.hasOwn(requests[0], "confirmOverwrite"), false);
  assert.equal(requests[1].confirmOverwrite, true);
  assert.deepEqual(Object.keys(requests[0]), ["discovery"]);
  assert.equal(ui.confirmations.length, 1);
});

test("bound row actions still submit only source and Pull reconciles before Refresh", async () => {
  const ui = await uiFixture(); ui.rows([{ entityType: "character", localId: "local", managerId: "remote", displayName: "Bound", status: "different" }]);
  await ui.button("Refresh").click();
  ui.action(() => ({ status: "pulled", frontendChanges: [{ entityType: "character", localId: "new", created: true }] }));
  await ui.button("Pull").click();
  assert.equal(ui.reconciled.length, 1);
  assert.equal(ui.reconciled[0].created, true);
  const body = ui.calls.find(c => c.path === "/pull").body;
  assert.deepEqual(Object.keys(body).sort(), ["entityType", "managerId"]);
  assert.equal(ui.calls.at(-1).path, "/refresh");
});

test("WB choice resumes the original Manager source; Cancel does not send a second Pull", async () => {
  for (const choice of ["Cancel", "Use existing", "Import duplicate"]) {
    const ui = await uiFixture(); ui.rows([{ entityType: "character", managerId: "original", displayName: "Remote", status: "manager_only" }]);
    await ui.button("Refresh").click(); let requests = 0;
    ui.action(() => {
      if (++requests === 1) throw Object.assign(new Error("choice"), { code: "worldbook_name_conflict",
        details: { managerId: "wb", displayName: "Lore", candidates: [{ localId: "book", displayName: "Lore" }] } });
      return { status: "pulled", frontendChanges: [] };
    });
    const pending = ui.button("Pull").click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ui.button("Pull").disabled, true);
    await ui.button(choice).click(); await pending;
    assert.equal(requests, choice === "Cancel" ? 1 : 2);
    if (choice !== "Cancel") {
      const last = ui.calls.filter(c => c.path === "/pull").at(-1).body;
      assert.equal(last.managerId, "original"); assert.equal(last.worldbookChoice.managerId, "wb");
      assert.equal(Object.hasOwn(last, "localId"), false);
    }
  }
});

test("Push All asks once with the counts, then reconciles once and refreshes", async () => {
  const ui = await uiFixture();
  await ui.button("Push All").click();
  const [batch] = ui.batchesSeen;
  assert.deepEqual(Object.keys(batch).sort(), ["confirm", "discovery", "isCancelled", "onProgress"]);
  assert.equal(ui.confirmations.length, 1);
  assert.equal(ui.confirmations[0].okButton, "Push All");
  assert.match(ui.confirmations[0].text, /Push All sends 2 Characters and 1 WorldBook that exist only in SillyTavern/);
  assert.match(ui.confirmations[0].text, /nothing already in Manager is changed/);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.reconciled)), [
    { batch: [{ entityType: "worldbook", localId: "Lore", created: true }], importSetting: null },
  ]);
  assert.equal(ui.calls.at(-1).path, "/refresh");
  const text = ui.field("message").textContent;
  assert.match(text, /^Push All: 1 pushed, 1 skipped, 1 failed\./);
  assert.match(text, /Failed: Broken: HTTP 500\./);
  assert.match(text, /Skipped: Kept: Pull it individually\./);
});

test("declining Push All or Pull All changes nothing", async () => {
  for (const label of ["Push All", "Pull All"]) {
    const ui = await uiFixture(); ui.confirm(false);
    await ui.button(label).click();
    assert.equal(ui.reconciled.length, 0);
    assert.equal(ui.field("message").textContent, `${label} cancelled.`);
    assert.equal(ui.calls.some(call => call.path === "/refresh"), false);
  }
});

test("a batch with nothing to copy says so without asking", async () => {
  const ui = await uiFixture();
  ui.batch(async () => ({ characters: 0, worldbooks: 0, results: [], frontendChanges: [] }));
  await ui.button("Pull All").click();
  assert.equal(ui.confirmations.length, 0);
  assert.equal(ui.field("message").textContent, "Pull All: nothing exists only in Manager.");
});

test("Pull All asks for tags once when ST would ask per Character, and passes that choice on", async () => {
  const ui = await uiFixture();
  ui.confirm((content) => {
    const select = content.descendants().find(child => child.tagName === "select");
    select.value = "4"; // Import existing tags only
    return true;
  });
  await ui.button("Pull All").click();
  assert.match(ui.confirmations[0].text, /Pull All copies 2 Characters and 1 WorldBook that exist only in Manager/);
  assert.match(ui.confirmations[0].text, /skipped, with the Characters that use it/);
  assert.match(ui.confirmations[0].text, /Tags of the new Characters/);
  assert.equal(ui.reconciled[0].importSetting, 4);
  assert.match(ui.field("message").textContent, /^Pull All: 1 pulled/);

  const decided = await uiFixture(); decided.tagSetting(3); // ST already imports all tags
  await decided.button("Pull All").click();
  assert.doesNotMatch(decided.confirmations[0].text, /Tags of the new Characters/);
  assert.equal(decided.reconciled[0].importSetting, null);
});

test("Stop is shown and usable only while a batch runs, and asks it to stop between entities", async () => {
  const ui = await uiFixture();
  assert.equal(ui.button("Stop").hidden, true);
  let release;
  const progress = [];
  ui.batch(async (path, { confirm, onProgress, isCancelled }) => {
    await confirm({ characters: 1, worldbooks: 0 });
    onProgress({ done: 0, total: 1 });
    progress.push(ui.field("message").textContent);
    await new Promise(resolve => { release = resolve; });
    return { characters: 1, worldbooks: 0, cancelled: isCancelled(), results: [], frontendChanges: [] };
  });
  const pending = ui.button("Push All").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.button("Stop").hidden, false);
  assert.equal(ui.button("Stop").disabled, false);
  assert.equal(ui.button("Pull All").disabled, true);
  await ui.button("Stop").click();
  release(); await pending;
  assert.deepEqual(progress, ["Push All: 0/1…"]);
  assert.equal(ui.field("message").textContent, "Push All cancelled.");
  assert.equal(ui.button("Stop").hidden, true);
  assert.equal(ui.button("Pull All").disabled, false);
});

// The tabbed panel and the file relay.
const tabCounts = (ui) => Object.fromEntries(ui.field("tabs").children.map(tab => [tab.textContent, tab.children[0].textContent]));
const toolbar = (ui) => ui.field("controls").children.filter(b => !b.hidden).map(b => b.textContent);

test("each tab lists its own kind with a count, and brings its own batch buttons", async () => {
  const ui = await uiFixture();
  ui.rows([
    { entityType: "character", localId: "a", managerId: "1", displayName: "Hero", status: "synced" },
    { entityType: "worldbook", localId: "Lore", managerId: "2", displayName: "Lore", status: "synced" },
  ]);
  ui.relayRows({
    presets: [{ type: "presets", name: "Daily", status: "st_only", local: { size: 2048 } }],
    regex: [{ type: "regex", name: "Trim", status: "manager_only", manager: { size: 300, updatedAt: "", source: "file" } },
      { type: "regex", name: "Hide", status: "same", local: { size: 10 }, manager: { size: 10, updatedAt: "", source: "file" } }],
  });
  await ui.button("Refresh").click();
  assert.deepEqual(tabCounts(ui), { Characters: "1", WorldBooks: "1", Presets: "1", Themes: "0", Regex: "2" });
  assert.deepEqual(ui.calls.filter(c => c.path.endsWith("refresh")).map(c => c.path), ["/refresh", "/relay/refresh"]);
  assert.deepEqual(toolbar(ui), ["Refresh", "Sync All", "Push All", "Pull All"]);

  await ui.tab("Presets");
  assert.deepEqual(toolbar(ui), ["Refresh", "Push All", "Pull All"]);
  assert.deepEqual(ui.rowTexts(), ["Daily ST only"]);
  assert.equal(ui.field("rows").children[0].children[0].children[1].textContent, "2 KB in SillyTavern");
  assert.deepEqual(ui.field("rows").children[0].children.slice(1).map(b => b.textContent), ["Push"]);

  await ui.tab("Regex");
  assert.deepEqual(toolbar(ui), ["Refresh", "Push All", "Download All"]);
  // In the service's order.
  assert.deepEqual(ui.rowTexts(), ["Trim Manager only", "Hide Same"]);
  assert.deepEqual(ui.field("rows").children[0].children.slice(1).map(b => b.textContent), ["Download"]);
  assert.equal(ui.field("tabs").children.find(tab => tab.textContent === "Regex").className, "tms-tab tms-tab-active");
});

test("status filters show only what is present, narrow the list, and reset with the tab", async () => {
  const ui = await uiFixture();
  ui.rows([
    { entityType: "character", localId: "a", managerId: "1", displayName: "Changed", status: "st_changed" },
    { entityType: "character", localId: "b", managerId: "2", displayName: "Mixed", status: "different" },
    { entityType: "character", localId: "c", managerId: null, displayName: "Local", status: "st_only" },
    { entityType: "character", localId: "d", managerId: "3", displayName: "Broken", status: "error", error: "Bad note." },
  ]);
  await ui.button("Refresh").click();
  const chips = () => ui.field("filters").children.map(chip => `${chip.textContent} ${chip.children[0].textContent}`);
  assert.deepEqual(chips(), ["All 4", "Changed 2", "ST only 1", "Problems 1"]);

  await ui.button("Changed").click();
  assert.deepEqual(ui.rowTexts(), ["Changed ST changed", "Mixed Different"]);
  assert.equal(ui.field("filters").children.find(chip => chip.textContent === "Changed").className, "tms-chip tms-chip-active");
  await ui.button("Problems").click();
  assert.deepEqual(ui.rowTexts(), ["Broken Cannot sync"]);

  await ui.tab("WorldBooks");
  assert.deepEqual(chips(), ["All 0"]);
  assert.equal(ui.field("rows").textContent, "Nothing here yet.");
});

test("a relay Push is confirmed as new or as a replacement; an equal file is not sent", async () => {
  const ui = await uiFixture();
  ui.relayRows({ presets: [
    { type: "presets", name: "New <b>", status: "st_only", local: { size: 1 } },
    { type: "presets", name: "Changed", status: "different", local: { size: 1 }, manager: { size: 2, updatedAt: "", source: "file" } },
    { type: "presets", name: "Equal", status: "same", local: { size: 1 }, manager: { size: 1, updatedAt: "", source: "file" } },
  ] });
  await ui.button("Refresh").click();
  await ui.tab("Presets");
  const push = (index) => ui.field("rows").children[index].children[1].click();

  await push(0);
  await push(1);
  assert.deepEqual(ui.confirmations.map(c => [c.text, c.okButton]), [
    ['Push preset "New <b>" to Manager?', "Push"],
    ['Push preset "Changed"? Manager\'s copy will be replaced with the SillyTavern version.', "Push"],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.filter(c => c.path === "/relay/push").map(c => c.body))), [
    { type: "presets", name: "New <b>", confirmOverwrite: false },
    { type: "presets", name: "Changed", confirmOverwrite: true },
  ]);
  assert.equal(ui.field("message").textContent, 'Pushed "Changed".');
  assert.deepEqual(ui.calls.filter(c => c.path === "/relay/refresh").at(-1).body, ["presets"], "only that type reloads");

  await push(2);
  assert.equal(ui.field("message").textContent, '"Equal" is already the same in Manager.');
  assert.equal(ui.calls.filter(c => c.path === "/relay/push").length, 2);

  ui.confirm(false);
  await push(0);
  assert.equal(ui.field("message").textContent, "Push cancelled.");
  assert.equal(ui.calls.filter(c => c.path === "/relay/push").length, 2);
});

test("a relay Pull asks only before replacing, says what comes next, and regex scripts download", async () => {
  const ui = await uiFixture();
  const managerSide = { size: 5, updatedAt: "", source: "file" };
  ui.relayRows({
    presets: [{ type: "presets", name: "Remote", status: "manager_only", manager: managerSide },
      { type: "presets", name: "Shared", status: "different", local: { size: 1 }, manager: managerSide }],
    themes: [{ type: "themes", name: "Night", status: "manager_only", manager: managerSide }],
    regex: [{ type: "regex", name: "Trim", status: "different", local: { size: 1 }, manager: managerSide }],
  });
  await ui.button("Refresh").click();
  const pull = (index) => ui.field("rows").children[index].children.at(-1).click();

  await ui.tab("Presets");
  await pull(0);
  assert.equal(ui.confirmations.length, 0, "a new preset needs no confirmation");
  assert.equal(ui.field("message").textContent, 'Pulled "Remote"; it is now the selected preset.');
  await pull(1);
  assert.deepEqual(ui.confirmations.map(c => [c.text, c.okButton]), [['Replace SillyTavern\'s preset "Shared" with Manager\'s copy?', "Pull"]]);

  await ui.tab("Themes");
  await pull(0);
  assert.equal(ui.field("message").textContent, 'Pulled "Night"; reload SillyTavern to see it in the theme list.');

  await ui.tab("Regex");
  await pull(0);
  assert.equal(ui.confirmations.length, 1, "a download changes nothing, so it is not confirmed");
  assert.equal(ui.field("message").textContent, 'Downloaded "Trim". Import it in SillyTavern\'s Regex panel.');
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.filter(c => c.path === "/relay/pull").map(c => c.body))), [
    { type: "presets", name: "Remote", confirmOverwrite: false },
    { type: "presets", name: "Shared", confirmOverwrite: true },
    { type: "themes", name: "Night", confirmOverwrite: false },
    { type: "regex", name: "Trim", confirmOverwrite: false },
  ]);
});

test("a relay file that changed after the list was drawn is confirmed again before it is replaced", async () => {
  const ui = await uiFixture();
  ui.relayRows({ themes: [{ type: "themes", name: "Night", status: "st_only", local: { size: 1 } }] });
  await ui.button("Refresh").click();
  await ui.tab("Themes");
  let attempts = 0;
  ui.relayAction(async (method, args) => {
    if (++attempts === 1) throw Object.assign(new Error("Confirm."), { code: "overwrite_confirmation_required" });
    return { type: args.type, name: args.name, status: "pushed" };
  });
  await ui.field("rows").children[0].children[1].click();
  assert.deepEqual(ui.confirmations.map(c => c.text), [
    'Push theme "Night" to Manager?',
    '"Night" now differs between SillyTavern and Manager. Replace the copy in Manager?',
  ]);
  assert.deepEqual(ui.calls.filter(c => c.path === "/relay/push").map(c => c.body.confirmOverwrite), [false, true]);
});

test("relay batches confirm once with the count, except a regex download, and summarize what happened", async () => {
  const ui = await uiFixture();
  await ui.button("Refresh").click();
  await ui.tab("Themes");
  await ui.button("Push All").click();
  assert.deepEqual(ui.confirmations.map(c => [c.text, c.okButton]), [
    ["Push All sends 2 themes that exist only in SillyTavern to Manager. Nothing already in Manager is changed.", "Push All"],
  ]);
  assert.equal(ui.field("message").textContent, "Push All: 1 pushed, 0 skipped, 1 failed. Failed: Broken: HTTP 500.");

  await ui.button("Pull All").click();
  assert.match(ui.confirmations[1].text, /^Pull All copies 2 themes that exist only in Manager into SillyTavern\./);
  assert.match(ui.field("message").textContent, /^Pull All: 1 pulled, .* Reload SillyTavern to see them in its lists\.$/);

  await ui.tab("Regex");
  await ui.button("Download All").click();
  assert.equal(ui.confirmations.length, 2, "downloading needs no confirmation");
  assert.match(ui.field("message").textContent, /^Download All: 1 downloaded, .* Import the downloaded file in SillyTavern's Regex panel\.$/);

  ui.confirm(false);
  await ui.tab("Presets");
  await ui.button("Push All").click();
  assert.equal(ui.field("message").textContent, "Push All cancelled.");
  assert.deepEqual(ui.calls.filter(c => c.path.startsWith("/relay/p")).map(c => [c.path, c.body.type]), [
    ["/relay/pushAll", "themes"], ["/relay/pullAll", "themes"], ["/relay/pullAll", "regex"], ["/relay/pushAll", "presets"],
  ]);
});

test("a Manager without the relay still syncs Characters; the file tabs say why they are empty", async () => {
  const ui = await uiFixture();
  ui.relayFail("Manager file list: HTTP 404");
  ui.rows([{ entityType: "character", localId: "a", managerId: "1", displayName: "Hero", status: "synced" }]);
  await ui.button("Refresh").click();
  assert.equal(ui.field("message").textContent, "Refreshed.");
  assert.deepEqual(ui.rowTexts(), ["Hero Synced"]);
  await ui.tab("Presets");
  assert.equal(ui.field("rows").textContent, "Presets, themes and regex are unavailable: Manager file list: HTTP 404");
});
