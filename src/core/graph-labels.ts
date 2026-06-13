/**
 * Pure helpers for the graph project-label feature: decide whether a graph node
 * is a project's central `MEMORY.md` and, if so, what its two-line label is.
 * No Obsidian / renderer access here so it can be unit-tested.
 */

export interface ProjectLabel {
  /** Dominant first line: the project name. */
  project: string;
  /** Secondary line: the node's original name in parentheses, e.g. "(MEMORY)". */
  sub: string;
}

const MEMORY_SUFFIX = "/MEMORY.md";

/**
 * If `id` (a graph node id == vault-relative file path) is a project's central
 * `MEMORY.md`, return its label, else null.
 *
 * The project name is taken from the file's `project` frontmatter when present
 * (the robust source — written upstream by the memory hook, see
 * agent-claude-memory-gatekeeper#6), and otherwise falls back to the first path
 * segment (the encoded gatekeeper folder). The encoded folder is not reliably
 * decodable into a pretty name, so it is only a fallback until the frontmatter
 * source lands.
 *
 * A root-level `MEMORY.md` (no parent folder) returns null: there is no project
 * folder to name it after.
 */
export function memoryNodeLabel(
  id: string,
  frontmatterProject?: unknown,
): ProjectLabel | null {
  if (!id.endsWith(MEMORY_SUFFIX)) return null;
  const segs = id.split("/");
  const base = segs[segs.length - 1].replace(/\.md$/, "");
  const fallback = segs[0] || base;
  const fromFm =
    typeof frontmatterProject === "string" ? frontmatterProject.trim() : "";
  return { project: fromFm || fallback, sub: `(${base})` };
}
