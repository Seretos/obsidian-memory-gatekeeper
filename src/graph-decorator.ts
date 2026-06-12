import { App, WorkspaceLeaf } from "obsidian";
import type { StatusStore } from "./status-store";
import {
  buildColorGroups,
  colorGroupSignature,
  type ColorGroup,
} from "./core/color-groups";

interface GraphEngine {
  getOptions(): { colorGroups?: ColorGroup[] } & Record<string, unknown>;
  setOptions(options: Record<string, unknown>): void;
  render?(): void;
}

const GRAPH_LEAF_TYPES = ["graph", "localgraph"];

/**
 * Highlights divergent nodes in graph views using the built-in "color groups"
 * feature (robust, search-query based) — there is no public API for individual
 * nodes. Color groups are applied live through the graph's data engine
 * (`view.dataEngine` for the global graph, `view.engine` for local graphs):
 * getOptions() → set colorGroups → setOptions(). The view state path is unused
 * because the global graph's leaf state is empty.
 *
 * We reserve two color groups, identified by COLOR_NEW / COLOR_MODIFIED, and
 * leave any user-defined groups untouched. Change detection avoids re-rendering
 * (and its brief reflow) when the divergent set hasn't changed.
 */
export class GraphDecorator {
  private static readonly COLOR_NEW = 0x44cf6e; // green
  private static readonly COLOR_MODIFIED = 0xe0a83b; // orange
  private static readonly RESERVED = [
    GraphDecorator.COLOR_NEW,
    GraphDecorator.COLOR_MODIFIED,
  ];

  constructor(
    private app: App,
    private store: StatusStore,
  ) {}

  refresh(): void {
    const desired = this.desiredGroups();
    for (const leaf of this.graphLeaves()) {
      try {
        this.applyToLeaf(leaf, desired);
      } catch {
        /* graph internals can change between Obsidian versions; ignore */
      }
    }
  }

  clear(): void {
    for (const leaf of this.graphLeaves()) {
      try {
        this.applyToLeaf(leaf, []);
      } catch {
        /* ignore */
      }
    }
  }

  private graphLeaves(): WorkspaceLeaf[] {
    return GRAPH_LEAF_TYPES.flatMap((t) =>
      this.app.workspace.getLeavesOfType(t),
    );
  }

  private engineOf(leaf: WorkspaceLeaf): GraphEngine | undefined {
    const view = leaf.view as unknown as {
      dataEngine?: GraphEngine;
      engine?: GraphEngine;
    };
    const engine = view?.dataEngine ?? view?.engine;
    if (
      engine &&
      typeof engine.getOptions === "function" &&
      typeof engine.setOptions === "function"
    ) {
      return engine;
    }
    return undefined;
  }

  private desiredGroups(): ColorGroup[] {
    return buildColorGroups(this.store.all(), {
      newColor: GraphDecorator.COLOR_NEW,
      modifiedColor: GraphDecorator.COLOR_MODIFIED,
    });
  }

  private applyToLeaf(leaf: WorkspaceLeaf, desired: ColorGroup[]): void {
    const engine = this.engineOf(leaf);
    if (!engine) return;

    const opts = engine.getOptions();
    const existing = opts.colorGroups ?? [];
    const ours = (g: ColorGroup) =>
      GraphDecorator.RESERVED.includes(g.color?.rgb);

    // Skip if our reserved groups already match — avoids needless re-render.
    if (
      colorGroupSignature(existing.filter(ours)) === colorGroupSignature(desired)
    ) {
      return;
    }

    opts.colorGroups = [...existing.filter((g) => !ours(g)), ...desired];
    engine.setOptions(opts);
    engine.render?.();
  }
}
