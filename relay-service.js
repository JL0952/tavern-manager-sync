import { relayContentHash } from "./sync-core/relayContent.js";
import { RELAY_TYPES } from "./st-relay.js";

// The file relay between SillyTavern and Manager for chat completion presets,
// UI themes and global regex scripts. Files are matched by name and compared
// by content hash; nothing remembers an earlier sync, so a file that differs
// is left to the user's choice of direction. Manager keeps files unchanged.

function fail(message, code = "relay_error", details = null) {
  return Object.assign(new Error(message), { code, details });
}

function assertType(type) {
  if (!RELAY_TYPES.includes(type)) throw fail("Unknown file type.");
}

// The relay API sits beside the sync API the endpoint names.
export function relayBase(syncEndpoint) {
  return syncEndpoint.replace(/\/api\/sync\/v1$/, "/api/relay/v1");
}

export function relayStatus(local, manager) {
  if (local && manager) return local.contentHash === manager.contentHash ? "same" : "different";
  return local ? "st_only" : "manager_only";
}

export function createRelayService({ sidecarStore, st, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!sidecarStore || !st || typeof fetchImpl !== "function") {
    throw fail("The relay needs the sync state, SillyTavern access and fetch.");
  }

  async function endpoint() {
    const { config } = await sidecarStore.read();
    if (!config.endpoint) throw fail("Configure a Manager endpoint first.");
    return relayBase(config.endpoint);
  }

  // Manager answers { error: { code, message } }.
  async function manager(url, options, label) {
    const response = await fetchImpl(url, options);
    if (!response.ok) {
      const error = (await response.json().catch(() => null))?.error;
      throw fail(`${label}: ${error?.message ?? `HTTP ${response.status}`}`, error?.code, error ?? null);
    }
    return response;
  }

  const typeUrl = (base, type, suffix = "") => `${base}/${encodeURIComponent(type)}${suffix}`;

  async function listManager(base, type) {
    const body = await (await manager(typeUrl(base, type), { cache: "no-store" }, "Manager file list")).json();
    if (!Array.isArray(body?.items)) throw fail("Manager's file list is invalid.");
    return body.items;
  }

  // One entry per name, holding each side's copy.
  function pair(type, locals, managerItems) {
    const entries = new Map();
    for (const local of locals) {
      entries.set(local.name, { type, name: local.name, local: { ...local, contentHash: relayContentHash(type, local.value) } });
    }
    for (const item of managerItems) {
      entries.set(item.name, { ...(entries.get(item.name) ?? { type, name: item.name }), manager: item });
    }
    return [...entries.values()]
      .map((entry) => ({ ...entry, status: relayStatus(entry.local, entry.manager) }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async function inspect(types = RELAY_TYPES) {
    for (const type of types) assertType(type);
    const base = await endpoint();
    const [locals, ...managerLists] = await Promise.all([st.list(), ...types.map((type) => listManager(base, type))]);
    const entries = Object.fromEntries(types.map((type, index) => [type, pair(type, locals[type], managerLists[index])]));
    return { base, entries };
  }

  // What the panel lists: no file contents.
  async function refresh(types = RELAY_TYPES) {
    const { entries } = await inspect(types);
    return Object.fromEntries(Object.entries(entries).map(([type, list]) => [type, list.map((entry) => ({
      type, name: entry.name, status: entry.status,
      ...(entry.local ? { local: { size: new TextEncoder().encode(entry.local.contents).length } } : {}),
      ...(entry.manager ? { manager: { size: entry.manager.size, updatedAt: entry.manager.updatedAt, source: entry.manager.source } } : {}),
    }))]));
  }

  async function upload(base, entry, onConflict) {
    const query = new URLSearchParams({ name: entry.name, onConflict });
    const response = await manager(typeUrl(base, entry.type, `?${query}`), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Content-Hash": entry.local.contentHash,
        "X-Relay-Source": "sillytavern",
      },
      body: entry.local.contents,
    }, "Manager upload");
    return (await response.json()).item;
  }

  // Manager's copy, checked against the hash it was stored with.
  async function readManagerValue(base, entry) {
    const response = await manager(typeUrl(base, entry.type, `/${encodeURIComponent(entry.manager.id)}`),
      { cache: "no-store" }, "Manager download");
    let value;
    try {
      value = JSON.parse(await response.text());
    } catch {
      throw fail(`Manager's copy of "${entry.name}" is not valid JSON.`);
    }
    if (relayContentHash(entry.type, value) !== entry.manager.contentHash) {
      throw fail(`Manager's copy of "${entry.name}" does not match its recorded content.`);
    }
    return value;
  }

  // Pulled presets and themes are reread from SillyTavern; equal hashes are
  // the proof, as a saved name SillyTavern changed would not match.
  async function verifyPulled(type, pulled) {
    const locals = (await st.list())[type];
    const byName = new Map(locals.map((local) => [local.name, relayContentHash(type, local.value)]));
    return pulled.filter((entry) => byName.get(entry.name) !== entry.manager.contentHash);
  }

  async function freshEntry(type, name) {
    assertType(type);
    const { base, entries } = await inspect([type]);
    const entry = entries[type].find((candidate) => candidate.name === name);
    if (!entry) throw fail(`"${name}" is no longer in SillyTavern or Manager.`);
    return { base, entry };
  }

  // Overwriting a different Manager copy needs confirmOverwrite.
  async function push({ type, name, confirmOverwrite = false } = {}) {
    const { base, entry } = await freshEntry(type, name);
    if (!entry.local) throw fail(`"${name}" is no longer in SillyTavern.`);
    if (entry.status === "same") return { type, name, status: "unchanged" };
    if (entry.status === "different" && !confirmOverwrite) {
      throw fail(`Confirm replacing Manager's "${name}".`, "overwrite_confirmation_required", { type, name });
    }
    await upload(base, entry, entry.manager ? "replace" : "fail");
    return { type, name, status: "pushed" };
  }

  // Regex scripts download for the Regex panel's Import. A preset or theme
  // overwrites a different SillyTavern copy only with confirmOverwrite; one
  // preset becomes the selected preset, as an imported one does.
  async function pull({ type, name, confirmOverwrite = false } = {}) {
    const { base, entry } = await freshEntry(type, name);
    if (!entry.manager) throw fail(`"${name}" is no longer in Manager.`);
    const value = await readManagerValue(base, entry);
    if (type === "regex") {
      st.downloadRegex([value]);
      return { type, name, status: "downloaded" };
    }
    if (entry.status === "same") return { type, name, status: "unchanged" };
    if (entry.status === "different" && !confirmOverwrite) {
      throw fail(`Confirm replacing SillyTavern's "${name}".`, "overwrite_confirmation_required", { type, name });
    }
    if (type === "presets") await st.writePreset(name, value, { select: true });
    else await st.writeTheme(name, value);
    if ((await verifyPulled(type, [entry])).length) {
      throw fail(`"${name}" was saved, but SillyTavern does not show the same content under that name.`);
    }
    return { type, name, status: "pulled", reloadNeeded: type === "themes" };
  }

  async function batch({ type, status, confirm, onProgress, isCancelled, item }) {
    const { base, entries } = await inspect([type]);
    const planned = entries[type].filter((entry) => entry.status === status);
    if (!planned.length) return { type, total: 0, results: [] };
    if (!(await confirm({ type, count: planned.length }))) return { type, total: planned.length, cancelled: true, results: [] };

    const results = [];
    for (const entry of planned) {
      if (isCancelled()) break;
      try {
        results.push({ name: entry.name, ...(await item(base, entry)) });
      } catch (error) {
        results.push({ name: entry.name, status: "failed", message: error.message });
      }
      onProgress({ type, done: results.length, total: planned.length });
    }
    return { type, total: planned.length, results, cancelled: results.length < planned.length };
  }

  function batchOptions(name, { type, confirm = async () => true, onProgress = () => {}, isCancelled = () => false, ...extra } = {}) {
    assertType(type);
    if (Object.keys(extra).length || typeof confirm !== "function" || typeof onProgress !== "function"
      || typeof isCancelled !== "function") {
      throw fail(`${name} accepts only a file type and batch callbacks.`);
    }
    return { type, confirm, onProgress, isCancelled };
  }

  // Sends every file only SillyTavern has; a name Manager gained meanwhile is
  // left alone.
  async function pushAll(options) {
    return batch({ ...batchOptions("Push All", options), status: "st_only", item: async (base, entry) => {
      try {
        await upload(base, entry, "fail");
      } catch (error) {
        if (error.code !== "relay_name_conflict") throw error;
        return { status: "skipped", message: "Manager got a file of this name meanwhile; push it on its own." };
      }
      return { status: "pushed" };
    } });
  }

  // Brings in every file only Manager has, without selecting anything. Regex
  // scripts become one download for the Regex panel's Import.
  async function pullAll(options) {
    const { type, ...callbacks } = batchOptions("Pull All", options);
    if (type === "regex") {
      const scripts = [];
      const result = await batch({ type, ...callbacks, status: "manager_only", item: async (base, entry) => {
        scripts.push(await readManagerValue(base, entry));
        return { status: "downloaded" };
      } });
      if (scripts.length) st.downloadRegex(scripts);
      return result;
    }

    const pulled = [];
    const result = await batch({ type, ...callbacks, status: "manager_only", item: async (base, entry) => {
      const value = await readManagerValue(base, entry);
      if (type === "presets") await st.writePreset(entry.name, value, { select: false });
      else await st.writeTheme(entry.name, value);
      pulled.push(entry);
      return { status: "pulled" };
    } });

    // One reread checks the whole batch.
    if (pulled.length) {
      const unverified = new Set((await verifyPulled(type, pulled)).map((entry) => entry.name));
      for (const entry of result.results) {
        if (unverified.has(entry.name)) {
          Object.assign(entry, { status: "failed", message: "Saved, but SillyTavern does not show the same content under this name." });
        }
      }
    }
    return { ...result, reloadNeeded: pulled.length > 0 };
  }

  return Object.freeze({ refresh, push, pull, pushAll, pullAll });
}
