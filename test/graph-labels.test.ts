import { describe, it, expect } from "vitest";
import { memoryNodeLabel } from "../src/core/graph-labels";

describe("memoryNodeLabel", () => {
  it("returns null for non-MEMORY nodes", () => {
    expect(memoryNodeLabel("E--/memory/reference_x.md")).toBeNull();
    expect(memoryNodeLabel("E--/memory/MEMORY.md.bak")).toBeNull();
    expect(memoryNodeLabel("notes/MEMORYfoo.md")).toBeNull();
  });

  it("returns null for a root-level MEMORY.md (no project folder)", () => {
    expect(memoryNodeLabel("MEMORY.md")).toBeNull();
  });

  it("falls back to the first path segment when no frontmatter project", () => {
    expect(memoryNodeLabel("E--/memory/MEMORY.md")).toEqual({
      project: "E--",
      sub: "(MEMORY)",
    });
    expect(memoryNodeLabel("C--code-myapp/memory/MEMORY.md")).toEqual({
      project: "C--code-myapp",
      sub: "(MEMORY)",
    });
  });

  it("prefers a non-empty frontmatter project over the fallback", () => {
    expect(
      memoryNodeLabel("E--/memory/MEMORY.md", "obsidian-memory-gatekeeper"),
    ).toEqual({ project: "obsidian-memory-gatekeeper", sub: "(MEMORY)" });
  });

  it("trims the frontmatter project", () => {
    expect(memoryNodeLabel("E--/memory/MEMORY.md", "  My App  ")).toEqual({
      project: "My App",
      sub: "(MEMORY)",
    });
  });

  it("ignores blank or non-string frontmatter and uses the fallback", () => {
    expect(memoryNodeLabel("E--/memory/MEMORY.md", "   ")?.project).toBe("E--");
    expect(memoryNodeLabel("E--/memory/MEMORY.md", 42)?.project).toBe("E--");
    expect(memoryNodeLabel("E--/memory/MEMORY.md", undefined)?.project).toBe(
      "E--",
    );
    expect(memoryNodeLabel("E--/memory/MEMORY.md", null)?.project).toBe("E--");
  });
});
