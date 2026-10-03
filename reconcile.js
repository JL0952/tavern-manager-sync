export class FrontendReconciliationError extends Error {}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || !value) {
    throw new FrontendReconciliationError(`${label} must be a non-empty string.`);
  }
}

/**
 * Reconcile a verified Pull with SillyTavern's own frontend state. Only the
 * changed entity identity is passed here, never raw card/worldbook content.
 */
export function createSillyTavernFrontendReconciler({
  getContext,
  decodeLocalId = decodeURIComponent,
  worldInfoCache,
  updateWorldInfoList,
  reloadWorldInfoEditor,
  fetch: fetchImpl = globalThis.fetch,
  document: documentImpl = globalThis.document,
} = {}) {
  if (typeof getContext !== "function") {
    throw new FrontendReconciliationError("SillyTavern frontend reconciliation requires getContext.");
  }
  if (typeof decodeLocalId !== "function") {
    throw new FrontendReconciliationError("SillyTavern frontend reconciliation requires local identity decoding.");
  }

  // What ST does after its own avatar change: reload the cached thumbnail and
  // card image, then reload every <img> that shows the thumbnail.
  async function refreshAvatarImages(avatar) {
    const thumbnailUrl = getContext()?.getThumbnailUrl?.("avatar", avatar)
      ?? `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`;
    await Promise.all([thumbnailUrl, `/characters/${encodeURIComponent(avatar)}`]
      .map((url) => fetchImpl(url, { method: "GET", cache: "reload" })));
    for (const image of documentImpl?.querySelectorAll?.(`img[src^="${thumbnailUrl}"]`) ?? []) {
      const source = image.src;
      image.src = "";
      image.src = source;
    }
  }

  async function reconcileCharacter(localId, created, avatarChanged) {
    assertNonEmptyString(localId, "Character localId");
    const avatar = decodeLocalId(localId);
    if (avatarChanged) await refreshAvatarImages(avatar);
    const context = getContext();
    if (created) {
      if (typeof context?.getCharacters !== "function") {
        throw new FrontendReconciliationError("SillyTavern Character list refresh is unavailable.");
      }
      await context.getCharacters();
      const character = getContext().characters?.find((character) => character.avatar === avatar);
      if (!character) {
        throw new FrontendReconciliationError("Created Character is missing after list refresh.");
      }
      await getContext().importTags(character);
      return;
    }

    if (
      !Array.isArray(context?.characters) ||
      typeof context.getOneCharacter !== "function" ||
      typeof context.selectCharacterById !== "function" ||
      !context.eventSource ||
      !context.eventTypes?.CHARACTER_EDITED
    ) {
      throw new FrontendReconciliationError("SillyTavern Character reconciliation context is unavailable.");
    }

    // getOneCharacter is ST's native targeted in-memory refresh. It replaces
    // just the matching entry in getContext().characters.
    await context.getOneCharacter(avatar);
    const characterId = context.characters.findIndex((character) => character?.avatar === avatar);
    if (characterId < 0 || !context.characters[characterId]) {
      throw new FrontendReconciliationError("SillyTavern Character is unavailable after targeted refresh.");
    }
    // ST owns Ask/None/All (and Only existing) behavior and its local registry.
    await context.importTags(context.characters[characterId]);

    // Reselecting the current character runs ST's normal editor population
    // path. It does not reload the page or alter unrelated Characters.
    if (String(context.characterId) === String(characterId)) {
      await context.selectCharacterById(characterId, { switchMenu: false });
    }

    await context.eventSource.emit(context.eventTypes.CHARACTER_EDITED, {
      detail: { id: characterId, character: context.characters[characterId] },
    });
  }

  async function reconcileWorldbook(localId) {
    assertNonEmptyString(localId, "Worldbook localId");
    const fileId = decodeLocalId(localId);
    if (
      !worldInfoCache ||
      typeof worldInfoCache.delete !== "function" ||
      typeof updateWorldInfoList !== "function" ||
      typeof reloadWorldInfoEditor !== "function"
    ) {
      throw new FrontendReconciliationError("SillyTavern World Info reconciliation APIs are unavailable.");
    }

    // ST loadWorldInfo returns a cached payload. Drop only this verified book,
    // refresh the native selector list, then reload the currently open editor
    // through ST's own editor path. No extra ST write is performed.
    worldInfoCache.delete(fileId);
    await updateWorldInfoList();
    await reloadWorldInfoEditor(fileId, true);
  }

  // A batch refreshes ST's lists once rather than once per entity. Pushed
  // Characters only gained their embedded id; created ones get their tags with
  // the setting chosen for the whole batch, so ST asks nothing per Character.
  async function reconcileAll(changes, importSetting) {
    const books = changes.filter((change) => change.entityType === "worldbook");
    const characters = changes.filter((change) => change.entityType === "character");
    if (books.length + characters.length !== changes.length) {
      throw new FrontendReconciliationError("SillyTavern reconciliation entityType is invalid.");
    }
    for (const { localId } of changes) assertNonEmptyString(localId, "Batch localId");
    const errors = [];

    if (books.length) {
      if (!worldInfoCache || typeof worldInfoCache.delete !== "function" || typeof updateWorldInfoList !== "function"
        || typeof reloadWorldInfoEditor !== "function") {
        throw new FrontendReconciliationError("SillyTavern World Info reconciliation APIs are unavailable.");
      }
      for (const { localId } of books) worldInfoCache.delete(decodeLocalId(localId));
      await updateWorldInfoList();
      // Only a book the editor already shows is reloaded.
      for (const { localId } of books) await reloadWorldInfoEditor(decodeLocalId(localId), false);
    }

    if (characters.length) {
      if (typeof getContext()?.getCharacters !== "function") {
        throw new FrontendReconciliationError("SillyTavern Character list refresh is unavailable.");
      }
      // ST reselects the open Character itself, through its own editor path.
      await getContext().getCharacters();
      const context = getContext();
      for (const { localId } of characters.filter((change) => change.created)) {
        const avatar = decodeLocalId(localId);
        const character = context.characters?.find((candidate) => candidate.avatar === avatar);
        if (!character) {
          errors.push(`Created Character ${avatar} is missing after list refresh.`);
          continue;
        }
        await context.importTags(character, { importSetting });
      }
    }

    if (errors.length) throw new FrontendReconciliationError(errors.join(" "));
  }

  return Object.freeze({
    async reconcile({ entityType, localId, created = false, avatarChanged = false } = {}) {
      if (entityType === "character") return reconcileCharacter(localId, created, avatarChanged);
      if (entityType === "worldbook") return reconcileWorldbook(localId);
      throw new FrontendReconciliationError("SillyTavern reconciliation entityType is invalid.");
    },
    async reconcileAll(changes = [], { importSetting = null } = {}) {
      return reconcileAll(changes, importSetting);
    },
  });
}
