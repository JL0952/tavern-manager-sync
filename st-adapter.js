import {
  CANONICAL_CHARACTER_FIELDS,
  normalizeCanonicalWorldBookEntry,
  createCanonicalCharacterProjection,
  createCanonicalWorldBookProjection,
  getCanonicalWorldBookProjectionDiagnostics,
  hashCanonicalProjection,
} from "./sync-core/syncProjection.js";
import { materializeCanonicalWorldBook } from "./sync-core/syncCanonicalMaterializer.js";
import { encodeLocalId } from "./st-discovery.js";

export class DiscoveryError extends Error {}
export class AdapterError extends Error {}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function normalizeString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeArray(value) {
  return Array.isArray(value) ? clone(value) : [];
}

function normalizeObject(value) {
  return isPlainObject(value) ? clone(value) : {};
}

function getCompatibleValue(source, rawCard, field, isValid) {
  for (const value of [source[field], rawCard[field]]) {
    if (isValid(value)) return value;
  }
  return undefined;
}

function getString(source, rawCard, field) {
  return normalizeString(getCompatibleValue(source, rawCard, field, (value) => typeof value === "string"));
}

function getArray(source, rawCard, field) {
  return normalizeArray(getCompatibleValue(source, rawCard, field, Array.isArray));
}

function getObject(source, rawCard, field) {
  return normalizeObject(getCompatibleValue(source, rawCard, field, isPlainObject));
}

function normalizeTags(value) {
  const tags = Array.isArray(value) ? value : [];
  return [...new Set(tags.filter((tag) => typeof tag === "string" && tag.trim()).map((tag) => tag.trim()))];
}

export function readCharacterWorldReference(rawCard) {
  const source = isPlainObject(rawCard.data) ? rawCard.data : rawCard;
  const world = source?.extensions?.world ?? rawCard?.extensions?.world;
  return typeof world === "string" && world ? world : null;
}

// The Manager UUID travels inside the card file so a manual download/import
// keeps its identity. It is outside the canonical projection, so it never
// participates in content hashes.
export const EMBEDDED_MANAGER_KEY = "tavern_manager";

export function readEmbeddedManagerId(rawCard) {
  const source = isPlainObject(rawCard?.data) ? rawCard.data : rawCard;
  const value = source?.extensions?.[EMBEDDED_MANAGER_KEY] ?? rawCard?.extensions?.[EMBEDDED_MANAGER_KEY];
  return isPlainObject(value) && typeof value.id === "string" && value.id ? value.id : null;
}

export function decodeLocalId(value) {
  if (typeof value !== "string" || !value) {
    throw new DiscoveryError("SillyTavern local identity must be a non-empty string.");
  }

  try {
    return decodeURIComponent(value);
  } catch (error) {
    throw new DiscoveryError(`SillyTavern local identity is invalid: ${error.message}`);
  }
}

export function normalizeSillyTavernCharacter(rawCard, localId, worldBookId) {
  if (!isPlainObject(rawCard)) {
    throw new DiscoveryError("SillyTavern character json_data must contain an object.");
  }

  const source = isPlainObject(rawCard.data) ? rawCard.data : rawCard;
  const creatorNotes =
    getString(source, rawCard, "creator_notes") ||
    getString(source, rawCard, "creatorNotes") ||
    normalizeString(source.creatorcomment) ||
    normalizeString(rawCard.creatorcomment);

  return {
    id: localId,
    spec: getString(source, rawCard, "spec"),
    spec_version: getString(source, rawCard, "spec_version"),
    name: getString(source, rawCard, "name"),
    description: getString(source, rawCard, "description"),
    personality: getString(source, rawCard, "personality"),
    scenario: getString(source, rawCard, "scenario"),
    first_mes: getString(source, rawCard, "first_mes"),
    mes_example: getString(source, rawCard, "mes_example"),
    creator_notes: creatorNotes,
    system_prompt: getString(source, rawCard, "system_prompt"),
    post_history_instructions: getString(source, rawCard, "post_history_instructions"),
    alternate_greetings: getArray(source, rawCard, "alternate_greetings"),
    group_only_greetings: getArray(source, rawCard, "group_only_greetings"),
    creator: getString(source, rawCard, "creator"),
    character_version: getString(source, rawCard, "character_version"),
    tags: normalizeTags(getCompatibleValue(source, rawCard, "tags", Array.isArray)),
    assets: getArray(source, rawCard, "assets"),
    extensions: getObject(source, rawCard, "extensions"),
    rawCard: clone(rawCard),
    worldBookId,
  };
}

function normalizeWorldbookEntry(id, value) {
  const rawEntry = normalizeObject(value);
  return {
    ...normalizeCanonicalWorldBookEntry({ ...rawEntry, id: String(rawEntry.uid ?? rawEntry.id ?? id) }, id),
    rawEntry,
  };
}

export function normalizeSillyTavernWorldbook(rawWorldBook, localId, fileId) {
  if (!isPlainObject(rawWorldBook)) {
    throw new DiscoveryError("SillyTavern worldbook must contain an object.");
  }

  const entriesObject = rawWorldBook.entries;
  if (!isPlainObject(entriesObject)) {
    throw new DiscoveryError("SillyTavern worldbook must contain an entries object.");
  }

  return {
    id: localId,
    name: normalizeString(rawWorldBook.name).trim() || fileId,
    entries: Object.entries(entriesObject)
      .map(([id, entry]) => normalizeWorldbookEntry(id, entry)),
    rawWorldBook: clone(rawWorldBook),
  };
}

function bindingsByLocalId(bindings) {
  const byLocal = new Map();

  for (const [bindingKey, binding] of Object.entries(bindings)) {
    const entityType = bindingKey.split(":", 1)[0];
    if (
      ["character", "worldbook"].includes(entityType) &&
      typeof binding.managerId === "string" && binding.managerId &&
      typeof binding.localId === "string" && binding.localId
    ) {
      byLocal.set(`${entityType}:${binding.localId}`, binding.managerId);
    }
  }

  return byLocal;
}

// WorldBook records never depend on bindings; Character records do, through
// their WorldBook link. `entityType` limits the scan to one of them.
export function scanSillyTavernEntities({ discovery, bindings = {}, entityType = null }) {
  if (!isPlainObject(discovery) || !Array.isArray(discovery.characters) || !Array.isArray(discovery.worldbooks)) {
    throw new DiscoveryError("SillyTavern discovery payload is invalid.");
  }

  const bindingsByLocal = bindingsByLocalId(bindings);
  const records = new Map();

  for (const item of entityType === "character" ? [] : discovery.worldbooks) {
    if (!isPlainObject(item) || typeof item.localId !== "string" || !item.localId || typeof item.fileId !== "string" || !item.fileId || !isPlainObject(item.rawWorldBook)) {
      throw new DiscoveryError("SillyTavern worldbook discovery record is invalid.");
    }

    try {
      const worldbook = normalizeSillyTavernWorldbook(item.rawWorldBook, item.localId, item.fileId);
      const canonical = createCanonicalWorldBookProjection(worldbook);
      records.set(`worldbook:${item.localId}`, {
        entityType: "worldbook",
        localId: item.localId,
        displayName: worldbook.name,
        canonical,
        contentHash: hashCanonicalProjection(canonical),
        diagnostics: getCanonicalWorldBookProjectionDiagnostics(worldbook),
      });
    } catch (error) {
      const name = typeof item.rawWorldBook.name === "string" ? item.rawWorldBook.name.trim() : "";
      records.set(`worldbook:${item.localId}`, unsyncable("worldbook", item.localId, name || item.fileId, error));
    }
  }

  for (const item of entityType === "worldbook" ? [] : discovery.characters) {
    if (!isPlainObject(item) || typeof item.localId !== "string" || !item.localId || typeof item.avatarFileName !== "string" || !item.avatarFileName || !isPlainObject(item.rawCard)) {
      throw new DiscoveryError("SillyTavern character discovery record is invalid.");
    }

    const localWorldReference = readCharacterWorldReference(item.rawCard);
    const localWorldId = localWorldReference ? encodeLocalId(localWorldReference) : null;
    const worldBookId = localWorldId ? bindingsByLocal.get(`worldbook:${localWorldId}`) ?? null : null;
    const diagnostics = [];

    if (localWorldReference && !worldBookId) {
      diagnostics.push({ code: "unpaired_local_worldbook_reference", localId: localWorldId });
    }

    try {
      const character = normalizeSillyTavernCharacter(item.rawCard, item.localId, worldBookId);
      const canonical = createCanonicalCharacterProjection(character);
      records.set(`character:${item.localId}`, {
        entityType: "character",
        localId: item.localId,
        embeddedManagerId: readEmbeddedManagerId(item.rawCard),
        displayName: character.name || item.avatarFileName,
        canonical,
        contentHash: hashCanonicalProjection(canonical),
        diagnostics,
      });
    } catch (error) {
      const source = isPlainObject(item.rawCard.data) ? item.rawCard.data : item.rawCard;
      const name = typeof source.name === "string" ? source.name : "";
      records.set(`character:${item.localId}`, unsyncable("character", item.localId, name || item.avatarFileName, error));
    }
  }

  return records;
}

// A Character or WorldBook whose content cannot be projected (an invalid
// Character's Note, for example) is reported on its own instead of failing the
// whole scan. It has no hash, so it is never paired, pushed or compared.
function unsyncable(entityType, localId, displayName, error) {
  return { entityType, localId, displayName, error: error.message };
}

function createCharacterPatch(rawCard, avatarFileName, canonical, worldBookFileId, managerId) {
  const source = isPlainObject(rawCard?.data) ? rawCard.data : rawCard;
  const fields = {};

  for (const field of CANONICAL_CHARACTER_FIELDS) {
    fields[field] = clone(canonical.card[field]);
  }

  const extensions = {
    world: worldBookFileId ?? "__@@UNSET@@__",
    depth_prompt: clone(canonical.card.extensions.depth_prompt),
    ...(managerId ? { [EMBEDDED_MANAGER_KEY]: { id: managerId } } : {}),
  };
  // /merge-attributes preserves containers; it does not update V1 mirrors.
  // Author both representations here instead of suppressing ST's warnings.
  const mirrors = Object.fromEntries(["name", "description", "personality", "scenario", "first_mes", "mes_example", "tags"]
    .map(field => [field, clone(fields[field])]));
  mirrors.creatorcomment = fields.creator_notes;
  for (const field of ["fav", "talkativeness"]) {
    if (source?.extensions?.[field] !== undefined) mirrors[field] = clone(source.extensions[field]);
  }
  const update = isPlainObject(rawCard?.data)
    ? { avatar: avatarFileName, ...mirrors, data: { ...fields, extensions } }
    : { avatar: avatarFileName, ...fields, ...mirrors, extensions };

  // The merge endpoint performs the structural preservation. Do not carry
  // arbitrary local raw fields into the request body.
  if (!isPlainObject(source)) {
    throw new DiscoveryError("SillyTavern character card has no writable object container.");
  }
  return update;
}

/**
 * Narrow native ST boundary for the minimal engine. It has no journal,
 * recovery, or persistent operation state: every call either rereads or
 * writes one concrete ST entity.
 */
export function createMinimalSillyTavernAdapter({
  readLocal,
  writeCharacter,
  writeWorldbook,
  createCharacter,
  createWorldbook,
  listWorldbooks,
  readAvatar: readAvatarFile,
  writeAvatar: writeAvatarFile,
} = {}) {
  if (
    typeof readLocal !== "function" ||
    typeof writeCharacter !== "function" ||
    typeof writeWorldbook !== "function" ||
    typeof createCharacter !== "function" ||
    typeof createWorldbook !== "function"
  ) {
    throw new AdapterError("Sync adapter requires SillyTavern read, write, and create handlers.");
  }

  function managerWorldBookId(bindings, localId) {
    const binding = Object.entries(bindings ?? {}).find(([key, candidate]) =>
      key.startsWith("worldbook:") && candidate.localId === localId,
    )?.[1];
    return binding?.managerId ?? null;
  }

  async function refresh({ entityType, localId, bindings = {} } = {}) {
    const current = await readLocal({ entityType, localId });

    if (entityType === "character") {
      if (!isPlainObject(current?.rawCard) || typeof current.avatarFileName !== "string") {
        throw new AdapterError("SillyTavern character reread is invalid.");
      }
      const localWorldReference = readCharacterWorldReference(current.rawCard);
      const linkedWorldBookLocalId = localWorldReference ? encodeLocalId(localWorldReference) : null;
      // Content that cannot be projected is reported, not thrown: Pull can
      // still overwrite it, while Push and verification refuse it.
      try {
        const character = normalizeSillyTavernCharacter(
          current.rawCard,
          localId,
          linkedWorldBookLocalId ? managerWorldBookId(bindings, linkedWorldBookLocalId) : null,
        );
        return {
          entityType,
          localId,
          canonical: createCanonicalCharacterProjection(character),
          linkedWorldBookLocalId,
        };
      } catch (error) {
        return { entityType, localId, linkedWorldBookLocalId, error: error.message };
      }
    }

    if (entityType === "worldbook") {
      if (!isPlainObject(current?.rawWorldBook) || typeof current.fileId !== "string") {
        throw new AdapterError("SillyTavern World Info reread is invalid.");
      }
      try {
        const worldbook = normalizeSillyTavernWorldbook(current.rawWorldBook, localId, current.fileId);
        return {
          entityType,
          localId,
          canonical: createCanonicalWorldBookProjection(worldbook),
          diagnostics: getCanonicalWorldBookProjectionDiagnostics(worldbook),
        };
      } catch (error) {
        return { entityType, localId, error: error.message };
      }
    }

    throw new AdapterError("Sync entity type is invalid.");
  }

  async function writeExisting({ entityType, localId, canonical, worldBookLocalId = null, managerId = null } = {}) {
    const current = await readLocal({ entityType, localId });
    if (entityType === "character") {
      if (!isPlainObject(current?.rawCard) || typeof current.avatarFileName !== "string") {
        throw new AdapterError("SillyTavern character reread is invalid.");
      }
      await writeCharacter({
        avatarFileName: current.avatarFileName,
        update: createCharacterPatch(
          current.rawCard,
          current.avatarFileName,
          canonical,
          worldBookLocalId ? decodeLocalId(worldBookLocalId) : null,
          managerId,
        ),
      });
      return;
    }

    if (entityType === "worldbook") {
      if (!isPlainObject(current?.rawWorldBook) || typeof current.fileId !== "string") {
        throw new AdapterError("SillyTavern World Info reread is invalid.");
      }
      // A book without an entries object cannot be synced; Pull rebuilds its
      // entries from canonical.
      const existingRaw = isPlainObject(current.rawWorldBook.entries)
        ? current.rawWorldBook
        : { ...current.rawWorldBook, entries: {} };
      const existingWorldbook = normalizeSillyTavernWorldbook(existingRaw, localId, current.fileId);
      const { worldBook } = materializeCanonicalWorldBook({ existingWorldBook: existingWorldbook, canonical });
      await writeWorldbook({ fileId: current.fileId, rawWorldBook: worldBook.rawWorldBook });
      return;
    }

    throw new AdapterError("Sync entity type is invalid.");
  }

  async function create({
    entityType,
    canonical,
    worldBookLocalId = null,
    reservedLocalIds = [],
    managerId = null,
  } = {}) {
    if (entityType === "character") {
      const avatarFileName = await createCharacter({
        canonical: clone(canonical),
        reservedLocalIds,
        worldBookFileId: worldBookLocalId ? decodeLocalId(worldBookLocalId) : null,
      });
      const localId = encodeLocalId(avatarFileName);
      // The ST create endpoint fills defaults outside the canonical allowlist;
      // merge the authoritative canonical fields before verification.
      await writeExisting({ entityType, localId, canonical, worldBookLocalId, managerId });
      return { localId };
    }

    if (entityType === "worldbook") {
      const name = typeof canonical?.worldbook?.name === "string" ? canonical.worldbook.name : "Worldbook";
      const seed = normalizeSillyTavernWorldbook({ name, entries: {} }, "new-worldbook", name);
      const { worldBook } = materializeCanonicalWorldBook({ existingWorldBook: seed, canonical });
      const fileId = await createWorldbook({
        name,
        rawWorldBook: worldBook.rawWorldBook,
        reservedLocalIds,
      });
      return { localId: encodeLocalId(fileId) };
    }

    throw new AdapterError("Sync entity type is invalid.");
  }

  // Writes only data.extensions.tavern_manager; the merge endpoint preserves
  // every other field. Returns whether a write was needed.
  async function stampManagerId({ localId, managerId } = {}) {
    if (typeof managerId !== "string" || !managerId) {
      throw new AdapterError("Manager id to embed must be a non-empty string.");
    }
    const current = await readLocal({ entityType: "character", localId });
    if (!isPlainObject(current?.rawCard) || typeof current.avatarFileName !== "string") {
      throw new AdapterError("SillyTavern character reread is invalid.");
    }
    if (readEmbeddedManagerId(current.rawCard) === managerId) return false;

    const marker = { [EMBEDDED_MANAGER_KEY]: { id: managerId } };
    await writeCharacter({
      avatarFileName: current.avatarFileName,
      update: isPlainObject(current.rawCard.data)
        ? { avatar: current.avatarFileName, data: { extensions: marker } }
        : { avatar: current.avatarFileName, extensions: marker },
    });
    return true;
  }

  // Avatars are image files beside the canonical content and never hashed.
  async function readAvatar({ localId } = {}) {
    if (typeof readAvatarFile !== "function") throw new AdapterError("SillyTavern avatar reads are unavailable.");
    return readAvatarFile({ avatarFileName: decodeLocalId(localId) });
  }

  async function writeAvatar({ localId, image } = {}) {
    if (typeof writeAvatarFile !== "function") throw new AdapterError("SillyTavern avatar writes are unavailable.");
    await writeAvatarFile({ avatarFileName: decodeLocalId(localId), image });
  }

  return Object.freeze({ refresh, writeExisting, create, stampManagerId, listWorldbooks, readAvatar, writeAvatar });
}
