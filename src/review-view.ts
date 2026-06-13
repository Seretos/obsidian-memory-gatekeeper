import { App, ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type { StatusStore } from "./status-store";
import { REVIEW_VIEW_TYPE, type DivergentEntry, type GatekeeperActions } from "./types";

/**
 * Sidebar panel listing all divergent (new/modified) files grouped by status,
 * each with Diff / Accept / Dismiss actions. Re-rendered on every engine scan.
 */
export class ReviewView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private store: StatusStore,
    private actions: GatekeeperActions,
    private isConfigured: () => boolean,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return REVIEW_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Memory Gatekeeper";
  }

  getIcon(): string {
    return "git-compare";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("gatekeeper-review");
    root.createEl("h4", { text: "Memory Gatekeeper" });

    if (!this.isConfigured()) {
      root.createEl("p", {
        cls: "gatekeeper-empty",
        text: "Set a target memory folder in the plugin settings to start reviewing.",
      });
      return;
    }

    const entries = this.store.all();
    if (entries.length === 0) {
      root.createEl("p", {
        cls: "gatekeeper-empty",
        text: "No pending memory changes. Vault matches the target memory.",
      });
      return;
    }

    const groups: Array<["new" | "modified", string]> = [
      ["new", "New"],
      ["modified", "Modified"],
    ];
    for (const [status, label] of groups) {
      const items = entries.filter((e) => e.status === status);
      if (items.length === 0) continue;
      root.createEl("div", {
        cls: "gatekeeper-group-header",
        text: `${label} (${items.length})`,
      });
      for (const entry of items) {
        this.renderRow(root, entry);
      }
    }
  }

  private renderRow(parent: HTMLElement, entry: DivergentEntry): void {
    const { relPath, status, isTombstone } = entry;
    const row = parent.createDiv({ cls: `gatekeeper-row gatekeeper-${status}` });

    const nameEl = row.createDiv({ cls: "gatekeeper-row-name" });
    nameEl.createSpan({ text: relPath });
    if (isTombstone) {
      nameEl.createSpan({
        cls: "gatekeeper-tombstone-label",
        text: " (deletion proposed)",
      });
    }
    nameEl.onclick = () => void this.actions.openFile(relPath);

    const btns = row.createDiv({ cls: "gatekeeper-row-buttons" });

    const diffBtn = btns.createEl("button", { text: "Diff" });
    diffBtn.onclick = () => void this.actions.openCompare(relPath);

    const acceptLabel = isTombstone ? "Delete" : "Accept";
    const acceptBtn = btns.createEl("button", { cls: "mod-cta", text: acceptLabel });
    acceptBtn.onclick = async () => {
      try {
        await this.actions.accept(relPath);
        new Notice(
          isTombstone ? `Deleted: ${relPath}` : `Accepted: ${relPath}`,
        );
      } catch (e) {
        new Notice(`Accept failed: ${(e as Error).message}`);
      }
    };

    const dismissBtn = btns.createEl("button", { text: "Discard" });
    dismissBtn.setAttr(
      "aria-label",
      isTombstone
        ? "Cancel deletion — keep the memory file"
        : "Revert vault file to the memory version",
    );
    dismissBtn.onclick = () => void this.actions.dismiss(relPath);
  }
}
