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

import { Notice } from "obsidian";
import type { SerializedCookie } from "./types";
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
    try {
      const res = await nodeRequest(`${this.baseUrl}/user/meeting/summary`, {
        method: "HEAD",
        headers: { Cookie: this.getCookieHeader() },
        followRedirects: false,
      });
      // Zoom redirects to /signin when unauthenticated
      const loc = res.headers["location"] ?? "";
      const ok =
        res.status >= 200 &&
        res.status < 400 &&
        !loc.includes("/signin") &&
        !loc.includes("/login") &&
        !loc.includes("/sso");
      this.dbg("isAuthenticated check:", res.status, ok);
      return ok;
    } catch (e) {
      this.dbg("isAuthenticated error:", e);
      return false;
    }
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

        // Detect successful login by URL change
        const checkUrl = () => {
          const url = win.webContents.getURL();
          if (
            url.startsWith(this.baseUrl) &&
            !url.includes("/signin") &&
            !url.includes("/login") &&
            !url.includes("/sso")
          ) {
            this.dbg("Login detected at URL:", url);
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
            new Notice("Zoom login successful — cookies saved.");
            this.dbg("Saved", zoomCookies.length, "cookies");
            win.close();
            resolve();
          } catch (e) {
            reject(e);
          }
        };

        win.webContents.on("did-navigate", checkUrl);
        win.webContents.on("did-navigate-in-page", checkUrl);
        win.on("closed", () => {
          // If the window is closed before login, just resolve silently
          resolve();
        });

        win.loadURL(signinUrl);
      });
    });
  }

  /** Clear stored cookies. */
  async logout(): Promise<void> {
    this.cookies = [];
    await this.persistCookies([]);
    new Notice("Zoom session cleared.");
  }
}
