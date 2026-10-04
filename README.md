# Tavern Manager Sync

A SillyTavern extension for synchronizing Characters, WorldBooks, presets, UI themes, and global regex scripts with [Tavern Manager](https://github.com/JL0952/tavern-manager).

## Features

- Bidirectional Character and WorldBook sync
- Push local SillyTavern entities to Tavern Manager; every Push asks for confirmation first, since Manager is the canonical library
- Pull Manager entities into SillyTavern
- Sync All with conflict/overwrite handling
- **Push All** and **Pull All** copy every Character and WorldBook that exists on one side only, after one confirmation, with progress and stop.
- Chat completion presets, UI themes and global regex scripts: Push and Pull them as files (regex scripts download for SillyTavern's Regex panel to import)
- Presets are stored as SillyTavern saves them, including any reverse proxy address and password
- Character avatars on Push and Pull (Push replaces the Manager avatar with SillyTavern's)
- A creator-notes line under each Character, so same-name Characters can be told apart
- Display-name and creator-notes search for Push/Pull lists
- Cards that cannot be synced are listed as **Cannot sync** with the reason instead of stopping Refresh; Pull can still overwrite them from Manager
- UI follows SillyTavern themes
- Local/LAN Manager support

## Requirements

- SillyTavern or TauriTavern
- Tavern Manager
- Git
- Tavern Manager's sync API running and reachable from the SillyTavern instance

## Installation

### SillyTavern

Open:

**Extensions → Install Extension**

Enter the Git repository URL:

`https://github.com/JL0952/tavern-manager-sync`

Then install the extension and reload SillyTavern.

### TauriTavern

Install it the same way, from **Extensions → Install Extension** with the Git repository URL above, then reload TauriTavern.

## Manager Endpoint

If Tavern Manager runs on the same machine as SillyTavern:

`http://127.0.0.1:3000/api/sync/v1`

If SillyTavern runs on another device on the same LAN:

`http://<manager-lan-ip>:3000/api/sync/v1`, and enter the Manager password (set it in Manager first)

Port `3000` is the Tavern Manager sync API.

Port `5173` is only for Manager development and should not be used as the sync endpoint.

## Usage

1. Start Tavern Manager.
2. Open the Tavern Manager Sync extension in SillyTavern.
3. Enter the Manager endpoint, and the Manager password if Manager runs on another device.
4. Click **Save**.
5. Click **Refresh**, then pick a tab: Characters, WorldBooks, Presets, Themes or Regex.
6. Use **Push**, **Pull**, **Sync All**, **Push All**, or **Pull All**.

## Compatibility

The extension supports both SillyTavern and TauriTavern.

TauriTavern uses a different WorldBook discovery API, which is handled automatically by the extension.

## Known Limitations

- Avatars are not part of the sync content hash. A changed avatar alone does not mark a Character as changed and Sync All does not transfer it; Push or Pull that Character to send it.
- An avatar that fails to transfer does not undo the verified card content; the result message lists it as a warning.

## Development

Run the tests with Node:

```
npm test
```

Some tests check the extension against SillyTavern's own code. They use the SillyTavern install this extension lives in, or `ST_SYNC_ST_ROOT`, and are skipped when neither is found.

`sync-core/` is copied verbatim from Tavern Manager (`npm run sync-core:export` there). Do not edit it here!
