import { describe, it, expect } from "vitest";
import { StatusStore } from "../src/status-store";
import type { DivergentEntry } from "../src/types";

const entry = (
  relPath: string,
  status: "new" | "modified",
  vaultHash = "h",
): DivergentEntry => ({ relPath, status, vaultHash });

describe("StatusStore", () => {
  it("reports 'identical' for unknown paths", () => {
    const store = new StatusStore({});
    expect(store.statusOf("missing.md")).toBe("identical");
    expect(store.get("missing.md")).toBeUndefined();
  });

  it("setAll replaces the full divergent set", () => {
    const store = new StatusStore({});
    store.setAll([entry("a.md", "new"), entry("b.md", "modified")]);
    expect(store.statusOf("a.md")).toBe("new");
    expect(store.statusOf("b.md")).toBe("modified");

    store.setAll([entry("c.md", "new")]);
    expect(store.statusOf("a.md")).toBe("identical");
    expect(store.statusOf("c.md")).toBe("new");
  });

  it("all() is sorted by relPath", () => {
    const store = new StatusStore({});
    store.setAll([
      entry("z.md", "new"),
      entry("a.md", "new"),
      entry("m.md", "modified"),
    ]);
    expect(store.all().map((e) => e.relPath)).toEqual([
      "a.md",
      "m.md",
      "z.md",
    ]);
  });

  it("isDismissed matches only on the exact content hash", () => {
    const store = new StatusStore({ "a.md": "hash1" });
    expect(store.isDismissed(entry("a.md", "new", "hash1"))).toBe(true);
    expect(store.isDismissed(entry("a.md", "new", "hash2"))).toBe(false);
    expect(store.isDismissed(entry("other.md", "new", "hash1"))).toBe(false);
  });

  it("dismiss records the hash and drops the entry from the live set", () => {
    const dismissed: Record<string, string> = {};
    const store = new StatusStore(dismissed);
    const e = entry("a.md", "new", "abc");
    store.setAll([e]);

    store.dismiss(e);

    expect(store.statusOf("a.md")).toBe("identical");
    expect(dismissed["a.md"]).toBe("abc"); // mutates the shared map for persistence
    expect(store.isDismissed(e)).toBe(true);
  });

  it("paths() lists current divergent paths", () => {
    const store = new StatusStore({});
    store.setAll([entry("a.md", "new"), entry("b.md", "modified")]);
    expect(store.paths().sort()).toEqual(["a.md", "b.md"]);
  });
});
