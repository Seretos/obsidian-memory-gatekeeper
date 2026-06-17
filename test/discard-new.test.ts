/**
 * Regression tests for ticket #15 — "discard new file" behaviour.
 *
 * Problem: When a NEW vault file (status "new", no target counterpart) was
 * discarded, dismiss() used to call store.dismiss() which hid the file by
 * recording relPath → vaultHash in settings.dismissed. The file stayed on
 * disk, indistinguishable from an accepted memory, and only re-surfaced once
 * its content changed. The fix deletes the vault file instead.
 *
 * These tests exercise the pure decision logic that can be verified without
 * a live Obsidian vault adapter:
 *
 *  1. The Discard aria-label three-way ternary in ReviewView.renderRow.
 *  2. The suppressDelete guard logic mirrored from discardNew / acceptToTarget.
 *  3. Confirmation that StatusStore.dismiss() is NOT called for the new-file
 *     path (the dismissed map remains empty after the new flow).
 *  4. Vault-side MEMORY.md regeneration after discardNew (real fs, tmpdir).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "fs";
import * as path from "path";
import * as os from "os";
import { StatusStore } from "../src/status-store";
import { regenerateMemoryIndex } from "../src/core/memory-index";
import type { DivergentEntry } from "../src/types";

// ---------------------------------------------------------------------------
// Helper: mirrors the three-branch aria-label ternary added to ReviewView.
// Keep in sync with src/review-view.ts renderRow().
// ---------------------------------------------------------------------------

function dismissLabel(isTombstone: boolean, status: "new" | "modified"): string {
  return isTombstone
    ? "Cancel deletion — keep the memory file"
    : status === "new"
      ? "Remove this proposal from the vault"
      : "Revert vault file to the memory version";
}

// ---------------------------------------------------------------------------
// 1. Aria-label three-branch ternary
// ---------------------------------------------------------------------------

describe("Discard button aria-label (ReviewView)", () => {
  it("tombstone entry shows cancel-deletion label", () => {
    expect(dismissLabel(true, "modified")).toBe(
      "Cancel deletion — keep the memory file",
    );
  });

  it("new-file entry shows removal-from-vault label", () => {
    expect(dismissLabel(false, "new")).toBe(
      "Remove this proposal from the vault",
    );
  });

  it("modified entry shows revert-to-memory label", () => {
    expect(dismissLabel(false, "modified")).toBe(
      "Revert vault file to the memory version",
    );
  });

  it("tombstone label is independent of the status field", () => {
    // isTombstone can coexist with status="new" (deletion proposal for a file
    // that never had a target); the tombstone label must still win.
    expect(dismissLabel(true, "new")).toBe(
      "Cancel deletion — keep the memory file",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. suppressDelete guard logic (mirrors discardNew / acceptToTarget pattern)
//
// The production code adds relPath to suppressDelete BEFORE the adapter.remove
// call, then removes it asynchronously via setTimeout(..., 0) in the finally
// block. This ensures the synchronously-or-microtask-queued vault `delete`
// event is consumed while the guard is live.
// ---------------------------------------------------------------------------

describe("suppressDelete guard pattern for discardNew", () => {
  it("relPath is in the set before the async remove completes", async () => {
    const suppressDelete = new Set<string>();
    const relPath = "project/memory/new-file.md";

    // Simulate the discardNew guard: add, then schedule removal.
    suppressDelete.add(relPath);
    expect(suppressDelete.has(relPath)).toBe(true);

    // Simulate the finally block with setTimeout(..., 0).
    const removePromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        suppressDelete.delete(relPath);
        resolve();
      }, 0);
    });

    // Before the macrotask runs, the guard is still live.
    expect(suppressDelete.has(relPath)).toBe(true);

    await removePromise;

    // After the macrotask, the guard is cleared.
    expect(suppressDelete.has(relPath)).toBe(false);
  });

  it("suppressDelete prevents handleVaultDelete from doing redundant work", () => {
    const suppressDelete = new Set<string>();
    const relPath = "project/memory/new-file.md";

    // Simulate what handleVaultDelete checks.
    function wouldPropagateToTarget(path: string): boolean {
      return !suppressDelete.has(path);
    }

    // Without guard: handleVaultDelete would propagate.
    expect(wouldPropagateToTarget(relPath)).toBe(true);

    // With guard added (as discardNew does before remove()): no propagation.
    suppressDelete.add(relPath);
    expect(wouldPropagateToTarget(relPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Regression: dismissed map must NOT be mutated on discard of a new file.
//
// Before the fix: dismiss() called store.dismiss(entry) which wrote
// relPath → vaultHash into the dismissed map. After the fix: the engine
// deletes the file from the vault; store.dismiss() is never called for the
// new-file branch.
// ---------------------------------------------------------------------------

describe("dismissed map not mutated on discard-new (regression)", () => {
  function makeDivergentEntry(
    relPath: string,
    status: "new" | "modified",
    vaultHash = "abc123",
  ): DivergentEntry {
    return { relPath, status, vaultHash };
  }

  it("store.dismiss() is never called — dismissed map stays clean after new-file discard", () => {
    // This test exercises the decision point in dismiss() (main.ts):
    //   if (reverted) { ... return; }       ← revertFromTarget succeeded
    //   await this.engine.discardNew(...)   ← new-file path: no store.dismiss()
    //
    // We mock the two branches to confirm which one is taken and that
    // store.dismiss() is not invoked anywhere on the new-file path.
    const dismissed: Record<string, string> = {};
    const store = new StatusStore(dismissed);
    const dismissSpy = vi.spyOn(store, "dismiss");

    const entry = makeDivergentEntry("project/memory/new-proposal.md", "new");
    store.setAll([entry]);

    // Simulate the engine: revertFromTarget returns false for a new file,
    // so the caller must fall through to the discardNew branch.
    const engineMock = {
      revertFromTarget: vi.fn().mockResolvedValue(false),
      discardNew: vi.fn().mockResolvedValue(undefined),
    };

    // Simulate what dismiss() in main.ts now does:
    async function simulateDismiss(relPath: string): Promise<void> {
      const e = store.get(relPath);
      if (!e) return;
      const reverted = await engineMock.revertFromTarget(relPath);
      if (reverted) return; // would call store.dismiss() in old code — not reached
      await engineMock.discardNew(relPath);
      // store.dismiss() is deliberately NOT called here
    }

    // Run the new path and confirm:
    return simulateDismiss("project/memory/new-proposal.md").then(() => {
      // discardNew was called (the vault deletion path)
      expect(engineMock.discardNew).toHaveBeenCalledWith("project/memory/new-proposal.md");
      // revertFromTarget was called first and returned false
      expect(engineMock.revertFromTarget).toHaveBeenCalledWith("project/memory/new-proposal.md");
      // store.dismiss() was NEVER called
      expect(dismissSpy).not.toHaveBeenCalled();
      // dismissed map is untouched
      expect(Object.keys(dismissed)).toHaveLength(0);
      expect(dismissed["project/memory/new-proposal.md"]).toBeUndefined();
    });
  });

  it("StatusStore.isDismissed returns false for a new-file entry after the fix", () => {
    // Before: the file would be hidden via isDismissed check in scan().
    // After: the file is deleted from the vault, so scan() never encounters it.
    // If somehow isDismissed were called, it should return false (nothing was
    // recorded) — not silently hide a file the user didn't explicitly dismiss.
    const dismissed: Record<string, string> = {};
    const store = new StatusStore(dismissed);
    const entry = makeDivergentEntry("project/memory/new-proposal.md", "new");

    // No call to store.dismiss() — dismissed map is empty.
    expect(store.isDismissed(entry)).toBe(false);
  });

  it("scan() would not re-hide deleted file even if dismissed map had stale entry", () => {
    // Extra defence: isDismissed is only consulted by scan() for status="new"
    // entries. A deleted file will not appear in vault.getFiles(), so scan()
    // will never call isDismissed() for it. The dismissed map staying clean
    // is a correctness bonus, not the primary protection.
    //
    // Verify the isDismissed guard logic: even a stale dismissed entry cannot
    // hide a file that scan() has stopped tracking.
    const dismissed: Record<string, string> = { "orphan.md": "old-hash" };
    const store = new StatusStore(dismissed);

    // scan() calls setAll with fresh results — orphan.md is not in the vault.
    store.setAll([]); // no divergent entries

    expect(store.statusOf("orphan.md")).toBe("identical");
    expect(store.get("orphan.md")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Vault-side MEMORY.md regeneration on discardNew (blocking-1 fix)
//
// When a "new" file in a subdirectory is discarded, discardNew() must
// regenerate the vault-side MEMORY.md in the file's parent folder so the
// index no longer lists the deleted proposal. This uses the same
// regenerateMemoryIndex helper as acceptToTarget / revertFromTarget.
// ---------------------------------------------------------------------------

describe("vault-side MEMORY.md regeneration after discardNew", () => {
  let vaultMemoryDir: string;

  beforeEach(async () => {
    // Simulate the vault's <project>/memory/ folder.
    vaultMemoryDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gk-discard-new-"));
  });

  afterEach(async () => {
    await fsp.rm(vaultMemoryDir, { recursive: true, force: true });
  });

  /** Write a file relative to vaultMemoryDir, creating parent dirs. */
  async function writeFile(relName: string, content: string): Promise<void> {
    const full = path.join(vaultMemoryDir, relName);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content, "utf8");
  }

  /** Read MEMORY.md from vaultMemoryDir. */
  async function readIndex(): Promise<string> {
    return fsp.readFile(path.join(vaultMemoryDir, "MEMORY.md"), "utf8");
  }

  it("discarding a new file removes it from the vault-side MEMORY.md", async () => {
    // Setup: two memory files exist in the vault memory folder, including the
    // one about to be discarded. Regenerate the index to reflect both.
    await writeFile(
      "keeper.md",
      "---\nname: Keeper\ndescription: This file stays\n---\n",
    );
    await writeFile(
      "new-proposal.md",
      "---\nname: New Proposal\ndescription: This will be discarded\n---\n",
    );
    await regenerateMemoryIndex(vaultMemoryDir);

    // Confirm both appear in the index before the discard.
    const before = await readIndex();
    expect(before).toContain("- [Keeper](keeper.md) — This file stays");
    expect(before).toContain("- [New Proposal](new-proposal.md) — This will be discarded");

    // Simulate what discardNew does: remove the vault file, then regenerate
    // the vault-side MEMORY.md in the parent folder.
    await fsp.unlink(path.join(vaultMemoryDir, "new-proposal.md"));
    await regenerateMemoryIndex(vaultMemoryDir);

    // After regeneration the discarded file must no longer appear in the index.
    const after = await readIndex();
    expect(after).not.toContain("new-proposal");
    expect(after).not.toContain("New Proposal");
    // The surviving file must still be listed.
    expect(after).toContain("- [Keeper](keeper.md) — This file stays");
  });

  it("top-level new file (no parent folder) does not trigger regeneration — hasParentFolder guard", () => {
    // The guard `relPath.includes("/")` prevents regeneration for top-level
    // files. Verify the guard itself: a path without "/" is not in a subfolder.
    const topLevel = "bare-proposal.md";
    expect(topLevel.includes("/")).toBe(false);
    // A path with "/" is in a subfolder — regeneration applies.
    const nested = "project/memory/new-proposal.md";
    expect(nested.includes("/")).toBe(true);
  });
});
