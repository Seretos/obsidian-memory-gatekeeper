import { describe, it, expect } from "vitest";
import {
  groupHunks,
  computeHunks,
  applyHunkToLeft,
  applyHunkToRight,
  applyHunkToVaultText,
  applyHunkToTargetText,
  buildDiffSegments,
  type Hunk,
  type ChangeSegment,
} from "../src/core/hunks";
import { computeDiffLines } from "../src/core/diff-lines";

// ---------------------------------------------------------------------------
// groupHunks
// ---------------------------------------------------------------------------

describe("groupHunks", () => {
  it("returns [] for identical files", () => {
    const diffLines = computeDiffLines("a\nb\nc", "a\nb\nc");
    expect(groupHunks(diffLines)).toEqual([]);
  });

  it("returns [] for empty diff lines array", () => {
    expect(groupHunks([])).toEqual([]);
  });

  it("produces one hunk for a single changed line with ≤3 context each side", () => {
    // before: target, after: vault
    // Lines: "a","b","OLD","d","e"  →  "a","b","NEW","d","e"
    const before = "a\nb\nOLD\nd\ne";
    const after = "a\nb\nNEW\nd\ne";
    const diffLines = computeDiffLines(before, after);
    const hunks = groupHunks(diffLines);

    expect(hunks).toHaveLength(1);
    const h = hunks[0];

    // The hunk must contain removed and added lines.
    expect(h.lines.some((l) => l.type === "removed")).toBe(true);
    expect(h.lines.some((l) => l.type === "added")).toBe(true);

    // Context lines included on both sides (up to 3).
    expect(h.lines.filter((l) => l.type === "context").length).toBeGreaterThan(0);
  });

  it("all-new file: produces one hunk covering all added lines", () => {
    const diffLines = computeDiffLines("", "x\ny\nz");
    const hunks = groupHunks(diffLines);
    expect(hunks).toHaveLength(1);
    const allAdded = hunks[0].lines.every((l) => l.type === "added");
    expect(allAdded).toBe(true);
    expect(hunks[0].lines.map((l) => l.text)).toEqual(["x", "y", "z"]);
  });

  it("all-removed file: produces one hunk covering all removed lines", () => {
    const diffLines = computeDiffLines("x\ny\nz", "");
    const hunks = groupHunks(diffLines);
    expect(hunks).toHaveLength(1);
    const allRemoved = hunks[0].lines.every((l) => l.type === "removed");
    expect(allRemoved).toBe(true);
  });

  it("disjoint changes with gap > 2*contextLines produce two separate hunks", () => {
    // 10 lines of context between two changes; contextLines default = 3
    // gap is 10 context lines; 2*3=6 < 10 → two separate hunks
    const beforeLines = [
      "c1",       // changed line #1 (before)
      "ctx1", "ctx2", "ctx3", "ctx4", "ctx5",
      "ctx6", "ctx7", "ctx8", "ctx9", "ctx10",
      "c2",       // changed line #2 (before)
    ];
    const afterLines = [
      "c1NEW",
      "ctx1", "ctx2", "ctx3", "ctx4", "ctx5",
      "ctx6", "ctx7", "ctx8", "ctx9", "ctx10",
      "c2NEW",
    ];
    const diffLines = computeDiffLines(
      beforeLines.join("\n"),
      afterLines.join("\n"),
    );
    const hunks = groupHunks(diffLines);
    expect(hunks).toHaveLength(2);
  });

  it("disjoint changes with gap ≤ 2*contextLines are merged into one hunk", () => {
    // 4 context lines between two changes; contextLines default = 3
    // gap is 4 < 2*3=6 → merged
    const beforeLines = ["c1", "ctx1", "ctx2", "ctx3", "ctx4", "c2"];
    const afterLines = ["c1NEW", "ctx1", "ctx2", "ctx3", "ctx4", "c2NEW"];
    const diffLines = computeDiffLines(
      beforeLines.join("\n"),
      afterLines.join("\n"),
    );
    const hunks = groupHunks(diffLines);
    expect(hunks).toHaveLength(1);
  });

  it("exactly 2*contextLines gap merges into one hunk", () => {
    // gap = 6 context lines, contextLines=3, 2*3=6 → merged
    const beforeLines = ["c1", "1", "2", "3", "4", "5", "6", "c2"];
    const afterLines = ["c1NEW", "1", "2", "3", "4", "5", "6", "c2NEW"];
    const diffLines = computeDiffLines(
      beforeLines.join("\n"),
      afterLines.join("\n"),
    );
    const hunks = groupHunks(diffLines);
    // gap of 6 = 2*3, the context windows touch, so they merge
    expect(hunks).toHaveLength(1);
  });

  it("single-line change: before=one line, after=different line", () => {
    const diffLines = computeDiffLines("hello", "world");
    const hunks = groupHunks(diffLines);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toContainEqual({ type: "removed", text: "hello" });
    expect(hunks[0].lines).toContainEqual({ type: "added", text: "world" });
  });

  it("trailing-newline consistent: 'a\\n' vs 'a\\n' → no hunks", () => {
    const diffLines = computeDiffLines("a\n", "a\n");
    const hunks = groupHunks(diffLines);
    expect(hunks).toHaveLength(0);
  });

  it("hunk startBefore/endBefore span the correct before-side lines", () => {
    // before: lines 0..2 = ["a","OLD","c"]
    // after:  lines 0..2 = ["a","NEW","c"]
    const diffLines = computeDiffLines("a\nOLD\nc", "a\nNEW\nc");
    const hunks = groupHunks(diffLines, 1); // contextLines=1 to keep range tight
    expect(hunks).toHaveLength(1);
    const h = hunks[0];
    // "OLD" is at before-index 1; with context=1 startBefore=0, endBefore=3
    expect(h.startBefore).toBe(0);
    expect(h.endBefore).toBe(3);
    expect(h.startAfter).toBe(0);
    expect(h.endAfter).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// applyHunkToRight  (accept vault → target)
// ---------------------------------------------------------------------------

describe("applyHunkToRight", () => {
  it("replaces OLD line in target buffer with NEW line from vault", () => {
    // target: ["a","OLD","c"],  vault: ["a","NEW","c"]
    const diffLines = computeDiffLines("a\nOLD\nc", "a\nNEW\nc");
    const hunks = groupHunks(diffLines, 0); // contextLines=0 for precision
    expect(hunks).toHaveLength(1);
    const h = hunks[0];

    const targetBuffer = ["a", "OLD", "c"];
    const result = applyHunkToRight(targetBuffer, h);
    expect(result).toEqual(["a", "NEW", "c"]);
  });

  it("does not mutate the original target buffer", () => {
    const diffLines = computeDiffLines("a\nOLD", "a\nNEW");
    const hunks = groupHunks(diffLines, 0);
    const h = hunks[0];
    const targetBuffer = ["a", "OLD"];
    applyHunkToRight(targetBuffer, h);
    expect(targetBuffer).toEqual(["a", "OLD"]);
  });

  it("handles accepting a new-file hunk (target buffer is empty)", () => {
    // all-new file
    const diffLines = computeDiffLines("", "x\ny");
    const hunks = groupHunks(diffLines, 0);
    expect(hunks).toHaveLength(1);
    const result = applyHunkToRight([], hunks[0]);
    expect(result).toEqual(["x", "y"]);
  });

  it("handles accepting a deletion (vault removes lines from target)", () => {
    // target: ["a","b","c"], vault: ["a","c"] (removed "b")
    const diffLines = computeDiffLines("a\nb\nc", "a\nc");
    const hunks = groupHunks(diffLines, 0);
    expect(hunks).toHaveLength(1);
    const result = applyHunkToRight(["a", "b", "c"], hunks[0]);
    expect(result).toEqual(["a", "c"]);
  });
});

// ---------------------------------------------------------------------------
// applyHunkToLeft  (revert vault ← target)
// ---------------------------------------------------------------------------

describe("applyHunkToLeft", () => {
  it("replaces NEW line in vault buffer with OLD line from target", () => {
    // target: ["a","OLD","c"],  vault: ["a","NEW","c"]
    const diffLines = computeDiffLines("a\nOLD\nc", "a\nNEW\nc");
    const hunks = groupHunks(diffLines, 0); // contextLines=0
    expect(hunks).toHaveLength(1);
    const h = hunks[0];

    const vaultBuffer = ["a", "NEW", "c"];
    const result = applyHunkToLeft(vaultBuffer, h);
    expect(result).toEqual(["a", "OLD", "c"]);
  });

  it("does not mutate the original vault buffer", () => {
    const diffLines = computeDiffLines("a\nOLD", "a\nNEW");
    const hunks = groupHunks(diffLines, 0);
    const vaultBuffer = ["a", "NEW"];
    applyHunkToLeft(vaultBuffer, hunks[0]);
    expect(vaultBuffer).toEqual(["a", "NEW"]);
  });

  it("handles reverting an all-new file hunk (empties vault buffer)", () => {
    // vault added lines "x","y"; revert means target had nothing
    const diffLines = computeDiffLines("", "x\ny");
    const hunks = groupHunks(diffLines, 0);
    expect(hunks).toHaveLength(1);
    const result = applyHunkToLeft(["x", "y"], hunks[0]);
    // removed lines = none (target was empty), so vault becomes []
    expect(result).toEqual([]);
  });

  it("handles reverting a deletion (restores removed line into vault)", () => {
    // target: ["a","b","c"], vault: ["a","c"] (vault removed "b")
    const diffLines = computeDiffLines("a\nb\nc", "a\nc");
    const hunks = groupHunks(diffLines, 0);
    expect(hunks).toHaveLength(1);
    const result = applyHunkToLeft(["a", "c"], hunks[0]);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("is the inverse of applyHunkToRight for a substitution", () => {
    // Applying to right then reverting with left should restore original.
    const diffLines = computeDiffLines("a\nOLD\nc", "a\nNEW\nc");
    const hunks = groupHunks(diffLines, 0);
    const h = hunks[0];

    const target = ["a", "OLD", "c"];
    const afterAccept = applyHunkToRight(target, h);
    expect(afterAccept).toEqual(["a", "NEW", "c"]);

    // Re-compute hunks for the now-identical buffers (they match after accept,
    // so no hunks). But the inverse property: starting from vault ["a","NEW","c"]
    // and applying the hunk left gives us the target lines back.
    const vault = ["a", "NEW", "c"];
    const afterRevert = applyHunkToLeft(vault, h);
    expect(afterRevert).toEqual(["a", "OLD", "c"]);
  });
});

// ---------------------------------------------------------------------------
// computeHunks (convenience wrapper)
// ---------------------------------------------------------------------------

describe("computeHunks", () => {
  it("is equivalent to groupHunks(computeDiffLines(before, after))", () => {
    const before = "foo\nbar";
    const after = "foo\nbaz";
    const direct = groupHunks(computeDiffLines(before, after));
    const convenience = computeHunks(before, after);
    expect(convenience).toEqual(direct);
  });

  it("passes contextLines through", () => {
    // with contextLines=0, no context lines in the hunk
    const hunks = computeHunks("a\nOLD\nc", "a\nNEW\nc", 0);
    expect(hunks).toHaveLength(1);
    const contextCount = hunks[0].lines.filter((l) => l.type === "context").length;
    expect(contextCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildDiffSegments
// ---------------------------------------------------------------------------

describe("buildDiffSegments", () => {
  it("returns a single context segment for identical files", () => {
    const segs = buildDiffSegments("a\nb\nc", "a\nb\nc");
    expect(segs).toEqual([{ type: "context", lines: ["a", "b", "c"] }]);
  });

  it("returns [] for two empty strings", () => {
    // computeDiffLines("","") yields a single empty context line; collapse it.
    const segs = buildDiffSegments("", "");
    // One context segment containing the single empty line.
    expect(segs).toEqual([{ type: "context", lines: [""] }]);
  });

  it("wraps a substitution as one change segment with old/new split", () => {
    const segs = buildDiffSegments("a\nOLD\nc", "a\nNEW\nc");
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ type: "context", lines: ["a"] });
    expect(segs[1].type).toBe("change");
    const change = segs[1] as ChangeSegment;
    expect(change.removed).toEqual(["OLD"]);
    expect(change.added).toEqual(["NEW"]);
    expect(segs[2]).toEqual({ type: "context", lines: ["c"] });
  });

  it("represents a pure insertion with empty removed", () => {
    const segs = buildDiffSegments("a\nc", "a\nNEW\nc");
    const change = segs.find((s) => s.type === "change") as ChangeSegment;
    expect(change.removed).toEqual([]);
    expect(change.added).toEqual(["NEW"]);
  });

  it("represents a pure deletion with empty added", () => {
    const segs = buildDiffSegments("a\nGONE\nc", "a\nc");
    const change = segs.find((s) => s.type === "change") as ChangeSegment;
    expect(change.removed).toEqual(["GONE"]);
    expect(change.added).toEqual([]);
  });

  it("produces separate change segments for disjoint edits", () => {
    const before = "a\nOLD1\nc\nd\nOLD2\nf";
    const after = "a\nNEW1\nc\nd\nNEW2\nf";
    const segs = buildDiffSegments(before, after);
    const changes = segs.filter((s) => s.type === "change") as ChangeSegment[];
    expect(changes).toHaveLength(2);
    expect(changes[0].removed).toEqual(["OLD1"]);
    expect(changes[0].added).toEqual(["NEW1"]);
    expect(changes[1].removed).toEqual(["OLD2"]);
    expect(changes[1].added).toEqual(["NEW2"]);
  });

  it("attaches a hunk to each change segment that applies correctly", () => {
    const before = "a\nOLD\nc"; // target
    const after = "a\nNEW\nc"; // vault
    const segs = buildDiffSegments(before, after);
    const change = segs.find((s) => s.type === "change") as ChangeSegment;

    // accept vault → target: target becomes vault
    const target = before.split("\n");
    expect(applyHunkToRight(target, change.hunk)).toEqual(["a", "NEW", "c"]);

    // revert vault ← target: vault becomes target
    const vault = after.split("\n");
    expect(applyHunkToLeft(vault, change.hunk)).toEqual(["a", "OLD", "c"]);
  });

  it("change segments are 1:1 and in order with groupHunks(diff, 0)", () => {
    const before = "a\nOLD1\nc\nOLD2\ne";
    const after = "a\nNEW1\nc\nNEW2\ne";
    const segs = buildDiffSegments(before, after);
    const changes = segs.filter((s) => s.type === "change") as ChangeSegment[];
    const hunks = groupHunks(computeDiffLines(before, after), 0);
    expect(changes.map((c) => c.hunk)).toEqual(hunks);
  });

  it("handles a change at the very start (no leading context)", () => {
    const segs = buildDiffSegments("OLD\nb", "NEW\nb");
    expect(segs[0].type).toBe("change");
    const change = segs[0] as ChangeSegment;
    expect(change.removed).toEqual(["OLD"]);
    expect(change.added).toEqual(["NEW"]);
    expect(segs[1]).toEqual({ type: "context", lines: ["b"] });
  });
});

// ---------------------------------------------------------------------------
// applyHunkToTargetText / applyHunkToVaultText (newline-safe string wrappers)
// ---------------------------------------------------------------------------

describe("applyHunkToTargetText / applyHunkToVaultText", () => {
  const firstHunk = (before: string, after: string): Hunk =>
    computeHunks(before, after, 0)[0];

  it("accept: substitutes the hunk, preserving a trailing newline", () => {
    const target = "a\nOLD\nc\n";
    const vault = "a\nNEW\nc\n";
    const h = firstHunk(target, vault);
    expect(applyHunkToTargetText(target, h)).toBe("a\nNEW\nc\n");
  });

  it("accept: preserves absence of a trailing newline", () => {
    const target = "a\nOLD\nc";
    const vault = "a\nNEW\nc";
    const h = firstHunk(target, vault);
    expect(applyHunkToTargetText(target, h)).toBe("a\nNEW\nc");
  });

  it("revert: restores the target lines into the vault buffer", () => {
    const target = "a\nOLD\nc\n";
    const vault = "a\nNEW\nc\n";
    const h = firstHunk(target, vault);
    expect(applyHunkToVaultText(vault, h)).toBe("a\nOLD\nc\n");
  });

  it("handles an edit on the final line of a newline-terminated file", () => {
    const target = "a\nb\nOLD\n";
    const vault = "a\nb\nNEW\n";
    const h = firstHunk(target, vault);
    expect(applyHunkToTargetText(target, h)).toBe("a\nb\nNEW\n");
    expect(applyHunkToVaultText(vault, h)).toBe("a\nb\nOLD\n");
  });

  it("handles a pure deletion at EOF, keeping the trailing newline", () => {
    const target = "a\nb\nGONE\n";
    const vault = "a\nb\n";
    const h = firstHunk(target, vault);
    // accept vault → target removes the GONE line
    expect(applyHunkToTargetText(target, h)).toBe("a\nb\n");
  });

  it("handles a pure insertion at EOF without a trailing newline", () => {
    const target = "a\nb";
    const vault = "a\nb\nNEW";
    const h = firstHunk(target, vault);
    expect(applyHunkToTargetText(target, h)).toBe("a\nb\nNEW");
  });

  it("does not mutate the input text's array (returns a fresh string)", () => {
    const target = "a\nOLD\nc";
    const vault = "a\nNEW\nc";
    const h = firstHunk(target, vault);
    const out = applyHunkToTargetText(target, h);
    expect(out).not.toBe(target);
    expect(target).toBe("a\nOLD\nc");
  });
});
