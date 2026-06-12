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
import {
  buildDiffSegments,
  applyHunkToLeft,
  applyHunkToRight,
  type ChangeSegment,
} from "./core/hunks";

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
    // Clear any previous render before building (prevents DOM accumulation when
    // called from hunk-apply onclick handlers).
    this.contentArea.empty();

    const root = this.contentArea.createDiv({
      cls: "gatekeeper-compare-rendered",
    });

    // Legend / column key — non-color cues spelled out for accessibility.
    const legend = root.createDiv({ cls: "gatekeeper-compare-legend" });
    legend.createSpan({
      cls: "gatekeeper-legend-added",
      text: "+ Vault (neu)",
    });
    legend.createSpan({
      cls: "gatekeeper-legend-removed",
      text: "− Memory (alt)",
    });

    const segments = buildDiffSegments(this.rightBuffer, this.leftBuffer);
    const hasChange = segments.some((s) => s.type === "change");
    if (!hasChange) {
      root.createDiv({
        cls: "gatekeeper-compare-identical",
        text: "Keine Unterschiede — Vault und Memory sind identisch.",
      });
    }

    // NOTE: MarkdownRenderer.render registers MarkdownRenderChild instances on
    // `this` (the Component). Those children accumulate across re-renders because
    // there is no public API to selectively unload them without unloading the
    // whole view. The practical leak is minor (inactive event listeners on
    // replaced DOM nodes), and fixing it cleanly would require a scoped sub-
    // Component per render cycle — complexity not warranted at this stage.
    let changeNo = 0;
    for (const seg of segments) {
      if (seg.type === "context") {
        // Unchanged prose, rendered once, full width.
        const ctx = root.createDiv({ cls: "gatekeeper-seg-context" });
        await this.renderMarkdownInto(seg.lines.join("\n"), ctx);
      } else {
        changeNo++;
        await this.renderChangeSegment(root, seg, changeNo);
      }
    }
  }

  /** Render one change segment: toolbar + side-by-side old/new rendered blocks. */
  private async renderChangeSegment(
    root: HTMLElement,
    seg: ChangeSegment,
    changeNo: number,
  ): Promise<void> {
    const block = root.createDiv({ cls: "gatekeeper-change" });

    // Toolbar with the per-hunk accept/revert controls, anchored at the change.
    const toolbar = block.createDiv({ cls: "gatekeeper-change-toolbar" });
    toolbar.createSpan({
      cls: "gatekeeper-change-label",
      text: `Änderung ${changeNo}`,
    });
    const acceptBtn = toolbar.createEl("button", {
      cls: "gatekeeper-change-accept",
      text: "Vault übernehmen →",
    });
    acceptBtn.setAttribute(
      "aria-label",
      "Vault-Version (links) in Memory übernehmen",
    );
    acceptBtn.onclick = () => {
      this.rightBuffer = applyHunkToRight(
        this.rightBuffer.split("\n"),
        seg.hunk,
      ).join("\n");
      this.isDirty = true;
      void this.renderCompareMode();
    };
    const revertBtn = toolbar.createEl("button", {
      cls: "gatekeeper-change-revert",
      text: "← Memory übernehmen",
    });
    revertBtn.setAttribute(
      "aria-label",
      "Memory-Version (rechts) in Vault übernehmen — Vault-Änderung verwerfen",
    );
    revertBtn.onclick = () => {
      this.leftBuffer = applyHunkToLeft(
        this.leftBuffer.split("\n"),
        seg.hunk,
      ).join("\n");
      this.isDirty = true;
      void this.renderCompareMode();
    };

    // Two columns: left = vault (new, added), right = memory (old, removed).
    const cols = block.createDiv({ cls: "gatekeeper-change-cols" });

    const leftCell = cols.createDiv({
      cls: "gatekeeper-change-cell gatekeeper-change-added",
    });
    leftCell.createDiv({ cls: "gatekeeper-change-cell-label", text: "+ Vault (neu)" });
    const leftBody = leftCell.createDiv({ cls: "gatekeeper-change-cell-body" });
    if (seg.added.length > 0) {
      await this.renderMarkdownInto(seg.added.join("\n"), leftBody);
    } else {
      leftBody.createDiv({
        cls: "gatekeeper-change-empty",
        text: "(nichts — diese Zeilen werden in Vault entfernt)",
      });
    }

    const rightCell = cols.createDiv({
      cls: "gatekeeper-change-cell gatekeeper-change-removed",
    });
    rightCell.createDiv({ cls: "gatekeeper-change-cell-label", text: "− Memory (alt)" });
    const rightBody = rightCell.createDiv({ cls: "gatekeeper-change-cell-body" });
    if (seg.removed.length > 0) {
      await this.renderMarkdownInto(seg.removed.join("\n"), rightBody);
    } else {
      rightBody.createDiv({
        cls: "gatekeeper-change-empty",
        text: "(nichts — diese Zeilen sind nur in Vault neu)",
      });
    }
  }

  /** Render a markdown fragment into `el` with Obsidian reading-view styling. */
  private async renderMarkdownInto(md: string, el: HTMLElement): Promise<void> {
    el.addClass("markdown-rendered");
    await MarkdownRenderer.render(this.app, md, el, this.relPath, this);
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
