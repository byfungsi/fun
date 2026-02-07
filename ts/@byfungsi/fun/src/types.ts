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
  agentId: string;
  message: string;
  timestamp: number;
  parentVersion: VersionNum | null;
  additions: number;
  deletions: number;
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
  agentId: string;
  message?: string;
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
  agentId: string;
  acquiredAt: number;
  expiresAt: number;
}

/** Lock acquisition result */
export type LockResult =
  | { acquired: true; lock: FileLock }
  | { acquired: false; holder: string; expiresAt: number };

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
