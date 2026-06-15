import { describe, it, expect } from "vitest";
import { shouldOpenDiffByDefault, isPlainPrimaryClick } from "../src/core/open-diff-default";
import type { FileStatus } from "../src/types";

describe("shouldOpenDiffByDefault", () => {
  // --- divergent statuses with all flags ON (the "intercept" cases) --------

  it('returns true for status "new" when setting enabled and configured', () => {
    expect(shouldOpenDiffByDefault("new", true, true)).toBe(true);
  });

  it('returns true for status "modified" when setting enabled and configured', () => {
    expect(shouldOpenDiffByDefault("modified", true, true)).toBe(true);
  });

  // --- non-divergent status ------------------------------------------------

  it('returns false for status "identical" even when setting enabled and configured', () => {
    expect(shouldOpenDiffByDefault("identical", true, true)).toBe(false);
  });

  // --- undefined status (file not in store) --------------------------------

  it("returns false for undefined status even when setting enabled and configured", () => {
    expect(shouldOpenDiffByDefault(undefined, true, true)).toBe(false);
  });

  // --- setting disabled ----------------------------------------------------

  it('returns false for status "new" when setting is disabled', () => {
    expect(shouldOpenDiffByDefault("new", false, true)).toBe(false);
  });

  it('returns false for status "modified" when setting is disabled', () => {
    expect(shouldOpenDiffByDefault("modified", false, true)).toBe(false);
  });

  // --- plugin not configured -----------------------------------------------

  it('returns false for status "new" when plugin is not configured', () => {
    expect(shouldOpenDiffByDefault("new", true, false)).toBe(false);
  });

  it('returns false for status "modified" when plugin is not configured', () => {
    expect(shouldOpenDiffByDefault("modified", true, false)).toBe(false);
  });

  // --- both flags off -------------------------------------------------------

  it("returns false when both setting disabled and not configured", () => {
    expect(shouldOpenDiffByDefault("new", false, false)).toBe(false);
    expect(shouldOpenDiffByDefault("modified", false, false)).toBe(false);
    expect(shouldOpenDiffByDefault("identical", false, false)).toBe(false);
    expect(shouldOpenDiffByDefault(undefined, false, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPlainPrimaryClick
// ---------------------------------------------------------------------------
// Note: the DOM/renderer interception itself (ExplorerDecorator capture-phase
// listener and GraphClickInterceptor onNodeClick wrapper) is verified manually
// per AGENTS.md. This suite covers the pure predicate used by both call sites.
//
// isPlainPrimaryClick uses duck-typing (not `instanceof MouseEvent`) so it is
// testable in Node/vitest (no DOM) while still working correctly at runtime
// inside Obsidian's Electron browser. Tests therefore pass plain objects that
// carry the required MouseEvent properties.

describe("isPlainPrimaryClick", () => {
  /** Build a MouseEvent-like plain object with sensible defaults. */
  function makeEvt(overrides: {
    button?: number;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
  } = {}): object {
    return {
      button: 0,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...overrides,
    };
  }

  // --- plain primary click (the "intercept" case) --------------------------

  it("returns true for a plain left-click with no modifier keys", () => {
    expect(isPlainPrimaryClick(makeEvt())).toBe(true);
  });

  // --- modifier keys --------------------------------------------------------

  it("returns false when ctrlKey is held", () => {
    expect(isPlainPrimaryClick(makeEvt({ ctrlKey: true }))).toBe(false);
  });

  it("returns false when metaKey is held (Cmd on macOS)", () => {
    expect(isPlainPrimaryClick(makeEvt({ metaKey: true }))).toBe(false);
  });

  it("returns false when altKey is held", () => {
    expect(isPlainPrimaryClick(makeEvt({ altKey: true }))).toBe(false);
  });

  it("returns false when shiftKey is held", () => {
    expect(isPlainPrimaryClick(makeEvt({ shiftKey: true }))).toBe(false);
  });

  // --- non-primary buttons --------------------------------------------------

  it("returns false for middle-click (button 1)", () => {
    expect(isPlainPrimaryClick(makeEvt({ button: 1 }))).toBe(false);
  });

  it("returns false for right-click (button 2)", () => {
    expect(isPlainPrimaryClick(makeEvt({ button: 2 }))).toBe(false);
  });

  // --- non-MouseEvent-like / edge inputs -----------------------------------

  it("returns false for undefined", () => {
    expect(isPlainPrimaryClick(undefined)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isPlainPrimaryClick(null)).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isPlainPrimaryClick("click")).toBe(false);
  });

  it("returns false for an object missing all MouseEvent properties", () => {
    expect(isPlainPrimaryClick({})).toBe(false);
  });

  it("returns false for an object with only some MouseEvent properties", () => {
    // Has button but missing ctrlKey/metaKey/altKey/shiftKey booleans
    expect(isPlainPrimaryClick({ button: 0 })).toBe(false);
  });
});
