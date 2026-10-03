export class SillyTavernDiscoveryError extends Error {}

export function encodeLocalId(value) {
  if (typeof value !== "string" || !value) throw new SillyTavernDiscoveryError("Invalid local identity.");
  return encodeURIComponent(value);
}

// Where World Info file ids come from. /api/worldinfo/list is a route of ST's
// Node server that ST's own frontend never calls, so TauriTavern does not
// implement it. Both hosts return the ids as /api/settings/get's world_names,
// the list ST's frontend itself reads; a file's stored name then needs a read.
export const WORLDBOOK_LIST_SOURCES = Object.freeze(["endpoint", "settings"]);

export function worldNamesFromSettings(settings) {
  const names = settings?.world_names;
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !name)) {
    throw new SillyTavernDiscoveryError("Invalid World Info name list.");
  }
  return names;
}

// Per-file reads run a few at a time, the way a browser spreads requests over
// its connections. Results keep list order; after a failure no new read starts.
const concurrentReads = 6;

export async function mapConcurrently(items, task) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;

  async function worker() {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await task(items[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrentReads, items.length) }, worker));
  return results;
}

export async function discoverSillyTavern({ requestHeaders, fetch: fetchImpl = globalThis.fetch, worldbookList = "endpoint" } = {}) {
  if (!WORLDBOOK_LIST_SOURCES.includes(worldbookList)) throw new SillyTavernDiscoveryError("Unknown World Info list source.");
  const headers = requestHeaders();
  async function read(path, body) {
    const response = await fetchImpl(path, { method: "POST", headers, body: JSON.stringify(body), cache: "no-cache" });
    if (!response.ok) throw new SillyTavernDiscoveryError(`ST discovery returned HTTP ${response.status}.`);
    return response.json();
  }
  const listed = await read("/api/characters/all", {});
  if (!Array.isArray(listed)) throw new SillyTavernDiscoveryError("Invalid Character list.");
  if (listed.some((item) => typeof item?.avatar !== "string" || !item.avatar)) {
    throw new SillyTavernDiscoveryError("Incomplete Character list.");
  }
  const characters = await mapConcurrently(listed, async (listedItem) => {
    const { avatar } = listedItem;
    const item = listedItem.shallow || typeof listedItem.json_data !== "string"
      ? await read("/api/characters/get", { avatar_url: avatar })
      : listedItem;
    // Never hash shallow display metadata or substitute it for the raw card.
    if (item?.shallow || typeof item?.json_data !== "string") {
      throw new SillyTavernDiscoveryError("Full Character data is unavailable.");
    }
    const rawCard = JSON.parse(item.json_data);
    if (!rawCard || typeof rawCard !== "object" || Array.isArray(rawCard)) {
      throw new SillyTavernDiscoveryError("Invalid Character data.");
    }
    return { localId: encodeLocalId(avatar), avatarFileName: avatar, rawCard };
  });
  let fileIds;
  if (worldbookList === "settings") {
    fileIds = worldNamesFromSettings(await read("/api/settings/get", {}));
  } else {
    const books = await read("/api/worldinfo/list", {});
    if (!Array.isArray(books)) throw new SillyTavernDiscoveryError("Invalid WorldBook list.");
    if (books.some((book) => typeof book?.file_id !== "string" || !book.file_id)) {
      throw new SillyTavernDiscoveryError("Incomplete WorldBook list.");
    }
    fileIds = books.map((book) => book.file_id);
  }
  const worldbooks = await mapConcurrently(fileIds, async (fileId) => {
    const rawWorldBook = await read("/api/worldinfo/get", { name: fileId });
    if (!rawWorldBook?.entries || typeof rawWorldBook.entries !== "object") {
      throw new SillyTavernDiscoveryError("Full WorldBook data is unavailable.");
    }
    return { localId: encodeLocalId(fileId), fileId, rawWorldBook };
  });
  return { characters, worldbooks };
}
