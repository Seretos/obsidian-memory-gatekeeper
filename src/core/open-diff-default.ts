import type { FileStatus } from "../types";

/**
 * Pure predicate: returns true when a click on a file should be intercepted
 * to open CompareView instead of the plain Markdown view.
 *
 * Conditions (all must hold):
 *  - `settingEnabled` — the "Open diff by default" toggle is ON
 *  - `configured`     — the plugin has a valid target folder (isConfigured())
 *  - `status`         — the file is divergent ("new" or "modified")
 *
 * All other statuses ("identical", undefined, absent) return false so that
 * non-divergent files open normally.
 */
export function shouldOpenDiffByDefault(
  status: FileStatus | undefined,
  settingEnabled: boolean,
  configured: boolean,
): boolean {
  return (
    settingEnabled && configured && (status === "new" || status === "modified")
  );
}

/**
 * Duck-typed shape for the MouseEvent properties this predicate inspects.
 * Using duck-typing (rather than `instanceof MouseEvent`) keeps the helper
 * unit-testable in a Node/vitest environment where the browser's MouseEvent
 * constructor is unavailable, while remaining correct at runtime inside
 * Obsidian's Electron browser.
 */
interface MouseEventLike {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function isMouseEventLike(evt: unknown): evt is MouseEventLike {
  if (evt === null || typeof evt !== "object") return false;
  const e = evt as Record<string, unknown>;
  return (
    typeof e["button"] === "number" &&
    typeof e["ctrlKey"] === "boolean" &&
    typeof e["metaKey"] === "boolean" &&
    typeof e["altKey"] === "boolean" &&
    typeof e["shiftKey"] === "boolean"
  );
}

/**
 * Pure predicate: returns true only for a plain primary-button click with no
 * modifier keys held. Both the explorer click handler and the graph
 * onNodeClick wrapper use this guard so that Ctrl/Cmd+click (new pane),
 * Alt+click (background), Shift+click, middle-click, and right-click all
 * pass through to Obsidian's default handling unmodified.
 *
 * Accepts any MouseEvent (or MouseEvent-like object); returns false for
 * non-event values and undefined.
 *
 * Note: DOM/renderer interception itself is verified manually per AGENTS.md.
 */
export function isPlainPrimaryClick(evt: unknown): boolean {
  if (!isMouseEventLike(evt)) return false;
  return (
    evt.button === 0 &&
    !evt.ctrlKey &&
    !evt.metaKey &&
    !evt.altKey &&
    !evt.shiftKey
  );
}
