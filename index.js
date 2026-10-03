import { eventSource, event_types, getRequestHeaders } from "../../../../script.js";
import { extension_settings, getContext } from "../../../extensions.js";
import { uuidv4 } from "../../../utils.js";
import { worldInfoCache, reloadEditor, updateWorldInfoList } from "../../../world-info.js";
import { createMinimalSyncService } from "./minimal-service.js";
import { createSillyTavernFrontendReconciler } from "./reconcile.js";
import { createFileSidecarStore } from "./sidecar-settings.js";
import { createMinimalSillyTavernAdapter } from "./st-adapter.js";
import { discoverSillyTavern, encodeLocalId } from "./st-discovery.js";
import { createNativeStGateway } from "./st-gateway.js";

const reconciler = createSillyTavernFrontendReconciler({
  getContext,
  worldInfoCache,
  updateWorldInfoList,
  reloadWorldInfoEditor: reloadEditor,
});

const labels = {
  synced: "Synced",
  st_changed: "ST changed",
  manager_changed: "Manager changed",
  different: "Different",
  manager_only: "Manager only",
  st_only: "ST only",
  duplicate: "Duplicate Manager id",
  error: "Cannot sync",
};

// Sync state lives in its own user file; extension_settings is read only as
// the legacy source until the first write moves it there.
const service = createMinimalSyncService({
  sidecarStore: createFileSidecarStore({
    requestHeaders: getRequestHeaders,
    legacySettings: extension_settings,
  }),
});

// TauriTavern runs ST's frontend on a Rust backend without the Node-only
// /api/worldinfo/list route; its platform object identifies it.
const worldbookList = globalThis.__TAURITAVERN__ ? "settings" : "endpoint";

const adapter = createMinimalSillyTavernAdapter(
  createNativeStGateway({
    requestHeaders: getRequestHeaders,
    uuid: uuidv4,
    worldbookList,
  }),
);

const actions = {
  push: (body) => service.push({ ...body, adapter }),
  pull: (body) => service.pull({ ...body, adapter }),
  "sync-all": (body) => service.syncAll({ ...body, adapter }),
};

const discover = () =>
  discoverSillyTavern({
    requestHeaders: getRequestHeaders,
    worldbookList,
  });

let panel;
let busy = false;
let currentRows = [];

const field = (role) => panel.querySelector(`[data-role="${role}"]`);

function message(text) {
  field("message").textContent = text;
}

function setBusy(value) {
  busy = value;

  for (const button of panel.querySelectorAll("button")) {
    button.disabled = value;
  }
}

function button(label, action) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "menu_button";
  element.textContent = label;
  element.disabled = busy;
  element.addEventListener("click", action);
  return element;
}

function renderRows(rows) {
  currentRows = Array.isArray(rows) ? rows : [];

  const container = field("rows");
  container.replaceChildren();

  const search = field("search").value.trim().toLocaleLowerCase();

  const visible = currentRows.filter((row) =>
    [row.displayName, row.creatorNotes].some((value) =>
      String(value ?? "")
        .toLocaleLowerCase()
        .includes(search),
    ),
  );

  for (const row of visible) {
    const element = document.createElement("div");
    element.className = "tms-entity-row flex-container alignitemscenter";

    const text = document.createElement("div");
    text.className = "tms-entity-text flex1";

    const label = document.createElement("span");
    label.className = "tms-entity-label";
    label.textContent =
      `${row.entityType === "character" ? "Character" : "WorldBook"}: ` +
      `${row.displayName} | ${labels[row.status] ?? row.status}`;

    text.append(label);

    // Creator notes tell same-name Characters apart; an unsyncable entity
    // shows why instead.
    const detail = row.error || row.creatorNotes;

    if (detail) {
      const line = document.createElement("span");
      line.className = row.error ? "tms-entity-error" : "tms-entity-notes";
      line.textContent = detail;
      line.title = detail;
      text.append(line);
    }

    element.append(text);

    if (row.localId && row.status !== "error") {
      element.append(
        button("Push", () =>
          run("push", {
            entityType: row.entityType,
            localId: row.localId,
          }),
        ),
      );
    }

    if (row.managerId) {
      element.append(
        button("Pull", () =>
          run("pull", {
            entityType: row.entityType,
            managerId: row.managerId,
          }),
        ),
      );
    }

    container.append(element);
  }

  if (!visible.length) {
    container.textContent = search
      ? "No matching entities."
      : "No entities available.";
  }
}

async function refresh() {
  const response = await service.refresh({
    discovery: await discover(),
  });

  renderRows(response.rows);
  return response;
}

function chooseWorldbook(details) {
  const container = field("choice");
  container.replaceChildren();

  const label = document.createElement("p");
  label.textContent =
    `A local WorldBook named ${details.displayName} exists. ` +
    "Use it without overwriting, or import another copy?";

  container.append(label);

  return new Promise((resolve) => {
    function option(label, value) {
      const element = button(label, () => {
        container.replaceChildren();
        resolve(value);
      });

      element.disabled = false;
      container.append(element);
    }

    for (const candidate of details.candidates ?? []) {
      option(
        details.candidates.length === 1
          ? "Use existing"
          : `Use existing: ${candidate.displayName} (${decodeURIComponent(candidate.localId)})`,
        {
          managerId: details.managerId,
          mode: "use_existing",
          localId: candidate.localId,
        },
      );
    }

    option("Import duplicate", {
      managerId: details.managerId,
      mode: "import_duplicate",
    });

    option("Cancel", null);
  });
}

function confirmManagerOverwrite(action) {
  if (typeof globalThis.confirm !== "function") {
    message(
      "Push cancelled because the overwrite confirmation dialog is unavailable.",
    );
    return false;
  }

  const label = action === "sync-all" ? "Sync All" : "Push";

  return globalThis.confirm(
    `${label} will overwrite existing Manager content with the SillyTavern version. Continue?`,
  );
}

async function run(action, source = {}) {
  if (busy) return;

  setBusy(true);

  try {
    if (action === "save") {
      await service.configure({
        endpoint: field("endpoint").value.trim(),
      });

      message("Endpoint saved.");
      return;
    }

    if (action === "refresh") {
      const { claimed } = await refresh();
      message(claimed ? `Refreshed; auto-linked ${claimed} entit${claimed === 1 ? "y" : "ies"}.` : "Refreshed.");
      return;
    }

    let body =
      action === "sync-all"
        ? { discovery: await discover() }
        : { ...source };

    let result;

    for (;;) {
      try {
        result = await actions[action](body);

        break;
      } catch (error) {
        if (
          ["push", "sync-all"].includes(action) &&
          error.code === "overwrite_confirmation_required"
        ) {
          if (!confirmManagerOverwrite(action)) return;

          body = {
            ...body,
            confirmOverwrite: true,
          };

          continue;
        }

        if (
          action !== "pull" ||
          error.code !== "worldbook_name_conflict"
        ) {
          throw error;
        }

        const choice = await chooseWorldbook(error.details);

        if (!choice) {
          message("Pull cancelled.");
          return;
        }

        body = {
          ...source,
          worldbookChoice: choice,
        };
      }
    }

    const uiErrors = [];

    for (const change of result.frontendChanges ?? []) {
      try {
        await reconciler.reconcile(change);
      } catch (error) {
        uiErrors.push(error.message);
      }
    }

    await refresh();

    const failed =
      result.results?.filter((entry) => entry.status === "failed").length ?? 0;
    // Avatar problems do not undo verified content; they are reported here.
    const warnings = [result, ...(result.results ?? [])].flatMap((entry) => entry.warnings ?? []);

    message(
      (uiErrors.length
        ? `Content saved; ST UI refresh failed: ${uiErrors.join("; ")}`
        : failed
          ? `Sync All: ${failed} action(s) failed. ` +
            `${result.results
              .filter((x) => x.status === "failed")
              .map((x) => `${x.displayName}: ${x.message}`)
              .join("; ")}`
          : action === "sync-all"
            ? "Sync All finished; unchanged, different and single-side entities skipped."
            : action === "push"
              ? "Pushed and verified."
              : "Pulled.") +
        (warnings.length ? ` ${warnings.join("; ")}` : ""),
    );
  } catch (error) {
    message(error.message);
  } finally {
    setBusy(false);
  }
}

function registerPanel() {
  if (document.getElementById("tavern_manager_sync")) return;

  const container = document.getElementById("extensions_settings");
  if (!container) return;

  panel = document.createElement("section");
  panel.id = "tavern_manager_sync";
  panel.className = "extension_container wide100p";

  panel.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <span style="font-weight: 700;">Tavern Manager Sync</span>
        <div class="fa-solid fa-circle-chevron-up inline-drawer-icon up"></div>
      </div>

      <div class="inline-drawer-content tms-content">
        <label class="tms-field-label">
          Manager endpoint
          <input
            class="text_pole"
            data-role="endpoint"
            placeholder="http://127.0.0.1:3000/api/sync/v1"
          >
        </label>

        <div data-role="controls" class="flex-container flexWrap"></div>

        <div
          data-role="message"
          class="tms-message"
          aria-live="polite"
        ></div>

        <section
          class="tms-list-group"
          aria-labelledby="tms-entities-heading"
        >
          <h4 id="tms-entities-heading">
            Characters &amp; WorldBooks
          </h4>

          <label class="tms-field-label">
            Search
            <input
              class="text_pole"
              type="search"
              data-role="search"
              placeholder="Filter by display name"
              autocomplete="off"
            >
          </label>

          <div
            class="tms-entity-list"
            data-role="rows"
            aria-live="polite"
          ></div>
        </section>

        <div data-role="choice" class="tms-choice"></div>
      </div>
    </div>
  `;

  container.append(panel);

  field("controls").append(
    button("Save", () => run("save")),
    button("Refresh", () => run("refresh")),
    button("Sync All", () => run("sync-all")),
  );

  field("search").addEventListener("input", () =>
    renderRows(currentRows),
  );

  renderRows([]);

  service.getConfiguration()
    .then((config) => {
      field("endpoint").value = config.endpoint || "";
      message("Use Refresh to list entities.");
    })
    .catch((error) => message(error.message));
}

eventSource.on(
  event_types.CHARACTER_RENAMED,
  (oldAvatar, newAvatar) => {
    if (typeof oldAvatar !== "string" || typeof newAvatar !== "string") {
      return;
    }

    return service.renameLocal({
      oldLocalId: encodeLocalId(oldAvatar),
      newLocalId: encodeLocalId(newAvatar),
    }).catch((error) => {
      if (panel) message(error.message);
    });
  },
);

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    registerPanel,
    { once: true },
  );
} else {
  registerPanel();
}