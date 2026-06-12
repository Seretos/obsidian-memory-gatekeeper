import type { DivergentEntry, FileStatus, StatusEntry } from "./types";

/**
 * Holds the current divergence state in memory and exposes the persisted
 * "dismissed" set. Dismissal is keyed by relPath + content hash, so a file
 * re-surfaces for review whenever its content changes again.
 */
export class StatusStore {
  /** Only divergent (new/modified) entries are kept. */
  private entries = new Map<string, DivergentEntry>();

  constructor(private dismissed: Record<string, string>) {}

  /** Replace the full set of divergent entries (called after each scan). */
  setAll(entries: DivergentEntry[]): void {
    this.entries.clear();
    for (const e of entries) this.entries.set(e.relPath, e);
  }

  get(relPath: string): DivergentEntry | undefined {
    return this.entries.get(relPath);
  }

  statusOf(relPath: string): FileStatus {
    return this.entries.get(relPath)?.status ?? "identical";
  }

  all(): DivergentEntry[] {
    return [...this.entries.values()].sort((a, b) =>
      a.relPath.localeCompare(b.relPath),
    );
  }

  paths(): string[] {
    return [...this.entries.keys()];
  }

  isDismissed(entry: StatusEntry): boolean {
    return this.dismissed[entry.relPath] === entry.vaultHash;
  }

  /** Mark this exact content as dismissed. Returns the mutated map for persistence. */
  dismiss(entry: StatusEntry): Record<string, string> {
    this.dismissed[entry.relPath] = entry.vaultHash;
    this.entries.delete(entry.relPath);
    return this.dismissed;
  }
}
