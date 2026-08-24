# CLAUDE.md

Guidance for Claude Code and other AI assistants working on this project.

## Project Structure

This is a monorepo with two main packages:

- **`package.json`** — Main CLI/MCP server package (`zoom-meeting-summaries-mcp`)
- **`ObsidianPlugin/`** — Obsidian plugin package with its own `package.json` and `manifest.json`

## Build & Test

```bash
npm run build  # Compile TypeScript in root (src/ → build/)
npm run dev    # Watch mode
```

For the plugin, see `ObsidianPlugin/CLAUDE.md` for its own build and deployment instructions.

## Version Bumping — CRITICAL REQUIREMENT

**Every code commit must include version bumps in all three version files:**

1. `package.json` — version field
2. `ObsidianPlugin/package.json` — version field  
3. `ObsidianPlugin/manifest.json` — version field (must stay in sync with #2)

### Workflow

1. Make code changes
2. **Identify the change type** (bug fix, feature, breaking change)
3. **Bump version in ALL THREE files**:
   - Increment `PATCH` for bug fixes and small improvements
   - Increment `MINOR` for new features or settings
   - Increment `MAJOR` for breaking changes
4. Rebuild: `npm run build`
5. Commit with code + version bump together: `git add . && git commit -m "..."`

### Why This Matters

- **`ObsidianPlugin/manifest.json` and `ObsidianPlugin/package.json` must be in sync** — if they diverge, `npm run build` uses the package.json version, but Obsidian users see the manifest.json version. Users will see a mismatch and future version updates may be ignored.
- **All three files must be in sync** — ensures consistent versioning across both the CLI package and the plugin, making release notes and documentation cleaner.

### Example

```bash
# Make changes to src/zoom-browser.ts
vim src/zoom-browser.ts

# Bump all three versions (e.g., 1.2.10 → 1.2.11 for a bug fix)
sed -i '' 's/"version": "1.2.10"/"version": "1.2.11"/g' package.json ObsidianPlugin/package.json ObsidianPlugin/manifest.json

# Rebuild
npm run build

# Commit
git add .
git commit -m "fix: auto-delete stale cookies when session validation fails"
```

## Deployment

### CLI Package
- Version in `package.json`
- After bumping version and rebuilding, commit
- Users will pull and use `npm run build` locally

### Obsidian Plugin
- Version in **both** `ObsidianPlugin/package.json` and `ObsidianPlugin/manifest.json`
- After bumping versions and rebuilding with `npm run build`, copy:
  - `ObsidianPlugin/main.js`
  - `ObsidianPlugin/manifest.json`
  - `ObsidianPlugin/styles.css`
  
  to the user's plugin directory

See `ObsidianPlugin/CLAUDE.md` for detailed plugin deployment instructions.

## Useful Commands

```bash
npm run build              # TypeScript → build/
npm run dev                # Watch mode
npm start                  # Run MCP server

# Check versions
grep '"version"' package.json ObsidianPlugin/package.json ObsidianPlugin/manifest.json
```

## Common Tasks

### Adding a Bug Fix
1. Fix the bug in `src/` files
2. Bump `PATCH` version in all three version files
3. Rebuild and commit

### Adding a New Feature
1. Implement feature in `src/` files
2. Bump `MINOR` version in all three version files
3. Rebuild and commit

### Modifying Documentation Only
1. Edit `.md` files or CLAUDE.md
2. **No version bump needed**
3. Commit documentation changes separately

## Notes

- Do NOT create empty commits or version-only commits — version bumps always accompany code changes
- Do NOT amend commits after pushing to keep history clean (re-bump version if needed and create a new commit)
- If you accidentally commit without bumping versions, amend the commit to add the version bumps before pushing
