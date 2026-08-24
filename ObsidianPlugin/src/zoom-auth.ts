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
const electron = require("electron");
const { BrowserWindow, session: electronSession } = electron.remote;

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

  /** Check whether stored cookies still grant access. */
  async isAuthenticated(): Promise<boolean> {
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
   * Resolves once the user has logged in and cookies are saved.
   */
  async login(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Use a dedicated partition so Zoom cookies don't leak to or from the
      // main Obsidian session
      const partition = "persist:zoom-obsidian";
      const ses = electronSession.fromPartition(partition);

      // Pre-load any previously saved cookies into this session so that
      // SSO providers that depend on prior Zoom cookies can complete the flow.
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
        }).catch(() => {/* ignore individual failures */})
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

          // Success: URL left auth paths AND we're at a real Zoom page (not auth/SSO)
          const leftAuthPaths =
            url.startsWith(this.baseUrl) &&
            !url.includes("/signin") &&
            !url.includes("/login") &&
            !url.includes("/sso") &&
            !url.includes("/auth") &&
            !url.includes("samlredirect");

          // Also require that we're at a substantive Zoom page (has path)
          const isSubstantivePage = url.length > (this.baseUrl.length + 10);

          if (leftAuthPaths && isSubstantivePage) {
            this.dbg("Login detected — URL:", url.split("?")[0], "title:", title);
            loginDetected = true;
            clearInterval(pollInterval);
            extractCookies();
          }
        };

        const extractCookies = async () => {
          try {
            const allCookies = await ses.cookies.get({});
            const zoomCookies: SerializedCookie[] = allCookies
              .filter((c: { domain: string }) => c.domain.includes("zoom.us"))
              .map((c: { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; expirationDate?: number }) => ({
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path,
                secure: c.secure,
                httpOnly: c.httpOnly,
                expirationDate: c.expirationDate,
              }));
            this.cookies = zoomCookies;
            await this.persistCookies(zoomCookies);
            notify("Zoom login successful — cookies saved.");
            this.dbg("Saved", zoomCookies.length, "cookies");
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

  /** Clear stored cookies. */
  async logout(): Promise<void> {
    this.cookies = [];
    await this.persistCookies([]);
    notify("Zoom session cleared.");
  }
}
