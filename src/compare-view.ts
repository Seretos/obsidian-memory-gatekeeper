import {
  App,
  Component,
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
  applyHunkToVaultText,
  applyHunkToTargetText,
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
  /** True once buffers have been loaded from disk at least once. */
  private initialized = false;
  /**
   * Whether the target (memory) file existed when loaded. Distinguishes "no
   * target file yet" (a new proposal) from "target file exists but is empty",
   * so Save doesn't silently materialize an empty memory file for a proposal
   * the user never put content into.
   */
  private targetExisted = false;

  /** Active MergeView instance (edit mode only). */
  private mergeView: MergeView | null = null;
  /** DOM container for the editor/compare area that gets torn down/rebuilt. */
  private contentArea: HTMLElement | null = null;
  /**
   * Disposable child component scoping the MarkdownRenderChild instances created
   * for the current compare-mode render. Unloaded and recreated on every
   * re-render so rendered-markdown children don't accumulate on the view.
   */
  private renderScope: Component | null = null;

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
    // Best-effort save on close. Obsidian's onClose CANNOT veto the close, so we
    // can't keep the leaf open if the save fails — save() surfaces a Notice on
    // failure, and the (rare) non-atomic case where the vault write lands but
    // the target write fails leaves that Notice as the signal. We deliberately
    // keep the Save option here rather than degrading to discard-only, since a
    // discard-only close would *guarantee* losing the edits.
    if (this.isDirty) {
      await this.promptDirtyResolve();
    }
    this.tearDownEditor();
    this.disposeRenderScope();
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

    // Guard against clobbering unsaved edits.
    if (this.initialized && this.isDirty) {
      if (relPath === this.relPath) {
        // Redundant setState for the file we already hold (e.g. a workspace
        // layout change): keep the live buffers, don't reload from disk.
        return;
      }
      // A different file is being loaded over unsaved edits — resolve them
      // (save or discard) first. If the user dismissed the prompt or the save
      // failed, abort the swap rather than dropping the edits on the floor.
      const resolved = await this.promptDirtyResolve();
      if (!resolved) return;
    }

    // Load into locals first; only commit relPath/buffers/dirty AFTER the read
    // succeeds, so a failed load can't leave the new path paired with the old
    // buffers (a later save would write stale content to the wrong file).
    let data;
    try {
      data = await this.actions.getDiffData(relPath);
    } catch (e) {
      new Notice(`Compare: could not load data – ${(e as Error).message}`);
      return;
    }

    this.relPath = relPath;
    this.leftBuffer = data.vault;
    this.rightBuffer = data.target ?? "";
    this.targetExisted = data.target !== null;
    this.isDirty = false;
    this.initialized = true;
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
    this.disposeRenderScope();
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

    // Fresh render scope: unload the previous one so its MarkdownRenderChild
    // instances are disposed instead of accumulating on the view across the
    // repeated re-renders triggered by hunk accept/revert. Capture it locally —
    // renderCompareMode is async and re-entrant, so a newer render can replace
    // this.renderScope while this one is still awaiting; the captured `scope`
    // lets each await-point detect that and bail (see renderMarkdownInto).
    this.disposeRenderScope();
    const scope = new Component();
    this.addChild(scope);
    this.renderScope = scope;

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

    // DELIBERATE TRADEOFF (user-confirmed): each segment is rendered as a
    // STANDALONE Markdown fragment so changes can be highlighted inline with
    // per-hunk accept/revert buttons anchored at the change. The cost is that a
    // multi-block construct split across a change boundary — a table whose body
    // row is edited, a fenced code block, a multi-block list — can mis-render,
    // because the fragment is parsed without its surrounding context. This is
    // accepted for the rendered compare view (it's great for prose/headings);
    // the Edit/MergeView mode shows the exact source for those cases.
    let changeNo = 0;
    for (const seg of segments) {
      // A newer render superseded this one (e.g. a rapid second hunk click) —
      // stop before appending stale DOM/children.
      if (this.renderScope !== scope) return;
      if (seg.type === "context") {
        // Unchanged prose, rendered once, full width.
        const ctx = root.createDiv({ cls: "gatekeeper-seg-context" });
        await this.renderMarkdownInto(seg.lines.join("\n"), ctx, scope);
      } else {
        changeNo++;
        await this.renderChangeSegment(root, seg, changeNo, scope);
      }
    }
  }

  /** Render one change segment: toolbar + side-by-side old/new rendered blocks. */
  private async renderChangeSegment(
    root: HTMLElement,
    seg: ChangeSegment,
    changeNo: number,
    scope: Component,
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
      this.rightBuffer = applyHunkToTargetText(
        this.rightBuffer,
        this.leftBuffer,
        seg.hunk,
      );
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
    // DELIBERATE merge semantics (user-confirmed): revert = "take the Memory
    // version". For a brand-new proposal (no memory file, empty right side) that
    // means the vault region is emptied — nothing is written until Save, and the
    // separate gatekeeper dismiss() flow is intentionally NOT wired in here; this
    // view stays a pure two-text merge tool.
    revertBtn.onclick = () => {
      this.leftBuffer = applyHunkToVaultText(
        this.leftBuffer,
        this.rightBuffer,
        seg.hunk,
      );
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
      await this.renderMarkdownInto(seg.added.join("\n"), leftBody, scope);
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
      await this.renderMarkdownInto(seg.removed.join("\n"), rightBody, scope);
    } else {
      rightBody.createDiv({
        cls: "gatekeeper-change-empty",
        text: "(nichts — diese Zeilen sind nur in Vault neu)",
      });
    }
  }

  /**
   * Render a markdown fragment into `el` with Obsidian reading-view styling,
   * scoping the MarkdownRenderChild to the given render component (not the view)
   * so it is unloaded on the next re-render. `scope` is the render-cycle's own
   * component; if a newer render has replaced it we skip, so a stale in-flight
   * render can't append children onto the current scope.
   */
  private async renderMarkdownInto(
    md: string,
    el: HTMLElement,
    scope: Component,
  ): Promise<void> {
    if (this.renderScope !== scope) return;
    el.addClass("markdown-rendered");
    await MarkdownRenderer.render(this.app, md, el, this.relPath, scope);
  }

  private disposeRenderScope(): void {
    if (this.renderScope) {
      this.removeChild(this.renderScope);
      this.renderScope = null;
    }
  }

  // -------------------------------------------------------------------------
  // Save
  // -------------------------------------------------------------------------

  /** Returns true only if the write(s) succeeded (dirty flag cleared). */
  private async save(): Promise<boolean> {
    // Sync editor state to buffers first.
    this.syncBuffersFromEditor();

    // Only materialize the target (memory) file if it already existed or the
    // user actually put content on the right side. This avoids creating an
    // empty memory file for a brand-new proposal that was never accepted.
    const writeTarget = this.targetExisted || this.rightBuffer.length > 0;

    try {
      await this.actions.writeVault(this.relPath, this.leftBuffer);
      if (writeTarget) {
        await this.actions.writeTarget(this.relPath, this.rightBuffer);
        // The target now exists on disk for subsequent saves.
        this.targetExisted = true;
      }
      this.isDirty = false;
      new Notice(`Saved: ${this.relPath}`);
      return true;
    } catch (e) {
      new Notice(`Save failed: ${(e as Error).message}`);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Dirty-close guard
  // -------------------------------------------------------------------------

  /**
   * Resolve unsaved edits (save or discard) before they would be lost — used
   * both when the view is closing and when setState loads a different file over
   * a dirty buffer. Resolves `true` when the edits are settled (saved OK or
   * explicitly discarded) and `false` when not (a failed save, or the modal was
   * dismissed via Esc/backdrop) so callers can avoid clobbering the buffer.
   *
   * NOTE on close: Obsidian's ItemView.onClose cannot veto the close — the leaf
   * is torn down regardless of what this resolves to. So we only offer Save
   * (write before the view goes away) or Discard; there is no honest "Cancel"
   * that keeps the view open, so we don't pretend to offer one.
   */
  private async promptDirtyResolve(): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new DirtyResolveModal(
        this.app,
        async (action) => {
          // "save" only counts as resolved if the write actually succeeded.
          resolve(action === "save" ? await this.save() : true);
        },
        () => resolve(false), // dismissed without choosing (Esc / click-away)
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

class DirtyResolveModal extends Modal {
  /** Set once a button is chosen, so onClose can tell a real choice from a
   *  dismissal (Esc / backdrop click) and never double-resolve the promise. */
  private actionChosen = false;

  constructor(
    app: App,
    private onAction: (action: "save" | "discard") => Promise<void>,
    private onDismiss: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("Unsaved changes");
    contentEl.createEl("p", {
      text: "This compare view has unsaved changes. Save them before continuing?",
    });

    const buttons = contentEl.createDiv({ cls: "gatekeeper-diff-buttons" });

    const saveBtn = buttons.createEl("button", {
      cls: "mod-cta",
      text: "Save changes",
    });
    saveBtn.onclick = async () => {
      this.actionChosen = true;
      this.close();
      await this.onAction("save");
    };

    const discardBtn = buttons.createEl("button", {
      text: "Discard changes",
    });
    discardBtn.onclick = async () => {
      this.actionChosen = true;
      this.close();
      await this.onAction("discard");
    };
  }

  onClose(): void {
    this.contentEl.empty();
    // Dismissed via Esc or clicking the backdrop — signal the caller so its
    // awaited promise resolves instead of hanging forever.
    if (!this.actionChosen) this.onDismiss();
  }
}
