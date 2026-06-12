import {
  App,
  ItemView,
  MarkdownRenderer,
  Modal,
  Notice,
  WorkspaceLeaf,
} from "obsidian";
import { MergeView } from "@codemirror/merge";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { COMPARE_VIEW_TYPE, type GatekeeperActions } from "./types";
import { computeHunks, applyHunkToLeft, applyHunkToRight } from "./core/hunks";

type CompareMode = "edit" | "compare";

/**
 * A full-featured side-by-side compare/merge view.
 *
 * Left pane = Vault (gatekeeper, "after"), Right pane = Memory (target, "before").
 * Both sides are editable. Changes can be accepted/reverted per-hunk or as a
 * whole via Save. Supports a toggle between:
 *  - "edit" mode: CodeMirror MergeView with hunk accept/revert gutter controls.
 *  - "compare" mode: rendered Markdown columns with per-hunk buttons.
 *
 * Unsaved edits in both buffers survive the mode switch.
 */
export class CompareView extends ItemView {
  private relPath = "";
  private leftBuffer = "";  // vault content (editable)
  private rightBuffer = ""; // target content (editable)
  private isDirty = false;
  private mode: CompareMode = "edit";

  /** Active MergeView instance (edit mode only). */
  private mergeView: MergeView | null = null;
  /** DOM container for the editor/compare area that gets torn down/rebuilt. */
  private contentArea: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private actions: GatekeeperActions,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return COMPARE_VIEW_TYPE;
  }

  getDisplayText(): string {
    const name = this.relPath
      ? this.relPath.split("/").pop() ?? this.relPath
      : "Compare";
    return `Compare: ${name}`;
  }

  getIcon(): string {
    return "git-compare-arrows";
  }

  async onOpen(): Promise<void> {
    this.buildShell();
  }

  async onClose(): Promise<void> {
    if (this.isDirty) {
      await this.promptDirtyClose();
    }
    this.tearDownEditor();
  }

  // Obsidian calls setState when a leaf is opened with a known state
  // (e.g. from setViewState or after workspace restore).
  async setState(
    state: Record<string, unknown>,
    result: { history: boolean },
  ): Promise<void> {
    await super.setState(state, result);
    const relPath = typeof state["relPath"] === "string" ? state["relPath"] : "";
    if (!relPath) return;
    this.relPath = relPath;
    this.isDirty = false;

    let data;
    try {
      data = await this.actions.getDiffData(relPath);
    } catch (e) {
      new Notice(`Compare: could not load data – ${(e as Error).message}`);
      return;
    }

    this.leftBuffer = data.vault;
    this.rightBuffer = data.target ?? "";
    this.renderCurrent();
  }

  getState(): Record<string, unknown> {
    return { relPath: this.relPath };
  }

  // -------------------------------------------------------------------------
  // Shell (toolbar + content area slot)
  // -------------------------------------------------------------------------

  private buildShell(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("gatekeeper-compare");

    // Toolbar
    const toolbar = root.createDiv({ cls: "gatekeeper-compare-toolbar" });

    const modeBtn = toolbar.createEl("button", { text: "Switch to Compare" });
    modeBtn.setAttribute("data-mode-toggle", "true");
    modeBtn.onclick = () => this.toggleMode(modeBtn);

    toolbar.createEl("span", {
      cls: "gatekeeper-compare-filename",
      text: this.relPath || "",
    });

    const saveBtn = toolbar.createEl("button", {
      cls: "mod-cta",
      text: "Save both",
    });
    saveBtn.onclick = () => void this.save();

    // Content area (replaced on mode switch)
    this.contentArea = root.createDiv({ cls: "gatekeeper-compare-panes" });
  }

  // -------------------------------------------------------------------------
  // Mode toggle
  // -------------------------------------------------------------------------

  private toggleMode(btn: HTMLButtonElement): void {
    // Sync buffers from editor before switching.
    this.syncBuffersFromEditor();

    if (this.mode === "edit") {
      this.mode = "compare";
      btn.setText("Switch to Edit");
    } else {
      this.mode = "edit";
      btn.setText("Switch to Compare");
    }
    this.renderCurrent();
  }

  // -------------------------------------------------------------------------
  // Render dispatch
  // -------------------------------------------------------------------------

  private renderCurrent(): void {
    this.tearDownEditor();
    if (!this.contentArea) return;
    this.contentArea.empty();

    // Update filename in toolbar if present.
    const filenameEl = this.contentEl.querySelector(
      ".gatekeeper-compare-filename",
    ) as HTMLElement | null;
    if (filenameEl) filenameEl.setText(this.relPath || "");

    if (this.mode === "edit") {
      this.renderEditMode();
    } else {
      void this.renderCompareMode();
    }
  }

  // -------------------------------------------------------------------------
  // Edit mode – CodeMirror MergeView
  // -------------------------------------------------------------------------

  private renderEditMode(): void {
    if (!this.contentArea) return;

    const container = this.contentArea.createDiv({
      cls: "gatekeeper-compare-editor",
    });

    const leftContent = this.leftBuffer;
    const rightContent = this.rightBuffer;

    // Build shared update listener to track dirty state and sync buffers.
    const self = this;
    const trackDirty = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        self.isDirty = true;
      }
    });

    this.mergeView = new MergeView({
      parent: container,
      // a = left (vault), b = right (target) — we use orientation "a-b"
      a: {
        doc: leftContent,
        extensions: [markdown(), trackDirty],
      },
      b: {
        doc: rightContent,
        extensions: [markdown(), trackDirty],
      },
      // Show revert gutter controls; "a-to-b" pushes left → right (accept)
      revertControls: "a-to-b",
      highlightChanges: true,
      gutter: true,
    });
  }

  // -------------------------------------------------------------------------
  // Compare mode – rendered Markdown columns with hunk buttons
  // -------------------------------------------------------------------------

  private async renderCompareMode(): Promise<void> {
    if (!this.contentArea) return;
    // Clear any previous render before building new panes (prevents DOM
    // accumulation when called from hunk-apply onclick handlers).
    this.contentArea.empty();

    const leftPane = this.contentArea.createDiv({
      cls: "gatekeeper-compare-pane gatekeeper-compare-pane-left",
    });
    const rightPane = this.contentArea.createDiv({
      cls: "gatekeeper-compare-pane gatekeeper-compare-pane-right",
    });

    // Pane headers
    leftPane.createEl("div", {
      cls: "gatekeeper-compare-pane-header",
      text: "Vault (gatekeeper)",
    });
    rightPane.createEl("div", {
      cls: "gatekeeper-compare-pane-header",
      text: "Memory (target)",
    });

    const leftContent = leftPane.createDiv({
      cls: "gatekeeper-compare-pane-content",
    });
    const rightContent = rightPane.createDiv({
      cls: "gatekeeper-compare-pane-content",
    });

    // Render markdown in each pane (this is a Component — lifecycle managed here).
    await MarkdownRenderer.render(
      this.app,
      this.leftBuffer,
      leftContent,
      this.relPath,
      this,
    );
    await MarkdownRenderer.render(
      this.app,
      this.rightBuffer,
      rightContent,
      this.relPath,
      this,
    );

    // Render per-hunk action buttons below the markdown.
    // NOTE: MarkdownRenderer.render registers MarkdownRenderChild instances on
    // `this` (the Component). Those children accumulate across re-renders because
    // there is no public API to selectively unload them without unloading the
    // whole view. The practical leak is minor (inactive event listeners on
    // replaced DOM nodes), and fixing it cleanly would require a scoped sub-
    // Component per render cycle — complexity not warranted at this stage.
    this.renderHunkActions();
  }

  private renderHunkActions(): void {
    const hunks = computeHunks(this.rightBuffer, this.leftBuffer);
    if (hunks.length === 0) return;

    const actionsEl = this.contentArea!.createDiv({
      cls: "gatekeeper-hunk-actions",
    });
    actionsEl.createEl("strong", { text: `${hunks.length} diff region(s):` });

    for (let i = 0; i < hunks.length; i++) {
      const hunk = hunks[i];
      const row = actionsEl.createDiv({ cls: "gatekeeper-hunk-row" });
      row.createEl("span", { text: `Hunk ${i + 1}` });

      const acceptBtn = row.createEl("button", {
        text: "Accept vault → target",
        cls: "gatekeeper-hunk-accept",
      });
      acceptBtn.onclick = () => {
        const targetLines = this.rightBuffer.split("\n");
        this.rightBuffer = applyHunkToRight(targetLines, hunk).join("\n");
        this.isDirty = true;
        // Re-render compare mode to reflect change.
        void this.renderCompareMode();
      };

      const revertBtn = row.createEl("button", {
        text: "Revert vault ← target",
        cls: "gatekeeper-hunk-revert",
      });
      revertBtn.onclick = () => {
        const vaultLines = this.leftBuffer.split("\n");
        this.leftBuffer = applyHunkToLeft(vaultLines, hunk).join("\n");
        this.isDirty = true;
        void this.renderCompareMode();
      };
    }
  }

  // -------------------------------------------------------------------------
  // Save
  // -------------------------------------------------------------------------

  private async save(): Promise<void> {
    // Sync editor state to buffers first.
    this.syncBuffersFromEditor();

    try {
      await this.actions.writeVault(this.relPath, this.leftBuffer);
      await this.actions.writeTarget(this.relPath, this.rightBuffer);
      this.isDirty = false;
      new Notice(`Saved: ${this.relPath}`);
    } catch (e) {
      new Notice(`Save failed: ${(e as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Dirty-close guard
  // -------------------------------------------------------------------------

  private async promptDirtyClose(): Promise<void> {
    return new Promise((resolve) => {
      const modal = new DirtyCloseModal(
        this.app,
        async (action) => {
          if (action === "save") {
            await this.save();
          }
          // "discard" and "cancel" both just resolve (view closes either way
          // since Obsidian does not have a cancellable onClose hook).
          resolve();
        },
      );
      modal.open();
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Sync the MergeView editor content back into leftBuffer/rightBuffer. */
  private syncBuffersFromEditor(): void {
    if (this.mergeView) {
      this.leftBuffer = this.mergeView.a.state.doc.toString();
      this.rightBuffer = this.mergeView.b.state.doc.toString();
    }
  }

  private tearDownEditor(): void {
    if (this.mergeView) {
      // MergeView.destroy() tears down both inner EditorViews AND cancels the
      // pending requestAnimationFrame from MergeView.measure(), preventing a
      // rAF leak. The internal dom.remove() is safe alongside a subsequent
      // contentArea.empty() (no harmful double-remove).
      this.mergeView.destroy();
      this.mergeView = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Dirty-close modal
// ---------------------------------------------------------------------------

class DirtyCloseModal extends Modal {
  constructor(
    app: App,
    private onAction: (action: "save" | "discard" | "cancel") => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("Unsaved changes");
    contentEl.createEl("p", {
      text: "You have unsaved changes in the compare view. What would you like to do?",
    });

    const buttons = contentEl.createDiv({ cls: "gatekeeper-diff-buttons" });

    const saveBtn = buttons.createEl("button", {
      cls: "mod-cta",
      text: "Save & close",
    });
    saveBtn.onclick = async () => {
      this.close();
      await this.onAction("save");
    };

    const discardBtn = buttons.createEl("button", { text: "Discard changes" });
    discardBtn.onclick = async () => {
      this.close();
      await this.onAction("discard");
    };

    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = async () => {
      this.close();
      await this.onAction("cancel");
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
