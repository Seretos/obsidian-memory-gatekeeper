import {
  Notice,
  Plugin,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { ComparisonEngine } from "./comparison-engine";
import { ExplorerDecorator } from "./explorer-decorator";
import { GraphDecorator } from "./graph-decorator";
import { GraphLabelDecorator } from "./graph-label-decorator";
import { GraphClickInterceptor } from "./graph-click-interceptor";
import { ReviewView } from "./review-view";
import { CompareView } from "./compare-view";
import { StatusStore } from "./status-store";
import { GatekeeperSettingTab, isValidTargetFolder } from "./settings";
import {
  DEFAULT_SETTINGS,
  REVIEW_VIEW_TYPE,
  COMPARE_VIEW_TYPE,
  type DiffData,
  type GatekeeperActions,
  type GatekeeperSettings,
} from "./types";

export default class MemoryGatekeeperPlugin
  extends Plugin
  implements GatekeeperActions
{
  settings!: GatekeeperSettings;
  private store!: StatusStore;
  private engine?: ComparisonEngine;
  private explorer?: ExplorerDecorator;
  private graph?: GraphDecorator;
  private graphLabels?: GraphLabelDecorator;
  private graphClickInterceptor?: GraphClickInterceptor;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.store = new StatusStore(this.settings.dismissed);

    this.registerView(
      REVIEW_VIEW_TYPE,
      (leaf) =>
        new ReviewView(leaf, this.store, this, () => this.isConfigured()),
    );
    this.registerView(
      COMPARE_VIEW_TYPE,
      (leaf) => new CompareView(leaf, this),
    );

    this.addSettingTab(new GatekeeperSettingTab(this.app, this));

    this.addRibbonIcon("git-compare", "Memory Gatekeeper", () =>
      this.activateReviewView(),
    );

    this.addCommand({
      id: "open-review-panel",
      name: "Open Memory Gatekeeper panel",
      callback: () => this.activateReviewView(),
    });
    this.addCommand({
      id: "rescan",
      name: "Rescan memory differences",
      callback: () => void this.engine?.scan(),
    });
    this.addCommand({
      id: "open-compare-view",
      name: "Open side-by-side compare for active file",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("No active file to compare.");
          return;
        }
        void this.openCompare(file.path);
      },
    });

    // The explorer rebuilds its DOM and graph leaves open/close on these
    // events; re-apply markers and graph colors so a graph opened *after* a
    // scan still gets highlighted.
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.refreshDecorations()),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () =>
        this.refreshDecorations(),
      ),
    );

    // Context-menu actions on divergent files.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!this.engine || !(file instanceof TFile)) return;
        const entry = this.store.get(file.path);
        if (!entry) return;
        menu.addSeparator();
        menu.addItem((item) =>
          item
            .setTitle("Memory: show diff")
            .setIcon("git-compare-arrows")
            .onClick(() => void this.openCompare(file.path)),
        );
        menu.addItem((item) =>
          item
            .setTitle("Memory: accept → write to memory")
            .setIcon("check")
            .onClick(() => void this.accept(file.path)),
        );
        menu.addItem((item) =>
          item
            .setTitle("Memory: discard → revert to memory")
            .setIcon("undo")
            .onClick(() => void this.dismiss(file.path)),
        );
      }),
    );

    // Wait for the workspace layout so the explorer DOM and any open graph
    // exist when the first scan applies decorations.
    this.app.workspace.onLayoutReady(() => {
      if (this.isConfigured()) void this.activate();
    });
  }

  onunload(): void {
    this.deactivate();
  }

  // --- activation lifecycle ----------------------------------------------

  isConfigured(): boolean {
    return isValidTargetFolder(this.settings.targetFolder);
  }

  private async activate(): Promise<void> {
    this.explorer = new ExplorerDecorator(
      this.app,
      this.store,
      this.settings,
      () => this.isConfigured(),
      this.openCompare.bind(this),
    );
    this.graph = new GraphDecorator(this.app, this.store);
    this.graphLabels = new GraphLabelDecorator(this.app);
    this.graphClickInterceptor = new GraphClickInterceptor(
      this.app,
      this.store,
      this.settings,
      () => this.isConfigured(),
      this.openCompare.bind(this),
    );
    this.engine = new ComparisonEngine(this.app, this.settings, this.store);
    this.engine.onChange(() => this.refreshUI());
    await this.engine.start();
  }

  private deactivate(): void {
    this.engine?.stop();
    this.engine = undefined;
    this.explorer?.clear();
    this.graph?.clear();
    this.graphLabels?.clear();
    this.graphClickInterceptor?.clear();
    this.explorer = undefined;
    this.graph = undefined;
    this.graphLabels = undefined;
    this.graphClickInterceptor = undefined;
    this.store.setAll([]);
    this.refreshViews();
  }

  /** Called when settings change: cleanly tear down and re-init. */
  async reconfigure(): Promise<void> {
    this.deactivate();
    if (this.isConfigured()) {
      await this.activate();
    } else {
      this.refreshViews();
    }
  }

  private refreshUI(): void {
    this.refreshDecorations();
    this.refreshViews();
  }

  private refreshDecorations(): void {
    this.explorer?.refresh();
    this.graph?.refresh();
    this.graphLabels?.refresh();
    this.graphClickInterceptor?.refresh();
  }

  private refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof ReviewView) view.render();
    }
  }

  private async activateReviewView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null =
      workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: REVIEW_VIEW_TYPE, active: true });
    }
    if (leaf) workspace.revealLeaf(leaf);
  }

  // --- GatekeeperActions --------------------------------------------------

  async getDiffData(relPath: string): Promise<DiffData> {
    if (!this.engine) throw new Error("Plugin is not active.");
    return this.engine.getDiffData(relPath);
  }

  async accept(relPath: string): Promise<void> {
    if (!this.engine) throw new Error("Plugin is not active.");
    await this.engine.acceptToTarget(relPath);
    // acceptToTarget triggers a scan -> refreshUI via onChange.
  }

  async dismiss(relPath: string): Promise<void> {
    if (!this.engine) return;
    const entry = this.store.get(relPath);
    if (!entry) return;
    // Discard the proposal: revert the gatekeeper file to the target's content.
    // For a tombstone (empty vault file = deletion proposal), revertFromTarget
    // writes the target content back into the vault file, cancelling the deletion.
    const reverted = await this.engine.revertFromTarget(relPath);
    if (reverted) {
      // revertFromTarget rescans -> refreshUI fires via onChange.
      const notice = entry.isTombstone
        ? `Cancelled deletion: ${relPath}`
        : `Discarded (reverted to memory): ${relPath}`;
      new Notice(notice);
      return;
    }
    // New file with no target counterpart: never delete, so hide it (by content
    // hash) until it changes again.
    this.store.dismiss(entry);
    await this.saveSettings();
    this.refreshUI();
    new Notice(`Hidden new proposal until it changes: ${relPath}`);
  }

  async openFile(relPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(relPath);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }

  async openCompare(relPath: string): Promise<void> {
    const { workspace } = this.app;
    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({
      type: COMPARE_VIEW_TYPE,
      active: true,
      state: { relPath },
    });
    workspace.revealLeaf(leaf);
  }

  async writeVault(relPath: string, content: string): Promise<void> {
    if (!this.engine) throw new Error("Plugin is not active.");
    await this.engine.writeVault(relPath, content);
  }

  async writeTarget(relPath: string, content: string): Promise<void> {
    if (!this.engine) throw new Error("Plugin is not active.");
    await this.engine.writeTarget(relPath, content);
  }

  // --- settings -----------------------------------------------------------

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.dismissed) this.settings.dismissed = {};
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
