import { promises as fsp } from "fs";
import * as path from "path";

/**
 * Parse YAML frontmatter (the block between the first pair of `---` lines) and
 * extract the `name` and `description` fields. Returns null when the frontmatter
 * block is absent, or when either field is missing or empty.
 *
 * Pure — no Obsidian imports, no DOM access.
 */
export function parseNameDescription(
  content: string,
): { name: string; description: string } | null {
  // Frontmatter must begin at line 1 (index 0).
  const lines = content.split("\n");
  if (lines[0].trim() !== "---") return null;

  // Find the closing ---
  let closingIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closingIdx = i;
      break;
    }
  }
  if (closingIdx === -1) return null;

  const block = lines.slice(1, closingIdx);

  let name = "";
  let description = "";
  for (const line of block) {
    // Match "key: value" — value may contain colons.
    const m = line.match(/^(\w+):\s*(.*)/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    if (key === "name") name = value;
    else if (key === "description") description = value;
  }

  if (!name || !description) return null;
  return { name, description };
}

/**
 * Returns true when `relPath` (Obsidian vault-relative, forward-slash
 * separated) names a `MEMORY.md` index file — i.e. its basename is exactly
 * `MEMORY.md` (case-sensitive, matching the exclusion used in collectMdFiles).
 * Works for root-level `MEMORY.md`, `proj/memory/MEMORY.md`, etc.
 *
 * Pure — no Obsidian imports, no DOM access.
 */
export function isMemoryIndexPath(relPath: string): boolean {
  return relPath.split("/").pop() === "MEMORY.md";
}

/**
 * Describes what handleVaultDelete should do for a given deletion event.
 * Pure — computed entirely from relPath and caller-supplied options; no I/O.
 */
export interface VaultDeletePlan {
  /** false for MEMORY.md paths or suppressed (plugin-initiated) deletions. */
  propagate: boolean;
  /** Absolute path of the target file to unlink; null when !propagate. */
  targetFile: string | null;
  /** Absolute target-side memory folder to reindex; null for top-level files
   *  or when !propagate. */
  targetMemoryFolder: string | null;
  /** Absolute vault-side memory folder to reindex; null when vaultBase is
   *  unavailable, for top-level files, or when !propagate. */
  vaultMemoryFolder: string | null;
}

/**
 * Compute the propagation plan for a vault `delete` event.
 *
 * @param relPath    Vault-relative path of the deleted file (forward slashes).
 * @param opts.targetFolder  Absolute path of the target (real memory) root.
 * @param opts.vaultBase     Absolute vault root path, or null if unavailable.
 * @param opts.suppressed    True when this deletion was initiated by the plugin
 *                           itself (tombstone accept guard).
 *
 * Pure — no I/O, no Obsidian imports.
 */
export function planVaultDeletePropagation(
  relPath: string,
  opts: {
    targetFolder: string;
    vaultBase: string | null;
    suppressed: boolean;
  },
): VaultDeletePlan {
  const noop: VaultDeletePlan = {
    propagate: false,
    targetFile: null,
    targetMemoryFolder: null,
    vaultMemoryFolder: null,
  };

  if (isMemoryIndexPath(relPath) || opts.suppressed) return noop;

  const targetFile = path.join(opts.targetFolder, relPath);

  let targetMemoryFolder: string | null = null;
  let vaultMemoryFolder: string | null = null;

  if (relPath.includes("/")) {
    targetMemoryFolder = path.dirname(targetFile);
    if (opts.vaultBase) {
      vaultMemoryFolder = path.dirname(path.join(opts.vaultBase, relPath));
    }
  }

  return { propagate: true, targetFile, targetMemoryFolder, vaultMemoryFolder };
}

/**
 * Parse the `project:` field from YAML frontmatter. Returns the trimmed value
 * when found and non-empty, null otherwise. Independent of parseNameDescription's
 * null rule — a file can lack name/description but still carry a project field.
 *
 * Pure — no Obsidian imports, no DOM access.
 */
export function parseProject(content: string): string | null {
  const lines = content.split("\n");
  if (lines[0].trim() !== "---") return null;

  let closingIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closingIdx = i;
      break;
    }
  }
  if (closingIdx === -1) return null;

  const block = lines.slice(1, closingIdx);
  for (const line of block) {
    const m = line.match(/^(\w+):\s*(.*)/);
    if (!m) continue;
    if (m[1] === "project") {
      const value = m[2].trim();
      return value || null;
    }
  }
  return null;
}

/**
 * Enumerate all `.md` files under `projectFolder` (recursively), except
 * `MEMORY.md`, read their YAML frontmatter, and write a fresh `MEMORY.md`
 * index into that folder. Files whose frontmatter is absent or incomplete are
 * skipped (a warning is printed to the console, not thrown).
 *
 * Sort order: alphabetical by path relative to `projectFolder`.
 *
 * Output format (when a `project:` field is found in any sibling .md file):
 * ```
 * ---
 * project: <value>
 * ---
 *
 * # Memory Index
 *
 * - [<name>](<relPath>) — <description>
 * ```
 *
 * Output format (when no `project:` field is found — keeps existing tests green):
 * ```
 * # Memory Index
 *
 * - [<name>](<relPath>) — <description>
 * ```
 *
 * Node-`fs`-only; no Obsidian imports.
 */
export async function regenerateMemoryIndex(
  projectFolder: string,
): Promise<void> {
  const entries = await collectMdFiles(projectFolder, projectFolder);

  // Sort deterministically by relative path.
  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));

  // Determine the project name from the first non-empty `project:` value found
  // across all sibling .md files (independent of name/description validity).
  let projectName: string | null = null;
  for (const { content } of entries) {
    const p = parseProject(content);
    if (p) {
      projectName = p;
      break;
    }
  }

  const lines: string[] = [];

  // Prepend YAML frontmatter block when a project name is known.
  if (projectName) {
    lines.push("---", `project: ${projectName}`, "---", "");
  }

  lines.push("# Memory Index", "");
  for (const { relPath, content } of entries) {
    const parsed = parseNameDescription(content);
    if (!parsed) {
      console.warn(
        `[memory-index] skipping ${relPath}: missing or incomplete frontmatter`,
      );
      continue;
    }
    // Use forward slashes in links regardless of OS.
    const linkPath = relPath.split(path.sep).join("/");
    lines.push(`- [${parsed.name}](${linkPath}) — ${parsed.description}`);
  }
  lines.push(""); // trailing newline

  const indexPath = path.join(projectFolder, "MEMORY.md");
  await fsp.writeFile(indexPath, lines.join("\n"), "utf8");
}

/**
 * Recursively walk `targetRoot` to find every directory (excluding targetRoot
 * itself) that directly contains at least one `.md` file other than `MEMORY.md`.
 * These are the "memory folders" (e.g. `<project>/memory/`).
 *
 * For each such folder:
 *   1. Call `regenerateMemoryIndex(folder)` to write / overwrite
 *      `<folder>/MEMORY.md` in the TARGET (always regenerated, even if one
 *      already exists).
 *   2. If `vaultRoot` is non-null, compute the mirrored vault path
 *      (`path.join(vaultRoot, path.relative(targetRoot, folder))`). If that
 *      vault folder already exists, copy the freshly generated `MEMORY.md`
 *      there (overwrite). New vault folders are never created — mirror only.
 *
 * Returns the count of target memory folders regenerated.
 * A non-existent `targetRoot` returns 0 without throwing.
 * `vaultRoot === null` means skip the mirror step.
 *
 * All copy I/O is non-fatal (try/catch + console.warn).
 * Node-`fs`-only; no Obsidian imports.
 */
export async function repairMissingIndexes(
  targetRoot: string,
  vaultRoot: string | null,
): Promise<number> {
  let repaired = 0;

  // Collect every directory (excluding targetRoot) that directly holds ≥1 .md
  // file (excluding MEMORY.md). Walk recursively.
  const memoryFolders = await findMemoryFolders(targetRoot);

  for (const folder of memoryFolders) {
    // Regenerate in the target (always overwrite). Track whether it succeeded
    // so the count only reflects actual successful regenerations.
    let regenerated = false;
    try {
      await regenerateMemoryIndex(folder);
      regenerated = true;
    } catch (e: unknown) {
      console.warn("[memory-index] repair: regeneration failed for", folder, e);
    }
    if (regenerated) repaired += 1;

    // Mirror into the vault if vaultRoot is provided and the vault folder exists.
    if (vaultRoot !== null) {
      const rel = path.relative(targetRoot, folder);
      const vaultFolder = path.join(vaultRoot, rel);
      try {
        // Only mirror if the vault folder actually exists — stat throws otherwise.
        const stat = await fsp.stat(vaultFolder);
        if (stat.isDirectory()) {
          const src = path.join(folder, "MEMORY.md");
          const dst = path.join(vaultFolder, "MEMORY.md");
          await fsp.copyFile(src, dst);
        }
      } catch (e: unknown) {
        // Vault folder absent or copy failed — non-fatal.
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          console.warn("[memory-index] repair: vault mirror failed for", vaultFolder, e);
        }
      }
    }
  }

  return repaired;
}

/**
 * Recursively find all directories UNDER `rootDir` (rootDir itself is never
 * included) that directly contain at least one `.md` file other than `MEMORY.md`.
 * A non-existent `rootDir` returns an empty array without throwing.
 */
async function findMemoryFolders(rootDir: string): Promise<string[]> {
  let dirents;
  try {
    dirents = await fsp.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const subdir = path.join(rootDir, dirent.name);
    // Check and recurse into this subdirectory.
    const subResults = await findMemoryFoldersRecurse(subdir);
    results.push(...subResults);
  }
  return results;
}

/**
 * Internal recursive helper: returns `dir` itself if it directly contains ≥1
 * non-MEMORY `.md` file, plus any matching descendant directories.
 */
async function findMemoryFoldersRecurse(dir: string): Promise<string[]> {
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: string[] = [];
  let hasDirectMd = false;

  for (const dirent of dirents) {
    if (dirent.isDirectory()) {
      const sub = await findMemoryFoldersRecurse(path.join(dir, dirent.name));
      results.push(...sub);
    } else if (
      dirent.isFile() &&
      dirent.name.endsWith(".md") &&
      dirent.name !== "MEMORY.md"
    ) {
      hasDirectMd = true;
    }
  }

  if (hasDirectMd) {
    results.push(dir);
  }

  return results;
}

/** Recursively collect all .md files under `dir` (excluding MEMORY.md). */
async function collectMdFiles(
  rootFolder: string,
  dir: string,
): Promise<Array<{ relPath: string; content: string }>> {
  const results: Array<{ relPath: string; content: string }> = [];

  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const dirent of dirents) {
    const fullPath = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      const sub = await collectMdFiles(rootFolder, fullPath);
      results.push(...sub);
    } else if (
      dirent.isFile() &&
      dirent.name.endsWith(".md") &&
      dirent.name !== "MEMORY.md"
    ) {
      try {
        const content = await fsp.readFile(fullPath, "utf8");
        const relPath = path.relative(rootFolder, fullPath);
        results.push({ relPath, content });
      } catch {
        // Skip unreadable files silently.
      }
    }
  }

  return results;
}
