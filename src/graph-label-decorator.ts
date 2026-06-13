import { App, WorkspaceLeaf } from "obsidian";
import { memoryNodeLabel, type ProjectLabel } from "./core/graph-labels";

/**
 * Labels each project's central `MEMORY.md` node in the graph with the project
 * name, because every project's hub file is named `MEMORY.md` and they would
 * otherwise all read "MEMORY" and be indistinguishable. The node gets a
 * two-line label:
 *
 *     <project>      ← dominant: bold + large (the node's own PIXI.Text)
 *     (MEMORY)       ← secondary: smaller + normal weight (an attached child)
 *
 * Fragile by nature: there is no public API for node labels, so this overrides
 * undocumented renderer internals (`leaf.view.renderer.nodes[i].text`, a
 * PIXI.Text whose `.text` and `.style` we mutate, plus a child PIXI.Text for
 * line 2). Everything is wrapped in try/catch and expected to need re-testing on
 * Obsidian upgrades (see AGENTS.md → Fragile integrations).
 *
 * A single PIXI.Text carries only one style, so line 2 is a separate PIXI.Text
 * added as a CHILD of the node's text — it inherits the node's position/scale,
 * tracking pan/zoom for free.
 *
 * Re-apply strategy: an interval re-asserts the labels while a graph is open
 * (the renderer creates labels lazily and recreates them as nodes leave/enter
 * the viewport, so a one-shot would not stick). The interval is gated on graph
 * leaves being present, so nothing polls when no graph is open. We deliberately
 * do NOT wrap the renderer's per-frame callback — keeping our hands off core
 * objects is the more robust trade-off here.
 */

const GRAPH_LEAF_TYPES = ["graph", "localgraph"];

// Absolute font sizes (Obsidian's default graph label is ~12). Tuned so the
// project name dominates and the secondary line stays subordinate.
const PROJECT_FONT_SIZE = 26;
const SUB_FONT_SIZE = 13;
const SUB_ALPHA = 0.85;
const REAPPLY_INTERVAL_MS = 250;

// Property used to tag/find the child text we attach to a node's PIXI.Text.
const SUB_FLAG = "__memGatekeeperSub";

/* The renderer/PIXI internals are untyped; keep the any-surface contained. */
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyText = any;

interface GraphNode {
  id?: unknown;
  text?: AnyText | null;
}

interface GraphRenderer {
  nodes?: GraphNode[];
}

interface OriginalLabel {
  text: string;
  /** The node's original PIXI style object, swapped back wholesale on restore.
   *  We replace `t.style` with a clone before mutating, so our size/weight
   *  changes can never leak onto nodes that happen to share a style object. */
  style: unknown;
}

export class GraphLabelDecorator {
  private timer?: number;
  private subs = new Set<AnyText>();
  private originals = new WeakMap<AnyText, OriginalLabel>();

  constructor(private app: App) {}

  /** Apply labels now and keep them applied while a graph is open. */
  refresh(): void {
    this.applyAll();
    this.ensureTimer();
  }

  /** Remove our labels, restore originals, and stop polling. */
  clear(): void {
    this.stopTimer();
    try {
      this.restoreVisible();
    } catch {
      /* ignore */
    }
    for (const sub of this.subs) this.destroySub(sub);
    this.subs.clear();
  }

  // --- timer (gated on an open graph) ------------------------------------

  // refresh() (hence ensureTimer) is driven by main.ts on `layout-change` and
  // `active-leaf-change`, both of which fire when a graph leaf opens/closes, and
  // by the comparison engine's first scan on activation — so the timer starts
  // whenever a graph becomes present without us subscribing to events here.
  private ensureTimer(): void {
    const hasGraph = this.graphLeaves().length > 0;
    if (hasGraph && this.timer == null) {
      this.timer = window.setInterval(() => this.tick(), REAPPLY_INTERVAL_MS);
    } else if (!hasGraph && this.timer != null) {
      this.stopTimer();
    }
  }

  private stopTimer(): void {
    if (this.timer != null) {
      window.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private tick(): void {
    if (this.graphLeaves().length === 0) {
      this.stopTimer();
      return;
    }
    try {
      this.pruneDeadSubs();
      this.applyAll();
    } catch {
      /* graph internals can change between Obsidian versions; ignore */
    }
  }

  /** Drop child texts whose parent was destroyed/detached by the renderer, so
   *  the tracking set can't grow without bound under viewport churn. */
  private pruneDeadSubs(): void {
    for (const sub of this.subs) {
      if (sub?._destroyed || !sub?.parent) {
        this.destroySub(sub);
        this.subs.delete(sub);
      }
    }
  }

  // --- apply -------------------------------------------------------------

  private graphLeaves(): WorkspaceLeaf[] {
    return GRAPH_LEAF_TYPES.flatMap((t) =>
      this.app.workspace.getLeavesOfType(t),
    );
  }

  private rendererOf(leaf: WorkspaceLeaf): GraphRenderer | undefined {
    const v = leaf.view as unknown as { renderer?: GraphRenderer };
    return v?.renderer;
  }

  private applyAll(): void {
    for (const leaf of this.graphLeaves()) {
      const r = this.rendererOf(leaf);
      if (!r) continue;
      for (const n of r.nodes ?? []) {
        try {
          this.applyNode(n);
        } catch {
          /* one bad node shouldn't break the rest */
        }
      }
    }
  }

  private applyNode(n: GraphNode): void {
    const t = n.text;
    if (!t || typeof t.text !== "string") return;

    const label = this.labelFor(n);
    if (!label) {
      // Not (or no longer) a MEMORY node — undo anything we did to this text.
      if (t[SUB_FLAG] || this.originals.has(t)) this.detach(t);
      return;
    }

    if (!this.originals.has(t)) {
      const originalStyle = t.style;
      // Replace the style with a clone before mutating, so our size/weight
      // changes are isolated to this node even if Obsidian shares one style
      // object across labels. Restored by swapping the original back.
      if (originalStyle && typeof originalStyle.clone === "function") {
        t.style = originalStyle.clone();
      }
      this.originals.set(t, { text: t.text, style: originalStyle });
    }

    // Line 1 — project name, bold + large.
    if (t.text !== label.project) t.text = label.project;
    if (t.style) {
      if (t.style.fontSize !== PROJECT_FONT_SIZE) {
        t.style.fontSize = PROJECT_FONT_SIZE;
      }
      if (t.style.fontWeight !== "bold") t.style.fontWeight = "bold";
    }

    // Line 2 — "(MEMORY)", smaller + normal, as an attached child text. Drop a
    // stale reference if the renderer destroyed/reparented our child.
    let sub = t[SUB_FLAG];
    if (sub && (sub._destroyed || sub.parent !== t)) {
      this.subs.delete(sub);
      sub = undefined;
      delete t[SUB_FLAG];
    }
    if (!sub) {
      sub = this.createSub(t, label);
      if (sub) {
        t[SUB_FLAG] = sub;
        this.subs.add(sub);
      }
    }
    if (sub) {
      if (sub.text !== label.sub) sub.text = label.sub;
      this.positionSub(t, sub);
    }
  }

  private labelFor(n: GraphNode): ProjectLabel | null {
    const id = n.id;
    if (typeof id !== "string") return null;
    const frontmatter = this.app.metadataCache.getCache(id)?.frontmatter as
      | Record<string, unknown>
      | undefined;
    return memoryNodeLabel(id, frontmatter?.project);
  }

  private createSub(parent: AnyText, label: ProjectLabel): AnyText | null {
    try {
      const Ctor = parent.constructor as { new (t: string, s: object): AnyText };
      const pstyle = parent.style ?? {};
      const sub = new Ctor(label.sub, {
        fontFamily: pstyle.fontFamily,
        fontSize: SUB_FONT_SIZE,
        fontWeight: "normal",
        fill: pstyle.fill ?? 0xffffff,
      });
      sub.anchor?.set?.(0.5, 0);
      sub.alpha = SUB_ALPHA;
      parent.addChild(sub);
      return sub;
    } catch {
      return null;
    }
  }

  /**
   * Place the secondary line just below line 1. Child coordinates live in the
   * parent's local (pre-scale) space and account for the parent's anchor, so
   * the offset tracks zoom along with the parent.
   */
  private positionSub(parent: AnyText, sub: AnyText): void {
    const anchorY = parent.anchor?.y ?? 0;
    const line1Height = PROJECT_FONT_SIZE * 1.3; // approx unscaled height
    sub.x = 0;
    sub.y = (1 - anchorY) * line1Height + 2; // just below line 1, small gap
  }

  // --- cleanup -----------------------------------------------------------

  /** Restore originals for every currently-live MEMORY text we touched. */
  private restoreVisible(): void {
    for (const leaf of this.graphLeaves()) {
      const r = this.rendererOf(leaf);
      if (!r) continue;
      for (const n of r.nodes ?? []) {
        const t = n.text;
        if (t && (t[SUB_FLAG] || this.originals.has(t))) this.detach(t);
      }
    }
  }

  /** Undo our overrides on one PIXI.Text: drop the child, restore the label. */
  private detach(t: AnyText): void {
    const sub = t[SUB_FLAG];
    if (sub) {
      this.destroySub(sub);
      this.subs.delete(sub);
      delete t[SUB_FLAG];
    }
    const orig = this.originals.get(t);
    if (orig) {
      try {
        if (typeof orig.text === "string") t.text = orig.text;
        // Swap the original style object back wholesale (we mutated a clone).
        if (orig.style !== undefined) t.style = orig.style;
      } catch {
        /* ignore */
      }
      this.originals.delete(t);
    }
  }

  private destroySub(sub: AnyText): void {
    try {
      sub.parent?.removeChild?.(sub);
      sub.destroy?.();
    } catch {
      /* ignore */
    }
  }
}
