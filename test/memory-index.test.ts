import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "fs";
import * as path from "path";
import * as os from "os";
import {
  isMemoryIndexPath,
  parseNameDescription,
  parseProject,
  planVaultDeletePropagation,
  regenerateMemoryIndex,
  repairMissingIndexes,
} from "../src/core/memory-index";

// ---------------------------------------------------------------------------
// isMemoryIndexPath
// ---------------------------------------------------------------------------

describe("isMemoryIndexPath", () => {
  it("returns true for a file at <project>/memory/MEMORY.md", () => {
    expect(isMemoryIndexPath("proj/memory/MEMORY.md")).toBe(true);
  });

  it("returns true for a root-level MEMORY.md (bare name)", () => {
    expect(isMemoryIndexPath("MEMORY.md")).toBe(true);
  });

  it("returns true for a deeply nested MEMORY.md", () => {
    expect(isMemoryIndexPath("a/b/c/MEMORY.md")).toBe(true);
  });

  it("returns false for an ordinary memory note", () => {
    expect(isMemoryIndexPath("proj/memory/some-note.md")).toBe(false);
  });

  it("returns false for memory.md (lowercase — case-sensitive)", () => {
    expect(isMemoryIndexPath("proj/memory/memory.md")).toBe(false);
  });

  it("returns false for MEMORY.md.bak (non-exact basename)", () => {
    expect(isMemoryIndexPath("proj/MEMORY.md.bak")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// planVaultDeletePropagation
// ---------------------------------------------------------------------------

describe("planVaultDeletePropagation", () => {
  const TARGET = "/target";
  const VAULT = "/vault";

  it("MEMORY.md → propagate:false, all nulls", () => {
    const plan = planVaultDeletePropagation("proj/memory/MEMORY.md", {
      targetFolder: TARGET,
      vaultBase: VAULT,
      suppressed: false,
    });
    expect(plan.propagate).toBe(false);
    expect(plan.targetFile).toBeNull();
    expect(plan.targetMemoryFolder).toBeNull();
    expect(plan.vaultMemoryFolder).toBeNull();
  });

  it("suppressed:true → propagate:false regardless of path", () => {
    const plan = planVaultDeletePropagation("proj/memory/note.md", {
      targetFolder: TARGET,
      vaultBase: VAULT,
      suppressed: true,
    });
    expect(plan.propagate).toBe(false);
    expect(plan.targetFile).toBeNull();
    expect(plan.targetMemoryFolder).toBeNull();
    expect(plan.vaultMemoryFolder).toBeNull();
  });

  it("normal nested file → propagate:true with correct targetFile and both memory folders", () => {
    const plan = planVaultDeletePropagation("proj/memory/note.md", {
      targetFolder: TARGET,
      vaultBase: VAULT,
      suppressed: false,
    });
    expect(plan.propagate).toBe(true);
    // Normalise separators for cross-platform comparison.
    expect(plan.targetFile?.replace(/\\/g, "/")).toBe("/target/proj/memory/note.md");
    expect(plan.targetMemoryFolder?.replace(/\\/g, "/")).toBe("/target/proj/memory");
    expect(plan.vaultMemoryFolder?.replace(/\\/g, "/")).toBe("/vault/proj/memory");
  });

  it("vaultBase null → vaultMemoryFolder null, target side still populated", () => {
    const plan = planVaultDeletePropagation("proj/memory/note.md", {
      targetFolder: TARGET,
      vaultBase: null,
      suppressed: false,
    });
    expect(plan.propagate).toBe(true);
    expect(plan.targetFile?.replace(/\\/g, "/")).toBe("/target/proj/memory/note.md");
    expect(plan.targetMemoryFolder?.replace(/\\/g, "/")).toBe("/target/proj/memory");
    expect(plan.vaultMemoryFolder).toBeNull();
  });

  it("top-level file (no '/') → propagate:true, targetFile set, both folders null", () => {
    const plan = planVaultDeletePropagation("note.md", {
      targetFolder: TARGET,
      vaultBase: VAULT,
      suppressed: false,
    });
    expect(plan.propagate).toBe(true);
    expect(plan.targetFile?.replace(/\\/g, "/")).toBe("/target/note.md");
    expect(plan.targetMemoryFolder).toBeNull();
    expect(plan.vaultMemoryFolder).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseNameDescription
// ---------------------------------------------------------------------------

describe("parseNameDescription", () => {
  it("parses a frontmatter block with name and description", () => {
    const content = [
      "---",
      "name: My Memory",
      "description: A useful memory entry",
      "---",
      "",
      "Body text.",
    ].join("\n");
    expect(parseNameDescription(content)).toEqual({
      name: "My Memory",
      description: "A useful memory entry",
    });
  });

  it("returns null when there is no frontmatter block", () => {
    expect(parseNameDescription("Just body text without frontmatter.")).toBeNull();
  });

  it("returns null when the opening --- is not on the first line", () => {
    const content = "\n---\nname: x\ndescription: y\n---\n";
    expect(parseNameDescription(content)).toBeNull();
  });

  it("returns null when there is no closing ---", () => {
    const content = "---\nname: x\ndescription: y\n";
    expect(parseNameDescription(content)).toBeNull();
  });

  it("returns null when name is missing from frontmatter", () => {
    const content = "---\ndescription: Only a description\n---\n";
    expect(parseNameDescription(content)).toBeNull();
  });

  it("returns null when description is missing from frontmatter", () => {
    const content = "---\nname: Only a name\n---\n";
    expect(parseNameDescription(content)).toBeNull();
  });

  it("returns null when name is present but empty", () => {
    const content = "---\nname:\ndescription: Something\n---\n";
    expect(parseNameDescription(content)).toBeNull();
  });

  it("returns null when description is present but empty", () => {
    const content = "---\nname: Something\ndescription:\n---\n";
    expect(parseNameDescription(content)).toBeNull();
  });

  it("handles extra fields in the frontmatter block", () => {
    const content = [
      "---",
      "project: my-project",
      "name: Useful Fact",
      "tags: [foo, bar]",
      "description: Describes the fact",
      "---",
    ].join("\n");
    expect(parseNameDescription(content)).toEqual({
      name: "Useful Fact",
      description: "Describes the fact",
    });
  });

  it("handles description with colons in the value", () => {
    const content = "---\nname: API Key\ndescription: key: value pair format\n---\n";
    expect(parseNameDescription(content)).toEqual({
      name: "API Key",
      description: "key: value pair format",
    });
  });

  it("returns null for an empty string", () => {
    expect(parseNameDescription("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseProject
// ---------------------------------------------------------------------------

describe("parseProject", () => {
  it("returns the project value when present in frontmatter", () => {
    const content = "---\nproject: my-project\nname: X\ndescription: Y\n---\n";
    expect(parseProject(content)).toBe("my-project");
  });

  it("returns null when frontmatter has no project field", () => {
    const content = "---\nname: X\ndescription: Y\n---\n";
    expect(parseProject(content)).toBeNull();
  });

  it("returns null when project: value is empty", () => {
    const content = "---\nproject:\nname: X\ndescription: Y\n---\n";
    expect(parseProject(content)).toBeNull();
  });

  it("returns null when there is no frontmatter block at all", () => {
    expect(parseProject("Just plain text with no frontmatter.")).toBeNull();
  });

  it("is independent of name/description — returns project even when name and description are absent", () => {
    // parseNameDescription would return null for this content, but parseProject
    // must still return the project value.
    const content = "---\nproject: standalone-project\n---\n";
    expect(parseProject(content)).toBe("standalone-project");
  });

  it("returns null when the opening --- is not on the first line", () => {
    const content = "\n---\nproject: x\n---\n";
    expect(parseProject(content)).toBeNull();
  });

  it("returns null when there is no closing ---", () => {
    const content = "---\nproject: x\n";
    expect(parseProject(content)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// regenerateMemoryIndex  (regression + edge cases)
// ---------------------------------------------------------------------------

describe("regenerateMemoryIndex", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gk-memidx-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  // Helper: write a file relative to tmpDir, creating parent dirs.
  async function writeFile(relPath: string, content: string): Promise<void> {
    const full = path.join(tmpDir, relPath);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content, "utf8");
  }

  // Helper: read MEMORY.md from tmpDir.
  async function readIndex(): Promise<string> {
    return fsp.readFile(path.join(tmpDir, "MEMORY.md"), "utf8");
  }

  // --- Regression test ---------------------------------------------------

  it("regression: two valid files produce correct bullets; stale content is replaced", async () => {
    // Write a stale MEMORY.md to confirm it gets overwritten.
    await writeFile("MEMORY.md", "# Stale index\n\n- [old](old.md) — stale\n");

    await writeFile(
      "alpha.md",
      "---\nname: Alpha Entry\ndescription: The first entry\n---\n\nBody.\n",
    );
    await writeFile(
      "beta.md",
      "---\nname: Beta Entry\ndescription: The second entry\n---\n\nBody.\n",
    );

    await regenerateMemoryIndex(tmpDir);

    const index = await readIndex();
    expect(index).toContain("# Memory Index");
    expect(index).toContain("- [Alpha Entry](alpha.md) — The first entry");
    expect(index).toContain("- [Beta Entry](beta.md) — The second entry");
    // Stale content is gone.
    expect(index).not.toContain("old");
    expect(index).not.toContain("stale");
    // Fixtures carry no `project:` field — output must NOT start with frontmatter.
    expect(index.startsWith("# Memory Index")).toBe(true);
    expect(index).not.toContain("---");
  });

  // --- Edge cases --------------------------------------------------------

  it("skips files without a frontmatter block", async () => {
    await writeFile("no-front.md", "Just body text, no frontmatter.\n");
    await writeFile(
      "good.md",
      "---\nname: Good\ndescription: Has frontmatter\n---\n",
    );

    await regenerateMemoryIndex(tmpDir);

    const index = await readIndex();
    expect(index).toContain("- [Good](good.md) — Has frontmatter");
    expect(index).not.toContain("no-front");
  });

  it("skips files whose frontmatter is missing the name field", async () => {
    await writeFile(
      "no-name.md",
      "---\ndescription: Only a description\n---\n",
    );

    await regenerateMemoryIndex(tmpDir);

    const index = await readIndex();
    expect(index).not.toContain("no-name");
    // Only the header line.
    const bullets = index
      .split("\n")
      .filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(0);
  });

  it("skips files whose frontmatter is missing the description field", async () => {
    await writeFile("no-desc.md", "---\nname: Only a name\n---\n");

    await regenerateMemoryIndex(tmpDir);

    const index = await readIndex();
    expect(index).not.toContain("no-desc");
  });

  it("excludes MEMORY.md from enumeration", async () => {
    // Even if MEMORY.md has valid frontmatter, it must not appear in the index.
    await writeFile(
      "MEMORY.md",
      "---\nname: Memory Index\ndescription: Should be excluded\n---\n",
    );
    await writeFile(
      "real.md",
      "---\nname: Real Entry\ndescription: Should be included\n---\n",
    );

    await regenerateMemoryIndex(tmpDir);

    const index = await readIndex();
    expect(index).not.toContain("Should be excluded");
    expect(index).toContain("- [Real Entry](real.md) — Should be included");
  });

  it("empty project folder (no .md files other than MEMORY.md) writes header-only output", async () => {
    await regenerateMemoryIndex(tmpDir);

    const index = await readIndex();
    // Should start with the header and have no bullet lines.
    expect(index.startsWith("# Memory Index")).toBe(true);
    const bullets = index
      .split("\n")
      .filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(0);
  });

  it("includes files in nested subdirectories with folder-relative link paths", async () => {
    await writeFile(
      path.join("memories", "deep.md"),
      "---\nname: Deep Entry\ndescription: In a subdirectory\n---\n",
    );

    await regenerateMemoryIndex(tmpDir);

    const index = await readIndex();
    // The link path should use forward slashes regardless of OS.
    expect(index).toContain("- [Deep Entry](memories/deep.md) — In a subdirectory");
  });

  it("sorts entries alphabetically by relative path", async () => {
    await writeFile(
      "z-last.md",
      "---\nname: Z Last\ndescription: Z comes last\n---\n",
    );
    await writeFile(
      "a-first.md",
      "---\nname: A First\ndescription: A comes first\n---\n",
    );
    await writeFile(
      "m-middle.md",
      "---\nname: M Middle\ndescription: M comes middle\n---\n",
    );

    await regenerateMemoryIndex(tmpDir);

    const index = await readIndex();
    const lines = index.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("a-first.md");
    expect(lines[1]).toContain("m-middle.md");
    expect(lines[2]).toContain("z-last.md");
  });

  it("overwrites a pre-existing MEMORY.md on repeated calls", async () => {
    await writeFile(
      "entry.md",
      "---\nname: My Entry\ndescription: Persists\n---\n",
    );

    await regenerateMemoryIndex(tmpDir);
    const first = await readIndex();
    expect(first).toContain("- [My Entry](entry.md) — Persists");

    // Remove the entry and regenerate — MEMORY.md should now be header-only.
    await fsp.unlink(path.join(tmpDir, "entry.md"));
    await regenerateMemoryIndex(tmpDir);
    const second = await readIndex();
    expect(second).not.toContain("My Entry");
    expect(second.startsWith("# Memory Index")).toBe(true);
  });

  it("prepends project: frontmatter block when memory files carry a project field", async () => {
    await writeFile(
      "alpha.md",
      "---\nproject: lib-python-vdesktop\nname: Alpha\ndescription: First entry\n---\n",
    );
    await writeFile(
      "beta.md",
      "---\nproject: lib-python-vdesktop\nname: Beta\ndescription: Second entry\n---\n",
    );

    await regenerateMemoryIndex(tmpDir);

    const index = await readIndex();
    // Must start with a YAML frontmatter block containing the project name.
    expect(index.startsWith("---\nproject: lib-python-vdesktop\n---\n")).toBe(true);
    // Must still contain the header and bullets after the frontmatter.
    expect(index).toContain("# Memory Index");
    expect(index).toContain("- [Alpha](alpha.md) — First entry");
    expect(index).toContain("- [Beta](beta.md) — Second entry");
    // The frontmatter block must appear before the header.
    const fmEnd = index.indexOf("---\n\n#");
    expect(fmEnd).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// repairMissingIndexes
// ---------------------------------------------------------------------------

describe("repairMissingIndexes", () => {
  let targetRoot: string;
  let vaultRoot: string;

  beforeEach(async () => {
    targetRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "gk-target-"));
    vaultRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "gk-vault-"));
  });

  afterEach(async () => {
    await fsp.rm(targetRoot, { recursive: true, force: true });
    await fsp.rm(vaultRoot, { recursive: true, force: true });
  });

  /** Write a file relative to a root dir, creating parent dirs. */
  async function writeUnder(
    root: string,
    relPath: string,
    content: string,
  ): Promise<void> {
    const full = path.join(root, relPath);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content, "utf8");
  }

  // Realistic memory-file frontmatter fixture.
  const MEMORY_FILE = (name: string, desc: string, project = "my-project") =>
    `---\nproject: ${project}\nname: ${name}\ndescription: ${desc}\n---\n`;

  // ---------------------------------------------------------------------------

  it(
    "regression: index is written at <project>/memory/MEMORY.md (not <project>/MEMORY.md)",
    async () => {
      await writeUnder(
        targetRoot,
        path.join("proj-a", "memory", "file.md"),
        MEMORY_FILE("File", "A file"),
      );

      const count = await repairMissingIndexes(targetRoot, null);

      expect(count).toBe(1);
      // Must exist at the memory subfolder, not the project root.
      const indexPath = path.join(targetRoot, "proj-a", "memory", "MEMORY.md");
      const content = await fsp.readFile(indexPath, "utf8");
      expect(content).toContain("# Memory Index");
      expect(content).toContain("- [File](file.md) — A file");

      // Must NOT exist at the project root.
      await expect(
        fsp.access(path.join(targetRoot, "proj-a", "MEMORY.md")),
      ).rejects.toThrow();
    },
  );

  it("existing MEMORY.md in target is overwritten (count includes it)", async () => {
    const stale = "# Stale\n\n- [old](old.md) — stale\n";
    await writeUnder(
      targetRoot,
      path.join("proj-b", "memory", "MEMORY.md"),
      stale,
    );
    await writeUnder(
      targetRoot,
      path.join("proj-b", "memory", "entry.md"),
      MEMORY_FILE("Entry", "Fresh entry"),
    );

    const count = await repairMissingIndexes(targetRoot, null);

    expect(count).toBe(1);
    const content = await fsp.readFile(
      path.join(targetRoot, "proj-b", "memory", "MEMORY.md"),
      "utf8",
    );
    expect(content).toContain("- [Entry](entry.md) — Fresh entry");
    expect(content).not.toContain("stale");
  });

  it(
    "index is mirrored to <vaultRoot>/<project>/memory/MEMORY.md when vault folder exists",
    async () => {
      await writeUnder(
        targetRoot,
        path.join("proj-c", "memory", "file.md"),
        MEMORY_FILE("File C", "Desc C"),
      );
      // Pre-create the vault memory folder so the mirror is allowed.
      await fsp.mkdir(path.join(vaultRoot, "proj-c", "memory"), {
        recursive: true,
      });

      await repairMissingIndexes(targetRoot, vaultRoot);

      const targetIndex = path.join(
        targetRoot,
        "proj-c",
        "memory",
        "MEMORY.md",
      );
      const vaultIndex = path.join(vaultRoot, "proj-c", "memory", "MEMORY.md");
      const targetContent = await fsp.readFile(targetIndex, "utf8");
      const vaultContent = await fsp.readFile(vaultIndex, "utf8");
      // Content must be identical — mirror is a byte-exact copy.
      expect(vaultContent).toBe(targetContent);
    },
  );

  it(
    "mirror copy is skipped when the vault folder does not exist (no new vault dirs created)",
    async () => {
      await writeUnder(
        targetRoot,
        path.join("proj-d", "memory", "file.md"),
        MEMORY_FILE("File D", "Desc D"),
      );
      // Vault folder for proj-d does NOT exist.

      const count = await repairMissingIndexes(targetRoot, vaultRoot);

      expect(count).toBe(1);
      // Target MEMORY.md written.
      await expect(
        fsp.access(path.join(targetRoot, "proj-d", "memory", "MEMORY.md")),
      ).resolves.toBeUndefined();
      // Vault folder must not have been created.
      await expect(
        fsp.access(path.join(vaultRoot, "proj-d")),
      ).rejects.toThrow();
    },
  );

  it("vaultRoot=null skips mirror step entirely", async () => {
    await writeUnder(
      targetRoot,
      path.join("proj-e", "memory", "file.md"),
      MEMORY_FILE("File E", "Desc E"),
    );

    const count = await repairMissingIndexes(targetRoot, null);

    expect(count).toBe(1);
    // Target written.
    await expect(
      fsp.access(path.join(targetRoot, "proj-e", "memory", "MEMORY.md")),
    ).resolves.toBeUndefined();
  });

  it("folder with no .md files (only .json/.txt) is skipped; count stays 0", async () => {
    await writeUnder(
      targetRoot,
      path.join("proj-nomd", "memory", "data.jsonl"),
      "{}",
    );
    await writeUnder(
      targetRoot,
      path.join("proj-nomd", "memory", "notes.txt"),
      "plain text",
    );

    const count = await repairMissingIndexes(targetRoot, null);

    expect(count).toBe(0);
    await expect(
      fsp.access(path.join(targetRoot, "proj-nomd", "memory", "MEMORY.md")),
    ).rejects.toThrow();
  });

  it("top-level .md files directly under targetRoot are ignored (root is not a memory folder)", async () => {
    await writeUnder(
      targetRoot,
      "top-level.md",
      MEMORY_FILE("Top", "At root"),
    );

    const count = await repairMissingIndexes(targetRoot, null);

    expect(count).toBe(0);
    // No MEMORY.md should be written at the root.
    await expect(
      fsp.access(path.join(targetRoot, "MEMORY.md")),
    ).rejects.toThrow();
  });

  it("multiple memory folders — all are regenerated; count is total", async () => {
    // Two projects, each with a memory subfolder.
    await writeUnder(
      targetRoot,
      path.join("proj-1", "memory", "a.md"),
      MEMORY_FILE("A", "First"),
    );
    await writeUnder(
      targetRoot,
      path.join("proj-2", "memory", "b.md"),
      MEMORY_FILE("B", "Second"),
    );

    const count = await repairMissingIndexes(targetRoot, null);

    expect(count).toBe(2);
    const idx1 = await fsp.readFile(
      path.join(targetRoot, "proj-1", "memory", "MEMORY.md"),
      "utf8",
    );
    const idx2 = await fsp.readFile(
      path.join(targetRoot, "proj-2", "memory", "MEMORY.md"),
      "utf8",
    );
    expect(idx1).toContain("- [A](a.md) — First");
    expect(idx2).toContain("- [B](b.md) — Second");
  });

  it("mirror is written only after successful regeneration (gating invariant)", async () => {
    // A project whose target memory folder has .md files AND whose vault
    // folder already exists. Regeneration succeeds → mirror must be written.
    await writeUnder(
      targetRoot,
      path.join("proj-gate", "memory", "note.md"),
      MEMORY_FILE("Note", "Gating test"),
    );
    await fsp.mkdir(path.join(vaultRoot, "proj-gate", "memory"), {
      recursive: true,
    });

    const count = await repairMissingIndexes(targetRoot, vaultRoot);

    expect(count).toBe(1);
    // Target index was written.
    const targetContent = await fsp.readFile(
      path.join(targetRoot, "proj-gate", "memory", "MEMORY.md"),
      "utf8",
    );
    expect(targetContent).toContain("- [Note](note.md) — Gating test");
    // Vault mirror must match the target index exactly (copy happened because
    // regenerated === true and the vault folder existed).
    const vaultContent = await fsp.readFile(
      path.join(vaultRoot, "proj-gate", "memory", "MEMORY.md"),
      "utf8",
    );
    expect(vaultContent).toBe(targetContent);
  });

  it("non-existent targetRoot returns 0 without throwing", async () => {
    const nonExistent = path.join(targetRoot, "does-not-exist");
    const count = await repairMissingIndexes(nonExistent, null);
    expect(count).toBe(0);
  });

  it("generated index carries project: frontmatter when memory files have it", async () => {
    await writeUnder(
      targetRoot,
      path.join("proj-fm", "memory", "file.md"),
      MEMORY_FILE("File FM", "Has project frontmatter", "lib-python-vdesktop"),
    );

    await repairMissingIndexes(targetRoot, null);

    const content = await fsp.readFile(
      path.join(targetRoot, "proj-fm", "memory", "MEMORY.md"),
      "utf8",
    );
    expect(content.startsWith("---\nproject: lib-python-vdesktop\n---\n")).toBe(
      true,
    );
    expect(content).toContain("# Memory Index");
    expect(content).toContain("- [File FM](file.md) — Has project frontmatter");
  });
});
