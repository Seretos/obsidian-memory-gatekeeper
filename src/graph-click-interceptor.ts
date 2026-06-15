import { App, WorkspaceLeaf } from "obsidian";
import type { StatusStore } from "./status-store";
import type { GatekeeperSettings } from "./types";
import { shouldOpenDiffByDefault, isPlainPrimaryClick, isMouseEventLike } from "./core/open-diff-default";

const GRAPH_LEAF_TYPES = ["graph", "localgraph"];

/* The renderer internals are untyped; keep the any-surface contained. */
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyRenderer = any;

/**
 * Intercepts graph node clicks to open CompareView for divergent files when the
 * "open diff by default" setting is enabled.
 *
 * Strategy: wrap each leaf's `renderer.onNodeClick` (save the original per
 * leaf renderer; replacement checks divergence + setting via
 * `shouldOpenDiffByDefault`, calls `openCompare(id)` and returns, else
 * delegates to original). `clear()` restores all saved originals.
 *
 * Fragile: `renderer.onNodeClick` is an undocumented internal. The same
 * pattern of touching renderer internals is used by GraphLabelDecorator for
 * node labels. All renderer access is wrapped in try/catch and may need
 * re-testing on Obsidian upgrades (see AGENTS.md → Fragile integrations).
 */
export class GraphClickInterceptor {
  /** Maps renderer → saved original onNodeClick for restoration in clear(). */
  private originals = new Map<AnyRenderer, AnyRenderer>();

  constructor(
    private app: App,
    private store: StatusStore,
    private settings: GatekeeperSettings,
    private isConfigured: () => boolean,
    private openCompare: (relPath: string) => Promise<void>,
  ) {}

  /** Wrap onNodeClick on every current graph leaf renderer. */
  refresh(): void {
    for (const leaf of this.graphLeaves()) {
      try {
        this.wrapLeaf(leaf);
      } catch {
        /* renderer internals can change between Obsidian versions; ignore */
      }
    }
  }

  /** Restore all saved originals and forget them. */
  clear(): void {
    for (const [renderer, original] of this.originals) {
      try {
        renderer.onNodeClick = original;
      } catch {
        /* ignore */
      }
    }
    this.originals.clear();
  }

  private graphLeaves(): WorkspaceLeaf[] {
    return GRAPH_LEAF_TYPES.flatMap((t) =>
      this.app.workspace.getLeavesOfType(t),
    );
  }

  private rendererOf(leaf: WorkspaceLeaf): AnyRenderer | undefined {
    const v = leaf.view as unknown as { renderer?: AnyRenderer };
    return v?.renderer;
  }

  private wrapLeaf(leaf: WorkspaceLeaf): void {
    const renderer = this.rendererOf(leaf);
    if (!renderer) return;

    // Already wrapped — skip to avoid double-wrapping.
    if (this.originals.has(renderer)) return;

    const original = renderer.onNodeClick;
    if (typeof original !== "function") return;

    // Capture the instance fields needed in the closure without `this` leaking.
    const store = this.store;
    const settings = this.settings;
    const isConfigured = this.isConfigured.bind(this);
    const openCompare = this.openCompare;

    renderer.onNodeClick = function (this: AnyRenderer, id: unknown, ...args: unknown[]) {
      try {
        if (typeof id === "string") {
          // The renderer passes the originating MouseEvent as one of the args
          // (position varies by Obsidian version). Search args for a mouse-
          // event-like value so that modifier-key clicks (Ctrl/Cmd/Alt/Shift)
          // and non-primary buttons pass through to Obsidian's default handling
          // unmodified. Uses duck-typing (isMouseEventLike) rather than
          // `instanceof MouseEvent` to avoid fragility against cross-realm
          // objects. If no event-like arg is found, fail safe by delegating.
          const mouseEvt = args.find(isMouseEventLike);
          if (mouseEvt !== undefined && !isPlainPrimaryClick(mouseEvt)) {
            return original.call(this, id, ...args);
          }
          const status = store.statusOf(id);
          if (
            mouseEvt !== undefined &&
            shouldOpenDiffByDefault(status, settings.openDiffByDefault, isConfigured())
          ) {
            void openCompare(id);
            return;
          }
        }
      } catch {
        /* guard against store or settings access errors */
      }
      // Delegate to original with correct `this` context.
      return original.call(this, id, ...args);
    };

    this.originals.set(renderer, original);
  }
}
