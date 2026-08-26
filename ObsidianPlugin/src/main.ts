/**
 * Zoom Meeting Summaries — Obsidian plugin entry point.
 *
 * Syncs Zoom AI meeting summaries into 1:1 notes in the vault.
 * Uses Electron BrowserWindow for Zoom SSO authentication and direct
 * fetch() calls to Zoom's internal REST API.
 *
 * Desktop-only (requires Electron APIs for auth).
 */

import { Modal, Notice, Plugin, type App, TFolder } from "obsidian";
import { DEFAULT_SETTINGS, DEFAULT_CONFIG_STATE, notify, type ZoomObsidianSettings, type ObsidianConfigState } from "./types";
import { ZoomAuth } from "./zoom-auth";
import { ZoomClient } from "./zoom-client";
import { VaultWriter } from "./vault-writer";
import { SyncOrchestrator, type SyncReport } from "./sync-orchestrator";
import { ZoomObsidianSettingTab } from "./settings";

export default class ZoomObsidianPlugin extends Plugin {
  settings!: ZoomObsidianSettings;
  configState!: ObsidianConfigState;
  auth!: ZoomAuth;
  client!: ZoomClient;
  private writer!: VaultWriter;

  /** Repo path written by install.sh; used when the setting is blank. */
  private detectedCliPath = "";

  /** Verbose console logging, gated on the Debug Logging setting. */
  private dbg(...args: unknown[]): void {
    if (this.settings?.debug) console.log("[zoom-obsidian]", ...args);
  }

  /** Prevent overlapping sync commands from sharing the scrape window and caches. */
  private syncInProgress = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.loadConfigState();
    await this.loadDetectedCliPath();

    this.auth = new ZoomAuth({
      subdomain: this.settings.zoomSubdomain,
      cookies: this.settings.cookies,
      persistCookies: async (cookies) => {
        this.settings.cookies = cookies;
        await this.saveSettings();
      },
      debug: this.settings.debug,
      cliPath: this.resolveCliPath(),
    });

    this.client = new ZoomClient(this.auth, {
      debug: this.settings.debug,
    });
    if (this.settings.zoomAccountId) this.client.setAccountId(this.settings.zoomAccountId);

    this.writer = new VaultWriter(this.app, {
      vaultSubfolder: this.settings.vaultSubfolder,
      oneOnOneFolders: this.parseOneFolders(),
      myDisplayName: this.settings.myDisplayName || undefined,
    });

    // Register commands
    this.addCommand({
      id: "zoom-obsidian-sync",
      name: "Sync Zoom summaries",
      callback: () => this.runSync(),
    });

    this.addCommand({
      id: "zoom-obsidian-login",
      name: "Login to Zoom",
      callback: () => this.doLogin(),
    });

    this.addCommand({
      id: "zoom-obsidian-list",
      name: "List Zoom summaries",
      callback: () => this.showSummaryList(),
    });

    this.addCommand({
      id: "zoom-obsidian-logout",
      name: "Logout from Zoom",
      callback: () => this.logoutFromZoom(),
    });

    this.addCommand({
      id: "zoom-obsidian-diagnose",
      name: "Diagnose Zoom SPA (opens browser window + logs to console)",
      callback: () => this.runSpaDiagnosis(),
    });

    // Ribbon icon
    this.addRibbonIcon("refresh-cw", "Sync Zoom summaries", () =>
      this.runSync()
    );

    // Settings tab
    this.addSettingTab(new ZoomObsidianSettingTab(this.app, this));
  }

  onunload(): void {
    this.client?.closeScrapeWindow();
  }

  // ── Settings ──────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
  }

  /**
   * Read the repo path that install.sh drops next to the plugin, so login
   * works without the user configuring anything.
   */
  async loadDetectedCliPath(): Promise<void> {
    try {
      const raw = await this.app.vault.adapter.read(
        `${this.manifest.dir}/cli-path.json`
      );
      this.detectedCliPath = (JSON.parse(raw).cliPath as string) ?? "";
    } catch {
      // Not installed via install.sh — the setting is the only source.
      this.detectedCliPath = "";
    }
  }

  /** Explicit setting wins; otherwise fall back to what install.sh recorded. */
  private resolveCliPath(): string {
    return this.settings.cliPath.trim() || this.detectedCliPath;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Apply runtime changes
    if (this.auth) {
      this.auth.setSubdomain(this.settings.zoomSubdomain);
      this.auth.setCookies(this.settings.cookies);
      this.auth.setDebug(this.settings.debug);
      this.auth.setCliPath(this.resolveCliPath());
    }
    if (this.client) {
      this.client.setDebug(this.settings.debug);
    }
    if (this.writer) {
      this.writer.clearCache();
    }
  }

  async loadConfigState(): Promise<void> {
    try {
      const rawData = await this.app.vault.adapter.read(
        `${this.manifest.dir}/obsidian-config.json`
      );
      this.configState = Object.assign(
        {},
        DEFAULT_CONFIG_STATE,
        JSON.parse(rawData)
      );
    } catch {
      // File doesn't exist or is invalid; use defaults
      this.configState = Object.assign({}, DEFAULT_CONFIG_STATE);
    }
  }

  async saveConfigState(): Promise<void> {
    try {
      const configPath = `${this.manifest.dir}/obsidian-config.json`;
      await this.app.vault.adapter.write(
        configPath,
        JSON.stringify(this.configState, null, 2)
      );
    } catch (e) {
      console.error(
        "[zoom-obsidian] Failed to save config state:",
        (e as Error).message
      );
    }
  }

  private parseOneFolders(): string[] {
    return this.settings.oneOnOneFolders
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // ── Commands ──────────────────────────────────────────────

  /**
   * Check authentication and, if the session is expired, automatically open
   * the Zoom login window so the user can re-authenticate via SSO.
   * Returns true if authenticated and ready to proceed.
   */
  private async ensureAuthenticated(): Promise<boolean> {
    const checkNotice = notify("Checking Zoom authentication…", 0);

    try {
      const authed = await this.auth.isAuthenticated();
      checkNotice.hide();

      if (authed) {
        this.dbg("[auth] Session is valid");
        return true;
      }

      // Session expired — sign in via the browser-based login helper.
      try {
        await this.auth.login();
      } catch (e) {
        notify(`Zoom login failed: ${(e as Error).message}`);
        return false;
      }

      // Confirm the new session actually works before starting a sync.
      if (await this.auth.isAuthenticated()) {
        notify("Zoom login successful — continuing.");
        return true;
      }

      notify("Zoom login finished but the session is still not valid. Please try again.");
      return false;
    } catch (e) {
      checkNotice.hide();
      notify(`Authentication check failed: ${(e as Error).message}`);
      return false;
    }
  }

  private async doLogin(): Promise<void> {
    try {
      // Explicit login command — always start a fresh session.
      await this.auth.login(true);
      notify("Zoom login successful.");
    } catch (e) {
      notify(`Zoom login failed: ${(e as Error).message}`);
    }
  }

  /** Clear both the stored Zoom cookies and the persistent Electron session. */
  async logoutFromZoom(): Promise<void> {
    if (this.syncInProgress) {
      notify("A Zoom sync is already in progress. Wait for it to finish before logging out.");
      return;
    }

    let failure: unknown;
    try {
      await this.auth.logout();
    } catch (e) {
      failure = e;
    }

    try {
      await this.client.clearSession();
    } catch (e) {
      failure ??= e;
    }

    if (failure) {
      notify(`Zoom logout failed: ${(failure as Error).message}`);
    }
  }

  private async runSync(): Promise<void> {
    if (this.syncInProgress) {
      notify("A Zoom sync is already in progress. The second request was skipped.");
      return;
    }
    this.syncInProgress = true;

    try {
      if (!(await this.ensureAuthenticated())) return;

      // Validate shared meetings folder exists if specified
      if (this.settings.sharedMeetingsFolder?.trim()) {
        const folderPath = this.settings.sharedMeetingsFolder.trim();
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder || !(folder instanceof TFolder)) {
          notify(
            `Error: Shared Meetings folder does not exist: "${folderPath}". Please create it or update the setting.`
          );
          return;
        }
      }

      // Apply latest settings to client/writer
      this.client.setAccountId(this.settings.zoomAccountId ?? "");
      // Rebuild writer in case settings changed
      this.writer = new VaultWriter(this.app, {
        vaultSubfolder: this.settings.vaultSubfolder,
        oneOnOneFolders: this.parseOneFolders(),
        myDisplayName: this.settings.myDisplayName || undefined,
      });

      const orchestrator = new SyncOrchestrator(this.client, this.writer, {
        debug: this.settings.debug,
        sharedMeetingsFolder: this.settings.sharedMeetingsFolder || undefined,
        lastProcessedShared: this.configState.lastProcessedShared,
        myDisplayName: this.settings.myDisplayName || undefined,
      });

      // Show progress via Notice
      let lastNotice: Notice | undefined;
      orchestrator.onProgress = (msg) => {
        lastNotice?.hide();
        lastNotice = notify(msg, 0);
      };

      try {
        const report = await orchestrator.run({
          filter: this.settings.filter || undefined,
          autoDelete: this.settings.autoDelete,
        });
        lastNotice?.hide();

        // Persist updated scan timestamps
        if (report.updatedLastProcessedShared) {
          this.configState.lastProcessedShared = report.updatedLastProcessedShared;
          await this.saveConfigState();
        }

        new SyncReportModal(this.app, report).open();
      } catch (e) {
        lastNotice?.hide();
        const msg = (e as Error).message;
        if (
          msg.includes("session expired") ||
          msg.includes("log in")
        ) {
          notify(
            "Zoom session expired. Please re-login via Settings or the Login to Zoom command."
          );
        } else {
          notify(`Sync failed: ${msg}`);
        }
      }
    } finally {
      this.client.closeScrapeWindow();
      this.syncInProgress = false;
    }
  }

  private async runSpaDiagnosis(): Promise<void> {
    if (!(await this.ensureAuthenticated())) return;
    notify("Opening Zoom SPA in browser window — check Obsidian console (Ctrl+Shift+I) for full report.", 8000);
    try {
      const report = await this.client.diagnoseSpa();
      // Show a condensed version in a modal
      new DiagnosticModal(this.app, report).open();
    } catch (e) {
      notify(`Diagnosis failed: ${(e as Error).message}`);
    }
  }

  private async showSummaryList(): Promise<void> {
    if (!(await this.ensureAuthenticated())) return;

    notify("Fetching Zoom summaries...", 0);
    try {
      const meetings = await this.client.listSummaries();
      new Notice("", 1); // dismiss
      new SummaryListModal(this.app, meetings).open();
    } catch (e) {
      notify(`Failed to list summaries: ${(e as Error).message}`);
    } finally {
      this.client.closeScrapeWindow();
    }
  }
}

// ── Modals ────────────────────────────────────────────────────

class SyncReportModal extends Modal {
  private report: SyncReport;

  constructor(app: App, report: SyncReport) {
    super(app);
    this.report = report;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("zoom-sync-modal");
    contentEl.createEl("h2", { text: "Zoom Sync Results" });

    const { written, skipped, errors, deleted, deleteFailed } = this.report;
    contentEl.createEl("p", {
      cls: "zoom-sync-status",
      text: `${written} written, ${skipped} skipped, ${errors} errors` +
        (deleted || deleteFailed
          ? `, ${deleted} deleted, ${deleteFailed} delete failures`
          : ""),
    });

    if (this.report.results.length > 0) {
      const table = contentEl.createEl("table", { cls: "zoom-sync-table" });
      const thead = table.createEl("thead");
      const headerRow = thead.createEl("tr");
      headerRow.createEl("th", { text: "Topic" });
      headerRow.createEl("th", { text: "File" });
      headerRow.createEl("th", { text: "Status" });

      const tbody = table.createEl("tbody");
      for (const r of this.report.results) {
        const row = tbody.createEl("tr");
        row.createEl("td", { text: r.topic });
        row.createEl("td", { text: r.file ?? "—" });
        row.createEl("td", { text: r.status });
      }
    }

    const actions = contentEl.createDiv({ cls: "zoom-sync-actions" });
    const closeBtn = actions.createEl("button", { text: "Close" });
    closeBtn.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class DiagnosticModal extends Modal {
  private report: string;
  constructor(app: App, report: string) {
    super(app);
    this.report = report;
  }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Zoom SPA Diagnostics" });
    contentEl.createEl("p", { text: "Full report logged to Obsidian developer console (Ctrl+Shift+I / Cmd+Opt+I). Summary:" });
    const lines = this.report.split("\n");
    const selectorSection = lines.filter(l => l.includes("✓") || l.includes("✗") || l.startsWith("===") || l.startsWith("href:") || l.startsWith("hash:") || l.startsWith("table count:"));
    const pre = contentEl.createEl("pre");
    pre.style.cssText = "white-space:pre-wrap;font-size:11px;max-height:400px;overflow-y:auto;background:#1e1e1e;color:#d4d4d4;padding:10px;border-radius:4px;";
    pre.textContent = selectorSection.join("\n");
    const btn = contentEl.createEl("button", { text: "Close" });
    btn.addEventListener("click", () => this.close());
  }
  onClose(): void { this.contentEl.empty(); }
}

class SummaryListModal extends Modal {
  private meetings: Array<Record<string, unknown>>;

  constructor(app: App, meetings: Array<Record<string, unknown>>) {
    super(app);
    this.meetings = meetings;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("zoom-sync-modal");
    contentEl.createEl("h2", { text: "Zoom Meeting Summaries" });
    contentEl.createEl("p", {
      text: `${this.meetings.length} summaries found.`,
    });

    if (this.meetings.length > 0) {
      const table = contentEl.createEl("table", { cls: "zoom-sync-table" });
      const thead = table.createEl("thead");
      const headerRow = thead.createEl("tr");
      headerRow.createEl("th", { text: "Topic" });
      headerRow.createEl("th", { text: "ID" });
      headerRow.createEl("th", { text: "Date" });

      const tbody = table.createEl("tbody");
      for (const m of this.meetings) {
        const row = tbody.createEl("tr");
        row.createEl("td", {
          text: (
            m.meeting_topic ??
            m.column_1 ??
            ""
          ).toString(),
        });
        row.createEl("td", {
          text: (m.column_2 ?? m.meeting_id ?? "").toString(),
        });
        row.createEl("td", {
          text: (m.column_4 ?? m.meeting_start_time ?? "").toString(),
        });
      }
    }

    const actions = contentEl.createDiv({ cls: "zoom-sync-actions" });
    const closeBtn = actions.createEl("button", { text: "Close" });
    closeBtn.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
