# Zoom Meeting Summaries — Obsidian Plugin

Syncs Zoom AI meeting summaries into your 1:1 note files inside an Obsidian vault. Uses browser-based cookie authentication (SSO, password, etc.) — no Zoom API app or OAuth setup required.

**Desktop only** — requires Electron APIs for the Zoom login window.

## Features

- **One-click sync**: Fetch all recent Zoom AI meeting summaries and write them into the correct 1:1 note files.
- **Smart file matching**: Matches meetings to vault files by attendee name, topic first name, or word boundary.
- **Chronological insertion**: Summaries inserted in newest-first order, with same-date merge support.
- **Idempotent**: Re-running sync won't duplicate summaries already present.
- **Optional auto-delete**: Remove summaries from Zoom after writing to vault.
- **Group meeting filtering**: Multi-person meetings (3+ participants) are automatically skipped.

## Prerequisites

- **Node.js** ≥ 18 and **npm** (for building)
- **Obsidian** desktop app (not mobile)

## Building

```bash
cd ObsidianPlugin
npm install
npm run build
```

This produces `main.js` in the `ObsidianPlugin/` directory.

For development with auto-rebuild on changes:

```bash
npm run dev
```

## Installation

### Manual Install

1. Build the plugin (see above).
2. In your Obsidian vault, create the plugin directory:
   ```bash
   mkdir -p /path/to/your/vault/.obsidian/plugins/zoom-obsidian
   ```
3. Copy the three required files:
   ```bash
   cp manifest.json main.js styles.css /path/to/your/vault/.obsidian/plugins/zoom-obsidian/
   ```
4. Restart Obsidian (or reload without restarting via Ctrl/Cmd+R).
5. Go to **Settings → Community plugins** and enable **Zoom Meeting Summaries**.

### BRAT Install (Alternative)

If you use the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin for beta testing:

1. Open BRAT settings in Obsidian.
2. Click **Add Beta plugin**.
3. Enter the repository URL and subdirectory path.
4. BRAT will handle installation and updates.

### Updating

After pulling new code and rebuilding, copy `main.js`, `manifest.json`, and `styles.css` to your vault's plugin directory again and reload Obsidian.

## Configuration

After enabling the plugin, go to **Settings → Zoom Meeting Summaries**:

### Zoom Connection

| Setting | Description |
|---------|-------------|
| **Zoom subdomain** | Your org's subdomain (e.g. `acme` for `acme.zoom.us`). Leave blank for `zoom.us`. |
| **Login / Re-login** | Opens a browser window for Zoom SSO/password login. Cookies are saved for future sessions. |
| **Logout** | Clears stored Zoom cookies. |

### Vault Layout

| Setting | Description |
|---------|-------------|
| **Vault subfolder** | Subfolder within vault root where 1:1 folders live (e.g. `MyOrg`). Leave blank to search from root. |
| **1:1 note folders** | Comma-separated folder names containing 1:1 note files. Default: `! One on Ones, ! One on Ones (Other)` |
| **Folder for Shared Meetings** | (Optional) Folder where meetings shared with you are written. Shared meetings are listed from `#/summaryShare` and are never deleted from Zoom. When this is set, sync runs in shared-only mode (owned-host meetings are not processed). |

### Sync Behavior

| Setting | Description |
|---------|-------------|
| **Auto-delete from Zoom** | Delete each summary from Zoom after writing it to the vault. |
| **Topic filter** | Only sync meetings whose topic contains this text (case-insensitive). Leave blank for all. **Note:** When a topic filter is active, the scan date for shared meetings is not advanced, so non-matching shared meetings won't be skipped on subsequent unfiltered runs. |

### Advanced

| Setting | Description |
|---------|-------------|
| **Debug logging** | Output verbose diagnostics to the developer console (Ctrl+Shift+I / Cmd+Opt+I). |

## Usage

### First-Time Setup

1. Open **Settings → Zoom Meeting Summaries**.
2. Enter your Zoom subdomain (if applicable).
3. Configure vault subfolder and 1:1 folder names to match your vault structure.
4. Click **Login to Zoom** — a browser window opens for you to complete SSO or password login.
5. After login, the window closes and cookies are saved.

### Syncing Summaries

Use any of these methods:

- **Ribbon icon**: Click the refresh icon in the left sidebar.
- **Command palette**: `Ctrl/Cmd+P` → "Zoom: Sync Zoom summaries"
- **Hotkey**: Assign a hotkey in Settings → Hotkeys.

The sync will:
1. Fetch meeting summaries from Zoom (incrementally — only meetings since the last successful sync).
2. Match each meeting to a 1:1 note file in your vault.
3. Write summaries into the correct files in chronological order.
4. Show a results modal with what was written, skipped, or errored.
5. Update the scan timestamp so future syncs only fetch new meetings.

Scan timestamps are stored in `obsidian-config.json` inside the plugin folder (`lastProcessedOwned` and `lastProcessedShared`). Delete this file to force a full re-scan.

### Listing Summaries

Command palette → "Zoom: List Zoom summaries" shows a table of all available summaries without writing anything.

### Commands

| Command | Description |
|---------|-------------|
| **Sync Zoom summaries** | Full sync: list → fetch → write → optionally delete |
| **Login to Zoom** | Open Zoom login in browser window |
| **List Zoom summaries** | Show available summaries in a modal |
| **Logout from Zoom** | Clear stored Zoom cookies |

## Troubleshooting

### "Not logged in" / "Session expired"

Zoom cookies expire periodically. Re-login via Settings or the "Login to Zoom" command.

### No summaries found

- Verify your Zoom subdomain is correct in settings.
- Check that AI meeting summaries are enabled in your Zoom account.
- Try enabling debug logging and check the developer console for diagnostic output.

### Wrong file matched

The plugin matches meetings to files by:
1. Exact full attendee name → file name
2. Topic first name (before colon) → file name starts with
3. Attendee first name → file name starts with
4. Any candidate name → file name contains as word

If matching is wrong, check that your meeting topic follows the `Name:Howard` format and that your 1:1 note files are named after the person.

### Summaries not appearing after sync

- Check the sync results modal for errors.
- Ensure the vault subfolder and 1:1 folder settings point to the correct directories.
- Multi-person meetings (3+ participants or multiple non-Howard names in topic) are automatically skipped.

## Architecture

```
src/
├── main.ts              Plugin entry point (extends Obsidian Plugin)
├── settings.ts          Settings tab UI
├── types.ts             Shared TypeScript interfaces
├── node-http.ts         Node.js https/http wrapper (bypasses Electron Cookie restriction)
├── zoom-auth.ts         Electron BrowserWindow login + cookie management
├── zoom-client.ts       Zoom client (hidden BrowserWindow for SPA scraping + REST API)
├── vault-writer.ts      Obsidian Vault API adapter (find files, write summaries)
└── sync-orchestrator.ts 7-phase sync workflow coordinator
```

The plugin replaces the standalone MCP server and script with:
- **Electron `BrowserWindow`** instead of Puppeteer — both for Zoom login (visible window) and SPA scraping (hidden window)
- **`nodeRequest()`** instead of `fetch()` for authenticated REST calls (Electron's `fetch` strips Cookie headers)
- **Obsidian `Vault` API** instead of Node.js `fs` for file operations
- **Plugin settings UI** instead of env vars and CLI flags

Zoom's meeting summary page is a client-side SPA — the table is rendered by JavaScript after page load. Plain HTTP requests get an empty HTML shell. The plugin uses a hidden `BrowserWindow` to load the SPA, wait for the table to render, then extract data via `webContents.executeJavaScript()`. Deletion also uses the hidden `BrowserWindow`: it navigates to the detail view, clicks the "delete meeting summary" button, confirms "Move to Trash", and falls back to `fetch()` inside the browser context (which has session cookies and CSRF tokens) if the UI flow doesn't confirm.

## License

ISC
