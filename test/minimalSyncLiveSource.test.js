import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { fileURLToPath } from "node:url";

const extensionRoot = fileURLToPath(new URL("..", import.meta.url));


class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.value = ""; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(event, fn) { this.listeners[event] = fn; }
  set innerHTML(html) { this.children = [...html.matchAll(/data-role="([^"]+)"/g)].map(([, role]) => {
    const child = new Element(role === "endpoint" || role === "search" ? "input" : "div"); child.dataset.role = role; return child;
  }); }
  descendants() { return this.children.flatMap(c => [c, ...c.descendants()]); }
  querySelector(selector) { const role = selector.match(/data-role="([^"]+)"/)?.[1]; return this.descendants().find(c => c.dataset.role === role); }
  querySelectorAll(selector) { return this.descendants().filter(c => c.tagName === selector); }
  click() { return this.disabled ? undefined : this.listeners.click?.({ target: this }); }
  input(value) { this.value = value; return this.listeners.input?.({ target: this }); }
}

async function uiFixture() {
  const container = new Element("div"); const calls = []; const reconciled = []; const events = []; const confirmations = [];
  const listeners = new Map(); const wiring = {};
  let nextRows = [];
  let onAction = () => ({ status: "pulled", frontendChanges: [] });
  let confirmation = true;
  let emitOnSave = true;
  const adapter = { synthetic: "adapter" };
  const record = (path, { adapter: given, ...body }) => {
    assert.equal(given, adapter, "every content action uses the native ST adapter");
    calls.push({ path, body });
    return onAction(path, body);
  };
  const service = {
    getConfiguration: async () => ({ endpoint: "http://synthetic.test/api/sync/v1", configured: true }),
    configure: async (body) => { calls.push({ path: "/config", body }); return { ...body, configured: true }; },
    refresh: async ({ discovery }) => { calls.push({ path: "/refresh", body: discovery }); return { rows: nextRows }; },
    push: async (args) => record("/push", args),
    pull: async (args) => record("/pull", args),
    syncAll: async (args) => record("/sync-all", args),
    renameLocal: async (body) => { calls.push({ path: "/rename", body }); return {}; },
  };
  const source = (await readFile(`${extensionRoot}/index.js`, "utf8")).replace(/^import [^;]*;\n/gm, "");
  const context = { document: { readyState: "complete", getElementById: id => id === "extensions_settings" ? container : null,
    createElement: tag => new Element(tag) },
    eventSource: {
      on: (name, fn) => { events.push(name); listeners.set(name, [...(listeners.get(name) ?? []), fn]); },
      removeListener: (name, fn) => listeners.set(name, (listeners.get(name) ?? []).filter(x => x !== fn)),
    },
    event_types: { CHARACTER_RENAMED: "rename", SETTINGS_UPDATED: "settings_updated" },
    getRequestHeaders: () => ({ "X-CSRF-Token": "synthetic" }), getContext: () => ({}), uuidv4: () => "uuid",
    extension_settings: { synthetic: true },
    saveSettings: async () => { if (emitOnSave) for (const fn of listeners.get("settings_updated") ?? []) await fn(); },
    worldInfoCache: new Map(), reloadEditor() {}, updateWorldInfoList() {}, encodeLocalId: encodeURIComponent,
    confirm: text => { confirmations.push(text); return confirmation; },
    createSillyTavernFrontendReconciler: () => ({ reconcile: async change => { reconciled.push(change); } }),
    discoverSillyTavern: async () => ({ characters: [], worldbooks: [] }),
    createFileSidecarStore: (options) => { wiring.store = options; return { synthetic: "store" }; },
    createNativeStGateway: (options) => { wiring.gateway = options; return { synthetic: "gateway" }; },
    createMinimalSillyTavernAdapter: (gateway) => { wiring.adapterGateway = gateway; return adapter; },
    createMinimalSyncService: (options) => { wiring.service = options; return service; },
  };
  vm.runInNewContext(source, context);
  await Promise.resolve();
  const panel = container.children[0];
  return { panel, calls, reconciled, events, confirmations, wiring, context, listeners,
    rows(value) { nextRows = value; }, action(fn) { onAction = fn; },
    confirm(value) { confirmation = value; }, emitOnSave(value) { emitOnSave = value; },
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
  assert.equal(ui.field("endpoint").value, "http://synthetic.test/api/sync/v1");
  assert.deepEqual(ui.events, ["rename"]); // No edit listener can feed reconciliation back into sync.
});

test("sync state never saves ST settings, which every stale tab overwrites wholesale", async () => {
  const source = await readFile(`${extensionRoot}/index.js`, "utf8");
  assert.doesNotMatch(source, /saveSettings|createSettingsSidecarStore/);
});

test("Save and Character rename call the service directly", async () => {
  const ui = await uiFixture();
  ui.field("endpoint").value = " http://synthetic.test/api/sync/v1 ";
  await ui.button("Save").click();
  await ui.listeners.get("rename")[0]("Old Name.png", "New Name.png");
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls)), [
    { path: "/config", body: { endpoint: "http://synthetic.test/api/sync/v1" } },
    { path: "/rename", body: { oldLocalId: "Old%20Name.png", newLocalId: "New%20Name.png" } },
  ]);
});

test("extension declares scoped ST-themed CSS and an independently scrollable entity list", async () => {
  const manifest = JSON.parse(await readFile(`${extensionRoot}/manifest.json`, "utf8"));
  const css = await readFile(`${extensionRoot}/style.css`, "utf8");
  const source = await readFile(`${extensionRoot}/index.js`, "utf8");
  assert.equal(manifest.css, "style.css");
  assert.match(source, /class="text_pole"/);
  assert.match(source, /class="inline-drawer"/);
  for (const variable of ["--SmartThemeBodyColor", "--SmartThemeBlurTintColor", "--SmartThemeBorderColor", "--mainFontFamily"]) {
    assert.match(css, new RegExp(variable));
  }
  assert.match(css, /#tavern_manager_sync \.tms-entity-list\s*\{[^}]*max-height:\s*18rem;[^}]*overflow-y:\s*auto;/s);
  assert.doesNotMatch(css, /(?:color|background(?:-color)?|border-color):\s*(?:#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i);
});

test("search filters display names case-insensitively and clearing restores rows", async () => {
  const ui = await uiFixture();
  ui.rows([
    { entityType: "character", localId: "alpha-local", managerId: "alpha-manager", displayName: "Alpha Hero", status: "synced" },
    { entityType: "worldbook", localId: "beta-local", managerId: null, displayName: "Beta Lore", status: "st_only" },
    { entityType: "character", localId: null, managerId: "gamma-manager", displayName: "Gamma Guide", status: "manager_only" },
  ]);
  await ui.button("Refresh").click();
  assert.equal(ui.field("rows").children.length, 3);

  ui.field("search").input("ALPHA");
  assert.equal(ui.field("rows").children.length, 1);
  assert.match(ui.field("rows").children[0].children[0].children[0].textContent, /Alpha Hero/);

  ui.field("search").input("missing");
  assert.equal(ui.field("rows").children.length, 0);
  assert.equal(ui.field("rows").textContent, "No matching entities.");
  ui.field("search").input("");
  assert.equal(ui.field("rows").children.length, 3);
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
  assert.match(broken[0].textContent, /Cannot sync/);
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

test("Push retries only after the user confirms an existing Manager overwrite", async () => {
  const ui = await uiFixture();
  ui.rows([{ entityType: "character", localId: "local", managerId: "remote", displayName: "Bound", status: "st_changed" }]);
  await ui.button("Refresh").click();
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
    { entityType: "character", localId: "local" },
    { entityType: "character", localId: "local", confirmOverwrite: true },
  ]);
  assert.equal(ui.confirmations.length, 1);
});

test("Push cancellation sends no confirmed overwrite request", async () => {
  const ui = await uiFixture(); ui.confirm(false);
  ui.rows([{ entityType: "character", localId: "local", managerId: "remote", displayName: "Bound", status: "st_changed" }]);
  await ui.button("Refresh").click();
  ui.action(() => { throw Object.assign(new Error("confirmation needed"), { code: "overwrite_confirmation_required" }); });
  await ui.button("Push").click();
  const requests = ui.calls.filter(call => call.path === "/push");
  assert.equal(requests.length, 1);
  assert.equal(Object.hasOwn(requests[0].body, "confirmOverwrite"), false);
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
