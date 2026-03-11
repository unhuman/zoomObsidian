/**
 * Zoom Meeting Summaries — Obsidian plugin entry point.
 *
 * Syncs Zoom AI meeting summaries into 1:1 notes in the vault.
 * Uses Electron BrowserWindow for Zoom SSO authentication and direct
 * fetch() calls to Zoom's internal REST API.
 *
 * Desktop-only (requires Electron APIs for auth).
 */

import { Modal, Notice, Plugin, type App } from "obsidian";
import { DEFAULT_SETTINGS, type ZoomObsidianSettings } from "./types";
import { ZoomAuth } from "./zoom-auth";
import { ZoomClient } from "./zoom-client";
import { VaultWriter } from "./vault-writer";
import { SyncOrchestrator, type SyncReport } from "./sync-orchestrator";
import { ZoomObsidianSettingTab } from "./settings";

export default class ZoomObsidianPlugin extends Plugin {
  settings!: ZoomObsidianSettings;
  auth!: ZoomAuth;
  private client!: ZoomClient;
  private writer!: VaultWriter;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.auth = new ZoomAuth({
      subdomain: this.settings.zoomSubdomain,
      cookies: this.settings.cookies,
      persistCookies: async (cookies) => {
        this.settings.cookies = cookies;
        await this.saveSettings();
      },
      debug: this.settings.debug,
    });

    this.client = new ZoomClient(this.auth, {
      debug: this.settings.debug,
    });

    this.writer = new VaultWriter(this.app, {
      vaultSubfolder: this.settings.vaultSubfolder,
      oneOnOneFolders: this.parseOneFolders(),
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
      callback: () => this.auth.logout(),
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

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Apply runtime changes
    if (this.auth) {
      this.auth.setSubdomain(this.settings.zoomSubdomain);
      this.auth.setCookies(this.settings.cookies);
    }
    if (this.client) {
      this.client.setDebug(this.settings.debug);
    }
    if (this.writer) {
      this.writer.clearCache();
    }
  }

  private parseOneFolders(): string[] {
    return this.settings.oneOnOneFolders
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // ── Commands ──────────────────────────────────────────────

  private async doLogin(): Promise<void> {
    try {
      await this.auth.login();
    } catch (e) {
      new Notice(`Zoom login failed: ${(e as Error).message}`);
    }
  }

  private async runSync(): Promise<void> {
    // Check auth first
    const authed = await this.auth.isAuthenticated();
    if (!authed) {
      new Notice(
        "Not logged in to Zoom. Please log in first (Settings → Zoom Meeting Summaries, or run the Login to Zoom command)."
      );
      return;
    }

    // Rebuild writer in case settings changed
    this.writer = new VaultWriter(this.app, {
      vaultSubfolder: this.settings.vaultSubfolder,
      oneOnOneFolders: this.parseOneFolders(),
    });

    const orchestrator = new SyncOrchestrator(this.client, this.writer, {
      debug: this.settings.debug,
    });

    // Show progress via Notice
    let lastNotice: Notice | undefined;
    orchestrator.onProgress = (msg) => {
      lastNotice?.hide();
      lastNotice = new Notice(msg, 0);
    };

    try {
      const report = await orchestrator.run({
        filter: this.settings.filter || undefined,
        autoDelete: this.settings.autoDelete,
      });
      lastNotice?.hide();
      new SyncReportModal(this.app, report).open();
    } catch (e) {
      lastNotice?.hide();
      const msg = (e as Error).message;
      if (
        msg.includes("session expired") ||
        msg.includes("log in")
      ) {
        new Notice(
          "Zoom session expired. Please re-login via Settings or the Login to Zoom command."
        );
      } else {
        new Notice(`Sync failed: ${msg}`);
      }
    } finally {
      this.client.closeScrapeWindow();
    }
  }

  private async showSummaryList(): Promise<void> {
    const authed = await this.auth.isAuthenticated();
    if (!authed) {
      new Notice("Not logged in to Zoom. Please log in first.");
      return;
    }

    new Notice("Fetching Zoom summaries...", 0);
    try {
      const meetings = await this.client.listSummaries();
      new Notice("", 1); // dismiss
      new SummaryListModal(this.app, meetings).open();
    } catch (e) {
      new Notice(`Failed to list summaries: ${(e as Error).message}`);
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
