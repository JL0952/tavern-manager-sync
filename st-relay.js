// SillyTavern's side of the file relay: chat completion presets, UI themes
// and global regex scripts, read and written the way SillyTavern itself does.
// Presets and themes come from the server's own listing, so they are the
// saved files. Regex scripts live in the open page's settings; they are only
// downloaded as files for the Regex panel's Import, so this extension never
// writes the settings file.

export const RELAY_TYPES = Object.freeze(["presets", "themes", "regex"]);

// SillyTavern writes presets and themes, and exports a regex script, as JSON
// indented by four spaces.
const fileText = (value) => JSON.stringify(value, null, 4);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// SillyTavern allows several regex scripts with one name; Manager keys files
// by name, so later ones are told apart the way Manager renames a copy.
function uniqueNames(items) {
  const used = new Set();
  return items.map((item) => {
    let name = item.name;
    for (let suffix = 2; used.has(name); suffix += 1) name = `${item.name} (${suffix})`;
    used.add(name);
    return { ...item, name };
  });
}

export function createStRelayGateway({ fetch: fetchImpl = globalThis.fetch, requestHeaders, getContext, download } = {}) {
  if (typeof fetchImpl !== "function" || typeof requestHeaders !== "function" || typeof getContext !== "function"
    || typeof download !== "function") {
    throw new Error("The relay needs fetch, request headers, the SillyTavern context and a download helper.");
  }

  async function post(path, body, label) {
    const response = await fetchImpl(path, {
      method: "POST",
      headers: { ...requestHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
    return response;
  }

  // Every relay file in SillyTavern now: { presets, themes, regex }, each a
  // list of { name, contents, value } where contents is the file's text.
  async function list() {
    const settings = await (await post("/api/settings/get", {}, "SillyTavern settings")).json();
    const names = settings?.openai_setting_names;
    const texts = settings?.openai_settings;
    if (!Array.isArray(names) || !Array.isArray(texts) || names.length !== texts.length || !Array.isArray(settings.themes)) {
      throw new Error("SillyTavern settings do not list presets and themes.");
    }

    // The server sends each preset file's own text.
    const presets = names.map((name, index) => ({ name, contents: texts[index], value: JSON.parse(texts[index]) }));
    const themes = settings.themes
      .filter((theme) => isPlainObject(theme) && typeof theme.name === "string" && theme.name)
      .map((theme) => ({ name: theme.name, contents: fileText(theme), value: theme }));
    const scripts = getContext().extensionSettings?.regex;
    const regex = uniqueNames((Array.isArray(scripts) ? scripts : [])
      .filter((script) => isPlainObject(script) && typeof script.scriptName === "string" && script.scriptName)
      .map((script) => ({ name: script.scriptName, contents: fileText(script), value: script })));

    return { presets, themes, regex };
  }

  // As the Import button does: other extensions see the preset first. One
  // preset is also selected; a batch only saves, so the current preset stays.
  async function writePreset(name, value, { select = false } = {}) {
    const context = getContext();
    const manager = context.getPresetManager?.("openai");
    if (!manager || typeof manager.savePreset !== "function") {
      throw new Error("SillyTavern's chat completion preset manager is unavailable.");
    }
    await context.eventSource?.emit?.(context.eventTypes?.OAI_PRESET_IMPORT_READY, { data: value, presetName: name });
    await manager.savePreset(name, value, { skipUpdate: !select });
  }

  // Saved under its name in Manager, which a copy kept beside a same-name theme
  // changes. SillyTavern lists themes once at load, so it appears after a reload.
  async function writeTheme(name, value) {
    if (typeof name !== "string" || !name || !isPlainObject(value)) {
      throw new Error("A theme needs a name.");
    }
    await post("/api/themes/save", { ...value, name }, "SillyTavern theme save");
  }

  // One script downloads as SillyTavern exports one; several as one array,
  // which the Regex panel's Import adds in one go.
  function downloadRegex(scripts) {
    if (!Array.isArray(scripts) || scripts.length === 0) throw new Error("Choose at least one regex script.");
    if (scripts.length === 1) {
      const name = String(scripts[0].scriptName || "script").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-");
      download(fileText(scripts[0]), `regex-${name}.json`, "application/json");
      return;
    }
    download(fileText(scripts), `regex-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, "application/json");
  }

  return Object.freeze({ list, writePreset, writeTheme, downloadRegex });
}
