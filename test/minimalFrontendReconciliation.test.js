import assert from "node:assert/strict";
import test from "node:test";

import { createSillyTavernFrontendReconciler } from "../reconcile.js";

test("new Character is absent initially and appears via the native list refresh", async () => {
  const calls = [];
  const context = {
    characters: [{ avatar: "Other.png" }],
    async getCharacters() { calls.push("list"); this.characters.push({ avatar: "New.png" }); },
    async getOneCharacter() { throw new Error("Existing-only API cannot insert a Character"); },
    async importTags(character, options) { assert.equal(character.avatar, "New.png"); assert.equal(options, undefined); calls.push("native tags"); },
    eventSource: { async emit() { throw new Error("Create refresh should not emit a sync edit"); } },
  };
  const reconciler = createSillyTavernFrontendReconciler({ getContext: () => context });
  await reconciler.reconcile({ entityType: "character", localId: "New.png", created: true });
  assert.deepEqual(calls, ["list", "native tags"]);
  assert.equal(context.characters.some(x => x.avatar === "New.png"), true);
});

test("Existing Character Pull reconciliation refreshes only that Character and emits ST's edit event", async () => {
  const calls = [];
  const context = {
    characterId: 0,
    characters: [{ avatar: "Created.png", data: { description: "before" } }],
    async getOneCharacter(avatar) {
      calls.push(["getOneCharacter", avatar]);
      this.characters[0] = { avatar, data: { description: "pulled" } };
    },
    async selectCharacterById(id, options) {
      calls.push(["selectCharacterById", id, options]);
    },
    async importTags(character, options) {
      assert.equal(character.data.description, "pulled"); assert.equal(options, undefined);
      calls.push(["native tags", character.avatar]);
    },
    eventTypes: { CHARACTER_EDITED: "character_edited" },
    eventSource: {
      async emit(type, event) {
        calls.push(["emit", type]);
        assert.equal(event.detail.character.avatar, "Created.png");
      },
    },
  };
  const reconciler = createSillyTavernFrontendReconciler({ getContext: () => context });

  await reconciler.reconcile({ entityType: "character", localId: encodeURIComponent("Created.png") });

  assert.deepEqual(calls, [
    ["getOneCharacter", "Created.png"],
    ["native tags", "Created.png"],
    ["selectCharacterById", 0, { switchMenu: false }],
    ["emit", "character_edited"],
  ]);
});

test("WorldBook Pull reconciliation refreshes only its cache and native editor", async () => {
  const calls = [];
  const cache = new Map([["Imported Lore", { stale: true }], ["Other", { preserved: true }]]);
  const reconciler = createSillyTavernFrontendReconciler({
    getContext: () => ({}),
    worldInfoCache: cache,
    async updateWorldInfoList() { calls.push("updateWorldInfoList"); },
    reloadWorldInfoEditor(fileId, loadIfNotSelected) { calls.push(["reloadWorldInfoEditor", fileId, loadIfNotSelected]); },
  });

  await reconciler.reconcile({ entityType: "worldbook", localId: encodeURIComponent("Imported Lore") });

  assert.equal(cache.has("Imported Lore"), false);
  assert.equal(cache.has("Other"), true);
  assert.deepEqual(calls, ["updateWorldInfoList", ["reloadWorldInfoEditor", "Imported Lore", true]]);
});

test("a Pull that changed the avatar reloads ST's cached images before the Character refresh", async () => {
  const calls = [];
  const thumbnailUrl = "/thumbnail?type=avatar&file=Hero%201.png";
  const shown = { src: `${thumbnailUrl}&t=1` };
  const context = {
    characters: [{ avatar: "Hero 1.png" }],
    getThumbnailUrl: (type, file) => `/thumbnail?type=${type}&file=${encodeURIComponent(file)}`,
    async getOneCharacter() { calls.push("getOneCharacter"); },
    async selectCharacterById() {},
    async importTags() {},
    eventTypes: { CHARACTER_EDITED: "character_edited" },
    eventSource: { async emit() {} },
  };
  const reconciler = createSillyTavernFrontendReconciler({
    getContext: () => context,
    async fetch(url, options) { calls.push([url, options.cache]); },
    document: { querySelectorAll(selector) {
      calls.push(selector);
      return [{ get src() { return shown.src; }, set src(value) { calls.push(["src", value]); shown.src = value; } }];
    } },
  });

  await reconciler.reconcile({ entityType: "character", localId: encodeURIComponent("Hero 1.png"), avatarChanged: true });

  assert.deepEqual(calls, [
    [thumbnailUrl, "reload"],
    ["/characters/Hero%201.png", "reload"],
    `img[src^="${thumbnailUrl}"]`,
    ["src", ""],
    ["src", `${thumbnailUrl}&t=1`],
    "getOneCharacter",
  ]);

  calls.length = 0;
  await reconciler.reconcile({ entityType: "character", localId: encodeURIComponent("Hero 1.png") });
  assert.deepEqual(calls, ["getOneCharacter"], "no avatar change, no image reload");
});
