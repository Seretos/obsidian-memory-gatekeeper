import { App, EventRef, normalizePath, TAbstractFile, TFile } from "obsidian";
import { promises as fsp } from "fs";
import * as fs from "fs";
import * as path from "path";
import { StatusStore } from "./status-store";
import { classify, hashContent } from "./core/compare";
import {
  isMemoryIndexPath,
  planVaultDeletePropagation,
  regenerateMemoryIndex,
} from "./core/memory-index";
import type { DiffData, DivergentEntry, GatekeeperSettings } from "./types";

/**
 * Compares each vault file against the same relative path under the target
 * (real memory) folder and keeps the StatusStore in sync. Watches both sides
 * and re-scans (debounced) on any change. Re-scanning fully is cheap because
 * memory folders are small.
 */
export class ComparisonEngine {
  private vaultRefs: EventRef[] = [];
  private targetWatcher?: fs.FSWatcher;
  private pollTimer?: ReturnType<typeof setInterval>;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private listeners: Array<() => void> = [];
  private running = false;
  /** relPaths of vault files being removed by the plugin itself (tombstone
   *  accept). The vault `delete` event fires for those too; this guard stops
   *  handleVaultDelete from double-processing them. */
  private suppressDelete = new Set<string>();

  constructor(
    private app: App,
    private settings: GatekeeperSettings,
    private store: StatusStore,
  ) {}

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  async start(): Promise<void> {
    this.running = true;
    await this.scan();
    this.watchVault();
    this.watchTarget();
  }

  stop(): void {
    this.running = false;
    for (const ref of this.vaultRefs) this.app.vault.offref(ref);
    this.vaultRefs = [];
    if (this.targetWatcher) {
      this.targetWatcher.close();
      this.targetWatcher = undefined;
    }
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }

  // --- watching -----------------------------------------------------------

  private watchVault(): void {
    const handler = (file: TAbstractFile) => {
      if (file instanceof TFile && this.isTracked(file)) this.scheduleScan();
    };
    this.vaultRefs.push(this.app.vault.on("modify", handler));
    this.vaultRefs.push(this.app.vault.on("create", handler));
    // Delete has its own handler: propagate to target and reindex.
    // isTracked() matches all .md files including MEMORY.md; the MEMORY.md
    // exclusion is handled inside handleVaultDelete, not here.
    this.vaultRefs.push(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && this.isTracked(file)) {
          void this.handleVaultDelete(file.path);
        }
      }),
    );
    this.vaultRefs.push(
      this.app.vault.on("rename", (file) => {
        if (file instanceof TFile) this.scheduleScan();
      }),
    );
  }

  private watchTarget(): void {
    try {
      this.targetWatcher = fs.watch(
        this.settings.targetFolder,
        { recursive: true },
        () => this.scheduleScan(),
      );
      this.targetWatcher.on("error", () => this.startPolling());
    } catch {
      this.startPolling();
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(
      () => this.scheduleScan(),
      this.settings.pollIntervalMs,
    );
  }

  private scheduleScan(): void {
    if (!this.running) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.scan(), 300);
  }

  // --- comparison ---------------------------------------------------------

  private isTracked(file: TFile): boolean {
    return this.settings.includeExtensions.includes(file.extension);
  }

  async scan(): Promise<void> {
    const files = this.app.vault
      .getFiles()
      .filter((f) => this.isTracked(f));

    const divergent: DivergentEntry[] = [];
    for (const file of files) {
      const relPath = file.path;
      // MEMORY.md is auto-generated on both sides; exclude it from review.
      if (isMemoryIndexPath(relPath)) continue;
      const vaultContent = await this.app.vault.adapter.read(relPath);
      const vaultHash = hashContent(vaultContent);
      const targetContent = await this.readTarget(relPath);

      const status = classify(vaultContent, targetContent);
      if (status === "identical") continue;

      const isTombstone = vaultContent.trim() === "";
      const entry: DivergentEntry = { relPath, status, vaultHash, isTombstone };
      // Hash-based hiding only applies to new files (no target to revert to).
      // Modified files are always shown until accepted or reverted.
      if (status === "new" && this.store.isDismissed(entry)) continue;
      divergent.push(entry);
    }

    this.store.setAll(divergent);
    this.emit();
  }

  // --- target IO ----------------------------------------------------------

  private targetPath(relPath: string): string {
    return path.join(this.settings.targetFolder, relPath);
  }

  private async readTarget(relPath: string): Promise<string | null> {
    try {
      return await fsp.readFile(this.targetPath(relPath), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async getDiffData(relPath: string): Promise<DiffData> {
    const vault = await this.app.vault.adapter.read(normalizePath(relPath));
    const target = await this.readTarget(relPath);
    return { relPath, vault, target };
  }

  /** Copy the vault file's content into the target folder (creating dirs). */
  async acceptToTarget(relPath: string): Promise<void> {
    const vault = await this.app.vault.adapter.read(normalizePath(relPath));
    const dest = this.targetPath(relPath);

    // The memory folder is the directory that directly contains the file.
    // Files at the vault root (no "/" in relPath) do not belong to any memory
    // folder, so we skip MEMORY.md regeneration for them.
    const hasParentFolder = relPath.includes("/");

    // Target-side memory folder: the directory containing the target file.
    const targetMemoryFolder = hasParentFolder ? path.dirname(dest) : null;

    // Vault-side memory folder: the directory containing the vault file.
    let vaultMemoryFolder: string | null = null;
    if (hasParentFolder) {
      try {
        const vaultBase = (this.app.vault.adapter as any).basePath as string;
        if (vaultBase) {
          vaultMemoryFolder = path.dirname(path.join(vaultBase, relPath));
        }
      } catch {
        // Non-fatal: vault base path unavailable.
      }
    }

    if (vault.trim() === "") {
      // Tombstone: the upstream hook signalled a deletion. Remove both copies.
      try {
        await fsp.unlink(dest);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      // This is the one deliberate vault deletion, gated on the empty tombstone.
      // Suppress the resulting vault `delete` event so handleVaultDelete does
      // not attempt a redundant target deletion (the unlink above already did it).
      this.suppressDelete.add(relPath);
      try {
        await this.app.vault.adapter.remove(normalizePath(relPath));
      } finally {
        // Defer so a synchronously- or microtask-queued vault `delete` event
        // from remove() is consumed by handleVaultDelete while the guard is
        // still live. Leaving it set for one extra macrotask is harmless.
        setTimeout(() => this.suppressDelete.delete(relPath), 0);
      }
    } else {
      // Normal accept: copy vault → target.
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, vault, "utf8");
    }

    // Regenerate MEMORY.md in the folder that contains the file on each side.
    // Skipped for top-level files (no parent folder).
    if (targetMemoryFolder) {
      await regenerateMemoryIndex(targetMemoryFolder).catch((e: unknown) => {
        console.warn("[memory-index] target-side regeneration failed:", e);
      });
    }
    if (vaultMemoryFolder) {
      await regenerateMemoryIndex(vaultMemoryFolder).catch((e: unknown) => {
        console.warn("[memory-index] vault-side regeneration failed:", e);
      });
    }

    await this.scan();
  }

  /**
   * Discard a proposed change by overwriting the vault (gatekeeper) file with
   * the target's content. Returns false when there is no target counterpart
   * (a brand-new file) — the caller decides how to handle that, since we never
   * delete gatekeeper files.
   */
  async revertFromTarget(relPath: string): Promise<boolean> {
    const target = await this.readTarget(relPath);
    if (target === null) return false;
    await this.app.vault.adapter.write(normalizePath(relPath), target);

    // Regenerate MEMORY.md in the folder that contains the file on both sides.
    // Skipped for top-level files (no parent folder).
    const hasParentFolder = relPath.includes("/");

    if (hasParentFolder) {
      const dest = this.targetPath(relPath);
      const targetMemoryFolder = path.dirname(dest);
      await regenerateMemoryIndex(targetMemoryFolder).catch((e: unknown) => {
        console.warn("[memory-index] target-side regeneration failed:", e);
      });

      try {
        const vaultBase = (this.app.vault.adapter as any).basePath as string;
        if (vaultBase) {
          const vaultMemoryFolder = path.dirname(path.join(vaultBase, relPath));
          await regenerateMemoryIndex(vaultMemoryFolder).catch(
            (e: unknown) => {
              console.warn("[memory-index] vault-side regeneration failed:", e);
            },
          );
        }
      } catch {
        // Non-fatal: vault base path unavailable.
      }
    }

    await this.scan();
    return true;
  }

  /**
   * Discard a "new" vault file (no target counterpart) by removing it from
   * the vault. This is the second deliberate vault deletion alongside the
   * tombstone-accept path in acceptToTarget. The vault `delete` event is
   * suppressed via suppressDelete so handleVaultDelete does not attempt a
   * pointless target-side unlink (there is no target file for a "new" entry).
   */
  async discardNew(relPath: string): Promise<void> {
    this.suppressDelete.add(relPath);
    try {
      await this.app.vault.adapter.remove(normalizePath(relPath));
    } finally {
      setTimeout(() => this.suppressDelete.delete(relPath), 0);
    }

    // Regenerate the vault-side MEMORY.md in the folder that contained the
    // removed file so the index no longer lists it. Skipped for top-level
    // files (no parent folder), mirroring the guard in acceptToTarget and
    // revertFromTarget. Target-side regeneration is not needed — a "new" file
    // has no target counterpart.
    const hasParentFolder = relPath.includes("/");
    if (hasParentFolder) {
      try {
        const vaultBase = (this.app.vault.adapter as any).basePath as string;
        if (vaultBase) {
          const vaultMemoryFolder = path.dirname(path.join(vaultBase, relPath));
          await regenerateMemoryIndex(vaultMemoryFolder).catch((e: unknown) => {
            console.warn("[memory-index] vault-side regeneration failed:", e);
          });
        }
      } catch {
        // Non-fatal: vault base path unavailable.
      }
    }

    await this.scan();
  }

  /**
   * Propagate a user deletion of a vault (gatekeeper) file to the target (real
   * memory) folder, then regenerate MEMORY.md on both sides. MEMORY.md
   * deletions are not propagated (the index is auto-generated). Plugin-initiated
   * vault removals (tombstone accept) are skipped via suppressDelete.
   */
  private async handleVaultDelete(relPath: string): Promise<void> {
    if (isMemoryIndexPath(relPath)) { this.scheduleScan(); return; }
    // Plugin-initiated removal (tombstone accept): acceptToTarget already
    // deleted the target file and will run scan() itself — no work needed here.
    if (this.suppressDelete.has(relPath)) return;

    let vaultBase: string | null = null;
    try {
      vaultBase = (this.app.vault.adapter as any).basePath as string ?? null;
    } catch {
      // Non-fatal: vault base path unavailable.
    }

    const plan = planVaultDeletePropagation(relPath, {
      targetFolder: this.settings.targetFolder,
      vaultBase,
      suppressed: this.suppressDelete.has(relPath),
    });

    if (!plan.propagate) return; // shouldn't happen given guards above, but be safe

    // Delete the corresponding target file (best-effort).
    try {
      await fsp.unlink(plan.targetFile!);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[vault-delete] target unlink failed:", e);
      }
    }

    // Regenerate MEMORY.md on both sides from the remaining files.
    // This happens synchronously (awaited) before scheduling the scan so that
    // burst deletions do not race the regeneration.
    if (plan.targetMemoryFolder) {
      await regenerateMemoryIndex(plan.targetMemoryFolder).catch((e: unknown) => {
        console.warn("[memory-index] target-side regeneration failed:", e);
      });
    }
    if (plan.vaultMemoryFolder) {
      await regenerateMemoryIndex(plan.vaultMemoryFolder).catch((e: unknown) => {
        console.warn("[memory-index] vault-side regeneration failed:", e);
      });
    }

    // Coalesce concurrent deletes into a single debounced scan rather than
    // firing one un-debounced scan per deleted file.
    this.scheduleScan();
  }

  /** Write arbitrary content back to the vault (gatekeeper) file. */
  async writeVault(relPath: string, content: string): Promise<void> {
    await this.app.vault.adapter.write(normalizePath(relPath), content);
    await this.scan();
  }

  /** Write arbitrary content to the target (real memory) file, creating dirs as needed. */
  async writeTarget(relPath: string, content: string): Promise<void> {
    const dest = this.targetPath(relPath);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, content, "utf8");
    await this.scan();
  }
}
