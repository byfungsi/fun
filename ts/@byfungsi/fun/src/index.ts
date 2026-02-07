/**
 * @byfungsi/fun - AI-friendly version control
 *
 * Track AI file changes, enable undo/redo, and coordinate multiple agents.
 *
 * @example
 * ```typescript
 * import { loadOrCreateSession, FileTracker } from "@byfungsi/fun";
 *
 * // Load or create a session for the current project
 * const session = await loadOrCreateSession("/path/to/project");
 * const tracker = new FileTracker(session, "my-agent");
 *
 * // Track a file change
 * const beforeContent = await readFile("src/main.ts", "utf-8");
 * // ... AI makes changes ...
 * const afterContent = await readFile("src/main.ts", "utf-8");
 *
 * await tracker.track("src/main.ts", beforeContent, afterContent, {
 *   message: "Updated imports",
 *   metadata: { toolCallId: "call_123" }
 * });
 *
 * // Revert if needed
 * await tracker.revert("src/main.ts");
 * ```
 */

// Core exports
export {
  Session,
  createSession,
  loadSession,
  loadOrCreateSession,
} from "./session";

export { FileTracker, type TrackOptions, type LockOptions } from "./tracker";

// Type exports
export type {
  SessionId,
  ContentHash,
  VersionNum,
  SessionMetadata,
  FileState,
  Version,
  PatchStats,
  TrackChangeOptions,
  PreCheckResult,
  FileLock,
  LockResult,
  AcquireLockOptions,
  Resolution,
  StatusInfo,
} from "./types";

export { ErrorCode, FunError } from "./types";

// Low-level FFI access (for advanced use)
export { ffi } from "./ffi";

// Utility functions
import { ffi } from "./ffi";

/**
 * Generate a unified diff between two strings
 */
export function generateDiff(
  before: string,
  after: string,
  filePath?: string
): string | null {
  const result = ffi.patchGenerate(before, after, filePath);
  return result.success ? result.diff! : null;
}

/**
 * Get diff statistics
 */
export function getDiffStats(
  before: string,
  after: string
): { additions: number; deletions: number; isEmpty: boolean } {
  const stats = ffi.patchStats(before, after);
  return {
    additions: stats.additions,
    deletions: stats.deletions,
    isEmpty: stats.isEmpty,
  };
}

/**
 * Compute Blake3 hash of content
 */
export function hash(content: string): string {
  const data = new TextEncoder().encode(content);
  const hashBytes = ffi.hash(data);
  return ffi.hashToHex(hashBytes);
}

/**
 * Get library version
 */
export function version(): string {
  return ffi.version();
}
