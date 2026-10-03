import { CANONICAL_PROJECTION_VERSION, hashCanonicalProjection as hash } from "./sync-core/syncProjection.js";
import { scanSillyTavernEntities } from "./st-adapter.js";
import { validateMinimalSidecar } from "./sidecar-settings.js";

const key = (type, id) => `${type}:${id}`;
const collection = (type) => type === "character" ? "characters" : "worldbooks";
const hashPattern = /^sha256:[a-f0-9]{64}$/;
const typeOf = (bindingKey) => bindingKey.split(":", 1)[0];
const byLocal = (bindings, type, id) => Object.entries(bindings)
  .find(([k, binding]) => typeOf(k) === type && binding.localId === id)?.[1];

function fail(message, code = "sync_error", details = null) {
  return Object.assign(new Error(message), { code, details });
}

// Manager answers { error: "text" } or { error: { code, message?, ...details } }.
async function managerError(response, method) {
  const error = (await response.json().catch(() => null))?.error;
  const reason = typeof error === "string" ? error : error?.message ?? error?.code;
  const suffix = typeof reason === "string" && reason ? `: ${reason.replace(/\.$/, "")}` : "";
  const code = typeof error?.code === "string" ? error.code : undefined;
  return fail(`Manager ${method} returned HTTP ${response.status}${suffix}.`, code, code ? error : null);
}

const notesPreviewLength = 160;
const htmlEntities = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", nbsp: " " };

// The plain-text preview Manager puts in its manifest, built the same way for
// Characters that exist only in ST. Display only.
export function creatorNotesPreview(notes) {
  const text = String(notes ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_match, name) => htmlEntities[name])
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(text);
  return characters.length > notesPreviewLength
    ? `${characters.slice(0, notesPreviewLength).join("").trimEnd()}…`
    : text;
}

function checkSource(type, id) {
  if (!["character", "worldbook"].includes(type) || typeof id !== "string" || !id) {
    throw fail("A valid sync source is required.");
  }
}

export function classify(localHash, managerHash, baseHash) {
  if (localHash === managerHash) return "synced";
  if (baseHash != null && localHash !== baseHash && managerHash === baseHash) return "st_changed";
  if (baseHash != null && localHash === baseHash && managerHash !== baseHash) return "manager_changed";
  return "different";
}

function countBy(items, keyOf) {
  const counts = new Map();
  for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1);
  return counts;
}

/**
 * Pair unbound entities of one type only on unambiguous evidence:
 * 1. the Manager UUID embedded in the ST card, disambiguated by an equal
 *    contentHash when several ST cards carry the same UUID;
 * 2. for legacy cards without one, an identical contentHash that is unique
 *    among the unbound entities on both sides.
 * Names and fuzzy content are never used. A Manager entity whose binding
 * points to a deleted ST file counts as unbound.
 */
export function planClaims({ type, locals, remotes, bindings }) {
  const typedLocals = [...locals.values()].filter((local) => local.entityType === type);
  const existingLocalIds = new Set(typedLocals.map((local) => local.localId));
  const boundLocalIds = new Set(Object.entries(bindings)
    .filter(([bindingKey]) => typeOf(bindingKey) === type).map(([, binding]) => binding.localId));
  // An unsyncable local has no hash to pair by; it still occupies its binding.
  const unbound = typedLocals.filter((local) => !boundLocalIds.has(local.localId) && !local.error);
  const claimable = (managerId) => {
    const binding = bindings[key(type, managerId)];
    return !binding || !existingLocalIds.has(binding.localId);
  };
  const claims = [];
  const duplicates = new Set();
  const claim = (local, remote) => claims.push({
    managerId: remote.id,
    localId: local.localId,
    baseHash: local.contentHash === remote.contentHash ? remote.contentHash : null,
    previous: bindings[key(type, remote.id)] ?? null,
  });

  const byEmbeddedId = new Map();
  for (const local of unbound.filter((candidate) => candidate.embeddedManagerId)) {
    byEmbeddedId.set(local.embeddedManagerId, [...(byEmbeddedId.get(local.embeddedManagerId) ?? []), local]);
  }
  for (const [managerId, group] of byEmbeddedId) {
    const remote = remotes.get(key(type, managerId));
    if (!remote) continue; // Deleted in Manager: the card stays ST only.
    let chosen = null;
    if (claimable(managerId)) {
      const matches = group.length === 1 ? group : group.filter((local) => local.contentHash === remote.contentHash);
      if (matches.length === 1) [chosen] = matches;
    }
    if (chosen) claim(chosen, remote);
    for (const local of group) if (local !== chosen) duplicates.add(local.localId);
  }

  // Uniqueness counts every remaining unbound card, including ones carrying
  // an unusable embedded id, so a legacy match is never one of several copies.
  const claimedLocalIds = new Set(claims.map((entry) => entry.localId));
  const claimedManagerIds = new Set(claims.map((entry) => entry.managerId));
  const localPool = unbound.filter((local) => !claimedLocalIds.has(local.localId));
  const remotePool = [...remotes.values()].filter((remote) => remote.type === type
    && !claimedManagerIds.has(remote.id) && !byEmbeddedId.has(remote.id) && claimable(remote.id));
  const localCounts = countBy(localPool, (local) => local.contentHash);
  const remoteCounts = countBy(remotePool, (remote) => remote.contentHash);
  for (const local of localPool) {
    if (local.embeddedManagerId || localCounts.get(local.contentHash) !== 1
      || remoteCounts.get(local.contentHash) !== 1) continue;
    claim(local, remotePool.find((remote) => remote.contentHash === local.contentHash));
  }

  return { claims, duplicates };
}

export function createMinimalSyncService({ sidecarStore, fetch: fetchImpl = globalThis.fetch }) {
  async function sidecar() {
    const state = validateMinimalSidecar(await sidecarStore.read());
    if (!state.config.endpoint) throw fail("Configure a Manager endpoint first.");
    return state;
  }

  async function request(endpoint, path, method = "GET", body) {
    const response = await fetchImpl(`${endpoint}/${path}`, {
      method,
      ...(body === undefined ? {} : {
        headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }),
    });
    if (method === "GET" && response.status === 404) return null;
    if (!response.ok) throw await managerError(response, method);
    return response.json();
  }

  // A Manager started before avatar sync has no avatar route; Express then
  // answers a plain 404 with no error code.
  async function avatarError(response, method) {
    const error = await managerError(response, method);
    return response.status === 404 && !error.details
      ? fail("this Manager has no avatar sync; restart or update Manager", "avatar_unsupported")
      : error;
  }

  // Avatars travel beside canonical content: never hashed, sent on every
  // Character Push and Pull. Only Manager's own sync_avatar_not_found means
  // it has none.
  async function readManagerAvatar(endpoint, managerId) {
    const response = await fetchImpl(`${endpoint}/characters/${encodeURIComponent(managerId)}/avatar`, { cache: "no-store" });
    if (!response.ok) {
      const error = await avatarError(response, "GET");
      if (error.code === "sync_avatar_not_found") return null;
      throw error;
    }
    return response.blob();
  }

  async function writeManagerAvatar(endpoint, managerId, image) {
    const response = await fetchImpl(`${endpoint}/characters/${encodeURIComponent(managerId)}/avatar`, {
      method: "PUT", headers: { "content-type": "image/png" }, body: image,
    });
    if (!response.ok) throw await avatarError(response, "PUT");
  }

  async function readManager(endpoint, type, id) {
    const response = await request(endpoint, `${collection(type)}/${encodeURIComponent(id)}`);
    if (response === null) return null;
    const entity = response?.entity;
    if (entity?.type !== type || entity.id !== id || !Number.isSafeInteger(entity.revision)
      || entity.revision < 1 || entity.canonical?.projectionVersion !== CANONICAL_PROJECTION_VERSION
      || hash(entity.canonical) !== entity.contentHash) {
      throw fail("Manager resource failed validation.");
    }
    if (entity.diagnostics?.some(item => item.code.startsWith("unsupported_nonportable_"))) {
      throw fail("WorldBook contains non-portable fields; cannot safely round-trip this source.", "unsupported_worldbook_fields",
        { fields: entity.diagnostics.map(({ code, field }) => ({ code, field })) });
    }
    return entity;
  }

  // `existenceOnly` accepts a local whose content cannot be synced, for a Pull
  // that only needs to know whether to overwrite or create it.
  async function readLocal(adapter, type, id, bindings, { existenceOnly = false } = {}) {
    try {
      const local = await adapter.refresh({ entityType: type, localId: id, bindings });
      if (local?.entityType !== type || local.localId !== id) throw fail("Invalid local reread.");
      if (local.error) {
        if (existenceOnly) return local;
        throw fail(`This ${type} cannot be synced: ${local.error}`, "unsyncable_local");
      }
      if (local.diagnostics?.some(item => item.code.startsWith("unsupported_nonportable_"))) {
        throw fail("WorldBook contains non-portable fields; cannot safely round-trip this source.", "unsupported_worldbook_fields",
          { fields: local.diagnostics.map(({ code, field }) => ({ code, field })) });
      }
      return { ...local, contentHash: hash(local.canonical) };
    } catch (error) {
      if (error.code === "missing_local") return null;
      throw error;
    }
  }

  function checkBinding(bindings, type, managerId, localId) {
    const remote = bindings[key(type, managerId)];
    const local = byLocal(bindings, type, localId);
    if ((remote && remote.localId !== localId) || (local && local.managerId !== managerId)) {
      throw fail("Destination is already bound to another source.");
    }
  }

  async function saveBinding(type, managerId, localId, baseHash, previous) {
    await sidecarStore.update((state) => {
      // Only the exact binding read by this action may be updated (including a
      // confirmed missing counterpart). No arbitrary rebinding is supported.
      if (previous) {
        const previousKey = key(type, previous.managerId);
        const current = state.bindings[previousKey];
        if (current?.localId !== previous.localId) throw fail("Binding changed during the action.");
        delete state.bindings[previousKey];
      }
      checkBinding(state.bindings, type, managerId, localId);
      state.bindings[key(type, managerId)] = { managerId, localId, baseHash };
    });
  }

  async function claimUnbound({ discovery, remotes, bindings }) {
    const planned = [];
    const duplicates = new Set();
    const draft = structuredClone(bindings);
    const scans = {};
    // WorldBooks first: a Character hash includes its WorldBook relationship,
    // which ST derives from the WorldBook binding.
    for (const type of ["worldbook", "character"]) {
      scans[type] = scanSillyTavernEntities({ discovery, bindings: draft, entityType: type });
      const { claims, duplicates: typeDuplicates } = planClaims({ type, locals: scans[type], remotes, bindings: draft });
      for (const entry of claims) {
        draft[key(type, entry.managerId)] = { managerId: entry.managerId, localId: entry.localId, baseHash: entry.baseHash };
        planned.push({ type, ...entry });
      }
      for (const localId of typeDuplicates) duplicates.add(key(type, localId));
    }
    let claimed = 0;
    if (planned.length) await sidecarStore.update((candidate) => {
      claimed = 0; // The store may rerun this on a fresher state.
      for (const entry of planned) {
        const bindingKey = key(entry.type, entry.managerId);
        // Apply only claims whose bindings did not change since this read.
        if (JSON.stringify(candidate.bindings[bindingKey] ?? null) !== JSON.stringify(entry.previous)) continue;
        if (byLocal(candidate.bindings, entry.type, entry.localId)) continue;
        candidate.bindings[bindingKey] = { managerId: entry.managerId, localId: entry.localId, baseHash: entry.baseHash };
        claimed++;
      }
    });
    // Refresh reuses these scans. WorldBooks never depend on bindings; claims
    // can change Character hashes through their WorldBook link.
    return { claimed, duplicates, worldbooks: scans.worldbook, characters: planned.length ? null : scans.character };
  }

  async function refresh({ discovery }) {
    const initial = await sidecar();
    const manifest = await request(initial.config.endpoint, "manifest");
    // The version is part of every hash. A V4 BASE cannot equal either V5 hash,
    // so the first unequal V5 comparison is Different, never a direction guess.
    if (manifest?.projectionVersion !== CANONICAL_PROJECTION_VERSION) throw fail("Manager must support projection V5.");
    const remotes = new Map();
    for (const type of ["character", "worldbook"]) {
      if (!Array.isArray(manifest?.[collection(type)])) throw fail("Invalid Manager manifest.");
      for (const entity of manifest[collection(type)]) {
        checkSource(type, entity.id);
        if (entity.type !== type || !hashPattern.test(entity.contentHash)) throw fail("Invalid manifest entry.");
        remotes.set(key(type, entity.id), entity);
      }
    }
    const { claimed, duplicates, worldbooks, characters } = await claimUnbound({ discovery, remotes, bindings: initial.bindings });
    const state = claimed ? await sidecar() : initial;
    const locals = new Map([...worldbooks,
      ...(characters ?? scanSillyTavernEntities({ discovery, bindings: state.bindings, entityType: "character" }))]);
    const rows = [];
    const changes = [];
    // Name and notes come from the same side: Manager first, then ST. An
    // unsyncable local shows why instead of a status.
    const describe = (entityType, local, remote) => ({
      displayName: remote?.displayName || local?.displayName || `Unnamed ${entityType}`,
      ...(entityType === "character"
        ? { creatorNotes: remote?.creatorNotes || creatorNotesPreview(local?.canonical?.card.creator_notes) }
        : {}),
      ...(local?.error ? { error: local.error } : {}),
    });
    for (const [bindingKey, binding] of Object.entries(state.bindings)) {
      const entityType = typeOf(bindingKey);
      const local = locals.get(key(entityType, binding.localId));
      const remote = remotes.get(bindingKey);
      const status = local?.error ? "error"
        : local && remote ? classify(local.contentHash, remote.contentHash, binding.baseHash)
          : local ? "st_only" : "manager_only";
      if (!local && !remote) changes.push({ bindingKey, binding, remove: true });
      else {
        rows.push({ entityType, localId: local ? binding.localId : null,
          managerId: remote ? binding.managerId : null, ...describe(entityType, local, remote), status });
        if (status === "synced" && binding.baseHash !== remote.contentHash) {
          changes.push({ bindingKey, binding, baseHash: remote.contentHash });
        }
      }
      locals.delete(key(entityType, binding.localId));
      remotes.delete(bindingKey);
    }
    for (const local of locals.values()) rows.push({ entityType: local.entityType,
      localId: local.localId, managerId: null, ...describe(local.entityType, local, null),
      status: local.error ? "error" : duplicates.has(key(local.entityType, local.localId)) ? "duplicate" : "st_only" });
    for (const remote of remotes.values()) rows.push({ entityType: remote.type,
      localId: null, managerId: remote.id, ...describe(remote.type, null, remote), status: "manager_only" });
    if (changes.length) await sidecarStore.update((candidate) => {
      for (const change of changes) {
        if (JSON.stringify(candidate.bindings[change.bindingKey]) !== JSON.stringify(change.binding)) continue;
        if (change.remove) delete candidate.bindings[change.bindingKey];
        else candidate.bindings[change.bindingKey].baseHash = change.baseHash;
      }
    });
    rows.sort((a, b) => a.entityType.localeCompare(b.entityType) || a.displayName.localeCompare(b.displayName));
    return { rows, claimed };
  }

  async function push({ entityType, localId, adapter, confirmOverwrite = false, ...extra }) {
    if (Object.keys(extra).length || typeof confirmOverwrite !== "boolean") {
      throw fail("Push accepts only a local source and an optional overwrite confirmation.");
    }
    checkSource(entityType, localId);
    let state = await sidecar();
    let local = await readLocal(adapter, entityType, localId, state.bindings);
    if (!local) throw fail("Local source no longer exists.");
    const binding = byLocal(state.bindings, entityType, localId);
    if (binding) checkBinding(state.bindings, entityType, binding.managerId, localId);
    let remote = binding ? await readManager(state.config.endpoint, entityType, binding.managerId) : null;
    if (remote && remote.contentHash !== local.contentHash && !confirmOverwrite) {
      throw fail("Confirm overwriting the existing Manager entity before Push.",
        "overwrite_confirmation_required", { entityType });
    }
    if (entityType === "character" && local.linkedWorldBookLocalId) {
      const bookId = local.linkedWorldBookLocalId;
      const bookBinding = byLocal(state.bindings, "worldbook", bookId);
      const book = bookBinding && await readManager(state.config.endpoint, "worldbook", bookBinding.managerId);
      if (!book) await push({ entityType: "worldbook", localId: bookId, adapter, confirmOverwrite });
      state = await sidecar();
      local = await readLocal(adapter, entityType, localId, state.bindings);
      if (!local) throw fail("Local source no longer exists.");
    }
    if (remote) {
      checkBinding((await sidecar()).bindings, entityType, remote.id, localId);
      if (remote.contentHash !== local.contentHash) await request(state.config.endpoint,
        `${collection(entityType)}/${encodeURIComponent(remote.id)}`, "PUT",
        { baseRevision: remote.revision, canonical: local.canonical });
    } else {
      const created = await request(state.config.endpoint, collection(entityType), "POST", { canonical: local.canonical });
      checkSource(entityType, created?.entity?.id);
      remote = created.entity;
    }
    const verifiedRemote = await readManager(state.config.endpoint, entityType, remote.id);
    const verifiedLocal = await readLocal(adapter, entityType, localId, (await sidecar()).bindings);
    if (verifiedRemote?.contentHash !== local.contentHash || verifiedLocal?.contentHash !== local.contentHash) {
      throw fail("Push verification failed; binding and baseHash were not updated.");
    }
    await saveBinding(entityType, remote.id, localId, local.contentHash, binding);
    const frontendChanges = [];
    if (entityType === "character") {
      try {
        if (await adapter.stampManagerId({ localId, managerId: remote.id })) {
          frontendChanges.push({ entityType, localId, created: false });
        }
      } catch (error) {
        throw fail(`Pushed and verified, but embedding the Manager id in the ST card failed: ${error.message}`);
      }
    }
    const warnings = [];
    if (entityType === "character") {
      // Push makes SillyTavern's picture the Manager avatar too.
      try {
        await writeManagerAvatar(state.config.endpoint, remote.id, await adapter.readAvatar({ localId }));
      } catch (error) {
        warnings.push(`${local.canonical.card.name || "Character"}: avatar not sent (${error.message})`);
      }
    }
    return { entityType, managerId: remote.id, localId, status: "pushed", frontendChanges, warnings };
  }

  async function pull({ entityType, managerId, adapter, worldbookChoice = null, ...extra }) {
    if (Object.keys(extra).length) throw fail("Pull accepts only a Manager source.");
    checkSource(entityType, managerId);
    let state = await sidecar();
    const remote = await readManager(state.config.endpoint, entityType, managerId);
    if (!remote) throw fail("Manager source no longer exists.");
    const binding = state.bindings[key(entityType, managerId)];
    if (binding) checkBinding(state.bindings, entityType, managerId, binding.localId);
    // Pull overwrites whatever is there, so unsyncable local content is fine.
    const local = binding && await readLocal(adapter, entityType, binding.localId, state.bindings, { existenceOnly: true });
    const frontendChanges = [];
    let worldBookLocalId = null;
    if (entityType === "character" && remote.canonical.relationship.worldBookId) {
      const bookId = remote.canonical.relationship.worldBookId;
      const bookBinding = state.bindings[key("worldbook", bookId)];
      const book = bookBinding && await readLocal(adapter, "worldbook", bookBinding.localId, state.bindings, { existenceOnly: true });
      if (book) worldBookLocalId = bookBinding.localId;
      else {
        const result = await pull({ entityType: "worldbook", managerId: bookId, adapter, worldbookChoice });
        worldBookLocalId = result.localId;
        frontendChanges.push(...result.frontendChanges);
      }
      state = await sidecar();
    }
    if (entityType === "worldbook" && !binding) {
      const candidates = (await adapter.listWorldbooks()).filter((book) => book.displayName === remote.canonical.worldbook.name);
      if (candidates.length) {
        const choice = worldbookChoice?.managerId === managerId ? worldbookChoice : null;
        if (choice?.mode === "cancel") throw fail("Pull cancelled.", "cancelled");
        if (choice?.mode === "use_existing") {
          if (!candidates.some((book) => book.localId === choice.localId)) throw fail("WorldBook choice is no longer available.");
          checkBinding(state.bindings, entityType, managerId, choice.localId);
          const existing = await readLocal(adapter, entityType, choice.localId, state.bindings);
          const currentRemote = await readManager(state.config.endpoint, entityType, managerId);
          if (!existing || currentRemote?.contentHash !== remote.contentHash) throw fail("WorldBook changed; try Pull again.");
          await saveBinding(entityType, managerId, choice.localId,
            existing.contentHash === remote.contentHash ? remote.contentHash : null);
          return { entityType, managerId, localId: choice.localId, status: "bound", frontendChanges };
        }
        if (choice?.mode !== "import_duplicate") throw fail("Choose how to import the same-name WorldBook.",
          "worldbook_name_conflict", { managerId, displayName: remote.canonical.worldbook.name, candidates });
      }
    }
    let localId = local ? binding.localId : null;
    if (local) {
      checkBinding((await sidecar()).bindings, entityType, managerId, localId);
      await adapter.writeExisting({ entityType, localId, canonical: remote.canonical, worldBookLocalId, managerId });
    } else {
      const reservedLocalIds = Object.entries(state.bindings)
        .filter(([k]) => typeOf(k) === entityType).map(([, b]) => b.localId);
      ({ localId } = await adapter.create({ entityType, canonical: remote.canonical, worldBookLocalId, reservedLocalIds, managerId }));
      checkSource(entityType, localId);
    }
    const verifiedRemote = await readManager(state.config.endpoint, entityType, managerId);
    const verifiedLocal = await readLocal(adapter, entityType, localId, (await sidecar()).bindings);
    if (verifiedRemote?.contentHash !== remote.contentHash || verifiedLocal?.contentHash !== remote.contentHash) {
      throw fail("Pull verification failed; binding and baseHash were not updated.");
    }
    await saveBinding(entityType, managerId, localId, remote.contentHash, binding);
    const warnings = [];
    let avatarChanged = false;
    if (entityType === "character") {
      // ST rewrites only the picture, so the verified content stays as it is.
      try {
        const image = await readManagerAvatar(state.config.endpoint, managerId);
        if (image) {
          await adapter.writeAvatar({ localId, image });
          avatarChanged = true;
        }
      } catch (error) {
        warnings.push(`${remote.canonical.card.name || "Character"}: avatar not written (${error.message})`);
      }
    }
    frontendChanges.push({ entityType, localId, created: !local, avatarChanged });
    return { entityType, managerId, localId, status: "pulled", frontendChanges, warnings };
  }

  async function syncAll({ discovery, adapter, confirmOverwrite = false, ...extra }) {
    if (Object.keys(extra).length || typeof confirmOverwrite !== "boolean") {
      throw fail("Sync All accepts only discovery and an optional overwrite confirmation.");
    }
    const { rows } = await refresh({ discovery });
    if (!confirmOverwrite && rows.some((row) => row.status === "st_changed")) {
      throw fail("Confirm overwriting existing Manager entities before Sync All.",
        "overwrite_confirmation_required");
    }
    const results = [];
    const frontendChanges = [];
    for (const row of rows.sort((a, b) => Number(b.entityType === "worldbook") - Number(a.entityType === "worldbook"))) {
      try {
        const result = row.status === "st_changed" ? await push({ entityType: row.entityType, localId: row.localId, adapter, confirmOverwrite })
          : row.status === "manager_changed" ? await pull({ entityType: row.entityType, managerId: row.managerId, adapter })
            : { status: "skipped" };
        results.push(result);
        frontendChanges.push(...(result.frontendChanges ?? []));
      } catch (error) {
        results.push({ status: "failed", entityType: row.entityType, displayName: row.displayName, message: error.message });
      }
    }
    return { results, frontendChanges };
  }

  async function configure({ endpoint }) {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || !url.pathname.replace(/\/+$/, "").endsWith("/api/sync/v1")) throw fail("Invalid Manager endpoint.");
    await sidecarStore.update((state) => { state.config.endpoint = url.href.replace(/\/+$/, ""); });
    return getConfiguration();
  }

  async function getConfiguration() {
    const { config } = await sidecarStore.read();
    return { endpoint: config.endpoint, configured: Boolean(config.endpoint) };
  }

  async function renameLocal({ oldLocalId, newLocalId }) {
    checkSource("character", oldLocalId);
    checkSource("character", newLocalId);
    if (oldLocalId === newLocalId) return {};
    await sidecarStore.update((state) => {
      const binding = byLocal(state.bindings, "character", oldLocalId);
      if (!binding) return;
      if (byLocal(state.bindings, "character", newLocalId)) throw fail("Renamed Character is already bound.");
      binding.localId = newLocalId;
    });
    return {};
  }

  return { refresh, push, pull, syncAll, configure, getConfiguration, renameLocal };
}
