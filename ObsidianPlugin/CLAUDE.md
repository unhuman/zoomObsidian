# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Development build with watch/rebuild
npm run build     # Production build (minified)
```

No automated tests — testing is manual by loading the plugin in Obsidian.

## Architecture

This is a **desktop-only Obsidian plugin** that syncs Zoom AI meeting summaries into vault note files. Desktop-only because it requires Electron APIs (BrowserWindow, session partitions) for authentication and SPA scraping.

### Source Files (`src/`)

| File | Role |
|------|------|
| `main.ts` | Plugin entry point; registers commands/ribbon; manages settings |
| `types.ts` | TypeScript interfaces (`MeetingSummaryItem`, settings, etc.) |
| `settings.ts` | Settings tab UI |
| `zoom-auth.ts` | Electron BrowserWindow login + cookie management + `silentRefresh()` |
| `zoom-client.ts` | Hidden BrowserWindow SPA scraping + REST API for Zoom summaries |
| `vault-writer.ts` | Obsidian Vault API adapter: file matching + summary insertion |
| `node-http.ts` | Node.js `https`/`http` wrapper (bypasses Electron's Cookie header restriction) |
| `sync-orchestrator.ts` | 7-phase sync workflow coordinator |

### Key Design Decisions

**SPA Scraping:** Zoom's meeting summary list is rendered by JavaScript. The plugin loads it in a hidden Electron `BrowserWindow`, waits for render, then extracts data via `webContents.executeJavaScript()`.

**Node.js HTTP instead of `fetch()`:** Electron's renderer-process `fetch()` strips the `Cookie` header. `node-http.ts` uses Node's `https`/`http` modules to send authenticated requests.

**Electron Session Partition:** Both login and scraping use `"persist:zoom-obsidian"` so cookies persist across BrowserWindow instances.

### Sync Workflow (sync-orchestrator.ts)

`processMeetingSource()` runs a 7-phase pipeline for each source type (`"owned"` or `"shared"`):

1. **List** meetings from Zoom
2. **Resolve attendees** — fetch detail for ambiguous matches
3. **Build plan** — decide insert/create/skip per meeting (skips multi-person meetings)
4. **Pre-fetch** — batch REST calls for full summary content
5. **Write** to vault — inserts under date headers, idempotent (skips if date already present)
6. **Delete** from Zoom (owned only, if `autoDelete` setting is on)
7. **Report** results

**Incremental sync:** Owned meetings are always fully scanned (they get deleted). Shared meetings use `lastProcessedShared` timestamp (stored in `obsidian-config.json`) for incremental scans.

### File Matching (vault-writer.ts)

4-level priority for matching a meeting attendee to a vault file:
1. Exact full name → file name
2. File name starts with topic's first name (prefer solo files)
3. File name starts with any attendee's first name
4. File name contains first name as word boundary

### Persistent State

- `data.json` — User settings (subdomain, cookies, folder paths, filters)
- `obsidian-config.json` — Config state (scan timestamps for incremental sync)

### Build

`esbuild.config.mjs` compiles `src/main.ts` → `main.js` (CommonJS, externals: `obsidian`, `electron`, Node built-ins). Output files for installation: `main.js`, `manifest.json`, `styles.css`.

### Versioning

Version must be kept in sync across two files: `manifest.json` and `package.json`. Use semantic versioning (`MAJOR.MINOR.PATCH`):

| Change type | Bump |
|-------------|------|
| Bug fix, incorrect behavior corrected | `PATCH` (1.1.0 → 1.1.1) |
| New feature, new setting, new command | `MINOR` (1.1.0 → 1.2.0) |
| Breaking change (incompatible settings, removed behavior) | `MAJOR` (1.1.0 → 2.0.0) |

After any code change, update the version in both files before building:

```json
// manifest.json
{ "version": "1.1.1" }

// package.json
{ "version": "1.1.1" }
```
