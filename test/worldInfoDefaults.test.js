import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { WORLDBOOK_ENTRY_DEFAULTS, WORLDBOOK_ENTRY_FIELD_TABLE } from "../sync-core/syncProjection.js";
import { needsSillyTavern, stRoot } from "./sillyTavern.js";

// Reads ST's newWorldInfoEntryDefinition from its source; the module itself only runs in a browser.
async function readStEntryTemplate() {
  const source = await readFile(join(stRoot, "public", "scripts", "world-info.js"), "utf8");
  const start = source.indexOf("export const newWorldInfoEntryDefinition = {");
  assert.ok(start >= 0, "ST still defines newWorldInfoEntryDefinition");
  const body = source.slice(start, source.indexOf("\n};", start));
  const constant = (name) => Number(source.match(new RegExp(`export const ${name} = (\\d+);`))[1]);
  const named = { "world_info_logic.AND_ANY": 0, DEFAULT_DEPTH: constant("DEFAULT_DEPTH"), DEFAULT_WEIGHT: constant("DEFAULT_WEIGHT") };
  const template = {};
  for (const [, name, value] of body.matchAll(/^\s+(\w+): \{ default: ([^,]+), type:/gm)) {
    template[name] = Object.hasOwn(named, value) ? named[value] : JSON.parse(value.replace(/'/g, "\""));
  }
  return template;
}

test("sync's WorldBook entry defaults are SillyTavern's own new-entry template", needsSillyTavern, async () => {
  const template = await readStEntryTemplate();
  const fieldByStName = Object.fromEntries(Object.entries(WORLDBOOK_ENTRY_FIELD_TABLE)
    .map(([field, { stName = field }]) => [stName, field]));
  const compared = new Set();

  for (const [stName, stDefault] of Object.entries(template)) {
    const field = fieldByStName[stName];
    if (!field) continue; // Editor and automation fields that are not synced.
    compared.add(field);
    // ST stores `enabled` inverted, as `disable`.
    assert.deepEqual(WORLDBOOK_ENTRY_DEFAULTS[field], field === "enabled" ? !stDefault : stDefault, field);
  }

  // Only the Character Book flag has no World Info template value.
  assert.deepEqual(Object.keys(WORLDBOOK_ENTRY_DEFAULTS).filter((field) => !compared.has(field)), ["useRegex"]);
});
