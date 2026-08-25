/**
 * Zoom authentication for the Obsidian plugin.
 *
 * Zoom SSO is fronted by Okta, which does not complete inside an embedded
 * Electron BrowserWindow — the sign-in widget never advances past the Okta
 * page, so no session is ever established. Opening the user's default browser
 * doesn't help either: cookies set there live in that browser's jar and are
 * unreachable from the plugin.
 *
 * So the plugin drives the same Puppeteer-based flow the CLI uses. `login()`
 * spawns `zoom-login.mjs` as a child process, which opens a real Chrome
 * window, waits for SSO to complete, and writes the session cookies to
 * ~/.zoom-mcp/cookies.json. The plugin then reads those cookies back. The user
 * never leaves Obsidian and never touches a terminal.
 *
 * Stored cookies are tested with a lightweight HEAD request first — if the
 * session is still valid, no browser opens at all.
 */

import type { SerializedCookie } from "./types";
import { notify } from "./types";
import { nodeRequest } from "./node-http";

/** Where the CLI (and therefore this plugin) keeps the Zoom session. */
function cookiesFilePath(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require("path");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const os = require("os");
  return path.join(os.homedir(), ".zoom-mcp", "cookies.json");
}

/** Result of running the login helper. */
interface SpawnResult {
  code: number | null;
  output: string;
}

export class ZoomAuth {
  private subdomain: string;
  private cookies: SerializedCookie[];
  private persistCookies: (cookies: SerializedCookie[]) => Promise<void>;
  private debug: boolean;
  /** Absolute path to the repo root containing zoom-login.mjs. */
  private cliPath: string;

  constructor(opts: {
    subdomain: string;
    cookies: SerializedCookie[];
    persistCookies: (cookies: SerializedCookie[]) => Promise<void>;
    debug?: boolean;
    cliPath?: string;
  }) {
    this.subdomain = opts.subdomain;
    this.cookies = opts.cookies;
    this.persistCookies = opts.persistCookies;
    this.debug = opts.debug ?? false;
    this.cliPath = opts.cliPath ?? "";
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

  /** Point the plugin at the repo checkout that holds zoom-login.mjs. */
  setCliPath(cliPath: string): void {
    this.cliPath = cliPath;
  }

  getCliPath(): string {
    return this.cliPath;
  }

  setDebug(debug: boolean): void {
    this.debug = debug;
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

  // ── Cookie file (shared with the CLI) ──────────────────────

  /** Read the cookie jar the CLI writes, or null if it isn't there. */
  private readCookieFile(): SerializedCookie[] | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require("fs");
      const file = cookiesFilePath();
      if (!fs.existsSync(file)) return null;
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Array<
        SerializedCookie & { expires?: number; session?: boolean }
      >;
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      // Puppeteer writes `expires` (epoch seconds, -1 for session cookies);
      // Electron's cookies.set wants `expirationDate`. Without this mapping
      // every restored cookie silently becomes a session cookie.
      return parsed.map((c) => {
        const { expires, session, ...rest } = c;
        const expirationDate =
          rest.expirationDate ??
          (typeof expires === "number" && expires > 0 ? expires : undefined);
        return expirationDate === undefined
          ? (rest as SerializedCookie)
          : ({ ...rest, expirationDate } as SerializedCookie);
      });
    } catch (e) {
      this.dbg("Could not read cookie file:", (e as Error).message);
      return null;
    }
  }

  /**
   * Adopt cookies written by the CLI whenever they differ from what we hold.
   *
   * Keying on the session cookie rather than on `this.cookies.length === 0`
   * matters: a stale jar in data.json would otherwise permanently shadow a
   * freshly written CLI session, so a successful re-login would have no effect.
   */
  private async loadSharedCliCookies(): Promise<void> {
    const cliCookies = this.readCookieFile();
    if (!cliCookies) return;

    const sessionId = (cookies: SerializedCookie[]): string =>
      cookies.find((c) => c.name === "_zm_ssid")?.value ?? "";

    const incoming = sessionId(cliCookies);
    if (this.cookies.length > 0 && incoming === sessionId(this.cookies)) return;

    this.dbg(`Loaded ${cliCookies.length} cookies from ${cookiesFilePath()}`);
    this.cookies = cliCookies;
    await this.persistCookies(cliCookies);
  }

  /** Delete the shared cookie file (used before a forced re-login). */
  private deleteCookieFile(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require("fs");
      const file = cookiesFilePath();
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        this.dbg("Deleted cookie file:", file);
      }
    } catch (e) {
      this.dbg("Could not delete cookie file:", (e as Error).message);
    }
  }

  // ── Session validation ─────────────────────────────────────

  /** Check whether stored cookies still grant access. */
  async isAuthenticated(): Promise<boolean> {
    // Pick up a session the CLI may have established.
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

  // ── Login (spawns the Puppeteer helper) ────────────────────

  /**
   * Candidate Node binaries, most-likely-to-work first.
   *
   * Obsidian launched from Finder often has a minimal PATH that omits
   * Homebrew/nvm, so a bare `node` can fail. Electron's own binary can run as
   * plain Node via ELECTRON_RUN_AS_NODE, which is always present — that's the
   * last-resort fallback.
   */
  private nodeCandidates(): Array<{ cmd: string; asNode: boolean }> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs");
    const candidates: Array<{ cmd: string; asNode: boolean }> = [];

    for (const p of [
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
    ]) {
      try {
        if (fs.existsSync(p)) candidates.push({ cmd: p, asNode: false });
      } catch {
        // Ignore probe failures and try the next path.
      }
    }

    candidates.push({ cmd: "node", asNode: false });
    candidates.push({ cmd: process.execPath, asNode: true });
    return candidates;
  }

  /** Run one candidate binary against the login script. */
  private runLoginScript(
    cmd: string,
    asNode: boolean,
    scriptPath: string,
    args: string[],
    timeoutMs: number
  ): Promise<SpawnResult> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require("child_process");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("path");

    return new Promise<SpawnResult>((resolve, reject) => {
      const env = { ...process.env };
      if (asNode) env.ELECTRON_RUN_AS_NODE = "1";
      else delete env.ELECTRON_RUN_AS_NODE;

      const child = spawn(cmd, [scriptPath, ...args], {
        cwd: path.dirname(scriptPath),
        env,
      });

      let output = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill();
        } catch {
          // Process may already be gone.
        }
        reject(new Error("Login timed out after 10 minutes"));
      }, timeoutMs);

      const capture = (buf: unknown) => {
        const text = String(buf);
        output += text;
        for (const line of text.split("\n")) {
          if (line.trim()) this.dbg("[login]", line.trim());
        }
      };

      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);

      child.on("error", (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });

      child.on("close", (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
  }

  /**
   * Authenticate by opening a real Chrome window via the Puppeteer helper.
   *
   * @param force Discard the existing session and sign in again.
   */
  async login(force = false): Promise<void> {
    if (!this.cliPath) {
      throw new Error(
        "Zoom CLI path is not set. Open plugin settings and set it to your " +
        "zoomObsidian repo checkout (the folder containing zoom-login.mjs)."
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("path");

    const scriptPath = path.join(this.cliPath, "zoom-login.mjs");
    if (!fs.existsSync(scriptPath)) {
      throw new Error(
        `zoom-login.mjs not found at ${scriptPath}. Check the Zoom CLI path in plugin settings.`
      );
    }
    if (!fs.existsSync(path.join(this.cliPath, "build", "zoom-browser.js"))) {
      throw new Error(
        `The CLI at ${this.cliPath} has not been built. Run "npm run build" there, then try again.`
      );
    }

    if (force) this.deleteCookieFile();

    const args: string[] = [];
    if (this.subdomain) args.push("--subdomain", this.subdomain);
    if (force) args.push("--force");

    const progress = notify(
      "Opening a browser window for Zoom sign-in. Complete the login there — Obsidian will continue automatically.",
      0
    );

    try {
      let result: SpawnResult | null = null;
      const spawnFailures: string[] = [];

      for (const { cmd, asNode } of this.nodeCandidates()) {
        try {
          this.dbg("Launching login helper with:", cmd, asNode ? "(as node)" : "");
          result = await this.runLoginScript(cmd, asNode, scriptPath, args, 600_000);
          break;
        } catch (e) {
          const msg = (e as NodeJS.ErrnoException).code === "ENOENT"
            ? `${cmd}: not found`
            : `${cmd}: ${(e as Error).message}`;
          this.dbg("Login helper launch failed —", msg);
          spawnFailures.push(msg);
          // A timeout is a real failure, not a missing binary — stop trying.
          if ((e as Error).message.includes("timed out")) throw e;
        }
      }

      if (!result) {
        throw new Error(
          `Could not run Node.js to start the login helper. Tried: ${spawnFailures.join("; ")}`
        );
      }

      if (result.code !== 0) {
        const tail = result.output.trim().split("\n").slice(-3).join(" | ");
        throw new Error(
          `Login helper exited with code ${result.code}${tail ? ` — ${tail}` : ""}`
        );
      }

      const cookies = this.readCookieFile();
      if (!cookies) {
        throw new Error("Login completed but no cookies were saved.");
      }

      this.cookies = cookies;
      await this.persistCookies(cookies);
      this.dbg("Saved", cookies.length, "cookies from login helper");
    } finally {
      progress.hide();
    }
  }

  /** Clear the stored session, both in the plugin and on disk. */
  async logout(): Promise<void> {
    this.cookies = [];
    await this.persistCookies([]);
    this.deleteCookieFile();
    notify("Zoom session cleared.");
  }
}
