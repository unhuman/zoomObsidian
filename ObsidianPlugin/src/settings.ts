/**
 * Plugin settings tab for configuring the Zoom Obsidian plugin.
 */

import { App, PluginSettingTab, Setting } from "obsidian";
import type ZoomObsidianPlugin from "./main";

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

    // ── Zoom Settings ────────────────────────────────────────

    containerEl.createEl("h3", { text: "Zoom Connection" });

    new Setting(containerEl)
      .setName("Zoom subdomain")
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
      .setName("Zoom authentication")
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
          await this.plugin.auth.login();
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

    // ── Vault Settings ───────────────────────────────────────

    containerEl.createEl("h3", { text: "Vault Layout" });

    new Setting(containerEl)
      .setName("Vault subfolder")
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
      .setName("1:1 note folders")
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

    // ── Sync Settings ────────────────────────────────────────

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
      .setName("Topic filter")
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

    // ── Debug ────────────────────────────────────────────────

    containerEl.createEl("h3", { text: "Advanced" });

    new Setting(containerEl)
      .setName("Debug logging")
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
