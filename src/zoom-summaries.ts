/**
 * Zoom meeting summaries client using browser-based auth.
 * Fetches data by intercepting Zoom's internal API calls on the summaries page.
 */

import { ZoomBrowser } from "./zoom-browser.js";

export interface MeetingSummaryItem {
  meeting_topic: string;
  meeting_id: string | number;
  meeting_uuid: string;
  meeting_start_time: string;
  meeting_end_time: string;
  host_name?: string;
  host_email?: string;
  summary_created_time?: string;
  [key: string]: unknown;
}

export interface MeetingSummaryDetail {
  meeting_topic: string;
  meeting_id: string | number;
  summary_overview?: string;
  summary_details?: string;
  next_steps?: string[];
  next_step_items?: unknown;
  error?: string;
  raw?: unknown;
  [key: string]: unknown;
}

export class ZoomSummariesClient {
  private browser: ZoomBrowser;
  private debug: boolean;
  // In-memory-only nav ID cache (uuidMeetingId + summaryId keyed by numeric meeting ID).
  // Populated fresh each run by prefetchNavIds/navigateToDetail — never seeded from disk.
  // This ensures recurring meetings (same numericId, different UUID per instance) always
  // get the live UUID from the current list rather than a stale cached value.
  private navIdCache = new Map<string, { uuidMeetingId: string; summaryId: string }>();

  constructor(browser: ZoomBrowser, options: { debug?: boolean } = {}) {
    this.browser = browser;
    this.debug = options.debug ?? false;
  }

  /** Expose the in-memory nav-ID cache (read-only diagnostic use). */
  getNavCache(): Record<string, { uuidMeetingId: string; summaryId: string }> {
    return Object.fromEntries(this.navIdCache);
  }

  private dbg(...args: unknown[]): void {
    if (this.debug) console.error(...args);
  }

  /**
   * List all meeting summaries by navigating to the summaries page
   * and scraping all pages via the zm-pagination next-page button.
   */
  async listSummaries(options: {
    from?: string;
    to?: string;
  } = {}): Promise<MeetingSummaryItem[]> {
    const baseUrl = this.browser.baseUrl;
    let url = `${baseUrl}/user/meeting/summary#/`;

    const page = await this.browser.navigateTo(url);

    // If date filters provided, apply them via URL params
    if (options.from || options.to) {
      const filterUrl = new URL(`${baseUrl}/user/meeting/summary`);
      if (options.from) filterUrl.searchParams.set("from", options.from);
      if (options.to) filterUrl.searchParams.set("to", options.to);
      await page.goto(filterUrl.toString(), { waitUntil: "networkidle2", timeout: 30000 });
    }

    // Wait for Zoom's table body to render (zm-table__body-wrapper holds the data rows)
    await page.waitForSelector(
      ".zm-table__body-wrapper tbody tr, .zm-table__body tbody tr",
      { timeout: 15000 }
    ).catch(() => {});

    const allSummaries: MeetingSummaryItem[] = [];

    // Helper to extract rows from whichever body table is present
    const scrapeRows = () => page.evaluate(() => {
      const results: Record<string, unknown>[] = [];
      const bodyTable =
        document.querySelector<HTMLTableElement>(".zm-table__body-wrapper table") ||
        document.querySelector<HTMLTableElement>(".zm-table__body table");
      const table = bodyTable ?? document.querySelector<HTMLTableElement>("table:last-of-type");
      if (!table) return results;

      table.querySelectorAll("tbody tr").forEach((row) => {
        const cells = row.querySelectorAll("td");
        const topicBtn = row.querySelector<HTMLButtonElement>("button.topic-link");
        const item: Record<string, unknown> = {};
        if (topicBtn) item.meeting_topic = topicBtn.textContent?.trim();
        cells.forEach((cell, i) => {
          const text = cell.textContent?.trim();
          if (text) item[`column_${i}`] = text;
        });
        if (Object.keys(item).length > 0) results.push(item);
      });
      return results;
    });

    // Paginate: scrape current page, click next until disabled
    while (true) {
      const rows = await scrapeRows();
      allSummaries.push(...(rows as MeetingSummaryItem[]));

      // Check whether the Next-page button exists and is not disabled
      const hasNext = await page.evaluate(() => {
        const btn = document.querySelector<HTMLButtonElement>("button.btn-next");
        return !!btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true";
      });

      if (!hasNext) break;

      // Note the current active page number so we can detect when the page turns
      const currentPage = await page.evaluate(() => {
        const active = document.querySelector<HTMLElement>(".zm-pager li.number.active");
        return active?.getAttribute("data-page") ?? active?.textContent?.trim();
      });

      await page.click("button.btn-next");

      // Wait until the active page indicator changes or a new set of rows appears
      await page.waitForFunction(
        (prevPage: string | undefined) => {
          const active = document.querySelector<HTMLElement>(".zm-pager li.number.active");
          const newPage = active?.getAttribute("data-page") ?? active?.textContent?.trim();
          return !!newPage && newPage !== prevPage;
        },
        { timeout: 15000 },
        currentPage ?? undefined
      ).catch(() => {});

      // Brief settle time for Vue reactivity to finish rendering rows
      await new Promise((r) => setTimeout(r, 500));
    }

    // Fallback if body table was never found — return raw page text
    if (allSummaries.length === 0) {
      const text = await page.evaluate(() => {
        const main = document.querySelector("main, #content, .content, [role=main]");
        return (main ?? document.body).textContent?.trim()?.substring(0, 5000) ?? "";
      });
      return [{ page_text: text } as unknown as MeetingSummaryItem];
    }

    return allSummaries;
  }

  /**
   * Navigate to the summaries list, find the row by numeric meeting ID,
   * click through to the detail hash, and return the UUID meetingId + summaryId.
   * Returns null if the meeting is not found.
   */
  private async navigateToDetail(
    numericId: string
  ): Promise<{ page: import("puppeteer").Page; uuidMeetingId: string; summaryId: string } | null> {
    const baseUrl = this.browser.baseUrl;
    // Navigate WITHOUT a hash so the SPA always does a full page reload.
    // Using the hash-only URL (e.g. #/) when already on the same SPA page results
    // in a no-op navigation (hash change only) and the table never re-renders.
    const page = await this.browser.navigateTo(`${baseUrl}/user/meeting/summary`);
    page.setDefaultNavigationTimeout(10000);
    page.setDefaultTimeout(10000);
    // Wait for the hash to settle to "#/" (the SPA router should redirect there)
    await page.waitForFunction(
      () => window.location.hash === "" || window.location.hash === "#/" || window.location.hash.startsWith("#/?"),
      { timeout: 5000 }
    ).catch(() => {});
    await page.waitForSelector(".zm-table__body-wrapper tbody tr, .zm-table__body tbody tr", { timeout: 15000 }).catch(() => {});

    if (this.debug) {
      const diagInfo = await page.evaluate((id: string) => {
        const rows = Array.from(document.querySelectorAll(
          ".zm-table__body-wrapper tbody tr, .zm-table__body tbody tr"
        ));
        const samples = rows.slice(0, 5).map(row => {
          const cells = Array.from(row.querySelectorAll("td")).map(td => td.textContent?.trim()?.substring(0, 30));
          return cells;
        });
        return { hash: window.location.hash, rowCount: rows.length, samples, lookingFor: id };
      }, numericId);
      console.error(`[navigateToDetail] hash="${diagInfo.hash}" rows=${diagInfo.rowCount} looking for="${diagInfo.lookingFor}"`);
      for (const s of diagInfo.samples) console.error(`  row cells: ${JSON.stringify(s)}`);
    }

    let found = false;
    while (!found) {
      found = await page.evaluate((id: string) => {
        const rows = Array.from(document.querySelectorAll<HTMLTableRowElement>(
          ".zm-table__body-wrapper tbody tr, .zm-table__body tbody tr"
        ));
        for (const row of rows) {
          const idCell = row.querySelector("td:nth-child(3)");
          const cellText = idCell?.textContent?.replace(/[\s-]/g, "") ?? "";
          if (cellText === id) {
            const btn = row.querySelector<HTMLButtonElement>("button.topic-link");
            btn?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            return true;
          }
        }
        return false;
      }, numericId);

      if (found) break;

      const hasNext = await page.evaluate(() => {
        const btn = document.querySelector<HTMLButtonElement>("button.btn-next");
        return !!btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true";
      });
      if (!hasNext) break;

      const currentPage = await page.evaluate(() => {
        const active = document.querySelector<HTMLElement>(".zm-pager li.number.active");
        return active?.getAttribute("data-page") ?? active?.textContent?.trim();
      });
      await page.click("button.btn-next");
      await page.waitForFunction(
        (prev: string | undefined) => {
          const active = document.querySelector<HTMLElement>(".zm-pager li.number.active");
          const p = active?.getAttribute("data-page") ?? active?.textContent?.trim();
          return !!p && p !== prev;
        },
        { timeout: 15000 },
        currentPage ?? undefined
      ).catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!found) return null;

    await page.waitForFunction(
      () => window.location.hash.startsWith("#/detail"),
      { timeout: 10000 }
    ).catch(() => {});

    const hash = await page.evaluate(() => window.location.hash);
    const params = new URLSearchParams(hash.replace(/^#\/detail\??/, ""));
    const uuidMeetingId = params.get("meetingId");
    const summaryId = params.get("summaryId");

    if (!uuidMeetingId || !summaryId) return null;
    this.navIdCache.set(numericId, { uuidMeetingId, summaryId });
    return { page, uuidMeetingId, summaryId };
  }

  /**
   * Get a specific meeting's summary.
   * Navigates to the summaries list, clicks the matching row (by numeric meeting ID),
   * extracts the UUID-based meetingId and summaryId from the hash URL, then calls
   * the internal REST API directly.
   */
  async getSummary(meetingId: string): Promise<MeetingSummaryDetail> {
    const baseUrl = this.browser.baseUrl;
    const numericId = meetingId.replace(/[\s-]/g, "");

    let uuidMeetingId: string;
    let summaryId: string;
    let page: import("puppeteer").Page;

    const cached = this.navIdCache.get(numericId);
    if (cached) {
      // Nav IDs already known — skip the list traversal entirely
      this.dbg(`[getSummary] Using cached nav IDs for ${numericId}`);
      ({ uuidMeetingId, summaryId } = cached);
      page = await this.browser.ensureAuthenticated();
    } else {
      const detail = await this.navigateToDetail(numericId);
      if (!detail) {
        return { meeting_id: meetingId, error: `Meeting ${meetingId} not found in summaries list.` } as unknown as MeetingSummaryDetail;
      }
      ({ page, uuidMeetingId, summaryId } = detail);
    }

    const apiUrl = `${baseUrl}/rest/meeting/web_view_summary?meetingId=${encodeURIComponent(uuidMeetingId)}&summaryId=${encodeURIComponent(summaryId)}&from=`;
    const apiResponse = await page.evaluate(async (url: string) => {
      const res = await fetch(url, { credentials: "include" });
      return res.json();
    }, apiUrl) as { status: boolean; result?: Record<string, unknown> };

    if (!apiResponse?.status || !apiResponse?.result) {
      return { meeting_id: meetingId, error: "API returned no result.", raw: apiResponse } as unknown as MeetingSummaryDetail;
    }

    const r = apiResponse.result;
    return {
      meeting_id: meetingId,
      meeting_topic: (r.topic ?? r.meetingTopic ?? "") as string,
      summary_overview: (r.summaryOverview ?? r.overview ?? "") as string,
      next_steps: (r.stepList ?? r.nextStepList ?? []) as string[],
      next_step_items: r.nextStepItems,
      summary_details: r.summaryDetails ?? r.details,
      ...r,
    } as unknown as MeetingSummaryDetail;
  }

  /**
   * Pre-populate navIdCache by doing a single pass through all list pages.
   * For each meeting whose numeric ID is in `numericIds` and not yet cached,
   * clicks the row to get the hash-based UUID + summaryId, then navigates
   * back to the list using direct page-number buttons when available.
   * Call this before getSummary to collapse N list traversals into one.
   */
  async prefetchNavIds(numericIds: string[]): Promise<void> {
    const needed = new Set(numericIds.filter(id => !this.navIdCache.has(id)));
    if (needed.size === 0) return;

    this.dbg(`[prefetch] Pre-fetching nav IDs for ${needed.size} meetings`);
    const baseUrl = this.browser.baseUrl;
    const page = await this.browser.navigateTo(`${baseUrl}/user/meeting/summary`);
    page.setDefaultTimeout(10000);

    await page.waitForFunction(
      () => window.location.hash === "" || window.location.hash === "#/" || window.location.hash.startsWith("#/?"),
      { timeout: 5000 }
    ).catch(() => {});
    await page.waitForSelector(
      ".zm-table__body-wrapper tbody tr, .zm-table__body tbody tr",
      { timeout: 15000 }
    ).catch(() => {});

    let currentPageNum = 1;

    while (needed.size > 0) {
      // Collect the numeric IDs visible on this page
      const pageIds = await page.evaluate((ids: string[]) => {
        const rows = Array.from(document.querySelectorAll<HTMLTableRowElement>(
          ".zm-table__body-wrapper tbody tr, .zm-table__body tbody tr"
        ));
        return rows
          .map(row => row.querySelector("td:nth-child(3)")?.textContent?.replace(/[\s-]/g, "") ?? "")
          .filter(id => ids.includes(id));
      }, [...needed]) as string[];

      this.dbg(`[prefetch] Page ${currentPageNum}: found ${pageIds.length} needed rows`);

      for (const numericId of pageIds) {
        // Click the row → SPA navigates to #/detail
        const clicked = await page.evaluate((id: string) => {
          const rows = Array.from(document.querySelectorAll<HTMLTableRowElement>(
            ".zm-table__body-wrapper tbody tr, .zm-table__body tbody tr"
          ));
          for (const row of rows) {
            if (row.querySelector("td:nth-child(3)")?.textContent?.replace(/[\s-]/g, "") === id) {
              (row.querySelector<HTMLButtonElement>("button.topic-link"))?.click();
              return true;
            }
          }
          return false;
        }, numericId);

        if (!clicked) continue;

        await page.waitForFunction(
          () => window.location.hash.startsWith("#/detail"),
          { timeout: 10000 }
        ).catch(() => {});

        const hash = await page.evaluate(() => window.location.hash);
        const params = new URLSearchParams(hash.replace(/^#\/detail\??/, ""));
        const uuidMeetingId = params.get("meetingId");
        const summaryId = params.get("summaryId");

        if (uuidMeetingId && summaryId) {
          this.navIdCache.set(numericId, { uuidMeetingId, summaryId });
          needed.delete(numericId);
          this.dbg(`[prefetch] Cached nav IDs for ${numericId}`);
        }

        // Navigate back to the list
        await page.evaluate(() => { window.location.hash = "#/"; });
        await page.waitForSelector(
          ".zm-table__body-wrapper tbody tr, .zm-table__body tbody tr",
          { timeout: 10000 }
        ).catch(() => {});

        // Re-navigate to the target page if needed.
        // IMPORTANT: we check the ACTUAL current page first — the SPA may have stayed
        // on the previous page (not reset to page 1) after the hash navigation back.
        // The old approach blindly clicked Next N-1 times, which overshot if the SPA
        // stayed on page N (sending us to page 2N-1 instead).
        if (currentPageNum > 1) {
          // Determine where the SPA actually landed after navigating back
          let actualPage = await page.evaluate(() => {
            const active = document.querySelector<HTMLElement>(".zm-pager li.number.active");
            const p = active?.getAttribute("data-page") ?? active?.textContent?.trim();
            return p ? parseInt(p, 10) : 1;
          });
          this.dbg(`[prefetch] After hash-back: actualPage=${actualPage}, need=${currentPageNum}`);

          if (actualPage > currentPageNum) {
            // SPA ended up past where we need to be — do a fresh load to reset to page 1
            this.dbg(`[prefetch] Overshot (page ${actualPage} > ${currentPageNum}), doing fresh load`);
            await page.goto(`${baseUrl}/user/meeting/summary`, { waitUntil: "domcontentloaded", timeout: 15000 });
            await page.waitForSelector(
              ".zm-table__body-wrapper tbody tr, .zm-table__body tbody tr",
              { timeout: 10000 }
            ).catch(() => {});
            actualPage = 1;
          }

          // Click Next forward from actualPage to currentPageNum
          for (let p = actualPage; p < currentPageNum; p++) {
            const currP = await page.evaluate(() => {
              const active = document.querySelector<HTMLElement>(".zm-pager li.number.active");
              return active?.getAttribute("data-page") ?? active?.textContent?.trim();
            });
            await page.click("button.btn-next");
            await page.waitForFunction(
              (prev: string | undefined) => {
                const active = document.querySelector<HTMLElement>(".zm-pager li.number.active");
                const lp = active?.getAttribute("data-page") ?? active?.textContent?.trim();
                return !!lp && lp !== prev;
              },
              { timeout: 15000 },
              currP ?? undefined
            ).catch(() => {});
            await new Promise(r => setTimeout(r, 300));
          }
          await new Promise(r => setTimeout(r, 300));
        }
      }

      // Move to the next page
      const hasNext = await page.evaluate(() => {
        const btn = document.querySelector<HTMLButtonElement>("button.btn-next");
        return !!btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true";
      });
      if (!hasNext) break;

      const currentPage = await page.evaluate(() => {
        const active = document.querySelector<HTMLElement>(".zm-pager li.number.active");
        return active?.getAttribute("data-page") ?? active?.textContent?.trim();
      });
      await page.click("button.btn-next");
      await page.waitForFunction(
        (prev: string | undefined) => {
          const active = document.querySelector<HTMLElement>(".zm-pager li.number.active");
          const p = active?.getAttribute("data-page") ?? active?.textContent?.trim();
          return !!p && p !== prev;
        },
        { timeout: 15000 },
        currentPage ?? undefined
      ).catch(() => {});
      await new Promise(r => setTimeout(r, 500));
      currentPageNum++;
    }

    this.dbg(`[prefetch] Done — navIdCache now has ${this.navIdCache.size} entries`);
  }

  /**
   * Delete a meeting's AI summary from Zoom.
   *
   * Strategy:
   * 1. Navigate to detail page (we get uuidMeetingId + summaryId).
   * 2. Enable CDP Network to intercept ALL outgoing requests.
   * 3. Try clicking the delete button with broad selectors + text search.
   * 4. Report every API call that fired so we know the real endpoint.
   * 5. If no network call was detected, fall back to trying common REST patterns directly.
   */
  async deleteSummary(meetingId: string, options: { label?: string } = {}): Promise<{ success: boolean; message: string }> {
    const numericId = meetingId.replace(/[\s-]/g, "");
    const baseUrl = this.browser.baseUrl;
    const prefix = options.label ? `${options.label} ` : "";

    console.error(`\n[delete] ${prefix}Starting deleteSummary for meetingId=${meetingId} numericId=${numericId}`);

    let page: import("puppeteer").Page;
    let uuidMeetingId: string;
    let summaryId: string;

    const cached = this.navIdCache.get(numericId);
    if (cached) {
      // Page should already be on the detail view from getSummary — verify and skip re-scraping
      page = await this.browser.ensureAuthenticated();
      const currentHash = await page.evaluate(() => window.location.hash);
      if (currentHash.startsWith("#/detail") && currentHash.includes(encodeURIComponent(cached.uuidMeetingId).replace(/%3D/g, "%3D"))) {
        console.error(`[delete] Using cached nav IDs — page already on detail view`);
      } else {
        // Navigate directly via hash change (much faster than scraping the list)
        this.dbg(`[delete] Cached IDs found but page is on "${currentHash}" — navigating via hash`);
        await page.evaluate((hash: string) => { window.location.hash = hash; },
          `/detail?meetingId=${encodeURIComponent(cached.uuidMeetingId)}&summaryId=${encodeURIComponent(cached.summaryId)}`);
        await page.waitForFunction(
          () => window.location.hash.startsWith("#/detail"),
          { timeout: 5000 }
        ).catch(() => {});
      }

      // Check the delete button is actually there — recurring meetings share the same
      // numeric ID but each instance has a unique summaryId. If the cached summaryId
      // was already deleted, the delete button won't appear. In that case, evict the
      // stale cache entry and fall through to navigateToDetail to find the next instance.
      const deleteButtonPresent = await page.waitForSelector(
        'button[aria-label="delete meeting summary"]', { timeout: 5000 }
      ).then(() => true).catch(() => false);

      if (!deleteButtonPresent) {
        this.dbg(`[delete] Delete button not found on cached detail URL — evicting cache entry and re-scraping list`);
        this.navIdCache.delete(numericId);
        const detail = await this.navigateToDetail(numericId);
        if (!detail) {
          console.error(`[delete] navigateToDetail returned null after cache miss — already deleted`);
          return { success: true, message: `Meeting ${meetingId} not found in summaries list (already deleted).` };
        }
        ({ page, uuidMeetingId, summaryId } = detail);
      } else {
        ({ uuidMeetingId, summaryId } = cached);
      }
    } else {
      const detail = await this.navigateToDetail(numericId);
      if (!detail) {
        console.error(`[delete] navigateToDetail returned null — meeting not found in list (already deleted?)`);
        // Treat as success: if the meeting isn't in the list it was already cleaned up
        return { success: true, message: `Meeting ${meetingId} not found in summaries list (already deleted).` };
      }
      ({ page, uuidMeetingId, summaryId } = detail);
    }
    console.error(`[delete] On detail page: uuidMeetingId=${uuidMeetingId}  summaryId=${summaryId}`);

    // Wait for the Delete button — this confirms the detail view has fully rendered.
    // Do NOT silently .catch() here: if the button never appears we must know.
    const deleteButtonVisible = await page.waitForSelector(
      'button[aria-label="delete meeting summary"]', { timeout: 8000 }
    ).then(() => true).catch(() => false);

    if (!deleteButtonVisible) {
      console.error(`[delete] Delete button never appeared for ${meetingId} — treating as already deleted`);
      return { success: true, message: `Delete button not found for meeting ${meetingId} (likely already deleted).` };
    }

    if (this.debug) {
      const pageElements = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll("button, [role='button'], [role='menuitem'], a[href]"));
        return els.map(e => ({
          tag: e.tagName.toLowerCase(),
          text: e.textContent?.trim().slice(0, 60),
          ariaLabel: (e as HTMLElement).getAttribute("aria-label"),
          className: (e as HTMLElement).className?.slice(0, 80),
        }));
      });
      console.error(`\n[delete debug] Detail page elements (${pageElements.length} total):`);
      for (const el of pageElements)
        console.error(`  <${el.tag}> text="${el.text}" aria-label="${el.ariaLabel}" class="${el.className}"`);
    }

    // Use CDP to intercept the delete API request AND its response.
    // We wait for the response (not just the request) before evaluating success.
    const client = await page.createCDPSession();
    await client.send("Network.enable");

    // Resolves with { url, status, requestId } when a delete-related response arrives.
    let resolveDeleteResponse!: (r: { url: string; status: number; requestId: string }) => void;
    const deleteResponsePromise = new Promise<{ url: string; status: number; requestId: string }>(
      res => { resolveDeleteResponse = res; }
    );

    const isDeleteUrl = (url: string) =>
      url.includes("zoom.us") &&
      (url.includes("summary") || url.includes("delete") || url.includes("trash"));

    // Track request IDs so we can match responses back to their requests
    const pendingDeleteRequests = new Map<string, string>(); // requestId → url

    client.on("Network.requestWillBeSent", (params) => {
      const { method, url } = params.request;
      if (!url.includes("zoom.us")) return;
      this.dbg(`  [net] ${method} ${url}`);
      if (method !== "GET" && isDeleteUrl(url)) {
        pendingDeleteRequests.set(params.requestId, url);
      }
    });
    client.on("Network.responseReceived", (params) => {
      const { requestId, response } = params;
      const url = pendingDeleteRequests.get(requestId);
      if (url) {
        this.dbg(`  [net response] ${response.url} → ${response.status}`);
        resolveDeleteResponse({ url, status: response.status, requestId });
      }
    });

    // Try to click the delete button — broad approach
    const clicked = await page.evaluate(() => {
      // 1. Any button whose text or aria-label contains "delete" (case-insensitive)
      const allEls = Array.from(document.querySelectorAll(
        "button, [role='button'], [role='menuitem'], li, a, span, div"
      )) as HTMLElement[];
      const deleteEl = allEls.find(e => {
        const txt  = e.textContent?.trim().toLowerCase() ?? "";
        const lbl  = (e.getAttribute("aria-label") ?? "").toLowerCase();
        const title = (e.getAttribute("title") ?? "").toLowerCase();
        return txt === "delete" || lbl.includes("delete") || title.includes("delete");
      });
      if (deleteEl) { deleteEl.click(); return `clicked: "${deleteEl.textContent?.trim()}" <${deleteEl.tagName.toLowerCase()}>`; }

      // 2. SVG trash icon button (common pattern)
      const trashBtn = document.querySelector<HTMLElement>('button svg[data-icon*="trash"], button[class*="trash"], button[class*="delete"]');
      if (trashBtn) { (trashBtn.closest("button") ?? trashBtn).click(); return "clicked trash icon button"; }

      return null;
    });

    this.dbg(`\n[delete debug] Click result: ${clicked ?? "NO BUTTON FOUND"}`);

    if (!clicked) {
      // Try opening a more/ellipsis menu first
      const menuOpened = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll("button, [role='button']")) as HTMLElement[];
        const moreEl = els.find(e => {
          const txt = e.textContent?.trim().toLowerCase() ?? "";
          const lbl = (e.getAttribute("aria-label") ?? "").toLowerCase();
          return txt === "..." || lbl.includes("more") || lbl.includes("action") || e.className.includes("ellipsis") || e.className.includes("more");
        });
        if (moreEl) { moreEl.click(); return true; }
        return false;
      });

      if (menuOpened) {
        await new Promise(r => setTimeout(r, 500));
        // Now try delete again after menu opened
        const clicked2 = await page.evaluate(() => {
          const allEls = Array.from(document.querySelectorAll(
            "button, [role='button'], [role='menuitem'], li, a"
          )) as HTMLElement[];
          const deleteEl = allEls.find(e => {
            const txt  = e.textContent?.trim().toLowerCase() ?? "";
            const lbl  = (e.getAttribute("aria-label") ?? "").toLowerCase();
            return txt === "delete" || lbl.includes("delete");
          });
          if (deleteEl) { deleteEl.click(); return true; }
          return false;
        });
        this.dbg(`[delete debug] After menu open, delete click: ${clicked2}`);
      }
    }

    // Wait for the "Move to Trash" confirmation button to appear (dialog opens after Delete click)
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll("button")).some(
        e => e.textContent?.trim().toLowerCase() === "move to trash"
      ),
      { timeout: 3000 }
    ).catch(() => {});
    const confirmed = await page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll(
        "button, [role='button']"
      )) as HTMLElement[];
      const confirmEl = allEls.find(e => {
        const txt = e.textContent?.trim().toLowerCase() ?? "";
        // "Move to Trash" is Zoom's actual confirmation label; fall back to generic confirms
        return txt === "move to trash" || txt === "trash" || txt === "confirm" || txt === "yes" || txt === "ok";
      });
      if (confirmEl) { confirmEl.click(); return confirmEl.textContent?.trim(); }
      return null;
    });
    this.dbg(`[delete debug] Confirmation click: ${confirmed ?? "none"}`);

    if (!confirmed) {
      // The confirmation dialog never appeared — the first click may not have reached
      // the Delete button. Skip the network wait and go straight to fallback.
      console.error(`[delete] Move to Trash dialog not found — skipping to fallback API`);
      await client.detach().catch(() => {});
    } else {
      // Wait for the response to the delete API call (up to 8s after confirmation click)
      const deleteResponse = await Promise.race([
        deleteResponsePromise,
        new Promise<null>(res => setTimeout(() => res(null), 8000)),
      ]);

      if (deleteResponse) {
        // Fetch the response body to check Zoom's own status field —
        // Zoom frequently returns HTTP 200 with { status: false, errorCode: N } on failure.
        let bodyJson: Record<string, unknown> | null = null;
        try {
          const bodyResult = await client.send("Network.getResponseBody", { requestId: deleteResponse.requestId });
          bodyJson = JSON.parse(bodyResult.body);
          this.dbg(`  [net body] ${JSON.stringify(bodyJson)}`);
        } catch { /* body unavailable or not JSON */ }

        await client.detach().catch(() => {});

        const httpOk = deleteResponse.status >= 200 && deleteResponse.status < 300;
        // Zoom wraps errors in 200 responses: check body.status===true if present
        const bodyOk = bodyJson === null || bodyJson.status === true || (bodyJson.status !== false && !bodyJson.errorCode);
        const success = httpOk && bodyOk;
        const bodyMsg = bodyJson ? ` body=${JSON.stringify(bodyJson)}` : "";
        console.error(`[delete] ${success ? "✓" : "✗"} Delete API response: ${deleteResponse.url} → HTTP ${deleteResponse.status}${bodyMsg}`);
        if (success) {
          // Evict cache so a subsequent call for the same numericId (recurring meeting)
          // re-scrapes the list to find the next summaryId rather than re-deleting the
          // same (now-trashed) summary and missing the remaining instance.
          this.navIdCache.delete(numericId);
          return { success: true, message: `Deleted for meeting ${meetingId}` };
        }
        // Body indicated failure — fall through to REST fallback
        console.error(`[delete] API body indicates failure — trying REST fallback`);
      } else {
        // Request fired but no response arrived within 8s
        console.error(`[delete] No response received for delete request within 8s`);
        await client.detach().catch(() => {});
      }
    } // end if (!confirmed) else

    // No UI delete worked — fall back to direct API with CSRF token extracted from page context
    this.dbg(`[delete debug] No delete API call detected via UI. Trying direct API calls...`);
    this.dbg(`[delete debug] uuidMeetingId=${uuidMeetingId}  summaryId=${summaryId}`);

    const fallbackResult = await page.evaluate(async (params: { baseUrl: string; uuidMeetingId: string; summaryId: string }) => {
      // --- Extract CSRF token from every known location ---
      function findCsrf(): { value: string; source: string } | null {
        // 1. Meta tags (Spring MVC / common SPA patterns)
        for (const name of ["_csrf", "csrf-token", "csrf_token", "x-csrf-token"]) {
          const el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
          if (el?.content) return { value: el.content, source: `meta[name="${name}"]` };
        }
        // 2. Cookies
        const cookieRe = /(?:^|;\s*)(?:zm_csrf|_zm_csrf|_csrf|csrf_token|csrfToken)=([^;]+)/;
        const cm = document.cookie.match(cookieRe);
        if (cm) return { value: decodeURIComponent(cm[1]), source: "cookie" };
        // 3. Window globals
        for (const key of ["_csrf", "csrfToken", "csrf_token", "zm_csrf", "_zm_csrf", "__csrf_token"]) {
          const v = (window as unknown as Record<string, string>)[key];
          if (v && typeof v === "string") return { value: v, source: `window.${key}` };
        }
        // 4. Hidden inputs
        const input = document.querySelector<HTMLInputElement>('input[name="_csrf"], input[name="csrf_token"]');
        if (input?.value) return { value: input.value, source: `input[name="${input.name}"]` };
        return null;
      }

      const csrf = findCsrf();
      const results: Array<{ method: string; url: string; status: number; body: unknown; csrfUsed: string | null }> = [];

      const csrfHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (csrf) {
        // Include with all common header names — belt and suspenders
        csrfHeaders["X-CSRF-Token"]  = csrf.value;
        csrfHeaders["X-CSRFToken"]   = csrf.value;
        csrfHeaders["csrf-token"]    = csrf.value;
        csrfHeaders["_csrf"]         = csrf.value;
      }

      // Try DELETE with query params
      const url1 = `${params.baseUrl}/rest/meeting/web_view_summary?meetingId=${encodeURIComponent(params.uuidMeetingId)}&summaryId=${encodeURIComponent(params.summaryId)}`;
      const r1 = await fetch(url1, { method: "DELETE", credentials: "include", headers: csrfHeaders });
      results.push({ method: "DELETE", url: url1, status: r1.status, body: await r1.json().catch(() => null), csrfUsed: csrf ? `${csrf.source}=${csrf.value.substring(0, 8)}...` : null });

      // Try POST to a delete sub-path
      const url2 = `${params.baseUrl}/rest/meeting/web_view_summary/delete`;
      const r2 = await fetch(url2, { method: "POST", credentials: "include",
        headers: csrfHeaders,
        body: JSON.stringify({ meetingId: params.uuidMeetingId, summaryId: params.summaryId })
      });
      results.push({ method: "POST", url: url2, status: r2.status, body: await r2.json().catch(() => null), csrfUsed: csrf ? `${csrf.source}=${csrf.value.substring(0, 8)}...` : null });

      return results;
    }, { baseUrl, uuidMeetingId, summaryId });

    this.dbg(`[delete debug] Direct API attempts:`);
    for (const r of fallbackResult)
      this.dbg(`  ${r.method} ${r.url} → HTTP ${r.status} csrf=${r.csrfUsed ?? "NONE"} ${JSON.stringify(r.body)}`);

    const succeeded = fallbackResult.find(r => {
      if (r.status < 200 || r.status >= 300) return false;
      const body = r.body as Record<string, unknown> | null;
      return body?.status === true || (body?.status !== false && !body?.errorCode);
    });
    if (succeeded) {
      // Evict cache so recurring-meeting follow-up calls find the next summaryId.
      this.navIdCache.delete(numericId);
    }
    return {
      success: !!succeeded,
      message: succeeded
        ? `Deleted Zoom summary for meeting ${meetingId} (direct API).`
        : `Delete could not be confirmed for meeting ${meetingId}. See stderr for diagnostics.`,
    };
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
