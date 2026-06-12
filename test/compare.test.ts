import { describe, it, expect } from "vitest";
import { classify, hashContent } from "../src/core/compare";

describe("classify", () => {
  it("returns 'new' when there is no target counterpart", () => {
    expect(classify("anything", null)).toBe("new");
  });

  it("returns 'modified' when contents differ", () => {
    expect(classify("a", "b")).toBe("modified");
  });

  it("returns 'identical' when contents match exactly", () => {
    expect(classify("same", "same")).toBe("identical");
  });

  it("is byte-exact: differing line endings count as modified", () => {
    expect(classify("a\r\nb", "a\nb")).toBe("modified");
  });

  it("treats empty vault vs empty target as identical", () => {
    expect(classify("", "")).toBe("identical");
  });

  it("treats empty vault vs missing target as new", () => {
    expect(classify("", null)).toBe("new");
  });
});

describe("hashContent", () => {
  it("is stable for equal input", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
  });

  it("differs for different input", () => {
    expect(hashContent("hello")).not.toBe(hashContent("hello!"));
  });

  it("produces a 40-char sha1 hex string", () => {
    expect(hashContent("x")).toMatch(/^[0-9a-f]{40}$/);
  });
});
