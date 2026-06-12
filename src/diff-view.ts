import { App, Modal, Notice } from "obsidian";
import { computeDiffLines, linePrefix } from "./core/diff-lines";
import type { GatekeeperActions } from "./types";

const LINE_CLASS = {
  added: "gatekeeper-line-added",
  removed: "gatekeeper-line-removed",
  context: "gatekeeper-line-context",
} as const;

/**
 * Whole-file diff (vertical slice 1). Shows the line diff between the vault
 * (gatekeeper) file and its target counterpart, with Accept / Dismiss actions.
 * Per-hunk selection is a planned later slice; editing happens in the note.
 */
export class DiffModal extends Modal {
  constructor(
    app: App,
    private relPath: string,
    private actions: GatekeeperActions,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl, titleEl } = this;
    titleEl.setText(`Memory diff – ${this.relPath}`);
    contentEl.addClass("gatekeeper-diff");

    const body = contentEl.createDiv({ cls: "gatekeeper-diff-body" });
    body.setText("Loading…");

    let data;
    try {
      data = await this.actions.getDiffData(this.relPath);
    } catch (e) {
      body.setText(`Could not load diff: ${(e as Error).message}`);
      return;
    }

    body.empty();
    if (data.target === null) {
      body.createEl("p", {
        cls: "gatekeeper-diff-note",
        text: "New file — does not exist in the target memory folder yet.",
      });
    }

    const pre = body.createEl("pre", { cls: "gatekeeper-diff-pre" });
    for (const line of computeDiffLines(data.target ?? "", data.vault)) {
      pre.createDiv({
        cls: LINE_CLASS[line.type],
        text: linePrefix(line.type) + line.text,
      });
    }

    const buttons = contentEl.createDiv({ cls: "gatekeeper-diff-buttons" });

    const acceptBtn = buttons.createEl("button", {
      cls: "mod-cta",
      text: "Accept → write to memory",
    });
    acceptBtn.onclick = async () => {
      try {
        await this.actions.accept(this.relPath);
        new Notice(`Accepted: ${this.relPath}`);
        this.close();
      } catch (e) {
        new Notice(`Accept failed: ${(e as Error).message}`);
      }
    };

    const dismissBtn = buttons.createEl("button", {
      text: "Discard → revert to memory",
    });
    dismissBtn.onclick = async () => {
      await this.actions.dismiss(this.relPath);
      this.close();
    };

    const openBtn = buttons.createEl("button", { text: "Open note" });
    openBtn.onclick = async () => {
      await this.actions.openFile(this.relPath);
      this.close();
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
