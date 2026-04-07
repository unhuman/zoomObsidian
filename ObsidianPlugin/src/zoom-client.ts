/**
 * Zoom meeting summaries client — Electron BrowserWindow + REST API.
 *
 * The Zoom meeting summary page is a SPA — the table is populated by
 * client-side JavaScript. Plain HTTP requests return empty HTML.
 * For listing, nav-ID resolution, and deletion we use a hidden Electron
 * BrowserWindow (with the authenticated session partition) to load the SPA,
 * wait for it to render, then interact via webContents.executeJavaScript().
 *
 * Summary detail uses direct REST endpoints via nodeRequest().
 *
 * All caches (navIdCache) are in-memory only.
 */

import type { ZoomAuth } from "./zoom-auth";
import type {
  MeetingSummaryItem,
  MeetingSummaryDetail,
  NavIdEntry,
} from "./types";
import { nodeRequest, type SimpleResponse } from "./node-http";

// Electron is externalized by esbuild — available at runtime in Obsidian desktop
// eslint-disable-next-line @typescript-eslint/no-var-requires
const electron = require("electron");
const { BrowserWindow: ElectronBrowserWindow, session: electronSession } = electron.remote;

export class ZoomClient {
  private auth: ZoomAuth;
  private debug: boolean;
  private navIdCache = new Map<string, NavIdEntry>();
  /** Hidden BrowserWindow used for SPA scraping. */
  private scrapeWin: InstanceType<typeof ElectronBrowserWindow> | null = null;
  /** Zoom account ID — used by the participants report API. Set via setAccountId(). */
  private _accountId: string = '';

  constructor(auth: ZoomAuth, opts?: { debug?: boolean }) {
    this.auth = auth;
    this.debug = opts?.debug ?? false;
  }

  setDebug(debug: boolean): void {
    this.debug = debug;
  }

  /** Set the Zoom account ID used by the participants report API. */
  setAccountId(id: string): void {
    this._accountId = id.trim();
  }

  private dbg(...args: unknown[]): void {
    if (this.debug) console.log("[zoom-client]", ...args);
  }

  /** Expose the in-memory nav-ID cache for diagnostics. */
  getNavCache(): Record<string, NavIdEntry> {
    return Object.fromEntries(this.navIdCache);
  }

  private navCacheKey(numericId: string, sourceType: 'owned' | 'shared' = 'owned', dateHint?: string): string {
    return dateHint ? `${sourceType}:${numericId}:${dateHint}` : `${sourceType}:${numericId}`;
  }

  private normalizeTopic(s: string): string {
    return s.toLowerCase().replace(/\s+/g, " ").trim();
  }

  // ─── Hidden BrowserWindow for SPA scraping ────────────────────

  /**
   * Get or create a hidden BrowserWindow with the authenticated session
   * partition. Cookies are pre-loaded so the SPA receives an authenticated
   * session without user interaction.
   */
  private async getOrCreateScrapeWindow(): Promise<InstanceType<typeof ElectronBrowserWindow>> {
    if (this.scrapeWin && !this.scrapeWin.isDestroyed()) {
      return this.scrapeWin;
    }

    const partition = "persist:zoom-obsidian";
    const ses = electronSession.fromPartition(partition);

    // Pre-load cookies into the Electron session
    const cookies = this.auth.getSerializedCookies();
    for (const c of cookies) {
      try {
        await ses.cookies.set({
          url: `https://${c.domain.replace(/^\./, "")}${c.path}`,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          expirationDate: c.expirationDate,
        });
      } catch { /* ignore individual cookie failures */ }
    }

    this.scrapeWin = new ElectronBrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    return this.scrapeWin;
  }

  /** Close the scrape window if it exists. */
  closeScrapeWindow(): void {
    if (this.scrapeWin && !this.scrapeWin.isDestroyed()) {
      this.scrapeWin.close();
    }
    this.scrapeWin = null;
  }

  /**
   * Open a VISIBLE BrowserWindow pointed at the meeting summary SPA and
   * return a diagnostic report of what DOM structure is present.
   *
   * Use this when the scraping pipeline stops working — the report shows
   * which selectors matched (or didn't), the hash-based route, and raw
   * class names from the tables so you can update the selectors.
   */
  async diagnoseSpa(): Promise<string> {
    const partition = "persist:zoom-obsidian";
    const ses = electronSession.fromPartition(partition);

    // Pre-load cookies
    const cookies = this.auth.getSerializedCookies();
    for (const c of cookies) {
      try {
        await ses.cookies.set({
          url: `https://${c.domain.replace(/^\./, "")}${c.path}`,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          expirationDate: c.expirationDate,
        });
      } catch { /* ignore */ }
    }

    const win = new ElectronBrowserWindow({
      show: true,
      width: 1280,
      height: 900,
      title: "Zoom SPA Diagnostics — Obsidian Plugin",
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    const url = `${this.auth.baseUrl}/user/meeting/summary#/list`;
    console.log("[zoom-client][diagnose] Loading:", url);
    await win.loadURL(url);

    // Wait up to 20s for ANYTHING to render
    const start = Date.now();
    while (Date.now() - start < 20000) {
      const hasContent = await win.webContents.executeJavaScript(
        `document.querySelectorAll('tbody tr, .zm-table__body-wrapper, [class*="table"], [class*="summary"], [class*="meeting"]').length > 0`
      );
      if (hasContent) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    // Give the SPA a bit more time to fully render
    await new Promise((r) => setTimeout(r, 1000));

    const report = await win.webContents.executeJavaScript(`
      (function() {
        var out = [];
        var href = window.location.href;
        var hash = window.location.hash;
        out.push("=== URL ===");
        out.push("href: " + href);
        out.push("hash: " + hash);

        out.push("\\n=== Known Selectors ===");
        var selectors = [
          '.zm-table__body-wrapper',
          '.zm-table__body',
          '.zm-table__body-wrapper tbody tr',
          '.zm-table__body tbody tr',
          'button.topic-link',
          'a.topic-link',
          '.zm-pager',
          '.zm-pager li.number.active',
          'button.btn-next',
          'button.btn-prev',
          '.zm-table__empty',
          '.zm-empty-state',
          '.empty-state',
        ];
        selectors.forEach(function(sel) {
          var count = document.querySelectorAll(sel).length;
          out.push((count > 0 ? "  ✓ " : "  ✗ ") + sel + " → " + count);
        });

        out.push("\\n=== All tables ===");
        var tables = document.querySelectorAll('table');
        out.push("table count: " + tables.length);
        tables.forEach(function(t, i) {
          var rows = t.querySelectorAll('tbody tr').length;
          var cls = t.className || '(no class)';
          var parentCls = (t.parentElement && t.parentElement.className) || '(no parent class)';
          out.push("  table[" + i + "] class=" + cls + " parentClass=" + parentCls + " rows=" + rows);
        });

        out.push("\\n=== Elements with 'table' in class ===");
        var tableEls = document.querySelectorAll('[class*="table"]');
        var seen = new Set();
        tableEls.forEach(function(el) {
          var cls = el.className;
          if (!seen.has(cls)) {
            seen.add(cls);
            var rows = el.querySelectorAll('tbody tr, tr').length;
            out.push("  " + el.tagName.toLowerCase() + '.' + cls.split(' ').join('.') + " rows=" + rows);
          }
        });

        out.push("\\n=== Elements with 'pager' or 'pagination' in class ===");
        var pagerEls = document.querySelectorAll('[class*="pager"], [class*="pagination"]');
        pagerEls.forEach(function(el) {
          out.push("  " + el.tagName.toLowerCase() + '.' + el.className.split(' ').join('.'));
        });

        out.push("\\n=== Buttons with 'next', 'prev', 'delete', 'topic' in class/aria ===");
        var btns = document.querySelectorAll('button, [role="button"]');
        btns.forEach(function(btn) {
          var cls = (btn.className || '').toLowerCase();
          var lbl = (btn.getAttribute('aria-label') || '').toLowerCase();
          var txt = (btn.textContent || '').trim().toLowerCase().substring(0, 40);
          if (cls.includes('next') || cls.includes('prev') || cls.includes('topic') || cls.includes('delete') ||
              lbl.includes('next') || lbl.includes('prev') || lbl.includes('delete') || lbl.includes('topic')) {
            out.push("  button class=" + btn.className + " aria-label=" + btn.getAttribute('aria-label') + " text=" + txt);
          }
        });

        out.push("\\n=== Body outer HTML (first 3000 chars) ===");
        out.push((document.body.outerHTML || '').substring(0, 3000));

        return out.join("\\n");
      })()
    `);

    console.log("[zoom-client][diagnose]\n" + report);

    // Phase 2: click the first topic button and capture the resulting URL
    const clickReport = await win.webContents.executeJavaScript(`
      (async function() {
        var btn = document.querySelector('button.topic-link');
        if (!btn) return "No topic-link button found";
        var beforeHash = window.location.hash;
        var beforeHref = window.location.href;
        btn.click();
        // Wait up to 8s for URL to change
        var start = Date.now();
        while (Date.now() - start < 8000) {
          await new Promise(function(r) { setTimeout(r, 200); });
          if (window.location.href !== beforeHref) break;
        }
        return JSON.stringify({
          before: { href: beforeHref, hash: beforeHash },
          after: { href: window.location.href, hash: window.location.hash },
          hashStartsWithDetail: window.location.hash.startsWith('#/detail'),
        });
      })()
    `);
    console.log("[zoom-client][diagnose] Click test:", clickReport);

    // Phase 3: if #/detail was reached, try the REST API
    let apiReport = "(skipped — hash did not change to #/detail)";
    try {
      const clickData = JSON.parse(clickReport as string);
      if (clickData.hashStartsWithDetail) {
        const hash = clickData.after.hash as string;
        const params = new URLSearchParams(hash.replace(/^#\/detail\??/, ""));
        const meetingId = params.get("meetingId");
        const summaryId = params.get("summaryId");
        if (meetingId && summaryId) {
          const apiUrl = `${this.auth.baseUrl}/rest/meeting/web_view_summary?meetingId=${encodeURIComponent(meetingId)}&summaryId=${encodeURIComponent(summaryId)}`;
          const apiResult = await win.webContents.executeJavaScript(`
            fetch(${JSON.stringify(apiUrl)}, { credentials: 'include', headers: { Accept: 'application/json' } })
              .then(function(r) { return r.json(); })
              .then(function(j) { return JSON.stringify({ status: j.status, resultKeys: j.result ? Object.keys(j.result) : null, raw: JSON.stringify(j).substring(0, 500) }); })
              .catch(function(e) { return "fetch error: " + e.message; })
          `);
          apiReport = `meetingId=${meetingId} summaryId=${summaryId}\nAPI: ${apiResult}`;
        } else {
          apiReport = `Hash is #/detail but no meetingId/summaryId params: ${hash}`;
        }
      }
    } catch (e) { apiReport = "parse error: " + (e as Error).message; }
    console.log("[zoom-client][diagnose] API test:", apiReport);

    const fullReport = report + "\n\n=== Click test ===\n" + clickReport + "\n\n=== API test ===\n" + apiReport;
    // Leave the window open so the user can inspect it
    return fullReport;
  }

  /**
   * Navigate the hidden window to a URL and wait for it to finish loading.
   * If the target URL is the same as the currently loaded URL, Electron's
   * loadURL() is a no-op (the page stays in whatever state it's in, e.g.
   * stuck on page 2 after pagination). Force a hard reload in that case
   * so the SPA resets to its initial state.
   */
  private async navigateScrapeWindow(url: string): Promise<void> {
    const win = await this.getOrCreateScrapeWindow();
    const currentUrl = win.webContents.getURL();
    if (currentUrl === url) {
      // Same URL — force a hard reload to reset SPA state
      win.webContents.reload();
      await new Promise<void>((resolve) => {
        win.webContents.once("did-finish-load", resolve);
      });
    } else {
      await win.loadURL(url);
    }
  }

  /**
   * Reset the SPA list pagination to page 1. After listSummaries pages through
   * all pages, the SPA stays on the last page. Subsequent resolveNavId calls
   * must start from page 1 to find meetings sorted newest-first.
   */
  private async resetToFirstPage(): Promise<void> {
    const pageInfo = await this.execInWindow<{ active: string | null; hasFirst: boolean }>(`
      (function() {
        var active = document.querySelector('.zm-pager li.number.active');
        var p = active ? (active.getAttribute('data-page') || active.textContent.trim()) : null;
        var first = document.querySelector('.zm-pager li.number[data-page="1"]');
        return { active: p, hasFirst: !!first };
      })()
    `);
    if (pageInfo.active && pageInfo.active !== '1') {
      this.dbg(`[resetToFirstPage] Currently on page ${pageInfo.active}, resetting to 1...`);
      if (pageInfo.hasFirst) {
        await this.execInWindow<void>(`document.querySelector('.zm-pager li.number[data-page="1"]').click()`);
      } else {
        // Click btn-prev repeatedly until we're on page 1
        let safety = 20;
        while (safety-- > 0) {
          const cur = await this.execInWindow<string>(`
            (function() {
              var a = document.querySelector('.zm-pager li.number.active');
              return a ? (a.getAttribute('data-page') || a.textContent.trim()) : '1';
            })()
          `);
          if (cur === '1') break;
          const hasPrev = await this.execInWindow<boolean>(`
            (function() {
              var btn = document.querySelector('button.btn-prev');
              return !!btn && !btn.disabled;
            })()
          `);
          if (!hasPrev) break;
          await this.execInWindow<void>(`document.querySelector('button.btn-prev').click()`);
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      // Wait for rows to re-render after page change
      await this.waitForCondition(`
        (function() {
          var a = document.querySelector('.zm-pager li.number.active');
          return !a || (a.getAttribute('data-page') || a.textContent.trim()) === '1';
        })()
      `, 10000);
      await new Promise((r) => setTimeout(r, 300));
      this.dbg(`[resetToFirstPage] Now on page 1.`);
    }
  }

  /**
   * Execute JavaScript in the hidden window's page context.
   */
  private async execInWindow<T>(code: string): Promise<T> {
    const win = await this.getOrCreateScrapeWindow();
    return win.webContents.executeJavaScript(code) as Promise<T>;
  }

  /**
   * Poll the SPA until a condition is met or timeout expires.
   * `conditionCode` should be a JS expression that returns a truthy value when ready.
   */
  private async waitForCondition(conditionCode: string, timeoutMs = 15000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ready = await this.execInWindow<boolean>(conditionCode);
      if (ready) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }

  // ─── Helpers ──────────────────────────────────────────────────

  /**
   * Make an authenticated fetch to Zoom, automatically attaching cookies.
   * Throws on network errors or if the response indicates an auth redirect.
   */
  private async zoomFetch(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {}
  ): Promise<SimpleResponse> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    headers["Cookie"] = this.auth.getCookieHeader();
    if (!headers["Accept"]) headers["Accept"] = "text/html, application/json";

    const res = await nodeRequest(url, {
      method: init.method,
      headers,
      body: init.body,
      followRedirects: false,
    });

    // Zoom redirects to /signin on expired session
    const loc = res.headers["location"] ?? "";
    if (loc.includes("/signin") || loc.includes("/login") || loc.includes("/sso")) {
      throw new Error("Zoom session expired — please log in again.");
    }

    // Follow non-login redirects
    if (res.status >= 300 && res.status < 400 && loc) {
      return this.zoomFetch(new URL(loc, url).toString(), init);
    }

    return res;
  }

  /**
   * Fetch a page's HTML and parse it into a DOM Document using DOMParser
   * (available in Obsidian's Electron renderer).
   */
  private async fetchDom(url: string): Promise<Document> {
    const res = await this.zoomFetch(url);
    const parser = new DOMParser();
    return parser.parseFromString(res.body, "text/html");
  }

  /**
   * Extract CSRF token from a fetched DOM, checking all Zoom-known locations.
   */
  private extractCsrf(doc: Document): string | null {
    // Meta tags
    for (const name of ["_csrf", "csrf-token", "csrf_token", "x-csrf-token"]) {
      const el = doc.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
      if (el?.content) return el.content;
    }
    // Hidden inputs
    const input = doc.querySelector<HTMLInputElement>(
      'input[name="_csrf"], input[name="csrf_token"]'
    );
    if (input?.value) return input.value;
    // Script globals — scan for common patterns in inline scripts
    for (const script of Array.from(doc.querySelectorAll("script"))) {
      const text = script.textContent ?? "";
      const match = text.match(
        /(?:_csrf|csrfToken|csrf_token)\s*[:=]\s*["']([^"']+)["']/
      );
      if (match) return match[1];
    }
    return null;
  }

  // ─── List Summaries (BrowserWindow SPA scraping) ───────────────

  /**
   * List all meeting summaries by loading the SPA in a hidden BrowserWindow,
   * waiting for the table to render, and extracting rows via executeJavaScript.
   * Paginates by clicking the Next button.
   *
   * @param sourceType - 'owned' for user's own meetings (#/list), 'shared' for meetings shared with user (#/summaryShare)
   */
  async listSummaries(
    sourceType: 'owned' | 'shared' = 'owned',
    options: { from?: string; to?: string } = {}
  ): Promise<MeetingSummaryItem[]> {
    const baseUrl = this.auth.baseUrl;
    const hashFragment = sourceType === 'shared' ? 'summaryShare' : 'list';
    let url = `${baseUrl}/user/meeting/summary#/${hashFragment}`;
    if (options.from || options.to) {
      const u = new URL(`${baseUrl}/user/meeting/summary`);
      if (options.from) u.searchParams.set("from", options.from);
      if (options.to) u.searchParams.set("to", options.to);
      url = `${u.toString()}#/${hashFragment}`;
    }

    this.dbg("Navigating scrape window to:", url);
    await this.navigateScrapeWindow(url);

    // Defensive: some loads land on the default list route even when a hash was supplied.
    // Force the intended route and give the SPA time to react.
    const expectedHash = sourceType === "shared" ? "#/summaryShare" : "#/list";
    const currentHash = await this.execInWindow<string>("window.location.hash || ''");
    if (!currentHash.startsWith(expectedHash)) {
      this.dbg(`Route mismatch after load (have "${currentHash}", want "${expectedHash}"). Forcing hash.`);
      await this.execInWindow<void>(`window.location.hash = ${JSON.stringify(expectedHash)}`);
      await new Promise((r) => setTimeout(r, 800));
    }

    // Wait for the SPA table to render
    const tableReady = await this.waitForCondition(`
      !!(document.querySelector('.zm-table__body-wrapper tbody tr') ||
         document.querySelector('.zm-table__body tbody tr') ||
         document.querySelector('.zm-table__empty, .zm-empty-state, .empty-state'))
    `, 15000);

    if (!tableReady) {
      this.dbg("Table never appeared — checking page content");
      const pageInfo = await this.execInWindow<string>(`
        (function() {
          var main = document.querySelector('main, #content, .content, [role=main]') || document.body;
          var hash = window.location.hash || '';
          var href = window.location.href || '';
          var tables = document.querySelectorAll('table').length;
          var rows = document.querySelectorAll('tbody tr').length;
          var text = (main.textContent || '').trim().substring(0, 2000);
          return JSON.stringify({ hash: hash, href: href, tables: tables, rows: rows, text: text });
        })()
      `);
      this.dbg("Page diagnostics:", pageInfo);
      return [];
    }

    const allSummaries: MeetingSummaryItem[] = [];

    // The scrapeRows code runs inside the BrowserWindow page context
    const scrapeRowsCode = `
      (function() {
        var results = [];
        var bodyTable =
          document.querySelector('.zm-table__body-wrapper table') ||
          document.querySelector('.zm-table__body table') ||
          document.querySelector('table:last-of-type');
        if (!bodyTable) return results;
        var rows = bodyTable.querySelectorAll('tbody tr');
        rows.forEach(function(row) {
          var cells = row.querySelectorAll('td');
          var topicBtn = row.querySelector('button.topic-link, a.topic-link, td:first-child button, td:first-child a');
          var item = {};
          if (topicBtn) item.meeting_topic = topicBtn.textContent.trim();
          cells.forEach(function(cell, i) {
            var text = cell.textContent.trim();
            if (text) item['column_' + i] = text;
          });
          if (!item.meeting_topic && cells.length > 0) {
            item.meeting_topic = (cells[0].textContent || '').trim();
          }
          if (!item.meeting_id) {
            for (var j = 0; j < cells.length; j++) {
              var digits = ((cells[j].textContent || '')).replace(/\D/g, '');
              if (digits.length >= 9 && digits.length <= 14) {
                item.meeting_id = digits;
                break;
              }
            }
          }
          if (Object.keys(item).length > 0) results.push(item);
        });
        return results;
      })()
    `;

    while (true) {
      const rows = await this.execInWindow<MeetingSummaryItem[]>(scrapeRowsCode);
      this.dbg(`Scraped ${rows.length} rows from current page`);
      allSummaries.push(...rows);

      // Check for next page
      const hasNext = await this.execInWindow<boolean>(`
        (function() {
          var btn = document.querySelector('button.btn-next');
          return !!btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
        })()
      `);
      if (!hasNext) break;

      // Note current page number
      const currentPage = await this.execInWindow<string | null>(`
        (function() {
          var active = document.querySelector('.zm-pager li.number.active');
          return active ? (active.getAttribute('data-page') || active.textContent.trim()) : null;
        })()
      `);

      // Click next
      await this.execInWindow<void>(`document.querySelector('button.btn-next').click()`);

      // Wait for page indicator to change
      const pageChanged = await this.waitForCondition(`
        (function() {
          var active = document.querySelector('.zm-pager li.number.active');
          var p = active ? (active.getAttribute('data-page') || active.textContent.trim()) : null;
          return !!p && p !== ${JSON.stringify(currentPage)};
        })()
      `, 15000);

      if (!pageChanged) {
        this.dbg("Page did not change after clicking next — stopping pagination");
        break;
      }

      // Brief settle for Vue reactivity
      await new Promise((r) => setTimeout(r, 500));
    }

    this.dbg(`Total summaries found: ${allSummaries.length}`);
    return allSummaries;
  }

  // ─── Nav-ID Resolution (BrowserWindow SPA interaction) ─────────

  /**
   * Resolve the UUID meetingId and summaryId for a numeric meeting ID
   * by loading the SPA in the hidden BrowserWindow, finding the matching
   * row, clicking it, and extracting the hash-based UUID + summaryId.
   *
   * Returns null if the meeting is not found.
   */
  async resolveNavId(
    numericId: string,
    sourceType: 'owned' | 'shared' = 'owned',
    dateHint?: string
  ): Promise<NavIdEntry | null> {
    const cacheKey = this.navCacheKey(numericId, sourceType, dateHint);
    const cached = this.navIdCache.get(cacheKey);
    if (cached) {
      this.dbg(`[resolveNavId] Cache HIT for ${numericId} dateHint="${dateHint}" cacheKey=${cacheKey}`);
      return cached;
    }
    this.dbg(`[resolveNavId] Cache MISS for ${numericId} dateHint="${dateHint}" cacheKey=${cacheKey}. Navigating to list...`);

    const baseUrl = this.auth.baseUrl;
    const hashFragment = sourceType === 'shared' ? 'summaryShare' : 'list';
    await this.navigateScrapeWindow(`${baseUrl}/user/meeting/summary#/${hashFragment}`);

    // Wait for SPA table
    const tableReady = await this.waitForCondition(`
      !!(document.querySelector('.zm-table__body-wrapper tbody tr') ||
         document.querySelector('.zm-table__body tbody tr'))
    `, 15000);
    console.log(`[zoom-client][resolveNavId] tableReady=${tableReady} id=${numericId} hash=${await this.execInWindow<string>(`window.location.hash`).catch(()=>'?')}`);
    if (!tableReady) return null;

    // Reset to page 1 — the SPA may still be on a later page from a prior scan
    await this.resetToFirstPage();

    while (true) {
      // Try to find and click the row (with optional dateHint to pick the right recurring instance)
      const clickResult = await this.execInWindow<{ found: boolean; candidateCount: number; matchedDate: boolean; clickedRowText: string }>(`
        (function() {
          var id = ${JSON.stringify(numericId)};
          var dateHint = ${JSON.stringify(dateHint ?? '')};
          var rows = document.querySelectorAll(
            '.zm-table__body-wrapper tbody tr, .zm-table__body tbody tr'
          );
          var candidates = [];
          for (var i = 0; i < rows.length; i++) {
            var cells = rows[i].querySelectorAll('td');
            var idMatch = false;
            for (var j = 0; j < cells.length; j++) {
              if ((cells[j].textContent || '').replace(/\\D/g, '') === id) { idMatch = true; break; }
            }
            if (idMatch) candidates.push(rows[i]);
          }
          if (candidates.length === 0) return { found: false, candidateCount: 0, matchedDate: false, clickedRowText: '' };

          var target = null;
          var matchedDate = false;
          if (dateHint) {
            // When dateHint is provided, ONLY click if we find a row containing that date.
            // This prevents clicking the wrong recurring instance on the wrong page.
            for (var k = 0; k < candidates.length; k++) {
              if ((candidates[k].textContent || '').indexOf(dateHint) !== -1) {
                target = candidates[k]; matchedDate = true; break;
              }
            }
            if (!target) {
              // Candidates exist but none match the dateHint — don't click, paginate instead.
              return { found: false, candidateCount: candidates.length, matchedDate: false, clickedRowText: 'DATE_MISMATCH: candidates on page but none match dateHint' };
            }
          } else {
            // No dateHint — just take the first match (legacy behavior)
            target = candidates[0];
            matchedDate = candidates.length === 1;
          }
          var clickedText = (target.textContent || '').trim().substring(0, 120);
          var btn = target.querySelector('button.topic-link');
          if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return { found: true, candidateCount: candidates.length, matchedDate: matchedDate, clickedRowText: clickedText };
        })()
      `);
      const found = clickResult.found;
      console.log(`[zoom-client][resolveNavId] id=${numericId} found=${found} candidates=${clickResult.candidateCount} clickedRow="${clickResult.clickedRowText.substring(0,60)}"`);

      if (found) {
        this.dbg(`[resolveNavId] Row found for ${numericId} (${sourceType}), waiting for #/detail...`);
      } else if (this.debug) {
        // Dump first few rows to diagnose column layout
        const rowDump = await this.execInWindow<string[]>(`
          (function() {
            var rows = document.querySelectorAll('.zm-table__body-wrapper tbody tr, .zm-table__body tbody tr');
            var out = [];
            for (var i = 0; i < Math.min(rows.length, 3); i++) {
              var cells = rows[i].querySelectorAll('td');
              var parts = [];
              for (var j = 0; j < cells.length; j++) parts.push('td[' + j + ']=' + (cells[j].textContent || '').trim().substring(0, 80));
              out.push(parts.join(' | '));
            }
            return out;
          })()
        `);
        this.dbg(`[resolveNavId] Row NOT found for ${numericId} on this page. First rows: ${JSON.stringify(rowDump)}`);
      }

      if (found) {
        // Both owned and shared navigate to #/detail (shared adds isShared=true)
        const hashChanged = await this.waitForCondition(
          `window.location.hash.startsWith('#/detail')`,
          10000
        );
        const finalHash = await this.execInWindow<string>(`window.location.hash`);
        console.log(`[zoom-client][resolveNavId] hashChanged=${hashChanged} finalHash="${finalHash.substring(0,80)}"`);

        if (hashChanged) {
          const entry = this.parseDetailHash(finalHash);
          if (entry) {
            if (sourceType === 'shared') entry.isShared = true;
            this.navIdCache.set(cacheKey, entry);
            this.dbg(`[resolveNavId] Cached: meetingId=${entry.uuidMeetingId} summaryId=${entry.summaryId} isShared=${entry.isShared}`);
            return entry;
          } else {
            this.dbg(`[resolveNavId] parseDetailHash returned null for hash: ${finalHash}`);
          }
        } else {
          this.dbg(`[resolveNavId] Hash did not change to #/detail. Current: ${finalHash}`);
        }
        return null;
      }

      // Check for next page
      this.dbg(`[resolveNavId] id=${numericId} not found on current page, checking pagination...`);
      const hasNext = await this.execInWindow<boolean>(`
        (function() {
          var btn = document.querySelector('button.btn-next');
          return !!btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
        })()
      `);
      if (!hasNext) break;

      const currentPage = await this.execInWindow<string | null>(`
        (function() {
          var active = document.querySelector('.zm-pager li.number.active');
          return active ? (active.getAttribute('data-page') || active.textContent.trim()) : null;
        })()
      `);
      await this.execInWindow<void>(`document.querySelector('button.btn-next').click()`);
      await this.waitForCondition(`
        (function() {
          var active = document.querySelector('.zm-pager li.number.active');
          var p = active ? (active.getAttribute('data-page') || active.textContent.trim()) : null;
          return !!p && p !== ${JSON.stringify(null)};
        })()
      `.replace(JSON.stringify(null), JSON.stringify(currentPage)), 15000);
      await new Promise((r) => setTimeout(r, 500));
    }

    return null;
  }

  /**
   * Pre-populate navIdCache in a single pass through all list pages.
   * For each meeting whose numeric ID is in `numericIds` and not yet cached,
   * clicks the row, captures UUID + summaryId from the hash, then navigates
   * back to continue scanning.
   */
  async prefetchNavIds(
    numericIds: string[],
    sourceType: 'owned' | 'shared' = 'owned'
  ): Promise<void> {
    const needed = new Set(
      numericIds.filter((id) => !this.navIdCache.has(this.navCacheKey(id, sourceType)))
    );
    if (needed.size === 0) return;

    this.dbg(`Pre-fetching nav IDs for ${needed.size} meetings`);
    const baseUrl = this.auth.baseUrl;
    const hashFragment = sourceType === 'shared' ? 'summaryShare' : 'list';
    await this.navigateScrapeWindow(`${baseUrl}/user/meeting/summary#/${hashFragment}`);

    // Wait for SPA table
    await this.waitForCondition(`
      !!(document.querySelector('.zm-table__body-wrapper tbody tr') ||
         document.querySelector('.zm-table__body tbody tr'))
    `, 15000);

    // Reset to page 1 in case the SPA stayed on a later page
    await this.resetToFirstPage();

    let currentPageNum = 1;

    while (needed.size > 0) {
      // Find which needed IDs are on this page
      const neededArr = [...needed];
      const pageIds = await this.execInWindow<string[]>(`
        (function() {
          var ids = ${JSON.stringify(neededArr)};
          var rows = document.querySelectorAll(
            '.zm-table__body-wrapper tbody tr, .zm-table__body tbody tr'
          );
          var found = [];
          for (var i = 0; i < rows.length; i++) {
            var cells = rows[i].querySelectorAll('td');
            for (var j = 0; j < cells.length; j++) {
              var cellText = (cells[j].textContent || '').replace(/\\D/g, '');
              if (ids.indexOf(cellText) !== -1) { found.push(cellText); break; }
            }
          }
          return found;
        })()
      `);

      this.dbg(`Page ${currentPageNum}: found ${pageIds.length} needed rows`);

      for (const numericId of pageIds) {
        // Click the row
        const clicked = await this.execInWindow<boolean>(`
          (function() {
            var id = ${JSON.stringify(numericId)};
            var rows = document.querySelectorAll(
              '.zm-table__body-wrapper tbody tr, .zm-table__body tbody tr'
            );
            for (var i = 0; i < rows.length; i++) {
              var cells = rows[i].querySelectorAll('td');
              var match = false;
              for (var j = 0; j < cells.length; j++) {
                if ((cells[j].textContent || '').replace(/\\D/g, '') === id) { match = true; break; }
              }
              if (match) {
                var btn = rows[i].querySelector('button.topic-link');
                if (btn) { btn.click(); return true; }
              }
            }
            return false;
          })()
        `);
        if (!clicked) continue;

        // Wait for hash to change to #/detail
        const hashChanged = await this.waitForCondition(
          `window.location.hash.startsWith('#/detail')`,
          10000
        );
        if (hashChanged) {
          const hash = await this.execInWindow<string>(`window.location.hash`);
          const entry = this.parseDetailHash(hash);
          if (entry) {
            if (sourceType === 'shared') entry.isShared = true;
            this.navIdCache.set(this.navCacheKey(numericId, sourceType), entry);
            needed.delete(numericId);
            this.dbg(`Cached nav IDs for ${numericId} (isShared=${entry.isShared})`);
          }
        }

        // Navigate back to list
        await this.execInWindow<void>(`window.location.hash = '#/${hashFragment}'`);
        await this.waitForCondition(`
          !!(document.querySelector('.zm-table__body-wrapper tbody tr') ||
             document.querySelector('.zm-table__body tbody tr'))
        `, 10000);

        // Re-navigate to the correct page if needed
        if (currentPageNum > 1) {
          const actualPage = await this.execInWindow<number>(`
            (function() {
              var active = document.querySelector('.zm-pager li.number.active');
              var p = active ? (active.getAttribute('data-page') || active.textContent.trim()) : '1';
              return parseInt(p, 10) || 1;
            })()
          `);

          if (actualPage !== currentPageNum) {
            this.dbg(`After hash-back: actualPage=${actualPage}, need=${currentPageNum}`);
            // Try direct page button first
            const directNav = await this.execInWindow<boolean>(`
              (function() {
                var btn = document.querySelector('.zm-pager li.number[data-page="${currentPageNum}"]');
                if (btn) { btn.click(); return true; }
                return false;
              })()
            `);
            if (directNav) {
              await this.waitForCondition(`
                (function() {
                  var active = document.querySelector('.zm-pager li.number.active');
                  var p = active ? (active.getAttribute('data-page') || active.textContent.trim()) : null;
                  return p === '${currentPageNum}';
                })()
              `, 10000);
            } else {
              // Fall back to clicking Next from current position
              for (let p = actualPage; p < currentPageNum; p++) {
                await this.execInWindow<void>(`document.querySelector('button.btn-next').click()`);
                await new Promise((r) => setTimeout(r, 500));
              }
            }
            await new Promise((r) => setTimeout(r, 300));
          }
        }
      }

      // Move to next page
      const hasNext = await this.execInWindow<boolean>(`
        (function() {
          var btn = document.querySelector('button.btn-next');
          return !!btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
        })()
      `);
      if (!hasNext) break;

      const currentPage = await this.execInWindow<string | null>(`
        (function() {
          var active = document.querySelector('.zm-pager li.number.active');
          return active ? (active.getAttribute('data-page') || active.textContent.trim()) : null;
        })()
      `);
      await this.execInWindow<void>(`document.querySelector('button.btn-next').click()`);
      await this.waitForCondition(`
        (function() {
          var active = document.querySelector('.zm-pager li.number.active');
          var p = active ? (active.getAttribute('data-page') || active.textContent.trim()) : null;
          return !!p && p !== ${JSON.stringify(currentPage)};
        })()
      `, 15000);
      await new Promise((r) => setTimeout(r, 500));
      currentPageNum++;
    }

    this.dbg(`Nav cache now has ${this.navIdCache.size} entries`);
  }

  /**
   * Resolve nav IDs by topic text as a fallback for shared pages where numeric
   * meeting IDs can be unreliable/missing in table columns.
   */
  private async resolveNavIdByTopic(
    topicHint: string,
    sourceType: 'owned' | 'shared' = 'owned'
  ): Promise<NavIdEntry | null> {
    const target = this.normalizeTopic(topicHint);
    if (!target) return null;

    const baseUrl = this.auth.baseUrl;
    const hashFragment = sourceType === 'shared' ? 'summaryShare' : 'list';
    await this.navigateScrapeWindow(`${baseUrl}/user/meeting/summary#/${hashFragment}`);

    const tableReady = await this.waitForCondition(`
      !!(document.querySelector('.zm-table__body-wrapper tbody tr') ||
         document.querySelector('.zm-table__body tbody tr'))
    `, 15000);
    if (!tableReady) return null;

    // Reset to page 1 in case the SPA stayed on a later page
    await this.resetToFirstPage();

    while (true) {
      const matchAndClick = await this.execInWindow<boolean>(`
        (function() {
          var target = ${JSON.stringify(target)};
          var norm = function(s) { return (s || '').toLowerCase().replace(/\\s+/g, ' ').trim(); };
          var rows = document.querySelectorAll('.zm-table__body-wrapper tbody tr, .zm-table__body tbody tr');
          for (var i = 0; i < rows.length; i++) {
            var topicEl = rows[i].querySelector('button.topic-link, a.topic-link, td:first-child button, td:first-child a, td:first-child');
            var rowTopic = norm(topicEl ? topicEl.textContent : '');
            if (rowTopic === target) {
              var btn = rows[i].querySelector('button.topic-link, a.topic-link, td:first-child button, td:first-child a');
              if (btn) { btn.click(); return true; }
            }
          }
          return false;
        })()
      `);

      if (matchAndClick) {
        this.dbg(`[resolveNavIdByTopic] Row matched for "${topicHint}" (${sourceType}), waiting for #/detail...`);
        const navigated = await this.waitForCondition(
          `window.location.hash.startsWith('#/detail')`,
          10000
        );
        const finalHash = await this.execInWindow<string>(`window.location.hash`);
        this.dbg(`[resolveNavIdByTopic] navigated=${navigated} hash="${finalHash}"`);
        if (!navigated) return null;

        const hash = await this.execInWindow<string>(`window.location.hash`);
        const entry = this.parseDetailHash(hash);
        if (entry && sourceType === 'shared') entry.isShared = true;
        return entry;
      }

      const hasNext = await this.execInWindow<boolean>(`
        (function() {
          var btn = document.querySelector('button.btn-next');
          return !!btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
        })()
      `);
      if (!hasNext) break;

      const currentPage = await this.execInWindow<string | null>(`
        (function() {
          var active = document.querySelector('.zm-pager li.number.active');
          return active ? (active.getAttribute('data-page') || active.textContent.trim()) : null;
        })()
      `);

      await this.execInWindow<void>(`document.querySelector('button.btn-next').click()`);
      await this.waitForCondition(`
        (function() {
          var active = document.querySelector('.zm-pager li.number.active');
          var p = active ? (active.getAttribute('data-page') || active.textContent.trim()) : null;
          return !!p && p !== ${JSON.stringify(currentPage)};
        })()
      `, 15000);
      await new Promise((r) => setTimeout(r, 500));
    }

    return null;
  }

  /**
   * Find a specific numeric meeting ID in a page's table and extract
   * its nav IDs from the detail link/hash.
   * Used as fallback when BrowserWindow scraping isn't needed.
   */
  private findNavIdInPage(
    doc: Document,
    numericId: string
  ): NavIdEntry | null {
    const bodyTable =
      doc.querySelector<HTMLTableElement>(".zm-table__body-wrapper table") ??
      doc.querySelector<HTMLTableElement>(".zm-table__body table") ??
      doc.querySelector<HTMLTableElement>("table:last-of-type");
    if (!bodyTable) return null;

    for (const row of Array.from(bodyTable.querySelectorAll("tbody tr"))) {
      const cells = row.querySelectorAll("td");
      let cellMatch = false;
      for (const cell of Array.from(cells)) {
        if ((cell.textContent ?? "").replace(/[\s-]/g, "") === numericId) { cellMatch = true; break; }
      }
      if (cellMatch) {
        return this.extractNavIdFromRow(row);
      }
    }
    return null;
  }

  /**
   * Extract uuidMeetingId and summaryId from a table row.
   * Zoom encodes these in the topic-link button's onclick or the row's
   * data attributes, or in an anchor href with a hash fragment.
   */
  private extractNavIdFromRow(row: Element): NavIdEntry | null {
    // Strategy 1: Look for a link/button with hash fragment containing meetingId + summaryId
    const links = row.querySelectorAll("a[href], button[data-meeting-id]");
    for (const link of Array.from(links)) {
      const href = link.getAttribute("href") ?? "";
      const entry = this.parseDetailHash(href);
      if (entry) return entry;

      // data attribute approach
      const mid = link.getAttribute("data-meeting-id");
      const sid = link.getAttribute("data-summary-id");
      if (mid && sid) return { uuidMeetingId: mid, summaryId: sid };
    }

    // Strategy 2: Check row data attributes
    const rowMid =
      row.getAttribute("data-meeting-id") ??
      row.getAttribute("data-uuid");
    const rowSid = row.getAttribute("data-summary-id");
    if (rowMid && rowSid) return { uuidMeetingId: rowMid, summaryId: rowSid };

    // Strategy 3: Look for onclick handler text
    const topicBtn = row.querySelector<HTMLElement>("button.topic-link");
    const onclick = topicBtn?.getAttribute("onclick") ?? "";
    const match = onclick.match(
      /meetingId[=:][\s'"]*([^&'"]+).*summaryId[=:][\s'"]*([^&'"]+)/
    );
    if (match) return { uuidMeetingId: match[1], summaryId: match[2] };

    return null;
  }

  /**
   * Parse "#/detail?meetingId=UUID&summaryId=SID" hash format.
   */
  private parseDetailHash(hashOrUrl: string): NavIdEntry | null {
    const hashIdx = hashOrUrl.indexOf("#/detail");
    if (hashIdx === -1) return null;
    const params = new URLSearchParams(
      hashOrUrl.substring(hashIdx).replace(/^#\/detail\??/, "")
    );
    const uuidMeetingId = params.get("meetingId");
    const summaryId = params.get("summaryId");
    if (uuidMeetingId && summaryId) return { uuidMeetingId, summaryId };
    return null;
  }

  // ─── Get Summary Detail ───────────────────────────────────────

  /**
   * Fetch the full summary for a meeting via Zoom's internal REST API.
   */
  async getSummary(
    meetingId: string,
    sourceType: 'owned' | 'shared' = 'owned',
    topicHint?: string,
    dateHint?: string
  ): Promise<MeetingSummaryDetail> {
    const numericId = meetingId.replace(/[\s-]/g, "");
    const baseUrl = this.auth.baseUrl;
    const cacheKey = this.navCacheKey(numericId, sourceType, dateHint);

    // Resolve the UUID-based meeting ID and summary ID
    let navEntry: NavIdEntry | undefined = this.navIdCache.get(cacheKey);
    if (!navEntry) {
      this.dbg(`[getSummary] No cached navEntry for ${numericId} (${sourceType}) dateHint=${dateHint}. Resolving by ID...`);
      navEntry = (await this.resolveNavId(numericId, sourceType, dateHint)) ?? undefined;
      if (!navEntry && topicHint) {
        this.dbg(`[getSummary] resolveNavId by numeric ID failed for ${numericId}; retrying by topic: ${topicHint}`);
        navEntry = (await this.resolveNavIdByTopic(topicHint, sourceType)) ?? undefined;
        if (navEntry) {
          if (sourceType === 'shared') navEntry.isShared = true;
          this.navIdCache.set(cacheKey, navEntry);
        }
      }
      if (!navEntry) {
        this.dbg(`[getSummary] FAILED to resolve navEntry for ${numericId} (${sourceType})`);
        return {
          meeting_id: meetingId,
          meeting_topic: "",
          error: `Meeting ${meetingId} not found in summaries list.`,
        };
      }
    }
    this.dbg(`[getSummary] navEntry for ${numericId} date=${dateHint}: meetingId=${navEntry.uuidMeetingId} summaryId=${navEntry.summaryId} isShared=${navEntry.isShared}`);

    const apiUrl = `${baseUrl}/rest/meeting/web_view_summary?meetingId=${encodeURIComponent(navEntry.uuidMeetingId)}&summaryId=${encodeURIComponent(navEntry.summaryId)}&from=${navEntry.isShared ? '&isShared=true' : ''}`;

    this.dbg(`[getSummary] Fetching REST API: ${apiUrl}`);

    // Use in-browser fetch (via the scrape window) — this has the full session
    // cookies and CSRF tokens that nodeRequest may lack for shared summaries.
    let apiResponse: { status: boolean; result?: Record<string, unknown> };
    try {
      apiResponse = await this.execInWindow<{ status: boolean; result?: Record<string, unknown> }>(`
        fetch(${JSON.stringify(apiUrl)}, {
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        }).then(function(r) { return r.json(); })
      `);
      this.dbg(`[getSummary] In-browser fetch result: status=${apiResponse?.status} hasResult=${!!apiResponse?.result} keys=${apiResponse?.result ? Object.keys(apiResponse.result).join(',') : 'none'}`);
    } catch (browserFetchErr) {
      this.dbg(`[getSummary] In-browser fetch failed (${(browserFetchErr as Error).message}), falling back to nodeRequest...`);
      // Fallback to nodeRequest
      const res = await this.zoomFetch(apiUrl, {
        headers: { Accept: "application/json" },
      });
      this.dbg(`[getSummary] nodeRequest status=${res.status} bodyLen=${res.body.length}`);
      if (this.debug) {
        this.dbg(`[getSummary] nodeRequest body (first 500): ${res.body.substring(0, 500)}`);
      }
      apiResponse = JSON.parse(res.body);
    }

    if (!apiResponse?.status || !apiResponse?.result) {
      this.dbg(
        `[getSummary] Empty API result for ${meetingId} (${sourceType}) ` +
          `status=${String(apiResponse?.status)}`
      );
      return {
        meeting_id: meetingId,
        meeting_topic: "",
        error: "API returned no result.",
        raw: apiResponse,
      };
    }

    const r = apiResponse.result;
    const finalStr = typeof r.finalSummaryString === "string" ? r.finalSummaryString.trim() : "";
    const boSummaryRaw = r.boSummary;
    const boStr = typeof boSummaryRaw === "string" ? boSummaryRaw.trim() : "";
    this.dbg(
      `[getSummary] ${sourceType} ${meetingId} fields: ` +
        `overview=${Boolean((r.summaryOverview ?? r.overview ?? "").toString().trim())} ` +
        `sections=${Array.isArray(r.summaryItemVOs) ? r.summaryItemVOs.length : 0} ` +
        `steps=${Array.isArray(r.stepList ?? r.nextStepList) ? ((r.stepList ?? r.nextStepList) as unknown[]).length : 0} ` +
        `finalSummaryString(${finalStr.length})="${finalStr.substring(0, 80)}" ` +
        `boSummary type=${typeof boSummaryRaw} val="${JSON.stringify(boSummaryRaw)?.substring(0, 80)}"`
    );
    return {
      meeting_id: meetingId,
      meeting_topic: (r.topic ?? r.meetingTopic ?? "") as string,
      summary_overview: (r.summaryOverview ?? r.overview ?? "") as string,
      next_steps: (r.stepList ?? r.nextStepList ?? []) as string[],
      next_step_items: r.nextStepItems as MeetingSummaryDetail["next_step_items"],
      nextStepItems: r.nextStepItems as MeetingSummaryDetail["nextStepItems"],
      summary_details: r.summaryDetails as string | undefined,
      summaryOverview: r.summaryOverview as string | undefined,
      summaryItemVOs: r.summaryItemVOs as MeetingSummaryDetail["summaryItemVOs"],
      stepList: r.stepList as string[] | undefined,
      ...r,
    } as unknown as MeetingSummaryDetail;
  }

  // ─── Meeting Participants ─────────────────────────────────────

  /**
   * Fetch the participant list for a meeting from Zoom's reporting API.
   * Falls back gracefully to [] if the navId isn't cached or the call fails.
   *
   * Filters out Zoom Room devices (email prefix "zoomroom_").
   * Returns display names — callers are responsible for filtering out self.
   */
  async getMeetingParticipants(
    meetingId: string,
    sourceType: 'owned' | 'shared' = 'owned'
  ): Promise<string[]> {
    const numericId = meetingId.replace(/[\s-]/g, "");
    const cacheKey = this.navCacheKey(numericId, sourceType);
    let navEntry = this.navIdCache.get(cacheKey);
    if (!navEntry) {
      this.dbg(`[getParticipants] No cached navEntry for ${numericId}; resolving now`);
      navEntry = (await this.resolveNavId(numericId, sourceType)) ?? undefined;
      if (!navEntry) {
        this.dbg(`[getParticipants] Could not resolve navId for ${numericId}`);
        return [];
      }
    }

    const uuidMeetingId = navEntry.uuidMeetingId;
    const url = `${this.auth.baseUrl}/rest/account/report/historymeetings/participants/list`;
    this.dbg(`[getParticipants] ${numericId} uuid=${uuidMeetingId}`);

    const win = await this.getOrCreateScrapeWindow();
    let raw: { accountId: string; storeKeys: string; body: unknown };
    try {
      raw = await win.webContents.executeJavaScript(`
        (async function() {
          // Extract accountId from the SPA's Vuex store — search all modules
          let accountId = ${JSON.stringify(this._accountId ?? '')};
          let storeKeys = '';
          if (!accountId) {
            try {
              const state = document.querySelector('#app').__vue_app__.config.globalProperties.$store.state;
              storeKeys = Object.keys(state).join(',');
              for (const key of Object.keys(state)) {
                const mod = state[key];
                if (mod && typeof mod === 'object' && typeof mod.accountId === 'string' && mod.accountId) {
                  accountId = mod.accountId;
                  break;
                }
              }
              if (!accountId && typeof state.accountId === 'string') accountId = state.accountId;
            } catch(e) {}
            try {
              if (!accountId) {
                const state = document.querySelector('#app').__vue__.$store.state;
                storeKeys = storeKeys || Object.keys(state).join(',');
                for (const key of Object.keys(state)) {
                  const mod = state[key];
                  if (mod && typeof mod === 'object' && typeof mod.accountId === 'string' && mod.accountId) {
                    accountId = mod.accountId;
                    break;
                  }
                }
              }
            } catch(e) {}
            try {
              if (!accountId) {
                const candidates = ['zoomConfig','zoomInitData','ZM','__zm__','zoomData'];
                for (const k of candidates) {
                  if (window[k]?.accountId) { accountId = window[k].accountId; break; }
                }
              }
            } catch(e) {}
          }

          const resp = await fetch(${JSON.stringify(url)}, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({
              accountId,
              groupId: '',
              isShowPersonal: true,
              isShowUniqueAttendee: false,
              meetingId: ${JSON.stringify(uuidMeetingId)},
              page: 1,
              scheduleForUserId: '',
            }),
          });
          const body = await resp.json();
          return { accountId, storeKeys, body };
        })()
      `);
    } catch (e) {
      this.dbg(`[getParticipants] Fetch error for ${numericId}: ${(e as Error).message}`);
      return [];
    }

    const result = raw?.body as { status?: boolean; result?: { list?: Array<{ name?: string; email?: string; roomDisplayName?: string }> } } | undefined;
    this.dbg(`[getParticipants] ${numericId} accountId="${raw?.accountId}" storeKeys="${raw?.storeKeys}" status=${result?.status} keys=${result?.result ? Object.keys(result.result).join(',') : 'none'} raw=${JSON.stringify(result).substring(0, 300)}`);

    if (!result?.result?.list) {
      this.dbg(`[getParticipants] No list in response for ${numericId}`);
      return [];
    }

    const humans = result.result.list.filter(p => {
      const email = (p.email ?? '').toLowerCase();
      return !email.startsWith('zoomroom_') && !p.roomDisplayName;
    });

    const names = humans.map(p => p.name ?? '').filter(Boolean);
    this.dbg(`[getParticipants] ${numericId}: ${names.join(', ')}`);
    return names;
  }

  // ─── Delete Summary ───────────────────────────────────────────

  /**
   * Delete a meeting's summary from Zoom using the hidden BrowserWindow.
   *
   * Strategy (mirrors the MCP server's Puppeteer-based approach):
   * 1. Navigate hidden window to the detail hash view
   * 2. Click the "delete meeting summary" button
   * 3. Confirm "Move to Trash" in the dialog
   * 4. Fallback: run fetch() inside the browser context (has session cookies + CSRF)
   */
  async deleteSummary(
    meetingId: string
  ): Promise<{ success: boolean; message: string }> {
    const numericId = meetingId.replace(/[\s-]/g, "");
    const baseUrl = this.auth.baseUrl;
    const cacheKey = this.navCacheKey(numericId, 'owned');
    console.log(`[zoom-client][delete] START meetingId=${meetingId} numericId=${numericId} cacheHit=${this.navIdCache.has(cacheKey)}`);

    let navEntry: NavIdEntry | undefined = this.navIdCache.get(cacheKey);
    if (!navEntry) {
      navEntry = (await this.resolveNavId(numericId, 'owned')) ?? undefined;
      console.log(`[zoom-client][delete] resolveNavId result: ${navEntry ? `meetingId=${navEntry.uuidMeetingId}` : "null (not found)"}`);
      if (!navEntry) {
        return {
          success: true,
          message: `Meeting ${meetingId} not found (already deleted).`,
        };
      }
    } else {
      console.log(`[zoom-client][delete] Using cached navEntry: meetingId=${navEntry.uuidMeetingId}`);
    }

    const { uuidMeetingId, summaryId } = navEntry;
    const detailUrl = `${baseUrl}/user/meeting/summary#/detail?meetingId=${encodeURIComponent(uuidMeetingId)}&summaryId=${encodeURIComponent(summaryId)}`;

    // If resolveNavId already navigated to this detail page via an in-page click,
    // skip the loadURL() call — a cold reload is slower and less reliable than the
    // in-page hash navigation that resolveNavId uses.
    const currentHash = await this.execInWindow<string>(`window.location.hash`).catch(() => "");
    const alreadyOnDetail = currentHash.startsWith("#/detail") && currentHash.includes(encodeURIComponent(uuidMeetingId));
    console.log(`[zoom-client][delete] currentHash=${currentHash} alreadyOnDetail=${alreadyOnDetail}`);
    if (!alreadyOnDetail) {
      console.log(`[zoom-client][delete] Navigating to detail: ${detailUrl}`);
      await this.navigateScrapeWindow(detailUrl);
      await this.waitForCondition(`window.location.hash.startsWith("#/detail")`, 5000);
    } else {
      console.log(`[zoom-client][delete] Already on detail page, skipping reload`);
    }

    // Wait for the detail page to render with a delete button.
    // Uses includes() not === to handle icon glyphs prepended to button text.
    const deleteButtonCondition = `
      (function() {
        if (document.querySelector('button[aria-label="delete meeting summary"]')) return true;
        if (document.querySelector('button[aria-label="Delete"]')) return true;
        var btns = document.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
          var txt = (btns[i].textContent || '').trim().toLowerCase();
          var lbl = (btns[i].getAttribute('aria-label') || '').toLowerCase();
          if ((txt.includes('delete') && txt.length < 20) ||
              lbl === 'delete' || lbl === 'delete meeting summary') return true;
        }
        return false;
      })()
    `;
    const deleteButtonReady = await this.waitForCondition(deleteButtonCondition, 15000);
    console.log(`[zoom-client][delete] deleteButtonReady=${deleteButtonReady}`);

    if (!deleteButtonReady) {
      // Dump all button texts to help diagnose UI changes
      const btnDump = await this.execInWindow<string>(`
        (function() {
          var btns = document.querySelectorAll('button');
          var out = [];
          for (var i = 0; i < btns.length; i++) {
            var txt = (btns[i].textContent || '').trim().substring(0, 40);
            var lbl = btns[i].getAttribute('aria-label') || '';
            out.push('btn[' + i + '] txt=' + JSON.stringify(txt) + ' lbl=' + JSON.stringify(lbl));
          }
          return out.join('\\n') || '(no buttons found)';
        })()
      `).catch(() => "(error dumping buttons)");
      this.dbg(`[delete] Delete button not found. Page buttons:\n${btnDump}`);
      this.dbg(`[delete] Current hash: `, await this.execInWindow<string>(`window.location.hash`).catch(() => "?"));

      // Maybe stale cache — evict and re-resolve
      this.navIdCache.delete(cacheKey);
      const retryNav = await this.resolveNavId(numericId, 'owned');
      if (!retryNav) {
        return {
          success: true,
          message: `Meeting ${meetingId} not found (already deleted).`,
        };
      }
      // Navigate to the fresh detail URL
      const retryUrl = `${baseUrl}/user/meeting/summary#/detail?meetingId=${encodeURIComponent(retryNav.uuidMeetingId)}&summaryId=${encodeURIComponent(retryNav.summaryId)}`;
      await this.navigateScrapeWindow(retryUrl);
      const retryReady = await this.waitForCondition(deleteButtonCondition, 15000);
      if (!retryReady) {
        return {
          success: false,
          message: `Delete button not found for meeting ${meetingId} — Zoom UI may have changed.`,
        };
      }
    }

    // Click the delete button
    const clicked = await this.execInWindow<string | null>(`
      (() => {
        const allEls = Array.from(document.querySelectorAll(
          "button, [role='button'], [role='menuitem'], li, a, span, div"
        ));
        const deleteEl = allEls.find(e => {
          const txt  = e.textContent?.trim().toLowerCase() ?? "";
          const lbl  = (e.getAttribute("aria-label") ?? "").toLowerCase();
          const title = (e.getAttribute("title") ?? "").toLowerCase();
          return txt === "delete" || lbl.includes("delete meeting summary") || lbl.includes("delete") || title.includes("delete");
        });
        if (deleteEl) { deleteEl.click(); return "clicked: " + deleteEl.textContent?.trim(); }
        return null;
      })()
    `);
    this.dbg(`[delete] Click result: ${clicked ?? "NO BUTTON FOUND"}`);

    if (!clicked) {
      // Try opening a more/ellipsis menu first
      const menuOpened = await this.execInWindow<boolean>(`
        (() => {
          const els = Array.from(document.querySelectorAll("button, [role='button']"));
          const moreEl = els.find(e => {
            const txt = e.textContent?.trim().toLowerCase() ?? "";
            const lbl = (e.getAttribute("aria-label") ?? "").toLowerCase();
            return txt === "..." || lbl.includes("more") || lbl.includes("action") || e.className.includes("ellipsis");
          });
          if (moreEl) { moreEl.click(); return true; }
          return false;
        })()
      `);

      if (menuOpened) {
        await new Promise((r) => setTimeout(r, 500));
        await this.execInWindow<boolean>(`
          (() => {
            const allEls = Array.from(document.querySelectorAll(
              "button, [role='button'], [role='menuitem'], li, a"
            ));
            const deleteEl = allEls.find(e => {
              const txt  = e.textContent?.trim().toLowerCase() ?? "";
              const lbl  = (e.getAttribute("aria-label") ?? "").toLowerCase();
              return txt === "delete" || lbl.includes("delete");
            });
            if (deleteEl) { deleteEl.click(); return true; }
            return false;
          })()
        `);
      }
    }

    // Wait for the "Move to Trash" confirmation dialog.
    // Give the dialog time to animate in after the delete click.
    await new Promise((r) => setTimeout(r, 600));
    const confirmReady = await this.waitForCondition(
      `Array.from(document.querySelectorAll("button")).some(function(e) {
        var txt = (e.textContent || '').trim().toLowerCase();
        return txt === "move to trash";
      })`,
      4000
    );

    let uiDeleteSucceeded = false;

    if (confirmReady) {
      // Click "Move to Trash"
      const confirmed = await this.execInWindow<string | null>(`
        (() => {
          const allEls = Array.from(document.querySelectorAll("button, [role='button']"));
          const confirmEl = allEls.find(e => {
            const txt = (e.textContent || '').trim().toLowerCase();
            return txt === "move to trash";
          });
          if (confirmEl) { confirmEl.click(); return confirmEl.textContent?.trim(); }
          return null;
        })()
      `);
      this.dbg(`[delete] Confirmation click: ${confirmed ?? "none"}`);

      if (confirmed) {
        // Wait for the page to navigate away from detail or for the delete button to disappear
        const deleted = await this.waitForCondition(
          `!window.location.hash.startsWith("#/detail") || (function() {
            var btns = document.querySelectorAll('button');
            for (var i = 0; i < btns.length; i++) {
              var txt = (btns[i].textContent || '').trim().toLowerCase();
              var lbl = (btns[i].getAttribute('aria-label') || '').toLowerCase();
              if (txt === 'delete' || lbl === 'delete' || lbl === 'delete meeting summary') return false;
            }
            return true;
          })()`,
          8000
        );
        if (deleted) {
          this.dbg(`[delete] UI delete confirmed for ${meetingId}`);
          uiDeleteSucceeded = true;
        }
      }
    } else {
      this.dbg(`[delete] Confirmation dialog not found — trying API fallback`);
    }

    if (uiDeleteSucceeded) {
      this.navIdCache.delete(cacheKey);
      return { success: true, message: `Deleted summary for meeting ${meetingId}.` };
    }

    // ─── Fallback: fetch() inside the browser context ───────────
    // The browser context has session cookies and CSRF tokens available.
    this.dbg(`[delete] UI flow did not confirm — trying direct API inside browser context`);

    const fallbackResult = await this.execInWindow<
      Array<{ method: string; url: string; status: number; body: unknown; csrfUsed: string | null }>
    >(`
      (async () => {
        function findCsrf() {
          for (const name of ["_csrf", "csrf-token", "csrf_token", "x-csrf-token"]) {
            const el = document.querySelector('meta[name="' + name + '"]');
            if (el?.content) return { value: el.content, source: "meta[" + name + "]" };
          }
          const cookieRe = /(?:^|;\\s*)(?:zm_csrf|_zm_csrf|_csrf|csrf_token|csrfToken)=([^;]+)/;
          const cm = document.cookie.match(cookieRe);
          if (cm) return { value: decodeURIComponent(cm[1]), source: "cookie" };
          for (const key of ["_csrf", "csrfToken", "csrf_token", "zm_csrf", "_zm_csrf", "__csrf_token"]) {
            const v = window[key];
            if (v && typeof v === "string") return { value: v, source: "window." + key };
          }
          const input = document.querySelector('input[name="_csrf"], input[name="csrf_token"]');
          if (input?.value) return { value: input.value, source: "input[" + input.name + "]" };
          return null;
        }

        const csrf = findCsrf();
        const results = [];
        const csrfHeaders = { "Content-Type": "application/json" };
        if (csrf) {
          csrfHeaders["X-CSRF-Token"]  = csrf.value;
          csrfHeaders["X-CSRFToken"]   = csrf.value;
          csrfHeaders["csrf-token"]    = csrf.value;
          csrfHeaders["_csrf"]         = csrf.value;
        }

        const url1 = "${baseUrl}/rest/meeting/web_view_summary?meetingId=" + ${JSON.stringify(uuidMeetingId)} + "&summaryId=" + ${JSON.stringify(summaryId)};
        const r1 = await fetch(url1, { method: "DELETE", credentials: "include", headers: csrfHeaders });
        results.push({ method: "DELETE", url: url1, status: r1.status, body: await r1.json().catch(() => null), csrfUsed: csrf ? csrf.source : null });

        const url2 = "${baseUrl}/rest/meeting/web_view_summary/delete";
        const r2 = await fetch(url2, { method: "POST", credentials: "include",
          headers: csrfHeaders,
          body: JSON.stringify({ meetingId: ${JSON.stringify(uuidMeetingId)}, summaryId: ${JSON.stringify(summaryId)} })
        });
        results.push({ method: "POST", url: url2, status: r2.status, body: await r2.json().catch(() => null), csrfUsed: csrf ? csrf.source : null });

        return results;
      })()
    `);

    this.dbg(`[delete] Fallback API results:`, fallbackResult);

    const succeeded = fallbackResult.find((r) => {
      if (r.status < 200 || r.status >= 300) return false;
      const body = r.body as Record<string, unknown> | null;
      return (
        body?.status === true ||
        (body?.status !== false && !body?.errorCode)
      );
    });

    if (succeeded) {
      this.navIdCache.delete(numericId);
      return {
        success: true,
        message: `Deleted summary for meeting ${meetingId} (API fallback).`,
      };
    }

    return {
      success: false,
      message: `Delete could not be confirmed for meeting ${meetingId}.`,
    };
  }
}
