/**
 * Sync Zoom AI summaries into Obsidian.
 *
 * Dry-run (default):
 *   node zoom-meetings-to-obsidian.mjs
 *   Copies vault files to /tmp/obsidian-preview/, applies mutations there,
 *   and logs what WOULD be deleted from Zoom without actually deleting.
 *
 * Write to real vault:
 *   node zoom-meetings-to-obsidian.mjs --update
 *   Writes directly into the real vault (no deletion).
 *
 * Write + delete from Zoom:
 *   node zoom-meetings-to-obsidian.mjs --update --delete
 *   Writes to the real vault and deletes each summary from Zoom afterward.
 *   --delete without --update is an error.
 *
 * Verbose diagnostics:
 *   Add --debug to any of the above to enable detailed logging (page elements,
 *   network requests, CSRF probing, row-scan results).
 *
 * Config resolution (each setting tries env var → config.json → interactive prompt):
 *   OBSIDIAN_VAULT_PATH / vaultPath        — absolute path to vault root
 *   ZOOM_SUBDOMAIN      / zoomSubdomain    — e.g. "acme" for acme.zoom.us
 *   VAULT_SUBFOLDER     / vaultSubfolder   — subfolder within vault (e.g. "Meetings")
 *   ONE_ON_ONE_FOLDERS  / oneOnOneFolders  — comma-separated 1:1 folder names (in priority order)
 *
 * All caches are in-memory only — no data is persisted to disk between runs.
 * This ensures recurring meetings (same numeric ID, different content each instance)
 * are always fetched fresh. `~/.zoom-mcp/` only holds cookies.json and config.json.
 */
import { ZoomBrowser } from './build/zoom-browser.js';
import { ZoomSummariesClient } from './build/zoom-summaries.js';
import { ObsidianClient } from './build/obsidian-client.js';
import { readFile, writeFile, mkdir, copyFile, stat } from 'fs/promises';
import { homedir } from 'os';
import path from 'path';
import readline from 'readline';

const TMP_ROOT   = '/tmp/obsidian-preview';
const UPDATE     = process.argv.includes('--update');
const DELETE     = process.argv.includes('--delete');
const DEBUG      = process.argv.includes('--debug');
const HELP       = process.argv.includes('--help') || process.argv.includes('-h');
const FILTER     = (() => { const i = process.argv.indexOf('--filter'); return i !== -1 ? process.argv[i + 1] : null; })();

if (HELP) {
  process.stdout.write(`
Usage: node zoom-meetings-to-obsidian.mjs [options]

Options:
  (none)               Dry-run: copy vault files to /tmp/obsidian-preview and
                       preview changes without touching the real vault.
  --update             Write summaries directly into the real Obsidian vault.
  --delete             After writing, delete each summary from Zoom.
                       Requires --update.
  --filter <term>      Only process meetings whose topic contains <term>
                       (case-insensitive substring match).
  --debug              Enable verbose diagnostic logging: page element dumps,
                       network request traces, CSRF probing, row-scan results.
  -h, --help           Show this help message.

Config (each: env var → ~/.zoom-mcp/config.json → interactive prompt):
  OBSIDIAN_VAULT_PATH / vaultPath       Absolute path to Obsidian vault root.
  ZOOM_SUBDOMAIN      / zoomSubdomain   Zoom subdomain (e.g. "acme" for acme.zoom.us).
  VAULT_SUBFOLDER     / vaultSubfolder  Subfolder within vault containing 1:1 folders.
  ONE_ON_ONE_FOLDERS  / oneOnOneFolders Comma-separated 1:1 folder names (in priority order).
                                        Default: "! One on Ones, ! One on Ones (Other)"

All caches are in-memory only (no disk persistence between runs).
~/.zoom-mcp/ only holds cookies.json and config.json.

Examples:
  node zoom-meetings-to-obsidian.mjs
  node zoom-meetings-to-obsidian.mjs --update
  node zoom-meetings-to-obsidian.mjs --update --delete
  node zoom-meetings-to-obsidian.mjs --update --delete --filter Alice
  node zoom-meetings-to-obsidian.mjs --update --delete --debug
`);
  process.exit(0);
}

if (DELETE && !UPDATE) {
  process.stderr.write('Error: --delete requires --update. Aborting.\n');
  process.exit(1);
}
const CACHE_DIR   = path.join(homedir(), '.zoom-mcp');
const CONFIG_FILE = path.join(CACHE_DIR, 'config.json');

/**
 * Load config.json (returns {} if missing/invalid).
 */
async function loadConfig() {
  try { return JSON.parse(await readFile(CONFIG_FILE, 'utf-8')); } catch { return {}; }
}

/**
 * Persist a partial config update to config.json.
 */
async function saveConfig(updates) {
  await mkdir(CACHE_DIR, { recursive: true });
  const cfg = await loadConfig();
  Object.assign(cfg, updates);
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

/**
 * Resolve all runtime settings (vault path, subdomain, subfolder, 1:1 folders).
 * Priority for each: env var → config.json → interactive prompt.
 * Prompted values are offered for saving to config.json.
 */
async function resolveConfig() {
  const cfg = await loadConfig();
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));
  const updates = {};

  // --- vault path ---
  let vaultPath = process.env.OBSIDIAN_VAULT_PATH || cfg.vaultPath || '';
  if (!vaultPath.trim()) {
    while (!vaultPath.trim()) {
      vaultPath = await ask('Enter the absolute path to your Obsidian vault: ');
      vaultPath = vaultPath.trim().replace(/^~/, homedir());
    }
    const save = (await ask(`Save vault path "${vaultPath}"? [Y/n] `)).trim().toLowerCase();
    if (save !== 'n') updates.vaultPath = vaultPath;
  }

  // --- zoom subdomain ---
  let zoomSubdomain = process.env.ZOOM_SUBDOMAIN || cfg.zoomSubdomain || '';
  if (!zoomSubdomain.trim()) {
    zoomSubdomain = (await ask('Zoom subdomain (e.g. "acme" for acme.zoom.us, or leave blank for zoom.us): ')).trim();
    if (zoomSubdomain) {
      const save = (await ask(`Save subdomain "${zoomSubdomain}"? [Y/n] `)).trim().toLowerCase();
      if (save !== 'n') updates.zoomSubdomain = zoomSubdomain;
    }
  }

  // --- vault subfolder ---
  let vaultSubfolder = process.env.VAULT_SUBFOLDER ?? cfg.vaultSubfolder ?? null;
  if (vaultSubfolder === null) {
    vaultSubfolder = (await ask('Vault subfolder containing 1:1 folders (leave blank for vault root): ')).trim();
    const save = (await ask(`Save subfolder "${vaultSubfolder}"? [Y/n] `)).trim().toLowerCase();
    if (save !== 'n') updates.vaultSubfolder = vaultSubfolder;
  }

  // --- 1:1 folder names ---
  const defaultFolders = ['! One on Ones', '! One on Ones (Other)'];
  let oneOnOneFolders;
  const foldersRaw = process.env.ONE_ON_ONE_FOLDERS || '';
  if (foldersRaw) {
    oneOnOneFolders = foldersRaw.split(',').map(s => s.trim()).filter(Boolean);
  } else if (cfg.oneOnOneFolders) {
    oneOnOneFolders = cfg.oneOnOneFolders;
  } else {
    const defaultStr = defaultFolders.join(', ');
    const answer = (await ask(`1:1 folder names (comma-separated, priority order) [${defaultStr}]: `)).trim();
    oneOnOneFolders = answer ? answer.split(',').map(s => s.trim()).filter(Boolean) : defaultFolders;
    const save = (await ask(`Save folder names "${oneOnOneFolders.join(', ')}"? [Y/n] `)).trim().toLowerCase();
    if (save !== 'n') updates.oneOnOneFolders = oneOnOneFolders;
  }

  rl.close();
  if (Object.keys(updates).length > 0) {
    await saveConfig(updates);
    process.stderr.write(`Saved settings to ${CONFIG_FILE}\n`);
  }

  return { vaultPath, zoomSubdomain: zoomSubdomain || undefined, vaultSubfolder: vaultSubfolder || undefined, oneOnOneFolders };
}

const { vaultPath: VAULT_PATH, zoomSubdomain: ZOOM_SUBDOMAIN, vaultSubfolder: VAULT_SUBFOLDER, oneOnOneFolders: ONE_ON_ONE_FOLDERS } = await resolveConfig();
const TARGET = UPDATE ? VAULT_PATH : TMP_ROOT;

if (UPDATE && DELETE) {
  process.stderr.write('*** LIVE MODE: writing to real vault and deleting from Zoom ***\n');
} else if (UPDATE) {
  process.stderr.write('*** LIVE MODE: writing to real vault (add --delete to also delete from Zoom) ***\n');
} else {
  process.stderr.write('Dry-run mode (pass --update to write to real vault).\n');
}
// Both caches are in-memory only — never persisted to disk.
// They exist solely to avoid duplicate fetches within a single run
// (e.g. a meeting whose attendees are resolved in phase 2 need not be
// re-fetched in phase 5).  Recurring meetings reuse the same numeric ID
// for different instances, so a disk cache would serve stale data.
let attendeesCache = {}; // in-memory only
let summaryCache   = {}; // in-memory only

const browser         = new ZoomBrowser({ zoomSubdomain: ZOOM_SUBDOMAIN });
const summariesClient = new ZoomSummariesClient(browser, { debug: DEBUG });
const obsidianOptions = { vaultSubfolder: VAULT_SUBFOLDER, oneOnOneFolders: ONE_ON_ONE_FOLDERS };
const realObsidian    = new ObsidianClient(VAULT_PATH, obsidianOptions);
const allFiles        = await realObsidian.allFiles();

function isAmbiguousMatch(firstName) {
  if (!firstName) return false;
  return allFiles.filter(f => f.name.toLowerCase().startsWith(firstName.toLowerCase())).length > 1;
}

// Phase 1: list meetings
const t0       = Date.now();
const allMeetings = await summariesClient.listSummaries();

// Early exit if no meetings found
if (allMeetings.length === 0) {
  process.stderr.write('No meetings found. Session may have expired, Zoom returned an empty list, or no summaries exist in your configured date range.\n');
  await browser.close();
  process.exit(0);
}

const meetings = FILTER
  ? allMeetings.filter(m => (m.meeting_topic ?? m.column_1 ?? '').toLowerCase().includes(FILTER.toLowerCase()))
  : allMeetings;
process.stderr.write(`Fetched ${allMeetings.length} meetings${FILTER ? `, ${meetings.length} match filter "${FILTER}"` : ''}.\n`);

// Phase 2: resolve attendees for ambiguous/unmatched (uses cache)
const attendeesMap     = new Map(Object.entries(attendeesCache));
const toFetchAttendees = new Map();

for (const m of meetings) {
  const topic      = (m.meeting_topic ?? m.column_1 ?? '').replace(/^Select /, '');
  const rawId      = (m.column_2 ?? '').replace(/[\s-]/g, '');
  const topicFirst = topic.split(':')[0].trim();
  const isCandidate = (topic.includes(':') && !topicFirst.includes(' ') && topicFirst.toLowerCase() !== 'zoom')
    || /^zoom meeting$/i.test(topic);
  if (!isCandidate || !rawId || attendeesMap.has(rawId) || toFetchAttendees.has(rawId)) continue;
  const quickMatch = allFiles.find(f => f.name.toLowerCase().startsWith(topicFirst.toLowerCase()));
  if (!quickMatch || isAmbiguousMatch(topicFirst)) toFetchAttendees.set(rawId, topic);
}

for (const [rawId, topic] of toFetchAttendees) {
  process.stderr.write(`  [attendees] ${topic} (${rawId})...\n`);
  try {
    const data  = await summariesClient.getSummary(rawId);
    const names = [];
    for (const item of data?.nextStepItems ?? [])
      for (const a of item.assignees ?? [])
        if (a.username && !names.includes(a.username)) names.push(a.username);
    attendeesMap.set(rawId, names);
    attendeesCache[rawId] = names; // within-run dedup
    if (!summaryCache[rawId]) summaryCache[rawId] = data;
  } catch (e) {
    process.stderr.write(`  Error: ${e.message}\n`);
    attendeesMap.set(rawId, []);
  }
}

// Phase 3: build plan
const plan = [];
for (const m of meetings) {
  const topic      = (m.meeting_topic ?? m.column_1 ?? '').replace(/^Select /, '');
  const rawId      = (m.column_2 ?? '').replace(/[\s-]/g, '');
  const date       = (m.column_4 ?? '').trim();
  const attendees  = attendeesMap.get(rawId) ?? [];
  const parsedDate = realObsidian.parseMeetingDate(date);
  // Skip multi-person meetings (2+ non-Howard names in topic or attendees)
  const otherAttendees = attendees.filter(n => !n.toLowerCase().includes('howard') && !/\d/.test(n));
  const topicNonHoward = topic.split(':').map(s => s.trim()).filter(s => s && /[a-zA-Z]{2,}/.test(s) && !s.toLowerCase().includes('howard'));
  if (otherAttendees.length > 1 || topicNonHoward.length > 1) {
    plan.push({ topic, rawId, parsedDate, vaultFile: null, tmpFile: undefined, action: 'skip' });
    continue;
  }

  const vaultFile  = await realObsidian.findPersonFile(topic, attendees.length ? attendees : undefined);
  let tmpFile, action;
  if (vaultFile) {
    tmpFile = path.join(TARGET, path.relative(VAULT_PATH, vaultFile));
    action  = 'insert';
  } else {
    const suggested = realObsidian.suggestNewFilePath(topic, attendees.length ? attendees : undefined);
    if (!suggested) { action = 'skip'; }
    else { tmpFile = path.join(TARGET, path.relative(VAULT_PATH, suggested)); action = 'create'; }
  }
  plan.push({ topic, rawId, parsedDate, vaultFile, tmpFile, action });
}

const active  = plan.filter(p => p.action !== 'skip');
const inserts = active.filter(p => p.action === 'insert');
const creates = active.filter(p => p.action === 'create');
process.stderr.write(`\nPlan: ${inserts.length} insert, ${creates.length} create, ${plan.length - active.length} skip.\n`);

// Phase 4: copy vault files → /tmp (dry-run only; skipped in live mode)
if (!UPDATE) {
  process.stderr.write(`\nCopying to ${TARGET}...\n`);
  const copied = new Set();
  for (const { vaultFile, tmpFile } of inserts) {
    if (copied.has(tmpFile)) continue;
    await mkdir(path.dirname(tmpFile), { recursive: true });
    try { await stat(tmpFile); process.stderr.write(`  exists   ${path.relative(VAULT_PATH, vaultFile)}\n`); }
    catch { await copyFile(vaultFile, tmpFile); process.stderr.write(`  copied   ${path.relative(VAULT_PATH, vaultFile)}\n`); }
    copied.add(tmpFile);
  }
  process.stderr.write(`Processed ${copied.size} unique files.\n`);
}

// Phase 5: fetch full summaries (cached by ID)
process.stderr.write(`\nFetching full summaries...\n`);
const toFetchFull = new Map();

// Helper: check if a cached summary actually has content
const hasCachedContent = (rawId) => {
  const s = summaryCache[rawId];
  if (!s) return false;
  // Check all field names the API may use (overallSummary, summaryOverview, summary_overview)
  if (s.overallSummary?.trim()) return true;
  if (s.summaryOverview?.trim()) return true;
  if (s.summary_overview?.trim()) return true;
  if (Array.isArray(s.summaryItemVOs) && s.summaryItemVOs.length > 0) return true;
  if (Array.isArray(s.stepList) && s.stepList.length > 0) return true;
  if (Array.isArray(s.next_steps) && s.next_steps.length > 0) return true;
  return false;
};

for (const { rawId, topic } of active)
  if (rawId && !hasCachedContent(rawId) && !toFetchFull.has(rawId))
    toFetchFull.set(rawId, topic);

// Pre-populate navIdCache in a single list traversal for all meetings
// that need fetching and aren't already in the persisted nav cache.
if (toFetchFull.size > 0) {
  // Pre-populate navIdCache in a single list traversal (in-memory only; not persisted).
  process.stderr.write(`  Pre-fetching nav IDs for ${toFetchFull.size} meetings (1 list traversal)...\n`);
  await summariesClient.prefetchNavIds([...toFetchFull.keys()]);
}

for (const [rawId, topic] of toFetchFull) {
  process.stderr.write(`  [summary] ${topic} (${rawId})...\n`);
  try { summaryCache[rawId] = await summariesClient.getSummary(rawId); }
  catch (e) { process.stderr.write(`  Error: ${e.message}\n`); }
}
process.stderr.write(`Fetched ${toFetchFull.size} new (${Object.keys(summaryCache).length} total in-run cache).\n`);

// Phase 6: write summaries
process.stderr.write(`\nWriting summaries...\n`);
for (const { tmpFile } of creates) if (tmpFile) await mkdir(path.dirname(tmpFile), { recursive: true });

const targetObsidian = new ObsidianClient(TARGET, obsidianOptions);
let written = 0, skipped = 0, errors = 0;
const results = [];
const toDelete = []; // entries to delete from Zoom (written + duplicates)

for (const { topic, rawId, parsedDate, tmpFile, action } of active) {
  if (!tmpFile || !rawId) { results.push({ topic, status: 'SKIP (no file)' }); skipped++; continue; }
  const summary = summaryCache[rawId];
  if (!summary) { results.push({ topic, status: 'SKIP (no summary)' }); skipped++; continue; }
  try {
    const r = await targetObsidian.insertSummary(tmpFile, parsedDate, summary);
    if (r.inserted) {
      written++;
      toDelete.push({ topic, rawId });
      results.push({ topic, file: path.relative(TARGET, tmpFile), status: `✓ ${action} @ ${parsedDate} (${r.position})` });
    } else {
      skipped++;
      toDelete.push({ topic, rawId });
      results.push({ topic, file: path.relative(TARGET, tmpFile), status: `= duplicate @ ${parsedDate}` });
    }
  } catch (e) {
    errors++;
    results.push({ topic, file: path.relative(TARGET, tmpFile), status: `\u2717 ERROR: ${e.message}` });
  }
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

// Print results table
const fileColHeader = UPDATE ? 'Vault relative path' : '/tmp/obsidian-preview relative path';
const cW = {
  topic:  Math.max(12, ...results.map(r => r.topic.length)),
  file:   Math.max(4,  ...results.map(r => (r.file ?? '').length)),
  status: Math.max(6,  ...results.map(r => r.status.length)),
};
const divider = `${'-'.repeat(cW.topic+2)}+${'-'.repeat(cW.file+2)}+${'-'.repeat(cW.status+2)}`;
console.log(`\n ${'Meeting Topic'.padEnd(cW.topic)} | ${fileColHeader.padEnd(cW.file)} | Status`);
console.log(divider);
for (const r of results)
  console.log(` ${r.topic.padEnd(cW.topic)} | ${(r.file ?? '\u2014').padEnd(cW.file)} | ${r.status}`);

console.log(`\nDone: ${written} written, ${skipped} skipped/duplicate, ${errors} errors. (${elapsed}s)`);
if (!UPDATE) console.log(`Inspect: ${TARGET}`);

// Delete from Zoom (--update --delete) or log what would be deleted (dry-run / --update only)
if (toDelete.length > 0) {
  if (UPDATE && DELETE) {
    // Do NOT deduplicate by rawId here — recurring meetings reuse the same base ID
    // for different instances, so each entry in toDelete may be a distinct meeting
    // that needs its own delete call. deleteSummary treats "not found" as success
    // (already gone), so a spurious second call for the same ID is harmless.
    process.stderr.write(`\nDeleting ${toDelete.length} summaries from Zoom...\n`);
    let deleted = 0, deleteFailed = 0;
    let deleteIdx = 0;
    for (const { topic, rawId } of toDelete) {
      deleteIdx++;
      const label = `${deleteIdx}/${toDelete.length}`;
      try {
        const r = await summariesClient.deleteSummary(rawId, { label });
        process.stderr.write(`  ${r.success ? '\u2713' : '\u2717'} ${rawId}  ${topic}: ${r.message}\n`);
        if (r.success) deleted++; else deleteFailed++;
      } catch (e) {
        process.stderr.write(`  \u2717 ${rawId}  ${topic}: ${e.message}\n`);
        deleteFailed++;
      }
    }
    console.log(`Deleted: ${deleted}, failed: ${deleteFailed}.`);
  } else if (UPDATE) {
    console.log(`\nNot deleting from Zoom (pass --delete to also remove summaries): ${new Set(toDelete.map(d => d.rawId)).size} unique IDs.`);
  } else {
    console.log(`\nWould delete from Zoom (${toDelete.length} entries, ${new Set(toDelete.map(d => d.rawId)).size} unique IDs):`);
    for (const { topic, rawId } of toDelete)
      console.log(`  - ${rawId}  ${topic}`);
  }
}

await browser.close();
process.exit(errors > 0 ? 1 : 0);
