/**
 * Zoom authentication via Electron BrowserWindow.
 *
 * Opens a BrowserWindow pointed at {subdomain}.zoom.us/signin for the user
 * to complete SSO / password login.  After login, cookies are extracted from
 * the BrowserWindow session and persisted via the plugin's saveData().
 *
 * On subsequent calls, stored cookies are tested with a lightweight HEAD
 * request — if still valid the BrowserWindow is skipped entirely.
 */

import type { SerializedCookie } from "./types";
import { notify } from "./types";
import { nodeRequest } from "./node-http";

// Electron is externalized by esbuild — available at runtime in Obsidian desktop
// eslint-disable-next-line @typescript-eslint/no-var-requires
let BrowserWindow: any;
let electronSession: any;
try {
  const electron = require("electron");
  BrowserWindow = electron.remote?.BrowserWindow;
  electronSession = electron.remote?.session;
} catch (e) {
  console.error("[zoom-auth] Failed to load Electron:", e);
}

export class ZoomAuth {
  private subdomain: string;
  private cookies: SerializedCookie[];
  private persistCookies: (cookies: SerializedCookie[]) => Promise<void>;
  private debug: boolean;

  constructor(opts: {
    subdomain: string;
    cookies: SerializedCookie[];
    persistCookies: (cookies: SerializedCookie[]) => Promise<void>;
    debug?: boolean;
  }) {
    this.subdomain = opts.subdomain;
    this.cookies = opts.cookies;
    this.persistCookies = opts.persistCookies;
    this.debug = opts.debug ?? false;
  }

  get baseUrl(): string {
    return this.subdomain
      ? `https://${this.subdomain}.zoom.us`
      : "https://zoom.us";
  }

  /** Update subdomain at runtime (e.g. from settings change). */
  setSubdomain(subdomain: string): void {
    this.subdomain = subdomain;
  }

  /** Replace in-memory cookies (e.g. after loadData). */
  setCookies(cookies: SerializedCookie[]): void {
    this.cookies = cookies;
  }

  private dbg(...args: unknown[]): void {
    if (this.debug) console.log("[zoom-auth]", ...args);
  }

  /**
   * Build a Cookie header string from stored cookies,
   * filtering to those that match zoom.us domains.
   */
  getCookieHeader(): string {
    return this.cookies
      .filter((c) => c.domain.includes("zoom.us"))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  /** Return a copy of the serialized cookies (for BrowserWindow session loading). */
  getSerializedCookies(): SerializedCookie[] {
    return [...this.cookies];
  }

  /**
   * Try to load cookies from CLI's shared location if plugin cookies are missing.
   */
  private async loadSharedCliCookies(): Promise<void> {
    if (this.cookies.length > 0) return; // Already have cookies

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require("fs");
      const path = require("path");
      const os = require("os");

      const cliCookiesPath = path.join(os.homedir(), ".zoom-mcp", "cookies.json");
      if (fs.existsSync(cliCookiesPath)) {
        const data = fs.readFileSync(cliCookiesPath, "utf-8");
        const cliCookies = JSON.parse(data) as SerializedCookie[];
        if (cliCookies.length > 0) {
          this.dbg(`Loaded ${cliCookies.length} cookies from CLI at ${cliCookiesPath}`);
          this.cookies = cliCookies;
          await this.persistCookies(cliCookies);
          notify("Using Zoom session from CLI authentication.");
        }
      }
    } catch (e) {
      this.dbg("Could not load CLI cookies:", (e as Error).message);
    }
  }

  /** Check whether stored cookies still grant access. */
  async isAuthenticated(): Promise<boolean> {
    // First, try to load CLI cookies if we don't have any
    await this.loadSharedCliCookies();

    if (!this.cookies.length) return false;

    // Try the HEAD check up to twice before giving up — transient network
    // blips should not look like an expired session.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await nodeRequest(`${this.baseUrl}/user/meeting/summary`, {
          method: "HEAD",
          headers: { Cookie: this.getCookieHeader() },
          followRedirects: false,
        });
        // Zoom redirects to /signin when unauthenticated
        const loc = res.headers["location"] ?? "";
        const isAuthRedirect =
          loc.includes("/signin") ||
          loc.includes("/login") ||
          loc.includes("/sso");
        // Treat server errors (5xx) as transient — don't conclude the session
        // is invalid just because Zoom had a hiccup.
        const isServerError = res.status >= 500;
        const ok =
          res.status >= 200 &&
          res.status < 400 &&
          !isAuthRedirect;
        this.dbg(`isAuthenticated attempt ${attempt}:`, res.status, ok);

        if (ok) return true;
        if (isServerError && attempt < 2) {
          this.dbg("Server error on attempt", attempt, "— retrying...");
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        this.dbg("Session invalid.");
        return false;
      } catch (e) {
        this.dbg(`isAuthenticated error (attempt ${attempt}):`, e);
        if (attempt < 2) {
          this.dbg("Network error — retrying...");
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        this.dbg("Network error persists.");
        return false;
      }
    }
    return false;
  }

  /**
   * Open a BrowserWindow for the user to complete Zoom login.
   * Falls back to polling if BrowserWindow is not available.
   * Resolves once the user has logged in and cookies are saved.
   */
  async login(): Promise<void> {
    // If BrowserWindow is not available, use polling fallback
    if (!BrowserWindow || !electronSession) {
      return this.loginViaPolling();
    }

    // Delete any stale cookies before starting fresh login
    await this.deleteCookies();

    return new Promise<void>((resolve, reject) => {
      // Use a dedicated partition so Zoom cookies don't leak to or from the
      // main Obsidian session
      const partition = "persist:zoom-obsidian";
      const ses = electronSession.fromPartition(partition);

      // Pre-load all previously saved cookies into this session.
      // This includes Okta session cookies which are essential for SSO to complete.
      const loadPromises = this.cookies.map((c) =>
        ses.cookies.set({
          url: `https://${c.domain.replace(/^\./, "")}${c.path}`,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          expirationDate: c.expirationDate,
        }).catch((e) => {
          this.dbg(`Failed to set cookie ${c.name} on domain ${c.domain}: ${(e as Error).message}`);
        })
      );

      Promise.all(loadPromises).then(() => {
        const win = new BrowserWindow({
          width: 1024,
          height: 720,
          title: "Zoom Login — Obsidian Plugin",
          webPreferences: {
            partition,
            nodeIntegration: false,
            contextIsolation: true,
          },
        });

        const signinUrl = `${this.baseUrl}/signin`;
        let loginDetected = false;

        // Detect successful login by URL change or page title
        const checkUrl = () => {
          if (loginDetected) return; // Already detected, ignore further checks
          const url = win.webContents.getURL();
          const title = win.getTitle();

          this.dbg(`[check] URL: ${url.split("?")[0]}, title: "${title}"`);

          // Success condition 1: URL left auth paths (even if stuck at Okta, that's part of SSO flow)
          const leftAuthPaths =
            !url.includes("/signin") &&
            !url.includes("/login") &&
            !url.includes("/sso") &&
            !url.includes("/auth") &&
            !url.includes("samlredirect");

          // Success condition 2: Page title changed from "Sign In" or "Cvent" (indicates authenticated page loaded)
          const titleChanged = title &&
            !title.includes("Sign In") &&
            !title.includes("Cvent") &&
            title.length > 5; // Avoid empty/placeholder titles

          // Success if EITHER:
          // - We left auth paths AND are at a substantive page, OR
          // - Page title changed (indicates we reached an authenticated page even if URL is at Okta)
          const isSubstantivePage = url.length > (this.baseUrl.length + 10);
          const success = (leftAuthPaths && isSubstantivePage) || titleChanged;

          if (success) {
            this.dbg("Login detected — URL:", url.split("?")[0], "title:", title);
            loginDetected = true;
            clearInterval(pollInterval);
            extractCookies();
          }
        };

        const extractCookies = async () => {
          try {
            // Navigate to a known Zoom page to ensure session is stable before extracting cookies
            this.dbg("Navigating to Zoom profile page to stabilize session...");
            await win.webContents.loadURL(`${this.baseUrl}/profile`);

            // Wait briefly for profile page to fully load
            await new Promise<void>((resolve) => {
              setTimeout(() => resolve(), 1000);
            });

            const allCookies = await ses.cookies.get({});
            // Save both Zoom and Okta cookies — Okta cookies are needed for SSO on next auth
            const relevantCookies: SerializedCookie[] = allCookies
              .filter((c: { domain: string }) => c.domain.includes("zoom.us") || c.domain.includes("okta.com"))
              .map((c: { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; expirationDate?: number }) => ({
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path,
                secure: c.secure,
                httpOnly: c.httpOnly,
                expirationDate: c.expirationDate,
              }));
            this.cookies = relevantCookies;
            await this.persistCookies(relevantCookies);
            notify("Zoom login successful — cookies saved.");
            this.dbg("Saved", relevantCookies.length, "cookies (zoom.us + okta.com domains)");
            win.close();
            resolve();
          } catch (e) {
            reject(e);
          }
        };

        // Listen for navigation events
        win.webContents.on("did-navigate", checkUrl);
        win.webContents.on("did-navigate-in-page", checkUrl);

        // Also poll every 500ms in case the page changes without triggering navigation events
        // (e.g., Zoom's SSO spinner staying on same URL)
        const pollInterval = setInterval(checkUrl, 500);

        // Timeout after 5 minutes
        const loginTimeout = setTimeout(() => {
          if (!loginDetected) {
            this.dbg("Login timeout after 5 minutes");
            clearInterval(pollInterval);
            win.close();
            reject(new Error("Login timeout — please try again"));
          }
        }, 300_000);

        win.on("closed", () => {
          clearInterval(pollInterval);
          clearTimeout(loginTimeout);
          // If the window is closed before login, just resolve silently
          if (!loginDetected) {
            resolve();
          }
        });

        win.loadURL(signinUrl);
      });
    });
  }

  /**
   * Fallback login: open system browser and poll for authentication.
   * Called when BrowserWindow is not available.
   */
  private async loginViaPolling(): Promise<void> {
    const signinUrl = `${this.baseUrl}/signin`;

    try {
      console.log("[zoom-auth] loginViaPolling started");
      this.dbg("loginViaPolling: attempting to open browser at", signinUrl);

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const electron = require("electron");
      console.log("[zoom-auth] electron module loaded");

      const shell = electron?.remote?.shell || electron?.shell;
      if (!shell) {
        console.error("[zoom-auth] shell module not found");
        throw new Error("Cannot access system shell — unable to open browser");
      }

      notify("Opening Zoom login in your default browser. Please complete authentication, then return to Obsidian.");
      console.log("[zoom-auth] About to open external URL:", signinUrl);

      // Open in system browser
      await shell.openExternal(signinUrl);
      console.log("[zoom-auth] openExternal completed");

      // Poll for authentication (check every 2 seconds for up to 10 minutes)
      const maxAttempts = 300;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise(r => setTimeout(r, 2000)); // Wait 2 seconds

        const authed = await this.isAuthenticated();
        if (authed) {
          this.dbg("Polling detected successful authentication after", (attempt + 1) * 2, "seconds");
          notify("Authentication detected — sync will proceed.");
          return;
        }

        if (attempt % 30 === 0 && attempt > 0) {
          this.dbg(`Still waiting for authentication (${attempt}/${maxAttempts} checks)...`);
        }
      }

      throw new Error("Login timeout — authentication did not complete within 10 minutes");
    } catch (e) {
      throw new Error(`Login failed: ${(e as Error).message}`);
    }
  }

  /** Delete the saved cookies file (used before fresh login). */
  private async deleteCookies(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require("fs");
      const path = require("path");
      const os = require("os");

      const cliCookiesPath = path.join(os.homedir(), ".zoom-mcp", "cookies.json");
      if (fs.existsSync(cliCookiesPath)) {
        fs.unlinkSync(cliCookiesPath);
        this.dbg("Deleted stale cookies file:", cliCookiesPath);
      }
    } catch (e) {
      this.dbg("Could not delete cookies file:", (e as Error).message);
    }
  }

  /** Clear stored cookies. */
  async logout(): Promise<void> {
    this.cookies = [];
    await this.persistCookies([]);
    await this.deleteCookies();
    notify("Zoom session cleared.");
  }
}
