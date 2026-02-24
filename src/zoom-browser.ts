/**
 * Puppeteer-based browser session management for Zoom.
 * Opens a visible browser for initial login, then saves/reuses cookies.
 */

import puppeteer, { Browser, Page, Cookie } from "puppeteer";
import { readFile, writeFile, mkdir } from "fs/promises";
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

      // Session expired — close and re-login
      console.error("Saved session expired. Opening browser for login...");
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

    // Wait for user to complete login (detected by returning to the Zoom domain on a non-auth page)
    console.error("Waiting for login to complete...");
    const expectedBase = this.baseUrl;
    await this.page.waitForFunction(
      (base: string) => {
        const url = window.location.href;
        return (
          url.startsWith(base) &&
          !url.includes("/signin") &&
          !url.includes("/login") &&
          !url.includes("/sso")
        );
      },
      { timeout: 300_000 }, // 5 minute timeout for login
      expectedBase
    );

    console.error("Login successful! Saving session...");
    const cookies = await this.page.cookies();
    await this.saveCookies(cookies);

    // Now switch to headless for actual work
    const headlessBrowser = await puppeteer.launch({ headless: true });
    const headlessPage = await headlessBrowser.newPage();
    await headlessPage.setCookie(...cookies);

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
