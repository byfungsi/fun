/**
 * Type definitions for @byfungsi/fun
 */

/** Session ID (UUID format) */
export type SessionId = string;

/** Content hash (Blake3, 32 bytes as hex) */
export type ContentHash = string;

/** Version number (1-indexed) */
export type VersionNum = number;

/** Session metadata */
export interface SessionMetadata {
  id: SessionId;
  projectPath: string;
  createdAt: number;
  lastModified: number;
  currentVersion: VersionNum;
}

/** File state for a tracked file */
export interface FileState {
  path: string;
  originalHash: ContentHash;
  currentHash: ContentHash;
  lastVersion: VersionNum;
  existedBefore: boolean;
}

/** Version information */
export interface Version {
  num: VersionNum;
  filePath: string;
  /** Editor/agent that made this change */
  editor: string;
  message: string;
  timestamp: number;
  parentVersion: VersionNum | null;
  additions: number;
  deletions: number;
  /** Custom metadata stored with this version */
  metadata?: Record<string, unknown>;
  /** True if this version represents a file deletion */
  deleted?: boolean;
}

/** Patch statistics */
export interface PatchStats {
  additions: number;
  deletions: number;
  hunks: number;
  isEmpty: boolean;
}

/** Options for tracking a change */
export interface TrackChangeOptions {
  filePath: string;
  beforeContent: string;
  afterContent: string;
  /** Editor/agent making this change */
  editor: string;
  message?: string;
  /** Custom metadata to store with this version (e.g., toolCallId, model, tokens) */
  metadata?: Record<string, unknown>;
}

/** Pre-check result for conflict detection */
export interface PreCheckResult {
  hasConflict: boolean;
  expectedContent?: string;
  actualContent?: string;
  diff?: string;
}

/** Lock information */
export interface FileLock {
  filePath: string;
  /** Editor/agent holding the lock */
  editor: string;
  acquiredAt: number;
  expiresAt: number;
}

/** Lock acquisition result */
export type LockResult =
  | { acquired: true; lock: FileLock }
  | { acquired: false; holder: string; expiresAt: number };

/** Options for acquiring a lock */
export interface AcquireLockOptions {
  /** Lock timeout in seconds (default: 300 = 5 minutes) */
  timeoutSeconds?: number;
}

/** Resolution for conflicts */
export type Resolution =
  | { type: "accept_human" }
  | { type: "revert_to_expected" }
  | { type: "merge"; content: string };

/** Status info for a session */
export interface StatusInfo {
  files: FileState[];
  currentVersion: VersionNum;
  hasUndo: boolean;
}

/** Error codes */
export enum ErrorCode {
  None = 0,
  OutOfMemory = 1,
  IoError = 2,
  InvalidArgument = 3,
  SessionNotFound = 4,
  SessionExists = 5,
  FileNotTracked = 6,
  LockHeld = 7,
  InternalError = 99,
}

/** Custom error class for Fun errors */
export class FunError extends Error {
  constructor(
    public code: ErrorCode,
    message: string
  ) {
    super(message);
    this.name = "FunError";
  }
}

// ============ Time-Travel API Types ============

/** Entry in a file's timeline for time-travel UI */
export interface FileTimelineEntry {
  /** Version number */
  version: VersionNum;
  /** Unix timestamp (milliseconds) */
  timestamp: number;
  /** Editor/agent that made this change */
  editor: string;
  /** Commit message */
  message: string;
  /** Unified diff for this version */
  diff: string;
  /** Full file content at this version */
  content: string;
  /** Lines added */
  additions: number;
  /** Lines deleted */
  deletions: number;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
  /** True if this version represents a file deletion */
  deleted?: boolean;
}

/** Result of a prune operation */
export interface PruneResult {
  /** Number of versions deleted */
  deletedVersions: number;
  /** Approximate bytes freed (patches + version metadata) */
  freedBytes: number;
  /** New current version number after renumbering */
  newCurrentVersion: VersionNum;
}

/** Result of revertByMetadata operation */
export interface RevertByMetadataResult {
  /** File paths that were reverted */
  revertedFiles: string[];
  /** Number of versions that matched the filter */
  versionsMatched: number;
}

/** Options for getHistory and getHistoryByMetadata */
export interface HistoryOptions {
  /** Maximum number of versions to return */
  limit?: number;
  /** Filter by editor/agent */
  editor?: string;
  /** Include deletion versions (default: true) */
  includeDeleted?: boolean;
}

/** Filter for querying versions by metadata */
export type MetadataFilter = Record<string, unknown>;

// ============ Sync API Types ============

/** Progress information during sync */
export interface SyncProgress {
  /** Current phase of the sync */
  phase: 'scanning' | 'checking' | 'capturing';
  /** Current file index (1-based) */
  current: number;
  /** Total number of files to check */
  total: number;
  /** Current file being processed */
  currentFile?: string;
}

/** Options for sync operation */
export interface SyncOptions {
  /** Callback for progress updates */
  onProgress?: (progress: SyncProgress) => void;
}

/** Result of a sync operation */
export interface SyncResult {
  /** Number of files checked */
  checkedFiles: number;
  /** Number of files with external changes captured */
  externalChanges: number;
  /** Number of deleted files captured */
  deletedFiles: number;
  /** Version numbers created during sync */
  capturedVersions: VersionNum[];
}

// ============ Surgical Revert Types ============

/** Conflict information when surgical revert fails */
export interface RevertConflict {
  /** Path to the conflicting file */
  filePath: string;
  /** Current content of the file */
  currentContent: string;
  /** Expected content (base for inverse patch) */
  expectedContent: string;
  /** Content we're trying to revert to */
  revertedContent: string;
  /** The inverse patch that failed to apply */
  inversePatch: string;
  /** Git-style conflict markers for manual resolution */
  conflictMarkers: string;
}

/** Result of a revertVersion operation */
export interface RevertVersionResult {
  /** Whether the revert succeeded */
  success: boolean;
  /** The new version created (if success) */
  newVersion?: Version;
  /** Conflict info for manual resolution (if failed) */
  conflict?: RevertConflict;
}

/** Result of canRevertVersion check */
export interface CanRevertResult {
  /** Whether the revert can be applied cleanly */
  canRevert: boolean;
  /** Reason if revert cannot be applied */
  reason?: string;
}
