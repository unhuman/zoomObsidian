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

  constructor(auth: ZoomAuth, opts?: { debug?: boolean }) {
    this.auth = auth;
    this.debug = opts?.debug ?? false;
  }

  setDebug(debug: boolean): void {
    this.debug = debug;
  }

  private dbg(...args: unknown[]): void {
    if (this.debug) console.log("[zoom-client]", ...args);
  }

  /** Expose the in-memory nav-ID cache for diagnostics. */
  getNavCache(): Record<string, NavIdEntry> {
    return Object.fromEntries(this.navIdCache);
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
   * Navigate the hidden window to a URL and wait for it to finish loading.
   */
  private async navigateScrapeWindow(url: string): Promise<void> {
    const win = await this.getOrCreateScrapeWindow();
    await win.loadURL(url);
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
   */
  async listSummaries(
    options: { from?: string; to?: string } = {}
  ): Promise<MeetingSummaryItem[]> {
    const baseUrl = this.auth.baseUrl;
    let url = `${baseUrl}/user/meeting/summary#/`;
    if (options.from || options.to) {
      const u = new URL(`${baseUrl}/user/meeting/summary`);
      if (options.from) u.searchParams.set("from", options.from);
      if (options.to) u.searchParams.set("to", options.to);
      url = u.toString();
    }

    this.dbg("Navigating scrape window to:", url);
    await this.navigateScrapeWindow(url);

    // Wait for the SPA table to render
    const tableReady = await this.waitForCondition(`
      !!(document.querySelector('.zm-table__body-wrapper tbody tr') ||
         document.querySelector('.zm-table__body tbody tr'))
    `, 15000);

    if (!tableReady) {
      this.dbg("Table never appeared — checking page content");
      const pageInfo = await this.execInWindow<string>(`
        (document.querySelector('main, #content, .content, [role=main]') || document.body)
          .textContent.trim().substring(0, 2000)
      `);
      this.dbg("Page text:", pageInfo);
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
          var topicBtn = row.querySelector('button.topic-link');
          var item = {};
          if (topicBtn) item.meeting_topic = topicBtn.textContent.trim();
          cells.forEach(function(cell, i) {
            var text = cell.textContent.trim();
            if (text) item['column_' + i] = text;
          });
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
  async resolveNavId(numericId: string): Promise<NavIdEntry | null> {
    const cached = this.navIdCache.get(numericId);
    if (cached) return cached;

    const baseUrl = this.auth.baseUrl;
    await this.navigateScrapeWindow(`${baseUrl}/user/meeting/summary`);

    // Wait for SPA table
    const tableReady = await this.waitForCondition(`
      !!(document.querySelector('.zm-table__body-wrapper tbody tr') ||
         document.querySelector('.zm-table__body tbody tr'))
    `, 15000);
    if (!tableReady) return null;

    while (true) {
      // Try to find and click the row
      const found = await this.execInWindow<boolean>(`
        (function() {
          var id = ${JSON.stringify(numericId)};
          var rows = document.querySelectorAll(
            '.zm-table__body-wrapper tbody tr, .zm-table__body tbody tr'
          );
          for (var i = 0; i < rows.length; i++) {
            var idCell = rows[i].querySelector('td:nth-child(3)');
            var cellText = (idCell ? idCell.textContent : '').replace(/[\\s-]/g, '');
            if (cellText === id) {
              var btn = rows[i].querySelector('button.topic-link');
              if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              return true;
            }
          }
          return false;
        })()
      `);

      if (found) {
        // Wait for hash to change to #/detail
        const hashChanged = await this.waitForCondition(
          `window.location.hash.startsWith('#/detail')`,
          10000
        );
        if (hashChanged) {
          const hash = await this.execInWindow<string>(`window.location.hash`);
          const entry = this.parseDetailHash(hash);
          if (entry) {
            this.navIdCache.set(numericId, entry);
            return entry;
          }
        }
        return null;
      }

      // Check for next page
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
  async prefetchNavIds(numericIds: string[]): Promise<void> {
    const needed = new Set(numericIds.filter((id) => !this.navIdCache.has(id)));
    if (needed.size === 0) return;

    this.dbg(`Pre-fetching nav IDs for ${needed.size} meetings`);
    const baseUrl = this.auth.baseUrl;
    await this.navigateScrapeWindow(`${baseUrl}/user/meeting/summary`);

    // Wait for SPA table
    await this.waitForCondition(`
      !!(document.querySelector('.zm-table__body-wrapper tbody tr') ||
         document.querySelector('.zm-table__body tbody tr'))
    `, 15000);

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
            var idCell = rows[i].querySelector('td:nth-child(3)');
            var cellText = (idCell ? idCell.textContent : '').replace(/[\\s-]/g, '');
            if (ids.indexOf(cellText) !== -1) found.push(cellText);
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
              var idCell = rows[i].querySelector('td:nth-child(3)');
              if ((idCell ? idCell.textContent : '').replace(/[\\s-]/g, '') === id) {
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
            this.navIdCache.set(numericId, entry);
            needed.delete(numericId);
            this.dbg(`Cached nav IDs for ${numericId}`);
          }
        }

        // Navigate back to list
        await this.execInWindow<void>(`window.location.hash = '#/'`);
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
      const idCell = row.querySelector("td:nth-child(3)");
      const cellText = idCell?.textContent?.replace(/[\s-]/g, "") ?? "";
      if (cellText === numericId) {
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
  async getSummary(meetingId: string): Promise<MeetingSummaryDetail> {
    const numericId = meetingId.replace(/[\s-]/g, "");
    const baseUrl = this.auth.baseUrl;

    // Resolve the UUID-based meeting ID and summary ID
    let navEntry: NavIdEntry | undefined = this.navIdCache.get(numericId);
    if (!navEntry) {
      navEntry = (await this.resolveNavId(numericId)) ?? undefined;
      if (!navEntry) {
        return {
          meeting_id: meetingId,
          meeting_topic: "",
          error: `Meeting ${meetingId} not found in summaries list.`,
        };
      }
    }

    const apiUrl = `${baseUrl}/rest/meeting/web_view_summary?meetingId=${encodeURIComponent(navEntry.uuidMeetingId)}&summaryId=${encodeURIComponent(navEntry.summaryId)}&from=`;

    const res = await this.zoomFetch(apiUrl, {
      headers: { Accept: "application/json" },
    });
    const apiResponse = JSON.parse(res.body) as {
      status: boolean;
      result?: Record<string, unknown>;
    };

    if (!apiResponse?.status || !apiResponse?.result) {
      return {
        meeting_id: meetingId,
        meeting_topic: "",
        error: "API returned no result.",
        raw: apiResponse,
      };
    }

    const r = apiResponse.result;
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

    let navEntry: NavIdEntry | undefined = this.navIdCache.get(numericId);
    if (!navEntry) {
      navEntry = (await this.resolveNavId(numericId)) ?? undefined;
      if (!navEntry) {
        return {
          success: true,
          message: `Meeting ${meetingId} not found (already deleted).`,
        };
      }
    }

    const { uuidMeetingId, summaryId } = navEntry;
    const detailUrl = `${baseUrl}/user/meeting/summary#/detail?meetingId=${encodeURIComponent(uuidMeetingId)}&summaryId=${encodeURIComponent(summaryId)}`;
    this.dbg(`[delete] Navigating to detail: ${detailUrl}`);

    // Navigate to the detail page in the hidden BrowserWindow
    await this.navigateScrapeWindow(detailUrl);

    // Wait for the page to settle on the #/detail hash
    await this.waitForCondition(
      `window.location.hash.startsWith("#/detail")`,
      5000
    );

    // Wait for the delete button to appear (confirms detail view rendered)
    const deleteButtonReady = await this.waitForCondition(
      `!!document.querySelector('button[aria-label="delete meeting summary"]')`,
      8000
    );

    if (!deleteButtonReady) {
      this.dbg(`[delete] Delete button not found — may already be deleted`);
      // Maybe stale cache — evict and re-resolve
      this.navIdCache.delete(numericId);
      const retryNav = await this.resolveNavId(numericId);
      if (!retryNav) {
        return {
          success: true,
          message: `Meeting ${meetingId} not found (already deleted).`,
        };
      }
      // Navigate to the fresh detail URL
      const retryUrl = `${baseUrl}/user/meeting/summary#/detail?meetingId=${encodeURIComponent(retryNav.uuidMeetingId)}&summaryId=${encodeURIComponent(retryNav.summaryId)}`;
      await this.navigateScrapeWindow(retryUrl);
      const retryReady = await this.waitForCondition(
        `!!document.querySelector('button[aria-label="delete meeting summary"]')`,
        8000
      );
      if (!retryReady) {
        return {
          success: true,
          message: `Delete button not found for meeting ${meetingId} (likely already deleted).`,
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

    // Wait for the "Move to Trash" confirmation dialog
    const confirmReady = await this.waitForCondition(
      `Array.from(document.querySelectorAll("button")).some(e => e.textContent?.trim().toLowerCase() === "move to trash")`,
      3000
    );

    let uiDeleteSucceeded = false;

    if (confirmReady) {
      // Click "Move to Trash" confirmation
      const confirmed = await this.execInWindow<string | null>(`
        (() => {
          const allEls = Array.from(document.querySelectorAll("button, [role='button']"));
          const confirmEl = allEls.find(e => {
            const txt = e.textContent?.trim().toLowerCase() ?? "";
            return txt === "move to trash" || txt === "trash" || txt === "confirm" || txt === "yes" || txt === "ok";
          });
          if (confirmEl) { confirmEl.click(); return confirmEl.textContent?.trim(); }
          return null;
        })()
      `);
      this.dbg(`[delete] Confirmation click: ${confirmed ?? "none"}`);

      if (confirmed) {
        // Wait for the page to navigate away from detail (back to list) or for
        // the delete button to disappear — either indicates success
        const deleted = await this.waitForCondition(
          `!window.location.hash.startsWith("#/detail") || !document.querySelector('button[aria-label="delete meeting summary"]')`,
          8000
        );
        if (deleted) {
          this.dbg(`[delete] UI delete confirmed for ${meetingId}`);
          uiDeleteSucceeded = true;
        }
      }
    } else {
      this.dbg(`[delete] Move to Trash dialog not found — trying fallback`);
    }

    if (uiDeleteSucceeded) {
      this.navIdCache.delete(numericId);
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
