// Native SillyTavern endpoints used by the minimal sync adapter. Requests are
// same-origin from the browser, so ST's own session cookie applies; the caller
// supplies ST's request headers (CSRF), UUID source and World Info list source.
import { WORLDBOOK_LIST_SOURCES, mapConcurrently, worldNamesFromSettings } from "./st-discovery.js";

// path.posix.parse(segment).name for one path segment. sanitize-filename output
// never contains "/", and ST derives World Info file_ids with path.parse.
export function parsedFileName(segment) {
  let startDot = -1;
  let preDotState = 0;

  for (let index = segment.length - 1; index >= 0; index -= 1) {
    if (segment[index] === ".") {
      if (startDot === -1) startDot = index;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }

  if (startDot === -1 || preDotState === 0 || (preDotState === 1 && startDot === segment.length - 1 && startDot === 1)) {
    return segment;
  }
  return segment.slice(0, startDot);
}

export function createNativeStGateway({ fetch: fetchImpl = globalThis.fetch, requestHeaders, uuid, worldbookList = "endpoint" } = {}) {
  if (typeof fetchImpl !== "function" || typeof requestHeaders !== "function" || typeof uuid !== "function") {
    throw new Error("SillyTavern gateway requires fetch, request headers, and a UUID source.");
  }
  if (!WORLDBOOK_LIST_SOURCES.includes(worldbookList)) {
    throw new Error("Unknown SillyTavern World Info list source.");
  }

  function post(path, body) {
    return fetchImpl(path, {
      method: "POST",
      headers: { ...requestHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function nativePost(path, body, label) {
    const response = await post(path, body);
    if (!response.ok) {
      throw new Error(`${label} returned HTTP ${response.status}.`);
    }
    return response;
  }

  function missingLocal(label) {
    const error = new Error(`${label} no longer exists locally.`);
    error.code = "missing_local";
    return error;
  }

  async function settingsWorldNames() {
    const response = await nativePost("/api/settings/get", {}, "SillyTavern settings");
    return worldNamesFromSettings(await response.json());
  }

  // ST lists every World Info file with the name stored inside it. From the
  // settings list, each file is read for that name.
  async function listWorldbookEntries() {
    if (worldbookList === "settings") {
      return mapConcurrently(await settingsWorldNames(), async (fileId) => {
        const response = await nativePost("/api/worldinfo/get", { name: fileId }, "SillyTavern World Info read");
        return { file_id: fileId, name: (await response.json())?.name };
      });
    }
    const response = await nativePost("/api/worldinfo/list", {}, "SillyTavern World Info list");
    const listed = await response.json();
    if (!Array.isArray(listed)) {
      throw new Error("SillyTavern World Info list is invalid.");
    }
    return listed.filter((entry) => typeof entry?.file_id === "string" && entry.file_id);
  }

  async function listWorldbookFileIds() {
    if (worldbookList === "settings") return new Set(await settingsWorldNames());
    return new Set((await listWorldbookEntries()).map((entry) => entry.file_id));
  }

  async function storedWorldbookFileId(name) {
    // ST itself writes World Info files as sanitize(`${name}.json`), using the
    // same sanitize-filename package behind this endpoint.
    const response = await nativePost(
      "/api/files/sanitize-filename",
      { fileName: `${name}.json` },
      "SillyTavern filename sanitization",
    );
    const { fileName } = await response.json();
    if (typeof fileName !== "string") {
      throw new Error("SillyTavern filename sanitization is invalid.");
    }
    return parsedFileName(fileName);
  }

  return Object.freeze({
    async listWorldbooks() {
      return (await listWorldbookEntries()).map(({ file_id: fileId, name }) => ({
        localId: encodeURIComponent(fileId),
        displayName: (typeof name === "string" && name.trim()) || fileId,
      }));
    },

    async readLocal({ entityType, localId }) {
      if (typeof localId !== "string" || !localId) {
        throw new Error("SillyTavern local identity is invalid.");
      }
      const fileId = decodeURIComponent(localId);

      if (entityType === "character") {
        const response = await post("/api/characters/get", { avatar_url: fileId });
        if (response.status === 404) throw missingLocal("SillyTavern character");
        if (!response.ok) throw new Error(`SillyTavern character reread returned HTTP ${response.status}.`);
        const payload = await response.json();
        if (typeof payload?.json_data !== "string") {
          throw new Error("SillyTavern character reread did not return json_data.");
        }
        try {
          return { avatarFileName: fileId, rawCard: JSON.parse(payload.json_data) };
        } catch (error) {
          throw new Error(`SillyTavern character json_data is invalid: ${error.message}`);
        }
      }

      if (entityType === "worldbook") {
        const worldbookFileIds = await listWorldbookFileIds();
        if (!worldbookFileIds.has(fileId)) throw missingLocal("SillyTavern World Info");
        const response = await post("/api/worldinfo/get", { name: fileId });
        if (response.status === 404) throw missingLocal("SillyTavern World Info");
        if (!response.ok) throw new Error(`SillyTavern World Info reread returned HTTP ${response.status}.`);
        const rawWorldBook = await response.json();
        if (!rawWorldBook || typeof rawWorldBook !== "object") throw missingLocal("SillyTavern World Info");
        return { fileId, rawWorldBook };
      }

      throw new Error("SillyTavern pull entity type is invalid.");
    },

    async writeCharacter({ avatarFileName, update }) {
      if (typeof avatarFileName !== "string" || !avatarFileName || !update || typeof update !== "object") {
        throw new Error("SillyTavern character update is invalid.");
      }
      await nativePost(
        "/api/characters/merge-attributes",
        { ...structuredClone(update), avatar: avatarFileName },
        "SillyTavern character update",
      );
    },

    // A Character's card file is its avatar image.
    async readAvatar({ avatarFileName }) {
      if (typeof avatarFileName !== "string" || !avatarFileName) {
        throw new Error("SillyTavern avatar read is invalid.");
      }
      const response = await fetchImpl(`/characters/${encodeURIComponent(avatarFileName)}`, {
        headers: requestHeaders(),
        cache: "no-store",
      });
      if (response.status === 404) throw missingLocal("SillyTavern character");
      if (!response.ok) throw new Error(`SillyTavern avatar read returned HTTP ${response.status}.`);
      return response.blob();
    },

    // ST's own avatar change: it redraws the picture and keeps the card data.
    async writeAvatar({ avatarFileName, image }) {
      if (typeof avatarFileName !== "string" || !avatarFileName || !(image instanceof Blob)) {
        throw new Error("SillyTavern avatar update is invalid.");
      }
      // The browser sets the multipart Content-Type with its boundary.
      const headers = Object.fromEntries(Object.entries(requestHeaders())
        .filter(([name]) => name.toLowerCase() !== "content-type"));
      const form = new FormData();
      form.append("avatar", image, image.type === "image/jpeg" ? "avatar.jpg" : "avatar.png");
      form.append("avatar_url", avatarFileName);
      const response = await fetchImpl("/api/characters/edit-avatar", { method: "POST", headers, body: form });
      if (!response.ok) throw new Error(`SillyTavern avatar update returned HTTP ${response.status}.`);
    },

    async writeWorldbook({ fileId, rawWorldBook }) {
      if (typeof fileId !== "string" || !fileId || !rawWorldBook || typeof rawWorldBook !== "object") {
        throw new Error("SillyTavern World Info update is invalid.");
      }
      const response = await nativePost(
        "/api/worldinfo/edit",
        { name: fileId, data: rawWorldBook },
        "SillyTavern World Info update",
      );
      const result = await response.json();
      if (result?.ok !== true) {
        throw new Error("SillyTavern World Info update did not confirm a successful write.");
      }
      // ST 1.18 returns { ok: true }, not a file_id. The fixed, sanitized
      // request name is verified by an immediate /api/worldinfo/get reread.
      return fileId;
    },

    async createCharacter({ canonical, worldBookFileId, reservedLocalIds = [] }) {
      const card = canonical?.card;
      if (!card || typeof card !== "object" || typeof card.name !== "string" || !card.name.trim()) {
        throw new Error("Canonical Character create request is invalid.");
      }
      let fileName;
      while (true) {
        fileName = `tavern-sync-${uuid()}`;
        if (reservedLocalIds.includes(encodeURIComponent(`${fileName}.png`))) continue;
        const existing = await post("/api/characters/get", { avatar_url: `${fileName}.png` });
        if (existing.status === 404) break;
        if (!existing.ok) throw new Error(`Character filename check returned HTTP ${existing.status}.`);
      }
      const response = await nativePost(
        "/api/characters/create",
        {
          ch_name: card.name,
          file_name: fileName,
          description: card.description,
          personality: card.personality,
          scenario: card.scenario,
          first_mes: card.first_mes,
          mes_example: card.mes_example,
          creator_notes: card.creator_notes,
          depth_prompt_prompt: card.extensions.depth_prompt.prompt,
          depth_prompt_depth: card.extensions.depth_prompt.depth,
          depth_prompt_role: card.extensions.depth_prompt.role,
          system_prompt: card.system_prompt,
          post_history_instructions: card.post_history_instructions,
          alternate_greetings: card.alternate_greetings,
          group_only_greetings: card.group_only_greetings,
          creator: card.creator,
          character_version: card.character_version,
          tags: card.tags,
          assets: card.assets,
          world: worldBookFileId ?? "",
        },
        "SillyTavern character create",
      );
      const avatarFileName = (await response.text()).trim();
      if (!avatarFileName) throw new Error("SillyTavern character create did not return an avatar filename.");
      return avatarFileName;
    },

    async createWorldbook({ name, rawWorldBook, reservedLocalIds = [] }) {
      if (typeof name !== "string" || !name.trim() || !rawWorldBook || typeof rawWorldBook !== "object") {
        throw new Error("Canonical WorldBook create request is invalid.");
      }
      const existingFileIds = await listWorldbookFileIds();
      for (const id of reservedLocalIds) existingFileIds.add(decodeURIComponent(id));
      for (let suffix = 1; suffix <= 1000; suffix += 1) {
        const requestedName = suffix === 1 ? name.trim() : `${name.trim()} (${suffix})`;
        // The exact ST storage rule chooses a free file_id before /edit, so a
        // duplicate import cannot overwrite an existing World Info file.
        const fileId = await storedWorldbookFileId(requestedName);
        if (!fileId || existingFileIds.has(fileId)) continue;
        const response = await nativePost(
          "/api/worldinfo/edit",
          { name: fileId, data: rawWorldBook },
          "SillyTavern World Info create",
        );
        const result = await response.json();
        if (result?.ok !== true) throw new Error("SillyTavern World Info create did not confirm success.");
        if (!(await listWorldbookFileIds()).has(fileId)) {
          throw new Error("SillyTavern World Info create did not produce the requested file_id.");
        }
        return fileId;
      }
      throw new Error("Unable to allocate a new SillyTavern World Info filename.");
    },
  });
}
