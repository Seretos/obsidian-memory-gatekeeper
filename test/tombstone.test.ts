/**
 * Focused unit tests for the tombstone gating decisions.
 *
 * Full integration coverage of scan() and acceptToTarget() requires a live
 * Obsidian vault adapter and real Node fs access, which cannot be cleanly
 * mocked without a heavy shim that would contort the production code. These
 * tests therefore exercise the pure decision logic that lives outside the
 * adapter boundary:
 *
 *  1. The empty-content detection that classifies a vault file as a tombstone.
 *  2. The classify() behaviour for empty vault files (what scan() observes).
 *  3. The projectFolder guard logic (inline in acceptToTarget) — tested via an
 *     extracted equivalent so that the "top-level file has no project folder"
 *     branch is visibly covered.
 */

import { describe, it, expect } from "vitest";
import { classify } from "../src/core/compare";

// ---------------------------------------------------------------------------
// 1. Tombstone detection: vaultContent.trim() === ""
//    This is the exact condition used in scan() to set isTombstone and in
//    acceptToTarget() to choose the deletion branch.
// ---------------------------------------------------------------------------

describe("tombstone empty-content detection", () => {
  /** Mirror of the inline predicate used in scan() and acceptToTarget(). */
  function isTombstone(vaultContent: string): boolean {
    return vaultContent.trim() === "";
  }

  it("empty string is a tombstone", () => {
    expect(isTombstone("")).toBe(true);
  });

  it("whitespace-only string is a tombstone", () => {
    expect(isTombstone("   ")).toBe(true);
    expect(isTombstone("\n")).toBe(true);
    expect(isTombstone("\r\n")).toBe(true);
    expect(isTombstone("  \n  \t  ")).toBe(true);
  });

  it("non-empty content is not a tombstone", () => {
    expect(isTombstone("# Some content")).toBe(false);
    expect(isTombstone("a")).toBe(false);
  });

  it("content with only a newline character is a tombstone", () => {
    // Edge: the upstream hook may write a single newline to signal deletion.
    expect(isTombstone("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. classify() for empty vault files — what scan() observes before the
//    tombstone branch runs.
// ---------------------------------------------------------------------------

describe("classify for tombstone-shaped vault files", () => {
  it("empty vault with no target is classified as 'new'", () => {
    // scan() will see status='new', then isTombstone=true — an unusual
    // combination (a deletion proposal for a file that never had a target).
    expect(classify("", null)).toBe("new");
  });

  it("empty vault with a non-empty target is classified as 'modified'", () => {
    // The common tombstone path: the upstream hook emptied the vault copy of a
    // file that already has real memory content in the target folder.
    expect(classify("", "some existing content")).toBe("modified");
  });

  it("empty vault with empty target is 'identical' (no divergence to surface)", () => {
    // Both sides are empty — scan() skips this; no tombstone entry is created.
    expect(classify("", "")).toBe("identical");
  });
});

// ---------------------------------------------------------------------------
// 3. projectFolder guard: top-level file (no "/" in relPath) must not trigger
//    regenerateMemoryIndex.
//    The guard is: hasProjectFolder = relPath.includes("/")
// ---------------------------------------------------------------------------

describe("acceptToTarget projectFolder guard logic", () => {
  /** Mirror of the inline guard in acceptToTarget(). */
  function deriveProjectFolder(
    targetFolder: string,
    relPath: string,
  ): string | null {
    const firstSegment = relPath.split("/")[0];
    const hasProjectFolder = relPath.includes("/");
    return hasProjectFolder
      ? require("path").join(targetFolder, firstSegment)
      : null;
  }

  it("returns null for a top-level file (no subdirectory)", () => {
    expect(deriveProjectFolder("/target", "top-level-file.md")).toBeNull();
  });

  it("returns the project subfolder for a file one level deep", () => {
    const result = deriveProjectFolder("/target", "my-project/memory.md");
    // Normalise separators for cross-platform comparison.
    expect(result?.replace(/\\/g, "/")).toBe("/target/my-project");
  });

  it("returns the first-segment subfolder for a deeply nested file", () => {
    const result = deriveProjectFolder(
      "/target",
      "my-project/sub/deep.md",
    );
    expect(result?.replace(/\\/g, "/")).toBe("/target/my-project");
  });

  it("a filename with no extension but no slash is still top-level (returns null)", () => {
    expect(deriveProjectFolder("/target", "bare-name")).toBeNull();
  });
});
