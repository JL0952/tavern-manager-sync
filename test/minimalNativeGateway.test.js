import assert from "node:assert/strict";
import { parse } from "node:path";
import test from "node:test";
import { createCanonicalCharacterProjection } from "../sync-core/syncProjection.js";
import { createNativeStGateway, parsedFileName } from "../st-gateway.js";
import { needsSillyTavern, requireFromSillyTavern } from "./sillyTavern.js";

// The same package ST's /api/files/sanitize-filename and /api/worldinfo/edit use.
const sanitize = needsSillyTavern.skip ? null : requireFromSillyTavern("sanitize-filename");

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function gatewayWith(handler, { requests = [], worldbookList } = {}) {
  let sequence = 0;
  return createNativeStGateway({
    requestHeaders: () => ({ "Content-Type": "application/json", "X-CSRF-Token": "synthetic-token" }),
    uuid: () => `uuid-${++sequence}`,
    worldbookList,
    fetch: async (url, options) => {
      requests.push({ url, options });
      const path = new URL(url, "http://st.test").pathname;
      // The /characters/ file check is a HEAD without a body.
      const body = options.body === undefined ? undefined : JSON.parse(options.body);
      if (path === "/api/files/sanitize-filename") {
        return response({ fileName: sanitize(String(body.fileName)) });
      }
      return handler(path, body);
    },
  });
}

test("gateway sends same-origin relative requests with ST's own CSRF headers", async () => {
  const requests = [];
  const gateway = gatewayWith((path) => {
    assert.equal(path, "/api/worldinfo/list");
    return response([]);
  }, { requests });
  await gateway.listWorldbooks();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/worldinfo/list");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers["X-CSRF-Token"], "synthetic-token");
  assert.equal(requests[0].options.headers["Content-Type"], "application/json");
});

test("WorldBook candidates come from the list alone, named like ST names them", async () => {
  const requests = [];
  const gateway = gatewayWith(() => response([
    { file_id: "Lore", name: "  Lore  " },
    { file_id: "Blank", name: "   " },
    { file_id: "Unnamed" },
    { file_id: "Odd", name: 7 },
    { name: "No file" },
  ]), { requests });
  assert.deepEqual(await gateway.listWorldbooks(), [
    { localId: "Lore", displayName: "Lore" },
    { localId: "Blank", displayName: "Blank" },
    { localId: "Unnamed", displayName: "Unnamed" },
    { localId: "Odd", displayName: "Odd" },
  ]);
  assert.equal(requests.length, 1);
});

test("World Info file_id derivation matches Node path.parse for sanitized names", needsSillyTavern, () => {
  for (const name of ["Lore", "Lore (2)", "a.b", "a..json", ".json", "..", ".", "", "x.", "...", "a.b.c", "中文.json", ".hidden.json"]) {
    assert.equal(parsedFileName(name), parse(name).name, JSON.stringify(name));
  }
  for (const name of ["Lore/Bad", "Con", "a:b", "trailing. ", "  spaced  ", "x".repeat(300)]) {
    const sanitized = sanitize(`${name}.json`);
    assert.equal(parsedFileName(sanitized), parse(sanitized).name, JSON.stringify(name));
  }
});

test("WorldBook native creation allocates an ST storage-safe duplicate name from the list endpoint", needsSillyTavern, async () => {
  const fileIds = new Set(["Lore", "Lore (2)"]);
  const writes = [];
  const gateway = gatewayWith((path, body) => {
    if (path === "/api/worldinfo/list") {
      return response([...fileIds].map((file_id) => ({ file_id, name: file_id, extensions: {} })));
    }
    if (path === "/api/worldinfo/edit") {
      writes.push(body);
      fileIds.add(body.name);
      return response({ ok: true });
    }
    throw new Error(`Unexpected native request ${path}.`);
  });

  const fileId = await gateway.createWorldbook({
    name: "Lore",
    rawWorldBook: { name: "Lore", entries: {} },
  });

  assert.equal(fileId, "Lore (3)");
  assert.deepEqual(writes.map((write) => write.name), ["Lore (3)"]);
});

test("WorldBook creation stores names through ST's sanitize rule", needsSillyTavern, async () => {
  const fileIds = new Set();
  const gateway = gatewayWith((path, body) => {
    if (path === "/api/worldinfo/list") return response([...fileIds].map((file_id) => ({ file_id })));
    assert.equal(path, "/api/worldinfo/edit");
    fileIds.add(body.name);
    return response({ ok: true });
  });
  assert.equal(await gateway.createWorldbook({ name: "Lore: Part/One?", rawWorldBook: { entries: {} } }),
    parse(sanitize("Lore: Part/One?.json")).name);
});

test("Character creation allows identical names and checks its unique filename before writing", async () => {
  const writes = [];
  const checked = new Set();
  const requests = [];
  const gateway = gatewayWith((path, body) => {
    if (path.startsWith("/characters/")) {
      checked.add(decodeURIComponent(path.slice("/characters/".length)));
      return new Response(null, { status: 404 });
    }
    assert.equal(path, "/api/characters/create");
    assert.ok(checked.has(`${body.file_name}.png`), "check destination before create");
    writes.push(body);
    return new Response(`${body.file_name}.png`);
  }, { requests });
  const canonical = createCanonicalCharacterProjection({ name: "Same Name", extensions: {
    depth_prompt: { prompt: "Synthetic note", depth: 0, role: "user" } } });
  const first = await gateway.createCharacter({ canonical });
  const second = await gateway.createCharacter({ canonical });
  assert.deepEqual([first, second], ["tavern-sync-uuid-1.png", "tavern-sync-uuid-2.png"]);
  assert.deepEqual(writes.map((body) => body.ch_name), ["Same Name", "Same Name"]);
  assert.ok(requests.filter(({ url }) => url.startsWith("/characters/")).every(({ options }) => options.method === "HEAD"
    && options.cache === "no-store" && options.headers["X-CSRF-Token"] === "synthetic-token"));
  // TauriTavern reports a get for an unknown Character as a backend error.
  assert.ok(!requests.some(({ url }) => url === "/api/characters/get"));
  for (const body of writes) {
    assert.equal(body.depth_prompt_prompt, "Synthetic note");
    assert.equal(body.depth_prompt_depth, 0);
    assert.equal(body.depth_prompt_role, "user");
  }
});

test("WorldBook creation does not occupy a missing filename reserved by another binding", needsSillyTavern, async () => {
  const files = new Set();
  const gateway = gatewayWith((path, body) => {
    if (path === "/api/worldinfo/list") {
      return response([...files].map((file_id) => ({ file_id })));
    }
    assert.equal(path, "/api/worldinfo/edit");
    files.add(body.name);
    return response({ ok: true });
  });
  assert.equal(await gateway.createWorldbook({ name: "Lore", rawWorldBook: { entries: {} },
    reservedLocalIds: ["Lore", "Lore%20(2)"] }), "Lore (3)");
});

test("WorldBook native creation uses the requested name when the storage file_id is free", needsSillyTavern, async () => {
  const fileIds = new Set();
  const gateway = gatewayWith((path, body) => {
    if (path === "/api/worldinfo/list") {
      return response([...fileIds].map((file_id) => ({ file_id, name: file_id, extensions: {} })));
    }
    if (path === "/api/worldinfo/edit") {
      fileIds.add(body.name);
      return response({ ok: true });
    }
    throw new Error(`Unexpected native request ${path}.`);
  });

  assert.equal(await gateway.createWorldbook({
    name: "New Lore",
    rawWorldBook: { name: "New Lore", entries: {} },
  }), "New Lore");
});

test("missing local Character and World Info are reported as missing, other failures are not", async () => {
  const requests = [];
  const gateway = gatewayWith((path) => {
    if (path === "/characters/Gone.png") return new Response(null, { status: 404 });
    if (path === "/api/worldinfo/list") return response([{ file_id: "Other" }]);
    throw new Error(`Unexpected native request ${path}.`);
  }, { requests });
  await assert.rejects(gateway.readLocal({ entityType: "character", localId: "Gone.png" }), { code: "missing_local" });
  await assert.rejects(gateway.readLocal({ entityType: "worldbook", localId: "Lore" }), { code: "missing_local" });
  assert.ok(!requests.some(({ url }) => url === "/api/characters/get"), "a missing card file is never fetched by get");
  // A file removed between the check and the read is still missing.
  const raced = gatewayWith((path) => path === "/api/characters/get" ? response({}, 404) : new Response(null, { status: 200 }));
  await assert.rejects(raced.readLocal({ entityType: "character", localId: "A.png" }), { code: "missing_local" });
  const failing = gatewayWith(() => response({}, 500));
  await assert.rejects(failing.readLocal({ entityType: "character", localId: "A.png" }),
    (error) => error.code === undefined && /HTTP 500/.test(error.message));
  const failingRead = gatewayWith((path) => path === "/api/characters/get" ? response({}, 500) : new Response(null, { status: 200 }));
  await assert.rejects(failingRead.readLocal({ entityType: "character", localId: "A.png" }),
    (error) => error.code === undefined && /HTTP 500/.test(error.message));
});

test("an existing card file is never chosen as a new Character's filename", async () => {
  const gateway = gatewayWith((path, body) => {
    if (path === "/characters/tavern-sync-uuid-1.png") return new Response(null, { status: 200 });
    if (path.startsWith("/characters/")) return new Response(null, { status: 404 });
    assert.equal(path, "/api/characters/create");
    return new Response(`${body.file_name}.png`);
  });
  const canonical = createCanonicalCharacterProjection({ name: "Taken", extensions: {
    depth_prompt: { prompt: "", depth: 4, role: "system" } } });
  assert.equal(await gateway.createCharacter({ canonical }), "tavern-sync-uuid-2.png");
});

test("avatars use ST's card image and its own edit-avatar upload, without a JSON Content-Type", async () => {
  const requests = [];
  const gateway = createNativeStGateway({
    requestHeaders: () => ({ "Content-Type": "application/json", "X-CSRF-Token": "synthetic-token" }),
    uuid: () => "uuid",
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === "/characters/Missing.png") return new Response("", { status: 404 });
      if (url.startsWith("/characters/")) return new Response("picture", { headers: { "content-type": "image/png" } });
      return new Response("", { status: 200 });
    },
  });

  const image = await gateway.readAvatar({ avatarFileName: "Hero #1.png" });
  assert.equal(await image.text(), "picture");
  assert.equal(requests[0].url, "/characters/Hero%20%231.png");
  assert.equal(requests[0].options.cache, "no-store");
  await assert.rejects(gateway.readAvatar({ avatarFileName: "Missing.png" }), { code: "missing_local" });

  for (const [type, fileName] of [["image/png", "avatar.png"], ["image/jpeg", "avatar.jpg"]]) {
    await gateway.writeAvatar({ avatarFileName: "Hero #1.png", image: new Blob(["new"], { type }) });
    const { url, options } = requests.at(-1);
    assert.equal(url, "/api/characters/edit-avatar");
    assert.equal(options.method, "POST");
    assert.deepEqual(options.headers, { "X-CSRF-Token": "synthetic-token" });
    assert.equal(options.body.get("avatar_url"), "Hero #1.png");
    assert.equal(options.body.get("avatar").name, fileName);
  }
  await assert.rejects(gateway.writeAvatar({ avatarFileName: "Hero.png", image: "not a blob" }), /avatar update is invalid/);
});

// TauriTavern has no /api/worldinfo/list; its ids come from the settings list.
function settingsGatewayWith(fileIds, books, { requests = [], writes = [] } = {}) {
  return gatewayWith((path, body) => {
    if (path === "/api/settings/get") return response({ world_names: [...fileIds] });
    if (path === "/api/worldinfo/get") return response(books[body.name] ?? { entries: {} });
    if (path === "/api/worldinfo/edit") {
      writes.push(body);
      fileIds.add(body.name);
      return response({ ok: true });
    }
    throw new Error(`Unexpected native request ${path}.`);
  }, { requests, worldbookList: "settings" });
}

test("without the list route, WorldBook candidates come from the settings list and each file's stored name", async () => {
  const requests = [];
  const gateway = settingsGatewayWith(new Set(["Lore", "Blank", "Unnamed"]), {
    Lore: { name: "  Lore  ", entries: {} },
    Blank: { name: "   ", entries: {} },
    Unnamed: { entries: {} },
  }, { requests });
  assert.deepEqual(await gateway.listWorldbooks(), [
    { localId: "Lore", displayName: "Lore" },
    { localId: "Blank", displayName: "Blank" },
    { localId: "Unnamed", displayName: "Unnamed" },
  ]);
  assert.deepEqual(requests.map((request) => request.url),
    ["/api/settings/get", "/api/worldinfo/get", "/api/worldinfo/get", "/api/worldinfo/get"]);
});

test("without the list route, a World Info file missing from the settings list is missing locally", async () => {
  const gateway = settingsGatewayWith(new Set(["Other"]), { Lore: { name: "Lore", entries: {} } });
  await assert.rejects(gateway.readLocal({ entityType: "worldbook", localId: "Lore" }), { code: "missing_local" });
  const present = settingsGatewayWith(new Set(["Lore"]), { Lore: { name: "Lore", entries: {} } });
  assert.deepEqual(await present.readLocal({ entityType: "worldbook", localId: "Lore" }),
    { fileId: "Lore", rawWorldBook: { name: "Lore", entries: {} } });
});

test("without the list route, WorldBook creation allocates a free name from the settings list", needsSillyTavern, async () => {
  const writes = [];
  const gateway = settingsGatewayWith(new Set(["Lore", "Lore (2)"]), {}, { writes });
  assert.equal(await gateway.createWorldbook({ name: "Lore", rawWorldBook: { name: "Lore", entries: {} } }), "Lore (3)");
  assert.deepEqual(writes.map((write) => write.name), ["Lore (3)"]);
});

test("an invalid settings World Info list or list source is refused", async () => {
  const gateway = gatewayWith(() => response({ world_names: ["Lore", ""] }), { worldbookList: "settings" });
  await assert.rejects(gateway.listWorldbooks(), /Invalid World Info name list/);
  assert.throws(() => gatewayWith(() => response([]), { worldbookList: "other" }), /Unknown SillyTavern World Info list source/);
});
