import { eventSource, event_types, getRequestHeaders } from "../../../../script.js";
import { extension_settings, getContext } from "../../../extensions.js";
import { tag_import_setting } from "../../../tags.js";
import { download, uuidv4 } from "../../../utils.js";
import { worldInfoCache, reloadEditor, updateWorldInfoList } from "../../../world-info.js";
import { createManagerFetch } from "./manager-fetch.js";
import { createMinimalSyncService } from "./minimal-service.js";
import { createSyncPanel } from "./panel.js";
import { createSillyTavernFrontendReconciler } from "./reconcile.js";
import { createRelayService } from "./relay-service.js";
import { createFileSidecarStore } from "./sidecar-settings.js";
import { createMinimalSillyTavernAdapter } from "./st-adapter.js";
import { discoverSillyTavern, encodeLocalId } from "./st-discovery.js";
import { createNativeStGateway } from "./st-gateway.js";
import { createStRelayGateway } from "./st-relay.js";

const reconciler = createSillyTavernFrontendReconciler({
  getContext,
  worldInfoCache,
  updateWorldInfoList,
  reloadWorldInfoEditor: reloadEditor,
});

// Sync state lives in its own user file; extension_settings is read only as
// the legacy source until the first write moves it there.
const sidecarStore = createFileSidecarStore({
  requestHeaders: getRequestHeaders,
  legacySettings: extension_settings,
});

// Manager on another device lets in only requests carrying its access token.
const managerFetch = createManagerFetch({ sidecarStore });

const service = createMinimalSyncService({ sidecarStore, fetch: managerFetch });

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

// Presets, themes and regex scripts relay as files through the same Manager.
const relay = createRelayService({
  sidecarStore,
  fetch: managerFetch,
  st: createStRelayGateway({ requestHeaders: getRequestHeaders, getContext, download }),
});

const discover = () =>
  discoverSillyTavern({
    requestHeaders: getRequestHeaders,
    worldbookList,
  });

const panel = createSyncPanel({
  document,
  getContext,
  service,
  adapter,
  reconciler,
  discover,
  relay,
  tagImportSetting: tag_import_setting,
});

eventSource.on(
  event_types.CHARACTER_RENAMED,
  (oldAvatar, newAvatar) => {
    if (typeof oldAvatar !== "string" || typeof newAvatar !== "string") {
      return;
    }

    return service.renameLocal({
      oldLocalId: encodeLocalId(oldAvatar),
      newLocalId: encodeLocalId(newAvatar),
    }).catch((error) => panel.message(error.message));
  },
);

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    panel.register,
    { once: true },
  );
} else {
  panel.register();
}
