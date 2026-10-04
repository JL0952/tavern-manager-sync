// Sync state for this SillyTavern user, with the same minimal schema the former
// server-plugin sidecar.json used: { schemaVersion: 1, config: { endpoint }, bindings },
// plus the Manager access token in config once a password signed in.
// It lives in its own user file. extension_settings is only the legacy location:
// every tab saves the whole settings object, so a stale tab silently reverted it.

export const SIDECAR_SETTINGS_KEY = "tavern-manager-sync";
export const SIDECAR_FILE_NAME = "tavern-manager-sync.json";
export const MINIMAL_SIDECAR_SCHEMA_VERSION = 1;

const contentHashPattern = /^sha256:[a-f0-9]{64}$/;

export class SidecarError extends Error {}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function assertExactKeys(value, keys, label) {
  if (!isPlainObject(value)) {
    throw new SidecarError(`${label} must be an object.`);
  }

  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();

  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new SidecarError(`${label} has unsupported fields.`);
  }
}

function assertNullableString(value, label) {
  if (value !== null && (typeof value !== "string" || !value)) {
    throw new SidecarError(`${label} must be null or a non-empty string.`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || !value) {
    throw new SidecarError(`${label} must be a non-empty string.`);
  }
}

function assertNullableHash(value, label) {
  if (value !== null && (typeof value !== "string" || !contentHashPattern.test(value))) {
    throw new SidecarError(`${label} must be null or a SHA-256 hash.`);
  }
}

function assertEntityType(value, label) {
  if (!["character", "worldbook"].includes(value)) {
    throw new SidecarError(`${label} must be a supported entity type.`);
  }
}

export function minimalBindingKey(entityType, managerId) {
  return `${entityType}:${managerId}`;
}

export function createEmptyMinimalSidecar() {
  return {
    schemaVersion: MINIMAL_SIDECAR_SCHEMA_VERSION,
    config: { endpoint: null },
    bindings: {},
  };
}

export function validateMinimalSidecar(sidecar) {
  assertExactKeys(sidecar, ["schemaVersion", "config", "bindings"], "Sync state");

  if (sidecar.schemaVersion !== MINIMAL_SIDECAR_SCHEMA_VERSION) {
    throw new SidecarError(`Sync state schemaVersion must be ${MINIMAL_SIDECAR_SCHEMA_VERSION}.`);
  }

  const hasToken = isPlainObject(sidecar.config) && Object.hasOwn(sidecar.config, "token");
  assertExactKeys(sidecar.config, hasToken ? ["endpoint", "token"] : ["endpoint"], "Sync state config");
  assertNullableString(sidecar.config.endpoint, "Sync state endpoint");
  if (hasToken) assertNonEmptyString(sidecar.config.token, "Sync state token");

  if (!isPlainObject(sidecar.bindings)) {
    throw new SidecarError("Sync state bindings must be an object.");
  }

  const localBindings = new Set();
  for (const [key, binding] of Object.entries(sidecar.bindings)) {
    assertExactKeys(
      binding,
      Object.hasOwn(binding, "entityType") ? ["entityType", "managerId", "localId", "baseHash"] : ["managerId", "localId", "baseHash"],
      `Sync binding "${key}"`,
    );
    const entityType = key.split(":", 1)[0];
    assertEntityType(entityType, "Sync binding type");
    if (binding.entityType !== undefined && binding.entityType !== entityType) throw new SidecarError("Inconsistent binding type.");
    assertNonEmptyString(binding.managerId, `Sync binding "${key}" managerId`);
    assertNonEmptyString(binding.localId, `Sync binding "${key}" localId`);
    assertNullableHash(binding.baseHash, `Sync binding "${key}" baseHash`);

    if (key !== minimalBindingKey(entityType, binding.managerId)) {
      throw new SidecarError(`Sync binding "${key}" has an inconsistent key.`);
    }

    const localKey = `${entityType}:${binding.localId}`;
    if (localBindings.has(localKey)) {
      throw new SidecarError(`Sync state has duplicate local binding "${localKey}".`);
    }
    localBindings.add(localKey);
  }

  return sidecar;
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/**
 * Store backed by data/<user>/user/files/tavern-manager-sync.json through ST's
 * own file endpoints. Every read goes to disk, so all tabs and devices share
 * one state. Until the file exists, the legacy extension_settings entry is the
 * state; the first update writes it into the file and settings are never
 * written again. An update recomputes on fresh state when another tab or
 * device wrote the file meanwhile, instead of overwriting that change.
 */
export function createFileSidecarStore({
  fetch: fetchImpl = globalThis.fetch,
  requestHeaders,
  legacySettings = {},
  legacyKey = SIDECAR_SETTINGS_KEY,
  fileName = SIDECAR_FILE_NAME,
  attempts = 3,
} = {}) {
  if (typeof fetchImpl !== "function" || typeof requestHeaders !== "function" || !isPlainObject(legacySettings)) {
    throw new SidecarError("Sync state store requires fetch, request headers and the legacy settings object.");
  }

  let writer = Promise.resolve();

  async function readText() {
    const response = await fetchImpl(`/user/files/${fileName}`, { cache: "no-store", headers: requestHeaders() });
    if (response.status === 404) return null;
    if (!response.ok) throw new SidecarError(`Reading sync state returned HTTP ${response.status}.`);
    return response.text();
  }

  function parse(text) {
    if (text === null) {
      const legacy = legacySettings[legacyKey];
      return legacy === undefined ? createEmptyMinimalSidecar() : clone(validateMinimalSidecar(legacy));
    }
    try {
      return validateMinimalSidecar(JSON.parse(text));
    } catch (error) {
      if (error instanceof SidecarError) throw error;
      throw new SidecarError(`Sync state file is invalid: ${error.message}`);
    }
  }

  async function write(sidecar) {
    const text = `${JSON.stringify(validateMinimalSidecar(clone(sidecar)), null, 2)}\n`;
    const response = await fetchImpl("/api/files/upload", {
      method: "POST",
      headers: { ...requestHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: fileName, data: toBase64(text) }),
    });
    if (!response.ok) throw new SidecarError(`Unable to write sync state: HTTP ${response.status}.`);
  }

  async function read() {
    return parse(await readText());
  }

  async function update(mutator) {
    if (typeof mutator !== "function") {
      throw new SidecarError("Sync state update requires a mutator.");
    }

    let release;
    const previous = writer;
    writer = new Promise((resolve) => { release = resolve; });
    await previous;

    try {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const before = await readText();
        const candidate = parse(before);
        const result = await mutator(candidate);
        if (await readText() !== before) continue;
        await write(candidate);
        return result;
      }
      throw new SidecarError("Sync state kept changing in another tab or device; try again.");
    } finally {
      release();
    }
  }

  return Object.freeze({ read, update });
}
