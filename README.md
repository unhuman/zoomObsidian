# Zoom Meeting Summaries MCP Server

An MCP (Model Context Protocol) server that provides access to Zoom meeting summaries and writes them into an Obsidian vault. Uses Puppeteer-based browser authentication — on first use, a browser window opens for you to sign in to Zoom. Session cookies are saved to `~/.zoom-mcp/cookies.json` and reused automatically until they expire.

Configurable for any Zoom organization (e.g., `acme.zoom.us`, `yourcompany.zoom.us`).

## Prerequisites

1. **Node.js** 18+
2. A **Zoom account** with AI Companion meeting summaries enabled
3. An **Obsidian vault** with 1:1 note files named `First Last.md`

## Setup

```bash
npm install
npm run build
```

## Configuration

| Variable | Description | Default |
|---|---|---|
| `ZOOM_SUBDOMAIN` | Your org's Zoom vanity subdomain (e.g. `acme` for `acme.zoom.us`) | *(empty — uses zoom.us)* |
| `OBSIDIAN_VAULT_PATH` | Absolute path to your Obsidian vault root | _(required)_ |
| `VAULT_SUBFOLDER` | Subfolder within the vault containing 1:1 note folders (e.g. `MyOrg`) | *(empty — search directly under vault root)* |
| `ONE_ON_ONE_FOLDERS` | Comma-separated list of folder names holding 1:1 notes | `! One on Ones, ! One on Ones (Other)` |
| `SHARED_MEETINGS_FOLDER` | (Optional, v1.1.0+) Folder for meetings shared WITH you. If not set, shared meetings are not processed. | *(empty)* |

## Usage with Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "zoom-summaries": {
      "command": "node",
      "args": ["/absolute/path/to/zoomFetchMCP/build/index.js"],
      "env": {
        "ZOOM_SUBDOMAIN": "acme",
        "OBSIDIAN_VAULT_PATH": "/path/to/your/vault",
        "VAULT_SUBFOLDER": "MyOrg",
        "ONE_ON_ONE_FOLDERS": "! One on Ones,! One on Ones (Other)"
      }
    }
  }
}
```

## Usage with VS Code Copilot (Agent Mode)

Ensure `chat.agent.enabled` is turned on in VS Code settings. Then add `.vscode/mcp.json` to your workspace:

```json
{
  "servers": {
    "zoom-summaries": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/zoomFetchMCP/build/index.js"],
      "env": {
        "ZOOM_SUBDOMAIN": "acme",
        "OBSIDIAN_VAULT_PATH": "/path/to/your/vault",
        "VAULT_SUBFOLDER": "MyOrg",
        "ONE_ON_ONE_FOLDERS": "! One on Ones,! One on Ones (Other)"
      }
    }
  }
}
```

## Available Tools

### `zoom_login`

Opens a browser window for you to sign into Zoom. Call this first if you get authentication errors. Session cookies are saved to `~/.zoom-mcp/cookies.json` for automatic reuse.

### `list_meeting_summaries`

List meeting summaries with optional source and date filtering.

| Parameter | Type | Description |
|---|---|---|
| `source` | string (optional) | `owned` (default) or `shared` |
| `from` | string (optional) | Start date (e.g. `2025-01-01`) |
| `to` | string (optional) | End date (e.g. `2025-02-01`) |

### `get_meeting_summary`

Get the full AI-generated summary for a specific meeting.

| Parameter | Type | Description |
|---|---|---|
| `meeting_id` | string | The Zoom meeting ID |

### `write_summary_to_obsidian`

Fetch a Zoom meeting summary and write it into the matching Obsidian 1:1 note. Matches the note file by the first name in the meeting topic (e.g. `Amit:Howard` → `Amit Kumar.md`). After a successful write, deletes the summary from Zoom.

| Parameter | Type | Description |
|---|---|---|
| `meeting_id` | string | The numeric Zoom meeting ID (e.g. `96980348286`) |

### `write_all_summaries_to_obsidian`

Fetch every Zoom meeting summary and write each one to the matching Obsidian 1:1 note. Skips multi-person meetings (not 1:1s), skips meetings with no matching file, and skips duplicates already present in the note. After each successful write (including duplicates already in the vault), deletes the summary from Zoom.

| Parameter | Type | Description |
|---|---|---|
| `from` | string (optional) | Start date filter (e.g. `2026-01-01`) |
| `to` | string (optional) | End date filter (e.g. `2026-02-23`) |

## Obsidian Integration

### File matching

The tool looks for a vault note to write each summary into using this priority:

1. **Exact attendee name match** — a file named `First Last.md` matching an attendee
2. **Topic first-name prefix** — file whose name starts with the first name from the topic (e.g. `Amit` from `Amit:Howard`), preferring solo files over shared ones (`Amit Kumar.md` over `Amit Kumar + Bob.md`)
3. **Word-boundary search** — broader name search as fallback

Multi-person meetings (3+ participants, or `Name1:Name2:Name3` topic format) are **skipped** — only 1:1s are written.

### Note format

Summaries are inserted in the vault's tab-indented style, newest-first:

- **If the date already has manual notes**: Zoom content is appended below the existing notes for that day (with a blank line separator), without repeating the date header. Starts with `\tZoom AI Summary`.
- **If the date is new**: A standalone `YYYY-MM-DD - Zoom AI Summary` section is inserted at the correct chronological position.

### Caches

All caches are **in-memory only** and scoped to a single run. They exist solely to avoid fetching the same meeting twice within one execution (e.g. a meeting whose attendees were resolved in the attendee phase need not be re-fetched in the summary phase). No cache data is ever written to disk. `~/.zoom-mcp/` only holds `cookies.json` (session) and optionally `config.json` (vault path).

## Dry-Run / Live Script

`zoom-meetings-to-obsidian.mjs` is a standalone Node.js script for previewing and applying changes.

```bash
# Dry-run: copies vault files to /tmp/obsidian-preview and applies mutations there
node zoom-meetings-to-obsidian.mjs

# Write to real vault (no deletion)
node zoom-meetings-to-obsidian.mjs --update

# Write to real vault and delete summaries from Zoom
node zoom-meetings-to-obsidian.mjs --update --delete

# Add --debug to any command for verbose diagnostics (page elements, network requests, etc.)
node zoom-meetings-to-obsidian.mjs --update --delete --debug
```

`--delete` without `--update` is an error.

Output includes:
- A table of every meeting: topic, target file, and insert/duplicate/skip status
- A `Would delete from Zoom` list (dry-run) or live deletion results (`--do-it`)

Inspect dry-run results in `/tmp/obsidian-preview` before running with `--do-it`.

## How It Works

1. On first use (or when cookies expire), calling `zoom_login` opens a real browser window
2. You sign in to Zoom normally (SSO, password, etc. — any method works)
3. Session cookies are saved to `~/.zoom-mcp/cookies.json`
4. Subsequent calls use a headless browser with saved cookies to scrape the summaries page
5. Meeting summaries are written into Obsidian notes using chronological insertion
6. After writing, the summary is deleted from Zoom's AI Companion summary list
7. If cookies expire, call `zoom_login` again

## Development

```bash
npm run build  # Compile TypeScript → build/
npm run dev    # Watch mode (tsc --watch)
npm start      # Run the MCP server (stdio transport)
```
