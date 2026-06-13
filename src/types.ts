export const REVIEW_VIEW_TYPE = "memory-gatekeeper-review";
export const COMPARE_VIEW_TYPE = "memory-gatekeeper-compare";

/** Status of a vault file relative to its counterpart in the target memory folder. */
export type FileStatus = "new" | "modified" | "identical";

export interface StatusEntry {
  /** Vault-relative path with forward slashes (Obsidian convention). */
  relPath: string;
  status: FileStatus;
  /** sha1 of the current vault content; used as the dismiss key. */
  vaultHash: string;
}

/** Only "new" and "modified" entries are surfaced to the UI. */
export type DivergentEntry = StatusEntry & {
  status: "new" | "modified";
  /**
   * True when the vault file is empty (a deletion tombstone written by the
   * upstream hook to signal that the corresponding memory file should be
   * removed). Accepting a tombstone deletes both the target and vault copy
   * rather than copying empty content.
   */
  isTombstone?: boolean;
};

export interface DiffData {
  relPath: string;
  vault: string;
  /** null when the file does not exist in the target folder yet. */
  target: string | null;
}

/** Operations the views need, without depending on the plugin/engine classes. */
export interface GatekeeperActions {
  getDiffData(relPath: string): Promise<DiffData>;
  accept(relPath: string): Promise<void>;
  dismiss(relPath: string): Promise<void>;
  openFile(relPath: string): Promise<void>;
  openCompare(relPath: string): Promise<void>;
  writeVault(relPath: string, content: string): Promise<void>;
  writeTarget(relPath: string, content: string): Promise<void>;
}

export interface GatekeeperSettings {
  /** Absolute path to the real memory folder this vault is gated against. */
  targetFolder: string;
  /** File extensions to compare (without dot), e.g. ["md"]. */
  includeExtensions: string[];
  /** Polling fallback interval (ms) for the target folder when fs.watch is unavailable. */
  pollIntervalMs: number;
  /** Highlight color for divergent graph nodes, as 0xRRGGBB. */
  graphHighlightColor: number;
  /** relPath -> dismissed content hash. Re-surfaces when the hash changes. */
  dismissed: Record<string, string>;
}

export const DEFAULT_SETTINGS: GatekeeperSettings = {
  targetFolder: "",
  includeExtensions: ["md"],
  pollIntervalMs: 4000,
  graphHighlightColor: 0xff5555,
  dismissed: {},
};
