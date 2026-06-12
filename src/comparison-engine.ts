import { App, EventRef, normalizePath, TAbstractFile, TFile } from "obsidian";
import { createHash } from "crypto";
import { promises as fsp } from "fs";
import * as fs from "fs";
import * as path from "path";
import { StatusStore } from "./status-store";
import type {
  DiffData,
  DivergentEntry,
  FileStatus,
  GatekeeperSettings,
} from "./types";

function sha1(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

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
    this.vaultRefs.push(this.app.vault.on("delete", handler));
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
      const vaultContent = await this.app.vault.adapter.read(relPath);
      const vaultHash = sha1(vaultContent);
      const targetContent = await this.readTarget(relPath);

      let status: FileStatus;
      if (targetContent === null) status = "new";
      else if (targetContent !== vaultContent) status = "modified";
      else status = "identical";

      if (status === "identical") continue;

      const entry: DivergentEntry = { relPath, status, vaultHash };
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
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, vault, "utf8");
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
    await this.scan();
    return true;
  }
}
