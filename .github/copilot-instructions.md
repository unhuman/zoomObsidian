# Copilot Instructions

## Project Overview

This repo contains **two independent implementations** of the same Zoom-meeting-summaries-to-Obsidian workflow:

1. **MCP server + standalone script** (root-level `src/` and `zoom-meetings-to-obsidian.mjs`) — Puppeteer-based, runs outside Obsidian.
2. **Obsidian plugin** (`ObsidianPlugin/`) — self-contained desktop plugin, uses Electron BrowserWindow + direct fetch() instead of Puppeteer.

Both share the same core logic (listing, matching, writing, deleting) but are architecturally independent — neither depends on the other.

---

## Build & Run

### MCP Server (root)

```bash
npm run build        # Compile TypeScript → build/
npm run dev          # Watch mode (tsc --watch)
npm start            # Run the MCP server (stdio transport)
```

### Obsidian Plugin

```bash
cd ObsidianPlugin
npm install
npm run build        # esbuild → main.js (CJS bundle)
npm run dev          # Watch mode with auto-rebuild
```

Install by copying `manifest.json`, `main.js`, and `styles.css` into `<vault>/.obsidian/plugins/zoom-obsidian/`. See `ObsidianPlugin/README.md` for full instructions.

No test suite or linter is configured for either project.

---

## Architecture — MCP Server (root `src/`)

This is an MCP (Model Context Protocol) server that exposes Zoom meeting summaries as tools and writes them into an Obsidian vault. It uses **Puppeteer web scraping** (not the Zoom REST API) with browser-based cookie authentication.

**Four-layer design:**

- `src/index.ts` — MCP server entry point. Registers five tools using `@modelcontextprotocol/sdk` and Zod schemas. Reads `ZOOM_SUBDOMAIN`, `OBSIDIAN_VAULT_PATH`, `VAULT_SUBFOLDER`, and `ONE_ON_ONE_FOLDERS` from env.
- `src/zoom-browser.ts` — `ZoomBrowser` class. Manages Puppeteer browser lifecycle, cookie persistence (`~/.zoom-mcp/cookies.json`), and the interactive-login-then-switch-to-headless flow.
- `src/zoom-summaries.ts` — `ZoomSummariesClient` class. Navigates to Zoom's web UI pages and scrapes meeting summary data. Exposes `listSummaries()`, `getSummary(id)`, `deleteSummary(id)`, and `prefetchNavIds(ids[])`. Uses a shared `navigateToDetail()` private helper for row-click + hash extraction. Navigation uses `domcontentloaded` (not `networkidle2`) to avoid 30s SPA timeouts.
- `src/obsidian-client.ts` — `ObsidianClient` class. Finds the right vault note for a meeting, inserts the summary in tab-indented newest-first order, and handles same-date merging (appending under existing manual notes without a new date header).

**Auth flow:** First call opens a visible browser for manual Zoom sign-in (SSO, password, etc.). Cookies are saved and reused headlessly until they expire. The `ensureAuthenticated()` method handles this transparently.

**Deletion flow:** After writing a summary to Obsidian (new or duplicate already present), `deleteSummary()` checks an in-memory `navIdCache` (populated during prior `getSummary` navigation). If the cache hits, it verifies the page is already on the `#/detail` view and skips re-scraping the list entirely; otherwise it navigates via hash change directly to the detail URL. It then `waitForSelector`s the delete button (aria-label `"delete meeting summary"`), clicks it, waits for the "Move to Trash" confirmation button via `waitForSelector`, clicks that, then uses a CDP `Network.requestWillBeSent` listener that resolves a promise immediately when the first non-GET zoom.us request fires (capped at 5s). The intercepted response status determines success.

**Nav-ID cache:** `navIdCache: Map<string, { uuidMeetingId, summaryId, isShared? }>` maps each meeting to its UUID-based identifiers. In the Obsidian plugin, keys are source-prefixed (`owned:123` / `shared:123`) to prevent cross-contamination. Populated by `navigateToDetail`/`resolveNavId` and by `prefetchNavIds`. Exposed to callers via `getNavCache()`. **In-memory only** — never persisted to disk. Recurring meetings reuse the same numeric ID for different instances, so a disk cache would serve stale UUID/summaryId pairs.

**Efficient pre-fetch:** `prefetchNavIds(numericIds[])` does a **single** pass through all list pages. For each page it clicks every needed row (hash changes to `#/detail`), captures the UUID + summaryId, then navigates back to the list via hash reset (`#/`). It jumps back to the correct page using numbered pagination buttons (`.zm-pager li.number[data-page=N]`) when available, falling back to sequential Next-clicks. This collapses N list traversals (one per `getSummary` call) into one traversal up front. `getSummary` itself checks `navIdCache` first and skips `navigateToDetail` entirely when the IDs are already known.

**Column-agnostic ID matching:** The owned and shared summary tables have different column layouts (owned: topic/date/ID; shared: topic/ID/owner/date). All row-scanning code matches the numeric meeting ID by scanning *all* `<td>` cells in a row rather than hardcoding a column index. The `listSummaries()` scraper also finds IDs by scanning for 9–14-digit numbers across all cells.

**Dry-run script:** `zoom-meetings-to-obsidian.mjs` is a standalone ESM script that copies vault files to `/tmp/obsidian-preview` and applies mutations there. It skips copying files that already exist in `/tmp` (preserving previous runs for idempotency testing). After writing, it logs a `Would delete from Zoom` list instead of actually deleting. Pass `--update` to write to the real vault. Pass `--update --delete` to also delete summaries from Zoom. `--delete` without `--update` is an error. Pass `--debug` to enable verbose diagnostic logging (page element dumps, network request traces, CSRF probing, row-scan results).

---

## Architecture — Obsidian Plugin (`ObsidianPlugin/`)

A self-contained Obsidian community plugin (desktop-only, `isDesktopOnly: true`). Replaces Puppeteer with Electron BrowserWindow for auth, uses direct `fetch()` with cookies for Zoom API calls, and the Obsidian `Vault` API for file I/O. Plugin settings UI replaces env vars and CLI flags.

**Seven-module design:**

- `src/main.ts` — Plugin entry point (extends `Plugin`). Registers four commands (`sync`, `login`, `list`, `logout`), a ribbon icon, and the settings tab. Contains `SyncReportModal` and `SummaryListModal` modal classes.
- `src/settings.ts` — `ZoomObsidianSettingTab`. Sections: Zoom Connection (subdomain, login/logout buttons), Vault Layout (subfolder, 1:1 folders, shared meetings folder), Sync Behavior (auto-delete, topic filter), Advanced (debug toggle).
- `src/types.ts` — All shared interfaces: `MeetingSummaryItem`, `MeetingSummaryDetail`, `SummarySection`, `NextStepItem`, `ZoomSummaryData`, `NavIdEntry`, `ZoomObsidianSettings`, `SerializedCookie`, and `DEFAULT_SETTINGS` constant.
- `src/node-http.ts` — `nodeRequest()` helper. Wraps Node.js `https`/`http` modules in a Promise-based API. Required because Electron's renderer-process `fetch()` silently strips the `Cookie` header (forbidden header per Fetch spec). Supports `followRedirects` option for manual redirect handling.
- `src/zoom-auth.ts` — `ZoomAuth` class. Opens Electron `BrowserWindow` with `persist:zoom-obsidian` session partition for Zoom SSO/password login. Extracts cookies after redirect, persists via callback. `isAuthenticated()` uses `nodeRequest()` with `followRedirects: false` to detect login redirects. Accessed via `require("electron").remote`.
- `src/zoom-client.ts` — `ZoomClient` class. Uses a hidden `BrowserWindow` (with authenticated session partition) for SPA scraping — Zoom's summary page is client-rendered and plain HTTP gets empty HTML. `listSummaries()` loads the SPA, waits for the table to render, extracts rows via `executeJavaScript()`, and paginates by clicking Next. `resolveNavId()`/`prefetchNavIds()` click topic rows in the SPA to capture UUID+summaryId from hash navigation. `zoomFetch()` helper uses `nodeRequest()` for direct REST calls (summary detail). `getSummary()` calls `/rest/meeting/web_view_summary`. `deleteSummary()` uses the hidden BrowserWindow: navigates to the detail hash, clicks the delete button (aria-label `"delete meeting summary"`), waits for "Move to Trash" confirmation dialog, clicks confirm, and falls back to `fetch()` inside the browser context (which has session cookies and CSRF tokens) if the UI flow doesn't confirm. Hidden window is cleaned up after each operation via `closeScrapeWindow()`.
- `src/vault-writer.ts` — `VaultWriter` class. Ported from `ObsidianClient`. Uses `app.vault.read/modify/create/getAbstractFileByPath`. File matching: exact full name → starts-with first name → contains as word (4-priority system). Chronological newest-first insertion with same-date merge and idempotency.
- `src/sync-orchestrator.ts` — `SyncOrchestrator` class. 7-phase workflow: list meetings → resolve attendees → build plan → prefetch nav IDs + summaries → write to vault → optionally delete from Zoom → report. In-memory `attendeesCache` and `summaryCache`. Progress callbacks for UI notices. Accepts optional `sharedMeetingsFolder` setting to process shared meetings in addition to owned meetings.

**Build tooling:** esbuild bundling to CJS (`main.js`), externals: `obsidian`, `electron`, `@electron/remote`, Node built-in modules. TypeScript strict mode, ES2022 target, bundler module resolution.

**Settings persistence:** Plugin settings stored in `data.json` via Obsidian's `saveData()`/`loadData()`. Includes serialized Zoom cookies (no external cookie file needed).

---

## Key Conventions

### General (both projects)
- All caches (`attendeesCache`, `summaryCache`, `navIdCache`) are **in-memory only** — never persisted to disk. They exist solely to avoid duplicate fetches within a single run.
- **Recurring meetings** reuse the same numeric meeting ID for every instance. Each instance has a different date and a different UUID/summaryId pair. The orchestrator uses composite instance keys (`rawId__parsedDate`) to distinguish them, and passes a `dateHint` (raw date text from the table row) through to `resolveNavId`/`getSummary` so the correct row is clicked. The nav cache also includes the dateHint in its key when provided.
- Multi-person meetings (3+ participants or `A:B:C` topic with 2+ non-Howard names) are skipped — only 1:1s are written to Obsidian.
- **Shared Meetings Support (v1.1.0+):** Both MCP server and Obsidian plugin can now process meetings shared WITH the user (in addition to owned meetings). The shared meetings SPA URL is different (`#/summaryShare` vs `#/list`). Clicking a shared meeting row navigates to `#/detail?meetingId=...&summaryId=...&isShared=true` (same `#/detail` scheme as owned, but with `isShared=true` parameter). The REST API call for shared summaries appends `&isShared=true`. A new optional setting "Folder for Shared Meetings" lets you write shared meetings to a dedicated folder. Shared meetings cannot be deleted from Zoom (API limitation). If the setting is empty/missing, shared meetings are **not** processed.

### MCP Server (root)
- ESM throughout (`"type": "module"` in package.json, Node16 module resolution). All local imports use `.js` extensions.
- All MCP tool handlers return `{ content: [{ type: "text", text: ... }] }` shape with `isError: true` on failure. Error messages suggest calling `zoom_login` first.
- Diagnostic/log output goes to `console.error` (stdout is reserved for MCP stdio transport). `zoom-meetings-to-obsidian.mjs` uses `console.log` for all user-facing output (table + would-delete list) and `process.stderr.write` for progress noise.
- The `ZOOM_SUBDOMAIN` env var controls which Zoom org to target (e.g., `acme` → `acme.zoom.us`).
- The `OBSIDIAN_VAULT_PATH` env var points to the vault root. Required for the MCP server; the standalone script prompts if unset.
- The `VAULT_SUBFOLDER` env var names the subfolder within the vault containing 1:1 note directories (e.g. `MyOrg`). Leave empty to search directly under vault root.
- The `ONE_ON_ONE_FOLDERS` env var is a comma-separated list of folder names holding 1:1 notes (default: `! One on Ones,! One on Ones (Other)`).
- The `SHARED_MEETINGS_FOLDER` env var (optional, v1.1.0+) names the folder for shared meetings. If unset or empty, shared meetings are not processed.
- The standalone script resolves each setting via: env var → `~/.zoom-mcp/config.json` → interactive prompt (with optional save). Config keys: `vaultPath`, `zoomSubdomain`, `vaultSubfolder`, `oneOnOneFolders`.
- No disk caches are written; `~/.zoom-mcp/` only holds `cookies.json` and optionally `config.json` (vault path).

### Obsidian Plugin
- TypeScript with esbuild bundler (not tsc for emit). CJS output format (Obsidian requirement). Externalized: `obsidian`, `electron`, `@electron/remote`, Node built-in modules.
- **HTTP requests must use `nodeRequest()` from `node-http.ts`**, not `fetch()`. Electron's renderer-process `fetch()` silently strips the `Cookie` header (forbidden per Fetch spec), breaking all authenticated Zoom requests. `nodeRequest()` wraps Node.js `https`/`http` modules which have no such restriction.
- Plugin settings replace env vars — configured via Obsidian's Settings UI (`ZoomObsidianSettingTab`).
- Electron BrowserWindow accessed via `require("electron").remote` (available in Obsidian desktop).
- Cookies persisted in plugin `data.json` via Obsidian `saveData()`. No external cookie file.
- Debug logging uses `console.log` with `[zoom-*]` prefixes (visible in Obsidian developer console).
- Desktop-only — `manifest.json` sets `isDesktopOnly: true`.

## Documentation
- Always update documentation with every change
- Ensure the help in the script file(s) is kept up to date
- Plugin documentation lives in `ObsidianPlugin/README.md` — update it when changing plugin behavior, commands, settings, or build steps
