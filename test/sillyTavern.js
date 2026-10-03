// Some tests check the extension against SillyTavern's own code. They use the
// SillyTavern install this extension lives in (data/<user>/extensions/
// tavern-manager-sync) or ST_SYNC_ST_ROOT, and are skipped without one.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const stRoot = process.env.ST_SYNC_ST_ROOT || fileURLToPath(new URL("../../../../../", import.meta.url));

const found = existsSync(join(stRoot, "src", "endpoints", "characters.js"));

export const needsSillyTavern = found ? {} : { skip: `SillyTavern not found at ${stRoot}; set ST_SYNC_ST_ROOT` };

export function requireFromSillyTavern(name) {
  return createRequire(join(stRoot, "package.json"))(name);
}
