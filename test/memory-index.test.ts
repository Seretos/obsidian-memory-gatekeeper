import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "fs";
import * as path from "path";
import * as os from "os";
import {
  parseNameDescription,
  regenerateMemoryIndex,
  repairMissingIndexes,
} from "../src/core/memory-index";

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
});

// ---------------------------------------------------------------------------
// repairMissingIndexes
// ---------------------------------------------------------------------------

describe("repairMissingIndexes", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gk-repair-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  /** Write a file relative to tmpDir, creating parent dirs. */
  async function writeFile(relPath: string, content: string): Promise<void> {
    const full = path.join(tmpDir, relPath);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content, "utf8");
  }

  it("regression: subfolder missing MEMORY.md with two valid .md files gets index written", async () => {
    await writeFile(
      path.join("project-a", "alpha.md"),
      "---\nname: Alpha\ndescription: First entry\n---\n",
    );
    await writeFile(
      path.join("project-a", "beta.md"),
      "---\nname: Beta\ndescription: Second entry\n---\n",
    );

    const count = await repairMissingIndexes(tmpDir);

    expect(count).toBe(1);
    const indexContent = await fsp.readFile(
      path.join(tmpDir, "project-a", "MEMORY.md"),
      "utf8",
    );
    expect(indexContent).toContain("# Memory Index");
    expect(indexContent).toContain("- [Alpha](alpha.md) — First entry");
    expect(indexContent).toContain("- [Beta](beta.md) — Second entry");
  });

  it("subfolder that already has MEMORY.md is not touched; count stays 0", async () => {
    const existingIndex = "# Memory Index\n\n- [Existing](existing.md) — Already here\n";
    await writeFile(path.join("project-b", "MEMORY.md"), existingIndex);
    await writeFile(
      path.join("project-b", "existing.md"),
      "---\nname: Existing\ndescription: Already here\n---\n",
    );

    const count = await repairMissingIndexes(tmpDir);

    expect(count).toBe(0);
    // Content must be unchanged.
    const indexContent = await fsp.readFile(
      path.join(tmpDir, "project-b", "MEMORY.md"),
      "utf8",
    );
    expect(indexContent).toBe(existingIndex);
  });

  it("subfolder with no .md files at all is skipped; count stays 0", async () => {
    // Create a subfolder that only contains a non-.md file.
    await writeFile(path.join("project-empty", "notes.txt"), "plain text");

    const count = await repairMissingIndexes(tmpDir);

    expect(count).toBe(0);
    // No MEMORY.md should have been created.
    await expect(
      fsp.access(path.join(tmpDir, "project-empty", "MEMORY.md")),
    ).rejects.toThrow();
  });

  it("multiple subfolders — only those missing MEMORY.md are repaired; count matches", async () => {
    // project-has-index: already has MEMORY.md → skip.
    await writeFile(
      path.join("project-has-index", "MEMORY.md"),
      "# Memory Index\n\n",
    );
    await writeFile(
      path.join("project-has-index", "file.md"),
      "---\nname: File\ndescription: In indexed project\n---\n",
    );

    // project-needs-index: missing MEMORY.md, has .md files → repair.
    await writeFile(
      path.join("project-needs-index", "entry.md"),
      "---\nname: Entry\ndescription: Needs index\n---\n",
    );

    // project-empty-no-index: no .md files → skip even though MEMORY.md absent.
    await writeFile(
      path.join("project-empty-no-index", "data.json"),
      "{}",
    );

    const count = await repairMissingIndexes(tmpDir);

    expect(count).toBe(1);
    const repairedIndex = await fsp.readFile(
      path.join(tmpDir, "project-needs-index", "MEMORY.md"),
      "utf8",
    );
    expect(repairedIndex).toContain("- [Entry](entry.md) — Needs index");
  });

  it("top-level .md files (not in any subfolder) are ignored", async () => {
    // A .md file directly under tmpDir (the root) — no subfolder.
    await writeFile(
      "top-level.md",
      "---\nname: Top\ndescription: At root\n---\n",
    );

    const count = await repairMissingIndexes(tmpDir);

    expect(count).toBe(0);
    // No MEMORY.md should have been written at the root.
    await expect(
      fsp.access(path.join(tmpDir, "MEMORY.md")),
    ).rejects.toThrow();
  });

  it("non-existent rootDir returns 0 without throwing", async () => {
    const nonExistent = path.join(tmpDir, "does-not-exist");
    const count = await repairMissingIndexes(nonExistent);
    expect(count).toBe(0);
  });
});
