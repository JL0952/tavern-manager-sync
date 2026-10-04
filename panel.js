// The extension panel: one tab per kind of entry. Characters and WorldBooks
// sync with Manager's library; presets, themes and regex scripts relay as
// files. Everything SillyTavern provides is passed in, so the panel itself
// imports nothing from SillyTavern.

const cardLabels = {
  synced: "Synced",
  st_changed: "ST changed",
  manager_changed: "Manager changed",
  different: "Different",
  manager_only: "Manager only",
  st_only: "ST only",
  duplicate: "Duplicate Manager id",
  error: "Cannot sync",
};

const relayLabels = {
  same: "Same",
  different: "Different",
  st_only: "ST only",
  manager_only: "Manager only",
};

const tabs = [
  { id: "characters", label: "Characters", kind: "cards", entityType: "character" },
  { id: "worldbooks", label: "WorldBooks", kind: "cards", entityType: "worldbook" },
  { id: "presets", label: "Presets", kind: "relay", noun: "preset" },
  { id: "themes", label: "Themes", kind: "relay", noun: "theme" },
  { id: "regex", label: "Regex", kind: "relay", noun: "regex script" },
];

// Filters shown for a tab; one with nothing in it is hidden.
const cardFilters = [
  ["all", "All", () => true],
  ["changed", "Changed", (status) => ["st_changed", "manager_changed", "different"].includes(status)],
  ["st_only", "ST only", (status) => status === "st_only"],
  ["manager_only", "Manager only", (status) => status === "manager_only"],
  ["synced", "Synced", (status) => status === "synced"],
  ["problems", "Problems", (status) => ["error", "duplicate"].includes(status)],
];

const relayFilters = [
  ["all", "All", () => true],
  ["different", "Different", (status) => status === "different"],
  ["st_only", "ST only", (status) => status === "st_only"],
  ["manager_only", "Manager only", (status) => status === "manager_only"],
  ["same", "Same", (status) => status === "same"],
];

function badgeTone(status) {
  if (["st_changed", "manager_changed", "different"].includes(status)) return "attention";
  if (["error", "duplicate"].includes(status)) return "problem";
  if (["synced", "same"].includes(status)) return "quiet";
  return "plain";
}

const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const typeLabel = (entityType) => entityType === "character" ? "Character" : "WorldBook";

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function createSyncPanel({
  document,
  getContext,
  service,
  adapter,
  reconciler,
  discover,
  relay,
  tagImportSetting,
}) {
  let panel;
  let busy = false;
  let activeTab = "characters";
  let activeFilter = "all";
  let cardRows = [];
  let relayRows = { presets: [], themes: [], regex: [] };
  let relayError = "";
  // Batches stop between entries when asked.
  let stopButton;
  let stopRequested = false;

  const field = (role) => panel.querySelector(`[data-role="${role}"]`);
  const currentTab = () => tabs.find((tab) => tab.id === activeTab);

  function message(text) {
    if (panel) field("message").textContent = text;
  }

  // The password itself is never kept; only whether Manager let this
  // SillyTavern in.
  function showPasswordState(config) {
    field("password").placeholder = config.signedIn ? "Signed in" : "Only if Manager is on another device";
  }

  function setBusy(value) {
    busy = value;

    for (const button of panel.querySelectorAll("button")) {
      button.disabled = value && button !== stopButton;
    }
  }

  function button(label, action, className = "menu_button") {
    const element = document.createElement("button");
    element.type = "button";
    element.className = className;
    element.textContent = label;
    element.disabled = busy;
    element.addEventListener("click", action);
    return element;
  }

  // ST's own popup follows the theme and works the same in SillyTavern and
  // TauriTavern. Its content is built from elements, so names stay plain text.
  function popupContent(...lines) {
    const content = document.createElement("div");
    for (const line of lines) {
      if (typeof line !== "string") {
        content.append(line);
        continue;
      }
      const paragraph = document.createElement("p");
      paragraph.textContent = line;
      content.append(paragraph);
    }
    return content;
  }

  async function confirmPopup(content, okButton) {
    const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = getContext();
    if (typeof callGenericPopup !== "function") {
      throw new Error("SillyTavern's confirmation popup is unavailable.");
    }
    const answer = await callGenericPopup(content, POPUP_TYPE.CONFIRM, "", { okButton, cancelButton: "Cancel" });
    return answer === POPUP_RESULT.AFFIRMATIVE;
  }

  // The rows the active tab lists, before filters.
  function tabRows(tab = currentTab()) {
    return tab.kind === "cards"
      ? cardRows.filter((row) => row.entityType === tab.entityType)
      : relayRows[tab.id];
  }

  function renderTabs() {
    const container = field("tabs");
    container.replaceChildren();

    for (const tab of tabs) {
      const element = button(tab.label, () => chooseTab(tab.id), "tms-tab");
      element.setAttribute?.("role", "tab");
      element.setAttribute?.("aria-selected", String(tab.id === activeTab));
      if (tab.id === activeTab) element.className = "tms-tab tms-tab-active";
      const count = document.createElement("span");
      count.className = "tms-count";
      count.textContent = String(tabRows(tab).length);
      element.append(count);
      container.append(element);
    }
  }

  function chooseTab(id) {
    if (busy || id === activeTab) return;
    activeTab = id;
    activeFilter = "all";
    render();
  }

  function renderToolbar() {
    const container = field("controls");
    container.replaceChildren();
    const tab = currentTab();
    container.append(button("Refresh", () => run("refresh")));

    if (tab.kind === "cards") {
      const pushAll = button("Push All", () => runBatch("push-all"));
      pushAll.title = "Push every Character and WorldBook that exists only in SillyTavern";
      const pullAll = button("Pull All", () => runBatch("pull-all"));
      pullAll.title = "Pull every Character and WorldBook that exists only in Manager";
      container.append(button("Sync All", () => run("sync-all")), pushAll, pullAll);
    } else {
      const pushAll = button("Push All", () => runRelayBatch("push"));
      pushAll.title = `Push every ${tab.noun} that exists only in SillyTavern`;
      const pullAll = button(tab.id === "regex" ? "Download All" : "Pull All", () => runRelayBatch("pull"));
      pullAll.title = tab.id === "regex"
        ? "Download every regex script that exists only in Manager, as one file"
        : `Pull every ${tab.noun} that exists only in Manager`;
      container.append(pushAll, pullAll);
    }

    container.append(stopButton);
  }

  function renderFilters(rows) {
    const container = field("filters");
    container.replaceChildren();
    const filters = currentTab().kind === "cards" ? cardFilters : relayFilters;

    for (const [id, label, matches] of filters) {
      const count = rows.filter((row) => matches(row.status)).length;
      if (!count && id !== "all" && id !== activeFilter) continue;
      const chip = button(label, () => {
        activeFilter = id;
        render();
      }, id === activeFilter ? "tms-chip tms-chip-active" : "tms-chip");
      const number = document.createElement("span");
      number.className = "tms-count";
      number.textContent = String(count);
      chip.append(number);
      container.append(chip);
    }
  }

  function statusBadge(status, label) {
    const badge = document.createElement("span");
    badge.className = `tms-badge tms-badge-${badgeTone(status)}`;
    badge.textContent = label;
    return badge;
  }

  function rowElement({ name, status, label, detail, detailIsError = false, actions }) {
    const element = document.createElement("div");
    element.className = "tms-entity-row flex-container alignitemscenter";

    const text = document.createElement("div");
    text.className = "tms-entity-text flex1";
    const title = document.createElement("span");
    title.className = "tms-entity-label";
    title.textContent = name;
    title.append(statusBadge(status, label));
    text.append(title);

    if (detail) {
      const line = document.createElement("span");
      line.className = detailIsError ? "tms-entity-error" : "tms-entity-notes";
      line.textContent = detail;
      line.title = detail;
      text.append(line);
    }

    element.append(text, ...actions);
    return element;
  }

  function cardRowElement(row) {
    const actions = [];
    if (row.localId && row.status !== "error") actions.push(button("Push", () => confirmPush(row)));
    if (row.managerId) {
      actions.push(button("Pull", () => run("pull", { entityType: row.entityType, managerId: row.managerId })));
    }
    // Creator notes tell same-name Characters apart; an unsyncable entity
    // shows why instead.
    return rowElement({
      name: row.displayName,
      status: row.status,
      label: cardLabels[row.status] ?? row.status,
      detail: row.error || row.creatorNotes,
      detailIsError: Boolean(row.error),
      actions,
    });
  }

  function relayRowElement(row) {
    const sizes = [
      row.local && `${formatSize(row.local.size)} in SillyTavern`,
      row.manager && `${formatSize(row.manager.size)} in Manager`,
    ].filter(Boolean).join(" · ");
    const actions = [];
    if (row.local) actions.push(button("Push", () => relayAction(row, "push")));
    if (row.manager) actions.push(button(row.type === "regex" ? "Download" : "Pull", () => relayAction(row, "pull")));
    return rowElement({ name: row.name, status: row.status, label: relayLabels[row.status] ?? row.status, detail: sizes, actions });
  }

  function renderRows(rows) {
    const container = field("rows");
    container.replaceChildren();
    const tab = currentTab();

    if (tab.kind === "relay" && relayError) {
      container.textContent = relayError;
      return;
    }

    const search = field("search").value.trim().toLocaleLowerCase();
    const matches = (tab.kind === "cards" ? cardFilters : relayFilters).find(([id]) => id === activeFilter)[2];
    const visible = rows.filter((row) => matches(row.status) && [row.displayName ?? row.name, row.creatorNotes]
      .some((value) => String(value ?? "").toLocaleLowerCase().includes(search)));

    for (const row of visible) {
      container.append(tab.kind === "cards" ? cardRowElement(row) : relayRowElement(row));
    }

    if (!visible.length) {
      container.textContent = search || activeFilter !== "all" ? "No matching entries." : "Nothing here yet.";
    }
  }

  function render() {
    if (!panel) return;
    const rows = tabRows();
    if (!(currentTab().kind === "cards" ? cardFilters : relayFilters).some(([id]) => id === activeFilter)) {
      activeFilter = "all";
    }
    renderTabs();
    renderToolbar();
    renderFilters(rows);
    renderRows(rows);
  }

  async function refreshCards() {
    const response = await service.refresh({ discovery: await discover() });
    cardRows = Array.isArray(response.rows) ? response.rows : [];
    render();
    return response;
  }

  // A Manager without the relay still syncs Characters and WorldBooks.
  async function refreshRelay(types) {
    try {
      relayRows = { ...relayRows, ...(await relay.refresh(types)) };
      relayError = "";
    } catch (error) {
      relayError = `Presets, themes and regex are unavailable: ${error.message}`;
    }
    render();
  }

  // Manager is the canonical library, so every Push is confirmed first: a row
  // Manager already has is overwritten, any other becomes a new Manager entity.
  async function confirmPush(row) {
    if (busy) return;
    const type = typeLabel(row.entityType);
    const overwrite = Boolean(row.managerId);
    const lines = [overwrite
      ? `Push ${type} "${row.displayName}"? Manager's copy will be replaced with the SillyTavern version` +
        `${row.entityType === "character" ? ", avatar included" : ""}.`
      : `Push ${type} "${row.displayName}" to Manager as a new ${type}?`];
    if (row.entityType === "character") {
      lines.push("If its linked WorldBook is not in Manager yet, that WorldBook is pushed too.");
    }
    try {
      if (!(await confirmPopup(popupContent(...lines), "Push"))) {
        message("Push cancelled.");
        return;
      }
    } catch (error) {
      message(error.message);
      return;
    }
    return run("push", {
      entityType: row.entityType,
      localId: row.localId,
      ...(overwrite ? { confirmOverwrite: true } : {}),
    });
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
    const label = action === "sync-all" ? "Sync All" : "Push";
    return confirmPopup(
      popupContent(`${label} will overwrite existing Manager content with the SillyTavern version. Continue?`),
      label,
    );
  }

  const countLabel = (count, entityType) => `${count} ${typeLabel(entityType)}${count === 1 ? "" : "s"}`;

  function countText({ characters, worldbooks }) {
    return [characters && countLabel(characters, "character"), worldbooks && countLabel(worldbooks, "worldbook")]
      .filter(Boolean).join(" and ");
  }

  async function confirmPushAll(counts) {
    const confirmed = await confirmPopup(popupContent(
      `Push All sends ${countText(counts)} that exist only in SillyTavern to Manager.`,
      "Each becomes a new Manager entity; nothing already in Manager is changed.",
    ), "Push All");
    return confirmed ? {} : null;
  }

  // ST would ask about tags once per created Character; a batch asks once.
  function tagImportChoice() {
    const label = document.createElement("label");
    label.textContent = "Tags of the new Characters: ";
    const select = document.createElement("select");
    select.className = "text_pole";
    for (const [value, text] of [
      [tagImportSetting.ALL, "Import all"],
      [tagImportSetting.ONLY_EXISTING, "Import existing tags only"],
      [tagImportSetting.NONE, "Import none"],
    ]) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = text;
      select.append(option);
    }
    select.value = String(tagImportSetting.ALL);
    label.append(select);
    return { label, select };
  }

  async function confirmPullAll(counts) {
    const lines = [
      `Pull All copies ${countText(counts)} that exist only in Manager into SillyTavern.`,
      "Nothing already in SillyTavern is changed. A WorldBook whose name SillyTavern already uses is skipped, " +
        "with the Characters that use it; Pull those one by one.",
    ];
    const tags = counts.characters && getContext().powerUserSettings?.tag_import_setting === tagImportSetting.ASK
      ? tagImportChoice()
      : null;
    if (tags) lines.push(tags.label);
    if (!(await confirmPopup(popupContent(...lines), "Pull All"))) return null;
    // Without a choice here, ST applies its own tag import setting.
    return { importSetting: tags ? Number(tags.select.value) : null };
  }

  const batches = {
    "push-all": { label: "Push All", done: "pushed", nothing: "nothing exists only in SillyTavern.",
      start: (options) => service.pushAll(options), confirm: confirmPushAll },
    "pull-all": { label: "Pull All", done: "pulled", nothing: "nothing exists only in Manager.",
      start: (options) => service.pullAll(options), confirm: confirmPullAll },
  };

  // At most ten entries per kind, so a long batch still fits the message line.
  function listOutcomes(results, status) {
    const entries = results.filter((entry) => entry.status === status)
      .map((entry) => `${entry.displayName ?? entry.name}: ${entry.message}`);
    return entries.length > 10 ? [...entries.slice(0, 10), `and ${entries.length - 10} more.`] : entries;
  }

  function batchSummary(label, done, result, total, extra = []) {
    const count = (status) => result.results.filter((entry) => entry.status === status).length;
    const parts = [`${label}: ${count(done)} ${done}, ${count("skipped")} skipped, ` +
      `${count("failed")} failed${result.cancelled ? `; stopped after ${result.results.length} of ${total}` : ""}.`];
    if (result.error) parts.push(result.error);
    const failed = listOutcomes(result.results, "failed");
    if (failed.length) parts.push(`Failed: ${failed.join(" ")}`);
    const skipped = listOutcomes(result.results, "skipped");
    if (skipped.length) parts.push(`Skipped: ${skipped.join(" ")}`);
    // Avatar problems do not undo verified content; they are reported here.
    const warnings = result.results.flatMap((entry) => entry.warnings ?? []);
    if (warnings.length) parts.push(warnings.join("; "));
    return [...parts, ...extra].join(" ");
  }

  async function runBatch(action) {
    if (busy) return;
    const batch = batches[action];
    setBusy(true);
    stopRequested = false;
    let importSetting = null;

    try {
      const result = await batch.start({
        discovery: await discover(),
        adapter,
        confirm: async (counts) => {
          const answer = await batch.confirm(counts);
          if (!answer) return false;
          importSetting = answer.importSetting ?? null;
          stopButton.hidden = false;
          message(`${batch.label}: starting…`);
          return true;
        },
        onProgress: ({ done, total }) => message(`${batch.label}: ${done}/${total}…`),
        isCancelled: () => stopRequested,
      });

      if (!result.characters && !result.worldbooks) {
        message(`${batch.label}: ${batch.nothing}`);
        return;
      }
      if (result.cancelled && !result.results.length) {
        message(`${batch.label} cancelled.`);
        return;
      }

      let uiError = null;
      try {
        await reconciler.reconcileAll(result.frontendChanges, { importSetting });
      } catch (error) {
        uiError = error.message;
      }
      await refreshCards();
      message(batchSummary(batch.label, batch.done, result, result.characters + result.worldbooks,
        uiError ? [`ST UI refresh failed: ${uiError}`] : []));
    } catch (error) {
      message(error.message);
    } finally {
      stopButton.hidden = true;
      setBusy(false);
    }
  }

  const relayPulledText = {
    presets: "it is now the selected preset.",
    themes: "reload SillyTavern to see it in the theme list.",
  };

  // A preset or theme replaces a different copy only after confirmation; a
  // regex script downloads for SillyTavern's Regex panel to import.
  async function relayAction(row, direction) {
    if (busy) return;
    const tab = tabs.find((candidate) => candidate.id === row.type);
    const sides = direction === "push" ? ["SillyTavern", "Manager"] : ["Manager", "SillyTavern"];

    if (row.status === "same" && !(direction === "pull" && row.type === "regex")) {
      message(`"${row.name}" is already the same in ${sides[1]}.`);
      return;
    }

    let confirmOverwrite = false;
    try {
      if (direction === "push") {
        confirmOverwrite = row.status === "different";
        const text = confirmOverwrite
          ? `Push ${tab.noun} "${row.name}"? Manager's copy will be replaced with the SillyTavern version.`
          : `Push ${tab.noun} "${row.name}" to Manager?`;
        if (!(await confirmPopup(popupContent(text), "Push"))) {
          message("Push cancelled.");
          return;
        }
      } else if (row.status === "different" && row.type !== "regex") {
        confirmOverwrite = true;
        if (!(await confirmPopup(popupContent(`Replace SillyTavern's ${tab.noun} "${row.name}" with Manager's copy?`), "Pull"))) {
          message("Pull cancelled.");
          return;
        }
      }
    } catch (error) {
      message(error.message);
      return;
    }

    setBusy(true);
    try {
      const request = { type: row.type, name: row.name, confirmOverwrite };
      let result;
      try {
        result = await relay[direction](request);
      } catch (error) {
        if (error.code !== "overwrite_confirmation_required") throw error;
        // It changed since the list was drawn.
        if (!(await confirmPopup(popupContent(`"${row.name}" now differs between SillyTavern and Manager. ` +
          `Replace the copy in ${sides[1]}?`), direction === "push" ? "Push" : "Pull"))) {
          message(`${direction === "push" ? "Push" : "Pull"} cancelled.`);
          return;
        }
        result = await relay[direction]({ ...request, confirmOverwrite: true });
      }

      await refreshRelay([row.type]);
      if (result.status === "unchanged") message(`"${row.name}" is already the same in ${sides[1]}.`);
      else if (result.status === "downloaded") message(`Downloaded "${row.name}". Import it in SillyTavern's Regex panel.`);
      else if (result.status === "pulled") message(`Pulled "${row.name}"; ${relayPulledText[row.type]}`);
      else message(`Pushed "${row.name}".`);
    } catch (error) {
      message(error.message);
    } finally {
      setBusy(false);
    }
  }

  // Push All and Pull All for one file type copy what exists on one side
  // only. Regex scripts download together as one file instead.
  async function runRelayBatch(direction) {
    if (busy) return;
    const tab = currentTab();
    const download = direction === "pull" && tab.id === "regex";
    const label = direction === "push" ? "Push All" : download ? "Download All" : "Pull All";
    const done = direction === "push" ? "pushed" : download ? "downloaded" : "pulled";
    setBusy(true);
    stopRequested = false;

    try {
      const result = await relay[direction === "push" ? "pushAll" : "pullAll"]({
        type: tab.id,
        confirm: async ({ count }) => {
          if (!download) {
            const lines = direction === "push"
              ? [`Push All sends ${plural(count, tab.noun)} that exist only in SillyTavern to Manager.`,
                "Nothing already in Manager is changed."]
              : [`Pull All copies ${plural(count, tab.noun)} that exist only in Manager into SillyTavern.`,
                "Nothing already in SillyTavern is changed. Reload SillyTavern afterwards to see them in its lists."];
            if (!(await confirmPopup(popupContent(...lines), label))) return false;
          }
          stopButton.hidden = false;
          message(`${label}: starting…`);
          return true;
        },
        onProgress: ({ done: finished, total }) => message(`${label}: ${finished}/${total}…`),
        isCancelled: () => stopRequested,
      });

      if (!result.total) {
        message(`${label}: no ${tab.noun}s exist only in ${direction === "push" ? "SillyTavern" : "Manager"}.`);
        return;
      }
      if (result.cancelled && !result.results.length) {
        message(`${label} cancelled.`);
        return;
      }

      await refreshRelay([tab.id]);
      const extra = [];
      if (download && result.results.some((entry) => entry.status === "downloaded")) {
        extra.push("Import the downloaded file in SillyTavern's Regex panel.");
      }
      if (result.reloadNeeded) extra.push("Reload SillyTavern to see them in its lists.");
      message(batchSummary(label, done, result, result.total, extra));
    } catch (error) {
      message(error.message);
    } finally {
      stopButton.hidden = true;
      setBusy(false);
    }
  }

  const actions = {
    push: (body) => service.push({ ...body, adapter }),
    pull: (body) => service.pull({ ...body, adapter }),
    "sync-all": (body) => service.syncAll({ ...body, adapter }),
  };

  async function run(action, source = {}) {
    if (busy) return;

    setBusy(true);

    try {
      if (action === "save") {
        const password = field("password").value;
        const config = await service.configure({
          endpoint: field("endpoint").value.trim(),
          password,
        });

        field("password").value = "";
        showPasswordState(config);
        message(password ? "Endpoint saved and signed in to Manager." : "Endpoint saved.");
        return;
      }

      if (action === "refresh") {
        const { claimed } = await refreshCards();
        await refreshRelay();
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
            if (!(await confirmManagerOverwrite(action))) {
              message(`${action === "sync-all" ? "Sync All" : "Push"} cancelled.`);
              return;
            }

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

      await refreshCards();

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

  function register() {
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
          <div class="tms-endpoint flex-container alignitemscenter">
            <label class="tms-field-label flex1">
              Manager endpoint
              <input
                class="text_pole"
                data-role="endpoint"
                placeholder="http://127.0.0.1:3000/api/sync/v1"
              >
            </label>
            <label class="tms-field-label tms-password">
              Manager password
              <input
                class="text_pole"
                type="password"
                data-role="password"
                autocomplete="new-password"
              >
            </label>
            <div data-role="save"></div>
          </div>

          <div data-role="tabs" class="tms-tabs" role="tablist" aria-label="What to sync"></div>

          <div data-role="controls" class="flex-container flexWrap"></div>

          <div
            data-role="message"
            class="tms-message"
            aria-live="polite"
          ></div>

          <section class="tms-list-group" aria-label="Entries">
            <div data-role="filters" class="tms-filters"></div>

            <input
              class="text_pole"
              type="search"
              data-role="search"
              placeholder="Search by name"
              aria-label="Search by name"
              autocomplete="off"
            >

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

    stopButton = button("Stop", () => {
      stopRequested = true;
      message("Stopping after the entries in progress…");
    });
    stopButton.hidden = true;

    field("save").append(button("Save", () => run("save")));
    field("search").addEventListener("input", () => renderRows(tabRows()));

    render();

    service.getConfiguration()
      .then((config) => {
        field("endpoint").value = config.endpoint || "";
        showPasswordState(config);
        message("Use Refresh to list entries.");
      })
      .catch((error) => message(error.message));
  }

  return Object.freeze({ register, message });
}
