/**
 * Zoom authentication only — no syncing.
 *
 * Opens a real Chrome window via Puppeteer for the user to complete Zoom SSO
 * (including Okta), then saves the session cookies to ~/.zoom-mcp/cookies.json.
 *
 * This exists so the Obsidian plugin can drive authentication itself: the
 * plugin spawns this script as a child process, waits for it to exit, then
 * picks up the cookies it wrote. Okta's SSO does not complete inside an
 * embedded Electron BrowserWindow, so a real browser is required.
 *
 * Usage:
 *   node zoom-login.mjs [--subdomain acme] [--force]
 *
 *   --subdomain <sub>  Zoom vanity subdomain (e.g. "acme" for acme.zoom.us).
 *                      Falls back to ZOOM_SUBDOMAIN, then ~/.zoom-mcp/config.json.
 *   --force            Discard any existing cookies and re-authenticate.
 *
 * Exit codes: 0 = authenticated, 1 = failed.
 */
import { ZoomBrowser } from './build/zoom-browser.js';
import { readFile, rm } from 'fs/promises';
import { homedir } from 'os';
import path from 'path';

const CONFIG_DIR = path.join(homedir(), '.zoom-mcp');
const COOKIES_FILE = path.join(CONFIG_DIR, 'cookies.json');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const FORCE = process.argv.includes('--force');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}

async function resolveSubdomain() {
  const fromArg = argValue('--subdomain');
  if (fromArg) return fromArg;
  if (process.env.ZOOM_SUBDOMAIN) return process.env.ZOOM_SUBDOMAIN;
  try {
    const cfg = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
    if (cfg.zoomSubdomain) return cfg.zoomSubdomain;
  } catch {
    // No config file — fall through to the zoom.us default.
  }
  return '';
}

async function main() {
  const zoomSubdomain = await resolveSubdomain();

  if (FORCE) {
    try {
      await rm(COOKIES_FILE);
      console.error('Discarded existing cookies (--force).');
    } catch {
      // Nothing to remove.
    }
  }

  const browser = new ZoomBrowser({ zoomSubdomain });

  try {
    await browser.ensureAuthenticated();
  } finally {
    await browser.close().catch(() => {});
  }

  // ensureAuthenticated() resolves only once a session is established, and
  // interactiveLogin() throws if no cookies were captured — so reaching here
  // means cookies.json is on disk.
  const cookies = JSON.parse(await readFile(COOKIES_FILE, 'utf-8'));
  console.error(`Authentication complete — ${cookies.length} cookies saved to ${COOKIES_FILE}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`Authentication failed: ${e?.message ?? e}`);
    process.exit(1);
  });
