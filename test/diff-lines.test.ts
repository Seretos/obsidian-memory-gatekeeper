import { describe, it, expect } from "vitest";
import { computeDiffLines, linePrefix } from "../src/core/diff-lines";

describe("computeDiffLines", () => {
  it("marks every line as context when both sides are equal", () => {
    const lines = computeDiffLines("a\nb", "a\nb");
    expect(lines.every((l) => l.type === "context")).toBe(true);
    expect(lines.map((l) => l.text)).toEqual(["a", "b"]);
  });

  it("marks all lines added when target is empty (new file)", () => {
    const lines = computeDiffLines("", "x\ny");
    const added = lines.filter((l) => l.type === "added").map((l) => l.text);
    expect(added).toEqual(["x", "y"]);
    expect(lines.some((l) => l.type === "removed")).toBe(false);
  });

  it("captures a changed line as removed + added", () => {
    const lines = computeDiffLines("hello\nworld", "hello\nplanet");
    expect(lines).toContainEqual({ type: "context", text: "hello" });
    expect(lines).toContainEqual({ type: "removed", text: "world" });
    expect(lines).toContainEqual({ type: "added", text: "planet" });
  });

  it("does not emit a trailing empty line from a final newline", () => {
    const lines = computeDiffLines("a\n", "a\n");
    expect(lines).toEqual([{ type: "context", text: "a" }]);
  });
});

describe("linePrefix", () => {
  it("maps each type to its marker", () => {
    expect(linePrefix("added")).toBe("+ ");
    expect(linePrefix("removed")).toBe("- ");
    expect(linePrefix("context")).toBe("  ");
  });
});
