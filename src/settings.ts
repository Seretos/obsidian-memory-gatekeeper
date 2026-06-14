import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import * as fs from "fs";
import type MemoryGatekeeperPlugin from "./main";
import { repairMissingIndexes } from "./core/memory-index";

/** Returns true if the path exists and is a directory. */
export function isValidTargetFolder(folder: string): boolean {
  if (!folder) return false;
  try {
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

export class GatekeeperSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: MemoryGatekeeperPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Target memory folder")
      .setDesc(
        "Absolute path to the real memory folder this vault is gated against. " +
          "The plugin stays inactive until a valid folder is set (so other vaults are unaffected).",
      )
      .addText((text) =>
        text
          .setPlaceholder("C:\\Users\\you\\.claude\\memory")
          .setValue(this.plugin.settings.targetFolder)
          .onChange(async (value) => {
            this.plugin.settings.targetFolder = value.trim();
            await this.plugin.saveSettings();
            await this.plugin.reconfigure();
            this.updateStatus(statusEl);
          }),
      );

    const statusEl = containerEl.createEl("div", {
      cls: "gatekeeper-settings-status",
    });
    this.updateStatus(statusEl);

    new Setting(containerEl)
      .setName("File extensions to compare")
      .setDesc("Comma-separated, without dots. Default: md")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.includeExtensions.join(", "))
          .onChange(async (value) => {
            this.plugin.settings.includeExtensions = value
              .split(",")
              .map((s) => s.trim().replace(/^\./, ""))
              .filter(Boolean);
            await this.plugin.saveSettings();
            await this.plugin.reconfigure();
          }),
      );

    new Setting(containerEl)
      .setName("Polling interval (ms)")
      .setDesc("Fallback poll interval for the target folder if file watching is unavailable.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.pollIntervalMs))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 500) {
              this.plugin.settings.pollIntervalMs = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Reset dismissed reviews")
      .setDesc("Clear all dismissed entries so every divergence re-surfaces.")
      .addButton((btn) =>
        btn.setButtonText("Reset").onClick(async () => {
          this.plugin.settings.dismissed = {};
          await this.plugin.saveSettings();
          await this.plugin.reconfigure();
          new Notice("Dismissed reviews reset.");
        }),
      );

    new Setting(containerEl)
      .setName("Repair MEMORY.md indexes")
      .setDesc(
        "Scans all project subfolders in the gatekeeper vault and the target memory folder. " +
          "For any folder that has .md files but no MEMORY.md, generates the missing index.",
      )
      .addButton((btn) =>
        btn.setButtonText("Repair").onClick(async () => {
          if (!this.plugin.isConfigured()) {
            new Notice("No valid target folder configured.");
            return;
          }
          const targetRepaired = await repairMissingIndexes(
            this.plugin.settings.targetFolder,
          ).catch(() => 0);
          const vaultBase = (this.plugin.app.vault.adapter as any)
            .basePath as string | undefined;
          const vaultRepaired = vaultBase
            ? await repairMissingIndexes(vaultBase).catch(() => 0)
            : 0;
          new Notice(`Repaired ${targetRepaired + vaultRepaired} folder(s).`);
        }),
      );
  }

  private updateStatus(el: HTMLElement): void {
    const valid = isValidTargetFolder(this.plugin.settings.targetFolder);
    el.setText(
      valid
        ? "✓ Active — target folder found."
        : "⏸ Inactive — set a valid target folder to enable.",
    );
    el.toggleClass("gatekeeper-status-active", valid);
    el.toggleClass("gatekeeper-status-inactive", !valid);
  }
}
