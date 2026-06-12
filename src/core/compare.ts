import { createHash } from "crypto";
import type { FileStatus } from "../types";

/** Stable content hash used as the dismiss key. */
export function hashContent(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

/**
 * Classify a vault file against its target counterpart.
 * `targetContent === null` means the file has no counterpart in the target
 * folder (a new proposal). Comparison is byte-exact (no EOL normalization).
 */
export function classify(
  vaultContent: string,
  targetContent: string | null,
): FileStatus {
  if (targetContent === null) return "new";
  if (targetContent !== vaultContent) return "modified";
  return "identical";
}
