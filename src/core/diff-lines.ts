import { diffLines } from "diff";

export type DiffLineType = "added" | "removed" | "context";

export interface DiffLine {
  type: DiffLineType;
  /** Single line of content (no trailing newline), without the +/-/space marker. */
  text: string;
}

const PREFIX: Record<DiffLineType, string> = {
  added: "+ ",
  removed: "- ",
  context: "  ",
};

/** Marker prefix ("+ ", "- ", "  ") for a diff line type. */
export function linePrefix(type: DiffLineType): string {
  return PREFIX[type];
}

/**
 * Compute a flat, per-line diff between `before` (target) and `after` (vault).
 * Each diff part can span multiple lines; this splits them into individual
 * lines tagged added / removed / context. Pure — no DOM access.
 */
export function computeDiffLines(before: string, after: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const part of diffLines(before, after)) {
    const type: DiffLineType = part.added
      ? "added"
      : part.removed
        ? "removed"
        : "context";
    for (const text of part.value.replace(/\n$/, "").split("\n")) {
      out.push({ type, text });
    }
  }
  return out;
}
