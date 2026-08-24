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

  private async validateChrome(): Promise<void> {
    try {
      const browser = await puppeteer.launch({ headless: true });
      await browser.close();
    } catch (e) {
      throw new Error(
        `Chrome/Chromium not found. Install it with:\n` +
        `  npx puppeteer browsers install chrome\n\n` +
        `Error details: ${e}`
      );
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

    // Validate Chrome is available before proceeding
    await this.validateChrome();

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
    // Delete any stale cookies before starting fresh login
    await this.deleteCookies();

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

    // Wait for user to complete login (page title changes from "Cvent - Sign In" or URL leaves auth paths)
    console.error("Waiting for login to complete. Check browser window and complete any remaining auth steps...");
    await this.page.waitForFunction(
      () => {
        const url = window.location.href;
        const title = document.title || "";

        // Success conditions:
        // 1. URL left auth paths (no /signin, /login, /sso in path)
        // 2. OR page title changed (indicating page loaded)
        const leftAuthPath = url.includes(this.baseUrl) &&
                            !url.includes("/signin") &&
                            !url.includes("/login") &&
                            !url.includes("/sso");
        const titleChanged = title && !title.includes("Sign In") && !title.includes("Cvent");

        return leftAuthPath || titleChanged;
      },
      { timeout: 60_000 }, // 60 second timeout — auth should complete quickly
      this.baseUrl
    );

    // At this point, we've confirmed we left auth pages. Session is established.
    console.error("Login successful! Capturing cookies...");
    const cookies = await this.page.cookies();
    console.error(`Captured ${cookies.length} cookies`);

    if (!cookies || cookies.length === 0) {
      console.error("ERROR: No cookies found after login. Session may be invalid.");
      await this.deleteCookies();
      throw new Error("Login appeared to succeed but no session cookies were captured.");
    }

    console.error("Saving cookies to disk...");
    await this.saveCookies(cookies);
    console.error("Cookies saved successfully.");

    console.error("Switching to headless browser...");
    const headlessBrowser = await puppeteer.launch({ headless: true });
    const headlessPage = await headlessBrowser.newPage();
    console.error("Setting cookies on headless page...");
    await headlessPage.setCookie(...cookies);

    console.error("Navigating to summaries page...");
    try {
      await headlessPage.goto(`${this.baseUrl}/user/meeting/summary#/list`, { waitUntil: "domcontentloaded", timeout: 15000 });
      console.error("Summaries page loaded.");
    } catch (e) {
      console.error(`Failed to load summaries page: ${e}`);
      throw e;
    }

    console.error("Closing visible browser...");
    await this.browser.close();
    this.browser = headlessBrowser;
    this.page = headlessPage;

    console.error("Authentication complete!");
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
