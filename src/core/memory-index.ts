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
 * Enumerate all `.md` files under `projectFolder` (recursively), except
 * `MEMORY.md`, read their YAML frontmatter, and write a fresh `MEMORY.md`
 * index into that folder. Files whose frontmatter is absent or incomplete are
 * skipped (a warning is printed to the console, not thrown).
 *
 * Sort order: alphabetical by path relative to `projectFolder`.
 *
 * Output format:
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

  const lines: string[] = ["# Memory Index", ""];
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
 * Scan immediate subdirectories of `rootDir` and, for each that:
 *   (a) has no MEMORY.md at its root, AND
 *   (b) contains at least one .md file (other than MEMORY.md) anywhere inside it,
 * generate a fresh MEMORY.md via `regenerateMemoryIndex`.
 *
 * Returns the number of folders repaired. Subfolders that already have a
 * MEMORY.md are left untouched. Top-level files (not in any subfolder) are
 * ignored. A non-existent `rootDir` returns 0 without throwing.
 *
 * Node-`fs`-only; no Obsidian imports.
 */
export async function repairMissingIndexes(rootDir: string): Promise<number> {
  let dirents;
  try {
    dirents = await fsp.readdir(rootDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let repaired = 0;
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const subdir = path.join(rootDir, dirent.name);
    const indexPath = path.join(subdir, "MEMORY.md");

    // Skip if MEMORY.md already exists.
    try {
      await fsp.access(indexPath);
      continue; // already has MEMORY.md
    } catch {
      // MEMORY.md absent — proceed
    }

    // Only repair if there is at least one .md file (other than MEMORY.md)
    // anywhere inside this subfolder.
    const mdFiles = await collectMdFiles(subdir, subdir);
    if (mdFiles.length === 0) continue;

    await regenerateMemoryIndex(subdir);
    repaired += 1;
  }

  return repaired;
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
