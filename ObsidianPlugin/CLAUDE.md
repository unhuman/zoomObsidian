# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Development build with watch/rebuild
npm run build     # Production build (minified)
```

No automated tests — testing is manual by loading the plugin in Obsidian.

## Deployment

After code changes:

1. **Update version** in BOTH `manifest.json` and `package.json` (see [Versioning](#versioning) section)
   - ⚠️ **CRITICAL:** These must be kept in sync at all times. If they diverge, `npm run build` will reference the wrong version.
2. **Build:** `npm run build`
3. **Copy all three files** to the vault plugin directory:
   ```bash
   cp ObsidianPlugin/main.js ObsidianPlugin/manifest.json ObsidianPlugin/styles.css \
     /path/to/vault/.obsidian/plugins/zoom-obsidian/
   ```
   (All three files must be in sync: `main.js`, `manifest.json`, `styles.css`)
4. **Reload in Obsidian:** Settings → Community Plugins → zoom-obsidian → toggle OFF, wait 2 seconds, toggle ON
5. **Verify:** Check the version number in Community Plugins settings matches the new version

**Important:** Simply copying `main.js` is insufficient. The manifest and styles must also be kept in sync. Using the "Refresh" button in settings updates the displayed version but does NOT reload the running code — you must toggle the plugin off then on.

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

**Adhoc "Zoom Meeting" 1:1 handling:** Owned meetings with topics matching `/^zoom\s+meeting\b/i` (e.g. "Zoom Meeting", "Zoom Meeting (1)") are treated as potential 1:1s. Phase 2 fetches attendees: first from `nextStepItems.assignees.username`, then falls back to `POST /rest/account/report/historymeetings/participants/list` (requires `zoomAccountId` in settings). Zoom Room devices (email prefix `zoomroom_`) are filtered out. If exactly one non-Howard attendee is identified, Phase 3 routes to `findPersonFile` / `suggestNewFilePath` exactly like named 1:1s.

**Placeholder detection (vault-writer.ts):** When a meeting is synced before its AI summary is ready, the plugin writes `(No summary available)` as a placeholder. On the next sync, `zoomBlockIsEmpty()` detects this and allows the real content to overwrite it. There are two formats to handle:
- **Standalone:** `YYYY-MM-DD - Zoom AI Summary` header with `(No summary available)` below (new file or no prior date entry).
- **Merged:** `Zoom AI Summary` label nested inside an existing `YYYY-MM-DD` date section (most common for regular 1:1s). `zoomBlockIsEmpty()` detects this using indentation-depth comparison (not tab/space specific), and `stripZoomBlock()` removes the nested label + content before re-inserting with real data.

**Indentation matching:** When merging content into an existing date section, the plugin detects the indentation style (tabs, 2-space, 4-space, etc.) from the first indented line in that block and uses it for the inserted Zoom AI Summary content.

### File Matching (vault-writer.ts)

4-level priority for matching a meeting attendee to a vault file:
1. Exact full name → file name
2. File name starts with topic's first name (prefer solo files)
3. File name starts with any attendee's first name
4. File name contains first name as word boundary

### Known Gotchas

**Zoom portal is Cvent-branded:** The user's Zoom portal may present with Cvent branding, but the underlying SPA structure and selectors are standard Zoom. Don't let the branding differences confuse scraping logic.

**Electron `loadURL` same-URL no-op (v1.1.7):** If `navigateScrapeWindow` is called with the same URL already loaded, Electron silently ignores the navigation. Fixed by detecting same-URL and forcing `webContents.reload()` + waiting for `did-finish-load`. This caused Phase 6 (delete) to silently fail when Phase 1 (list) left the window on page 2 with 0 rows.

**Delete button aria-label varies:** The delete button on the detail page may use aria-label `"delete meeting summary"`, `"Delete"`, or just text `"Delete"`. Use broad matching (text includes `'delete'` + length < 20). Confirmation dialog button is `"Move to Trash"` — match only that, not `"delete"`, to avoid hitting the still-visible Delete button before the dialog appears.

**`resolveNavId` cell matching:** Strip all non-digits (`/\D/g`) when comparing scraped cell text to meeting ID — not just spaces/hyphens.

**`instanceKey` must include time (v1.1.16):** `instanceKey` is used as the dedup key for pre-fetch and summary cache. It was `rawId__parsedDate` (date only), which collided for recurring meetings with the same meeting ID occurring on the same day. Fixed to `rawId__date` where `date` is the raw `dateHint` string (includes time), falling back to `parsedDate`. Without this, only the first of multiple same-day instances of a recurring meeting is fetched.

**Zoom API field caveats:**
- `finalSummaryString` — pre-formatted full summary string used by some meeting types (demos, webinars). Check with `typeof x === "string"` before `.trim()`.
- `boSummary` — may be boolean `false` (not a string). Always guard with `typeof x === "string"` before calling `.trim()` or treating as content.
- `hasSummaryContent()` checks: `overallSummary`, `summaryOverview`, `summary_overview`, `summaryItemVOs`, `stepList`, `next_steps`, `finalSummaryString`, `boSummary`.

### Persistent State

- `data.json` — User settings (subdomain, cookies, folder paths, filters)
- `obsidian-config.json` — Config state (scan timestamps for incremental sync)

### Build

`esbuild.config.mjs` compiles `src/main.ts` → `main.js` (CommonJS, externals: `obsidian`, `electron`, Node built-ins). Output files for installation: `main.js`, `manifest.json`, `styles.css`.

### Versioning

**⚠️ CRITICAL: Version must be kept in sync across BOTH `manifest.json` and `package.json`**

If these files diverge:
- `npm run build` will use the version from `package.json` in the build output
- The version shown to Obsidian users comes from `manifest.json`
- Users will see a mismatch between what `npm run build` reported and what Obsidian displays
- Future version bumps may be ignored if the build script version falls behind

**ALWAYS update version in BOTH files BEFORE building and committing.**

Use semantic versioning (`MAJOR.MINOR.PATCH`):

| Change type | Bump | Example |
|-------------|------|---------|
| Bug fix, incorrect behavior corrected | `PATCH` | 1.2.5 → 1.2.6 |
| New feature, new setting, new command | `MINOR` | 1.2.5 → 1.3.0 |
| Breaking change (incompatible settings, removed behavior) | `MAJOR` | 1.2.5 → 2.0.0 |

**Process:**
1. Identify the change type (bug fix, new feature, or breaking change)
2. Increment the appropriate version component in BOTH `manifest.json` and `package.json`
3. Build (`npm run build`)
4. Commit with the version bump included

Example:

```json
// manifest.json
{ "version": "1.1.1" }

// package.json
{ "version": "1.1.1" }
```
