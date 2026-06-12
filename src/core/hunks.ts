import { computeDiffLines, type DiffLine } from "./diff-lines";

export interface Hunk {
  /** 0-based inclusive start in the "before" (target) sequence. */
  startBefore: number;
  /** 0-based exclusive end in the "before" (target) sequence. */
  endBefore: number;
  /** 0-based inclusive start in the "after" (vault) sequence. */
  startAfter: number;
  /** 0-based exclusive end in the "after" (vault) sequence. */
  endAfter: number;
  lines: DiffLine[];
}

/**
 * Group a flat DiffLine[] (from computeDiffLines) into hunks, each capturing
 * a changed region together with up to `contextLines` surrounding context
 * lines. Identical files produce []. Overlapping or adjacent context windows
 * are merged into one hunk.
 *
 * Pure — no DOM access.
 */
export function groupHunks(
  diffLines: DiffLine[],
  contextLines = 3,
): Hunk[] {
  if (diffLines.length === 0) return [];

  // First pass: collect flat diff records tracking both-side line indices.
  interface FlatRecord {
    line: DiffLine;
    idxBefore: number; // -1 for added lines (no before index)
    idxAfter: number;  // -1 for removed lines (no after index)
  }

  const flat: FlatRecord[] = [];
  let iBefore = 0;
  let iAfter = 0;
  for (const line of diffLines) {
    if (line.type === "context") {
      flat.push({ line, idxBefore: iBefore, idxAfter: iAfter });
      iBefore++;
      iAfter++;
    } else if (line.type === "removed") {
      flat.push({ line, idxBefore: iBefore, idxAfter: -1 });
      iBefore++;
    } else {
      // added
      flat.push({ line, idxBefore: -1, idxAfter: iAfter });
      iAfter++;
    }
  }

  // Find indices (in `flat`) of all changed lines.
  const changedIndices: number[] = [];
  for (let i = 0; i < flat.length; i++) {
    if (flat[i].line.type !== "context") changedIndices.push(i);
  }
  if (changedIndices.length === 0) return [];

  // Merge changed indices into windows [start, end) in flat-index space,
  // expanding by contextLines on each side and merging overlapping windows.
  const windows: Array<{ from: number; to: number }> = [];
  for (const ci of changedIndices) {
    const from = Math.max(0, ci - contextLines);
    const to = Math.min(flat.length, ci + contextLines + 1);
    if (
      windows.length > 0 &&
      from <= windows[windows.length - 1].to
    ) {
      // Merge with the last window.
      windows[windows.length - 1].to = Math.max(
        windows[windows.length - 1].to,
        to,
      );
    } else {
      windows.push({ from, to });
    }
  }

  // Convert windows to Hunks.
  const hunks: Hunk[] = [];
  for (const win of windows) {
    const slice = flat.slice(win.from, win.to);
    // Determine before/after ranges from the slice.
    let startBefore = -1;
    let endBefore = -1;
    let startAfter = -1;
    let endAfter = -1;

    for (const rec of slice) {
      if (rec.idxBefore !== -1) {
        if (startBefore === -1) startBefore = rec.idxBefore;
        endBefore = rec.idxBefore + 1;
      }
      if (rec.idxAfter !== -1) {
        if (startAfter === -1) startAfter = rec.idxAfter;
        endAfter = rec.idxAfter + 1;
      }
    }

    // If a window contains only added lines, startBefore stays -1; clamp to
    // the before-index just before the window begins (insertion point).
    if (startBefore === -1) {
      // Find first before-indexed record before this window.
      let insertPoint = 0;
      for (let i = win.from - 1; i >= 0; i--) {
        if (flat[i].idxBefore !== -1) {
          insertPoint = flat[i].idxBefore + 1;
          break;
        }
      }
      startBefore = insertPoint;
      endBefore = insertPoint;
    }
    if (startAfter === -1) {
      let insertPoint = 0;
      for (let i = win.from - 1; i >= 0; i--) {
        if (flat[i].idxAfter !== -1) {
          insertPoint = flat[i].idxAfter + 1;
          break;
        }
      }
      startAfter = insertPoint;
      endAfter = insertPoint;
    }

    hunks.push({
      startBefore,
      endBefore,
      startAfter,
      endAfter,
      lines: slice.map((r) => r.line),
    });
  }

  return hunks;
}

/**
 * Accept a hunk in the direction vault ← target: copy the target (removed)
 * lines from the hunk into the vault buffer, replacing the vault (added) lines.
 * Returns a new array — the input is not mutated.
 */
export function applyHunkToLeft(vaultLines: string[], hunk: Hunk): string[] {
  // The "removed" lines in the hunk are the target's lines.
  const targetLines = hunk.lines
    .filter((l) => l.type === "removed")
    .map((l) => l.text);
  const result = [...vaultLines];
  result.splice(hunk.startAfter, hunk.endAfter - hunk.startAfter, ...targetLines);
  return result;
}

/**
 * Accept a hunk in the direction vault → target: copy the vault (added)
 * lines from the hunk into the target buffer, replacing the target (removed) lines.
 * Returns a new array — the input is not mutated.
 */
export function applyHunkToRight(targetLines: string[], hunk: Hunk): string[] {
  // The "added" lines in the hunk are the vault's lines.
  const vaultLines = hunk.lines
    .filter((l) => l.type === "added")
    .map((l) => l.text);
  const result = [...targetLines];
  result.splice(hunk.startBefore, hunk.endBefore - hunk.startBefore, ...vaultLines);
  return result;
}

/**
 * Convenience: compute hunks directly from two text strings.
 * before = target content, after = vault content.
 */
export function computeHunks(
  before: string,
  after: string,
  contextLines = 3,
): Hunk[] {
  return groupHunks(computeDiffLines(before, after), contextLines);
}

/** Unchanged run, identical on both sides. */
export interface ContextSegment {
  type: "context";
  lines: string[];
}

/**
 * A changed region. `removed` are the "before"/target lines (old), `added`
 * are the "after"/vault lines (new). Either may be empty (pure insertion or
 * pure deletion). `hunk` carries the exact 0-context index ranges so the
 * change can be applied with applyHunkToLeft / applyHunkToRight.
 */
export interface ChangeSegment {
  type: "change";
  removed: string[];
  added: string[];
  hunk: Hunk;
}

export type DiffSegment = ContextSegment | ChangeSegment;

/**
 * Split the diff between `before` (target) and `after` (vault) into an ordered
 * sequence of context and change segments. Consecutive unchanged lines collapse
 * into one ContextSegment; each maximal run of added/removed lines becomes one
 * ChangeSegment carrying its exact Hunk (0 context lines). The change segments
 * are in 1:1 order with `groupHunks(diff, 0)`.
 *
 * This is the rendering-agnostic backbone of the compare view: the UI walks
 * these segments to render unchanged prose once and changed prose as aligned
 * old-vs-new blocks with per-hunk accept/revert controls. Pure — no DOM access.
 */
export function buildDiffSegments(before: string, after: string): DiffSegment[] {
  const diff = computeDiffLines(before, after);
  const hunks = groupHunks(diff, 0);

  const segments: DiffSegment[] = [];
  let context: string[] = [];
  let hunkIdx = 0;
  let i = 0;

  const flushContext = (): void => {
    if (context.length > 0) {
      segments.push({ type: "context", lines: context });
      context = [];
    }
  };

  while (i < diff.length) {
    if (diff[i].type === "context") {
      context.push(diff[i].text);
      i++;
      continue;
    }
    // Start of a change run — flush any pending context first.
    flushContext();
    const removed: string[] = [];
    const added: string[] = [];
    while (i < diff.length && diff[i].type !== "context") {
      if (diff[i].type === "removed") removed.push(diff[i].text);
      else added.push(diff[i].text);
      i++;
    }
    segments.push({ type: "change", removed, added, hunk: hunks[hunkIdx++] });
  }
  flushContext();

  return segments;
}
