import { describe, it, expect } from "vitest";
import {
  buildColorGroups,
  colorGroupSignature,
} from "../src/core/color-groups";
import type { DivergentEntry } from "../src/types";

const COLORS = { newColor: 0x44cf6e, modifiedColor: 0xe0a83b };

const entry = (
  relPath: string,
  status: "new" | "modified",
): DivergentEntry => ({ relPath, status, vaultHash: "h" });

describe("buildColorGroups", () => {
  it("returns no groups for an empty set", () => {
    expect(buildColorGroups([], COLORS)).toEqual([]);
  });

  it("creates one group per non-empty status with OR-joined path queries", () => {
    const groups = buildColorGroups(
      [entry("a.md", "new"), entry("b.md", "new"), entry("c.md", "modified")],
      COLORS,
    );
    expect(groups).toHaveLength(2);

    const newGroup = groups.find((g) => g.color.rgb === COLORS.newColor);
    expect(newGroup?.query).toBe('path:"a.md" OR path:"b.md"');

    const modGroup = groups.find((g) => g.color.rgb === COLORS.modifiedColor);
    expect(modGroup?.query).toBe('path:"c.md"');
  });

  it("omits the group for a status that has no files", () => {
    const groups = buildColorGroups([entry("only.md", "modified")], COLORS);
    expect(groups).toHaveLength(1);
    expect(groups[0].color.rgb).toBe(COLORS.modifiedColor);
  });

  it("sets alpha 1 on each group", () => {
    const groups = buildColorGroups([entry("a.md", "new")], COLORS);
    expect(groups[0].color.a).toBe(1);
  });
});

describe("colorGroupSignature", () => {
  it("is order-independent", () => {
    const a = buildColorGroups(
      [entry("x.md", "new"), entry("y.md", "modified")],
      COLORS,
    );
    const b = [...a].reverse();
    expect(colorGroupSignature(a)).toBe(colorGroupSignature(b));
  });

  it("differs when the path set changes", () => {
    const a = buildColorGroups([entry("x.md", "new")], COLORS);
    const b = buildColorGroups([entry("z.md", "new")], COLORS);
    expect(colorGroupSignature(a)).not.toBe(colorGroupSignature(b));
  });

  it("equals the empty-string signature for no groups", () => {
    expect(colorGroupSignature([])).toBe("");
  });
});
