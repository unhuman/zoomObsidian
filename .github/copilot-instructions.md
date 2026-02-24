# Copilot Instructions

## Build & Run

```bash
npm run build        # Compile TypeScript → build/
npm run dev          # Watch mode (tsc --watch)
npm start            # Run the MCP server (stdio transport)
```

No test suite or linter is configured.

## Architecture

This is an MCP (Model Context Protocol) server that exposes Zoom meeting summaries as tools and writes them into an Obsidian vault. It uses **Puppeteer web scraping** (not the Zoom REST API) with browser-based cookie authentication.

**Four-layer design:**

- `src/index.ts` — MCP server entry point. Registers five tools using `@modelcontextprotocol/sdk` and Zod schemas. Reads `ZOOM_SUBDOMAIN`, `OBSIDIAN_VAULT_PATH`, `VAULT_SUBFOLDER`, and `ONE_ON_ONE_FOLDERS` from env.
- `src/zoom-browser.ts` — `ZoomBrowser` class. Manages Puppeteer browser lifecycle, cookie persistence (`~/.zoom-mcp/cookies.json`), and the interactive-login-then-switch-to-headless flow.
- `src/zoom-summaries.ts` — `ZoomSummariesClient` class. Navigates to Zoom's web UI pages and scrapes meeting summary data. Exposes `listSummaries()`, `getSummary(id)`, `deleteSummary(id)`, and `prefetchNavIds(ids[])`. Uses a shared `navigateToDetail()` private helper for row-click + hash extraction. Navigation uses `domcontentloaded` (not `networkidle2`) to avoid 30s SPA timeouts.
- `src/obsidian-client.ts` — `ObsidianClient` class. Finds the right vault note for a meeting, inserts the summary in tab-indented newest-first order, and handles same-date merging (appending under existing manual notes without a new date header).

**Auth flow:** First call opens a visible browser for manual Zoom sign-in (SSO, password, etc.). Cookies are saved and reused headlessly until they expire. The `ensureAuthenticated()` method handles this transparently.

**Deletion flow:** After writing a summary to Obsidian (new or duplicate already present), `deleteSummary()` checks an in-memory `navIdCache` (populated during prior `getSummary` navigation). If the cache hits, it verifies the page is already on the `#/detail` view and skips re-scraping the list entirely; otherwise it navigates via hash change directly to the detail URL. It then `waitForSelector`s the delete button (aria-label `"delete meeting summary"`), clicks it, waits for the "Move to Trash" confirmation button via `waitForSelector`, clicks that, then uses a CDP `Network.requestWillBeSent` listener that resolves a promise immediately when the first non-GET zoom.us request fires (capped at 5s). The intercepted response status determines success.

**Nav-ID cache:** `navIdCache: Map<string, { uuidMeetingId, summaryId }>` maps each numeric meeting ID to its UUID-based identifiers. Populated by `navigateToDetail` and by `prefetchNavIds`. Exposed to callers via `getNavCache()`. **In-memory only** — never persisted to disk. Recurring meetings reuse the same numeric ID for different instances, so a disk cache would serve stale UUID/summaryId pairs.

**Efficient pre-fetch:** `prefetchNavIds(numericIds[])` does a **single** pass through all list pages. For each page it clicks every needed row (hash changes to `#/detail`), captures the UUID + summaryId, then navigates back to the list via hash reset (`#/`). It jumps back to the correct page using numbered pagination buttons (`.zm-pager li.number[data-page=N]`) when available, falling back to sequential Next-clicks. This collapses N list traversals (one per `getSummary` call) into one traversal up front. `getSummary` itself checks `navIdCache` first and skips `navigateToDetail` entirely when the IDs are already known.

**Dry-run script:** `zoom-meetings-to-obsidian.mjs` is a standalone ESM script that copies vault files to `/tmp/obsidian-preview` and applies mutations there. It skips copying files that already exist in `/tmp` (preserving previous runs for idempotency testing). After writing, it logs a `Would delete from Zoom` list instead of actually deleting. Pass `--update` to write to the real vault. Pass `--update --delete` to also delete summaries from Zoom. `--delete` without `--update` is an error. Pass `--debug` to enable verbose diagnostic logging (page element dumps, network request traces, CSRF probing, row-scan results).

## Key Conventions

- ESM throughout (`"type": "module"` in package.json, Node16 module resolution). All local imports use `.js` extensions.
- All MCP tool handlers return `{ content: [{ type: "text", text: ... }] }` shape with `isError: true` on failure. Error messages suggest calling `zoom_login` first.
- Diagnostic/log output goes to `console.error` (stdout is reserved for MCP stdio transport). `zoom-meetings-to-obsidian.mjs` uses `console.log` for all user-facing output (table + would-delete list) and `process.stderr.write` for progress noise.
- The `ZOOM_SUBDOMAIN` env var controls which Zoom org to target (e.g., `acme` → `acme.zoom.us`).
- The `OBSIDIAN_VAULT_PATH` env var points to the vault root. Required for the MCP server; the standalone script prompts if unset.
- The `VAULT_SUBFOLDER` env var names the subfolder within the vault containing 1:1 note directories (e.g. `MyOrg`). Leave empty to search directly under vault root.
- The `ONE_ON_ONE_FOLDERS` env var is a comma-separated list of folder names holding 1:1 notes (default: `! One on Ones,! One on Ones (Other)`).
- The standalone script resolves each setting via: env var → `~/.zoom-mcp/config.json` → interactive prompt (with optional save). Config keys: `vaultPath`, `zoomSubdomain`, `vaultSubfolder`, `oneOnOneFolders`.
- All caches (`attendeesCache`, `summaryCache`, `navIdCache`) are **in-memory only** — never persisted to disk. They exist solely to avoid duplicate fetches within a single run. No disk caches are written; `~/.zoom-mcp/` only holds `cookies.json` and optionally `config.json` (vault path).
- Multi-person meetings (3+ participants or `A:B:C` topic with 2+ non-Howard names) are skipped — only 1:1s are written to Obsidian.

## Documentation
- Always update documentation with every change
- ensure the help in the script file(s) is kept up to date
