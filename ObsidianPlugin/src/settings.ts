/**
 * Plugin settings tab for configuring the Zoom Obsidian plugin.
 */

import { App, PluginSettingTab, Setting } from "obsidian";
import type ZoomObsidianPlugin from "./main";
import { notify } from "./types";

export class ZoomObsidianSettingTab extends PluginSettingTab {
  plugin: ZoomObsidianPlugin;

  constructor(app: App, plugin: ZoomObsidianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Zoom Meeting Summaries" });

    // ── Zoom Connection ──────────────────────────────────────

    containerEl.createEl("h3", { text: "Zoom Connection" });

    new Setting(containerEl)
      .setName("Zoom Account ID")
      .setDesc(
        'Required for participant lookup on adhoc "Zoom Meeting" 1:1s. ' +
        'Find it in DevTools → Network while on Analytics & Reports → Meetings & Webinars: ' +
        'click a participant count and inspect the POST body — the "accountId" value.'
      )
      .addText((text) =>
        text
          .setPlaceholder("VfmcPDweRYu1g6GgEEPq4g")
          .setValue(this.plugin.settings.zoomAccountId)
          .onChange(async (value) => {
            this.plugin.settings.zoomAccountId = value.trim();
            this.plugin.client.setAccountId(this.plugin.settings.zoomAccountId);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Zoom Subdomain")
      .setDesc(
        'Your organization\'s Zoom subdomain (e.g. "acme" for acme.zoom.us). Leave blank for zoom.us.'
      )
      .addText((text) =>
        text
          .setPlaceholder("acme")
          .setValue(this.plugin.settings.zoomSubdomain)
          .onChange(async (value) => {
            this.plugin.settings.zoomSubdomain = value.trim();
            this.plugin.auth.setSubdomain(this.plugin.settings.zoomSubdomain);
            await this.plugin.saveSettings();
          })
      );

    const authSetting = new Setting(containerEl)
      .setName("Zoom Authentication")
      .setDesc(
        this.plugin.settings.cookies.length > 0
          ? `Logged in (${this.plugin.settings.cookies.length} cookies stored).`
          : "Not logged in."
      );

    authSetting.addButton((btn) =>
      btn
        .setButtonText(
          this.plugin.settings.cookies.length > 0
            ? "Re-login"
            : "Login to Zoom"
        )
        .setCta()
        .onClick(async () => {
          try {
            await this.plugin.auth.login(true);
            notify("Zoom login successful.");
          } catch (e) {
            notify(`Zoom login failed: ${(e as Error).message}`);
          }
          this.display(); // refresh to show updated status
        })
    );

    if (this.plugin.settings.cookies.length > 0) {
      authSetting.addButton((btn) =>
        btn.setButtonText("Logout").onClick(async () => {
          await this.plugin.auth.logout();
          this.plugin.settings.cookies = [];
          await this.plugin.saveSettings();
          this.display();
        })
      );
    }

    new Setting(containerEl)
      .setName("My Zoom Display Name")
      .setDesc(
        "Your Zoom display name. Only your first name is used, to filter you out of meeting topic parts and AI summary assignees. Not needed for the participant report API, which identifies you by host email."
      )
      .addText((text) =>
        text
          .setPlaceholder("Jane Smith")
          .setValue(this.plugin.settings.myDisplayName)
          .onChange(async (value) => {
            this.plugin.settings.myDisplayName = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // ── Vault Layout ─────────────────────────────────────────

    containerEl.createEl("h3", { text: "Vault Layout" });

    new Setting(containerEl)
      .setName("Vault Subfolder")
      .setDesc(
        'Subfolder within the vault root where 1:1 folders live (e.g. "MyOrg"). Leave blank to search from vault root.'
      )
      .addText((text) =>
        text
          .setPlaceholder("MyOrg")
          .setValue(this.plugin.settings.vaultSubfolder)
          .onChange(async (value) => {
            this.plugin.settings.vaultSubfolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("1:1 Note Folders")
      .setDesc(
        'Comma-separated folder names (in priority order) that contain 1:1 note files. Default: "! One on Ones, ! One on Ones (Other)"'
      )
      .addText((text) =>
        text
          .setPlaceholder("! One on Ones, ! One on Ones (Other)")
          .setValue(this.plugin.settings.oneOnOneFolders)
          .onChange(async (value) => {
            this.plugin.settings.oneOnOneFolders = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Folder for Shared Meetings")
      .setDesc(
        'Folder where shared Zoom meetings are written (optional). If left blank, shared meetings are not processed. Shared meetings cannot be deleted from Zoom.'
      )
      .addText((text) =>
        text
          .setPlaceholder("Shared Meetings")
          .setValue(this.plugin.settings.sharedMeetingsFolder)
          .onChange(async (value) => {
            this.plugin.settings.sharedMeetingsFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // ── Sync Behavior ────────────────────────────────────────

    containerEl.createEl("h3", { text: "Sync Behavior" });

    new Setting(containerEl)
      .setName("Auto-delete from Zoom")
      .setDesc(
        "After successfully writing a summary to the vault, delete it from Zoom."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoDelete)
          .onChange(async (value) => {
            this.plugin.settings.autoDelete = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Topic Filter")
      .setDesc(
        'Only sync meetings whose topic contains this text (case-insensitive). Leave blank for all.'
      )
      .addText((text) =>
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.filter)
          .onChange(async (value) => {
            this.plugin.settings.filter = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Advanced ─────────────────────────────────────────────

    containerEl.createEl("h3", { text: "Advanced" });

    const activeCliPath = this.plugin.auth.getCliPath();
    new Setting(containerEl)
      .setName("Zoom CLI Path")
      .setDesc(
        "Folder containing zoom-login.mjs — used to open a real browser for Zoom sign-in. " +
        "install.sh fills this in automatically; set it only to override. " +
        (activeCliPath ? `Currently using: ${activeCliPath}` : "Not set — login is unavailable.")
      )
      .addText((text) =>
        text
          .setPlaceholder("/path/to/zoomObsidian")
          .setValue(this.plugin.settings.cliPath)
          .onChange(async (value) => {
            this.plugin.settings.cliPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Debug Logging")
      .setDesc(
        "Log verbose diagnostic output to the developer console (Ctrl+Shift+I / Cmd+Opt+I)."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debug).onChange(async (value) => {
          this.plugin.settings.debug = value;
          await this.plugin.saveSettings();
        })
      );
  }
}
