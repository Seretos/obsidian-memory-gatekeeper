import type { DivergentEntry } from "../types";

export interface ColorGroup {
  query: string;
  color: { a: number; rgb: number };
}

export interface GroupColors {
  /** rgb for "new" files. */
  newColor: number;
  /** rgb for "modified" files. */
  modifiedColor: number;
}

/**
 * Build the graph color groups for the current divergent set: one group per
 * status (new / modified) whose query ORs together the matching file paths.
 * Statuses with no files produce no group. Pure — no graph/engine access.
 */
export function buildColorGroups(
  entries: DivergentEntry[],
  colors: GroupColors,
): ColorGroup[] {
  const groups: ColorGroup[] = [];
  const build = (status: "new" | "modified", rgb: number) => {
    const paths = entries
      .filter((e) => e.status === status)
      .map((e) => `path:"${e.relPath}"`);
    if (paths.length) {
      groups.push({ query: paths.join(" OR "), color: { a: 1, rgb } });
    }
  };
  build("new", colors.newColor);
  build("modified", colors.modifiedColor);
  return groups;
}

/** Order-independent signature of a set of color groups, for change detection. */
export function colorGroupSignature(groups: ColorGroup[]): string {
  return groups
    .map((g) => `${g.color?.rgb}:${g.query}`)
    .sort()
    .join("|");
}
