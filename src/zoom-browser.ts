/**
 * Puppeteer-based browser session management for Zoom.
 * Opens a visible browser for initial login, then saves/reuses cookies.
 */

import puppeteer, { Browser, Page, Cookie } from "puppeteer";
import { readFile, writeFile, mkdir, rm } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

const COOKIES_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".zoom-mcp"
);
const COOKIES_FILE = path.join(COOKIES_DIR, "cookies.json");

export interface ZoomBrowserConfig {
  /** The Zoom vanity subdomain, e.g. "acme" for acme.zoom.us. Leave empty for zoom.us. */
  zoomSubdomain?: string;
}

export class ZoomBrowser {
  private config: ZoomBrowserConfig;
  private browser: Browser | null = null;
  private page: Page | null = null;

  constructor(config: ZoomBrowserConfig = {}) {
    this.config = config;
  }

  get baseUrl(): string {
    const sub = this.config.zoomSubdomain;
    return sub ? `https://${sub}.zoom.us` : "https://zoom.us";
  }

  private async saveCookies(cookies: Cookie[]): Promise<void> {
    if (!existsSync(COOKIES_DIR)) {
      await mkdir(COOKIES_DIR, { recursive: true });
    }
    await writeFile(COOKIES_FILE, JSON.stringify(cookies, null, 2));
  }

  private async loadCookies(): Promise<Cookie[] | null> {
    try {
      const data = await readFile(COOKIES_FILE, "utf-8");
      return JSON.parse(data) as Cookie[];
    } catch {
      return null;
    }
  }

  private async deleteCookies(): Promise<void> {
    try {
      await rm(COOKIES_FILE);
      console.error("Deleted stale cookies file.");
    } catch {
      // File doesn't exist or already deleted, ignore
    }
  }

  /**
   * Ensure we have an authenticated browser page.
   * If saved cookies exist and are valid, reuse them.
   * Otherwise, open a visible browser for manual login.
   */
  async ensureAuthenticated(): Promise<Page> {
    if (this.page) {
      return this.page;
    }

    // Try loading saved cookies first (headless)
    const savedCookies = await this.loadCookies();
    if (savedCookies && savedCookies.length > 0) {
      console.error("Restoring saved Zoom session...");
      this.browser = await puppeteer.launch({ headless: true });
      this.page = await this.browser.newPage();
      await this.page.setCookie(...savedCookies);

      // Verify session is still valid
      const summariesUrl = `${this.baseUrl}/user/meeting/summary#/`;
      await this.page.goto(summariesUrl, { waitUntil: "networkidle2", timeout: 30000 });

      const currentUrl = this.page.url();
      if (
        currentUrl.startsWith(this.baseUrl) &&
        !currentUrl.includes("/signin") &&
        !currentUrl.includes("/login") &&
        !currentUrl.includes("/sso")
      ) {
        console.error("Session restored successfully.");
        return this.page;
      }

      // Session expired — delete stale cookies and re-login
      console.error("Saved session expired. Opening browser for login...");
      await this.deleteCookies();
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }

    // Open visible browser for manual login
    return this.interactiveLogin();
  }

  private async interactiveLogin(): Promise<Page> {
    console.error(
      "Opening browser for Zoom login. Please sign in, then the process will continue automatically."
    );

    this.browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      args: ["--window-size=1280,900"],
    });

    this.page = await this.browser.newPage();
    const signinUrl = `${this.baseUrl}/signin`;
    await this.page.goto(signinUrl, { waitUntil: "networkidle2" });

    // Wait for user to complete login (detected by page content changing from spinner)
    console.error("Waiting for login to complete...");
    await this.page.waitForFunction(
      () => {
        // Look for spinner/loading indicators disappearing
        const spinnerElements = document.querySelectorAll(
          '[class*="spinner"], [class*="loading"], [class*="loader"], .zm-spinner'
        );
        const hasVisibleSpinner = Array.from(spinnerElements).some(el => {
          const htmlEl = el as HTMLElement;
          return htmlEl.offsetParent !== null; // visible (not display:none)
        });

        // Check for actual Zoom page content (nav, headers, etc.)
        const hasPageContent = !!document.querySelector(
          '.zm-header, nav, [role="navigation"], main, [role="main"]'
        );

        // Success: no visible spinner AND page has content
        return !hasVisibleSpinner && hasPageContent;
      },
      { timeout: 300_000 } // 5 minute timeout for login
    );

    // Verify session is fully established by navigating to profile and checking for UI elements
    console.error("Verifying session stability...");
    try {
      await this.page.goto(`${this.baseUrl}/profile`, { waitUntil: "domcontentloaded", timeout: 15000 });
      await this.page.waitForSelector(
        '.zm-header .nar-avatar, .nav-right, [class*="user-avatar"]',
        { timeout: 10000 }
      );
    } catch (e) {
      console.error("Session verification failed. Cookies will be deleted for a fresh login on retry.");
      await this.deleteCookies();
      throw new Error(`Login appeared to succeed but Zoom profile page did not fully load. Session may be unstable. Error: ${e}`);
    }

    console.error("Login successful! Saving session...");
    const cookies = await this.page.cookies();
    await this.saveCookies(cookies);

    // Now switch to headless for actual work
    const headlessBrowser = await puppeteer.launch({ headless: true });
    const headlessPage = await headlessBrowser.newPage();
    await headlessPage.setCookie(...cookies);

    // Prime the headless page with the summaries URL to ensure it's authenticated
    await headlessPage.goto(`${this.baseUrl}/user/meeting/summary#/list`, { waitUntil: "domcontentloaded", timeout: 15000 });

    await this.browser.close();
    this.browser = headlessBrowser;
    this.page = headlessPage;

    return this.page;
  }

  /**
   * Navigate to a URL and return the page content.
   * Uses domcontentloaded (not networkidle2) to avoid timeouts on Zoom's SPA
   * which continuously polls in the background.
   */
  async navigateTo(url: string): Promise<Page> {
    const page = await this.ensureAuthenticated();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    return page;
  }

  /**
   * Intercept XHR/fetch responses to capture JSON data from Zoom's internal API.
   */
  async interceptJsonResponse(
    url: string,
    apiPattern: string
  ): Promise<unknown> {
    const page = await this.ensureAuthenticated();

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        page.removeAllListeners("response");
        reject(new Error("Timeout waiting for API response"));
      }, 30000);

      page.on("response", async (response) => {
        const responseUrl = response.url();
        if (responseUrl.includes(apiPattern)) {
          clearTimeout(timeout);
          try {
            const json = await response.json();
            resolve(json);
          } catch (e) {
            reject(new Error(`Failed to parse API response: ${e}`));
          }
        }
      });

      page.goto(url, { waitUntil: "networkidle2" }).catch(reject);
    });
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }
}
