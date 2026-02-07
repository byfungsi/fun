/**
 * FileTracker - Convenience wrapper for tracking AI file changes
 */

import { Session } from "./session";
import type {
  Version,
  PreCheckResult,
  Resolution,
  FileLock,
  LockResult,
  FileTimelineEntry,
  MetadataFilter,
  HistoryOptions,
  VersionNum,
  SyncOptions,
  SyncResult,
  RevertVersionResult,
  CanRevertResult,
} from "./types";

/** Options for FileTracker.track() */
export interface TrackOptions {
  /** Commit message describing the change */
  message?: string;
  /** Custom metadata to store with this version */
  metadata?: Record<string, unknown>;
}

/** Options for FileTracker.lock() */
export interface LockOptions {
  /** Lock timeout in seconds (default: 300 = 5 minutes) */
  timeoutSeconds?: number;
}

/**
 * Convenience wrapper for tracking file changes by an editor/agent
 */
export class FileTracker {
  constructor(
    private session: Session,
    private editor: string
  ) {}

  /**
   * Track a file change
   */
  async track(
    file: string,
    before: string,
    after: string,
    options?: TrackOptions
  ): Promise<Version> {
    return this.session.trackChange({
      filePath: file,
      beforeContent: before,
      afterContent: after,
      editor: this.editor,
      message: options?.message,
      metadata: options?.metadata,
    });
  }

  /**
   * Pre-check for conflicts before editing
   */
  async preCheck(file: string): Promise<PreCheckResult> {
    return this.session.preCheck(file, this.editor);
  }

  /**
   * Resolve a conflict
   */
  async resolve(file: string, resolution: Resolution): Promise<void> {
    switch (resolution.type) {
      case "accept_human":
        // Update our tracking to match the current file state
        // TODO: Implement accepting human changes
        break;

      case "revert_to_expected":
        // Revert to what we expected
        await this.session.revertFile(file);
        break;

      case "merge":
        // Write merged content
        // TODO: Implement merge
        break;
    }
  }

  /**
   * Revert a file to original state
   */
  async revert(file: string): Promise<void> {
    await this.session.revertFile(file, 0);
  }

  /**
   * Revert a file to a specific version
   */
  async revertToVersion(file: string, version: VersionNum): Promise<void> {
    await this.session.revertFile(file, version);
  }

  // ============ Time-Travel API ============

  /**
   * Get history of changes made by this editor
   */
  async getHistory(options?: HistoryOptions): Promise<Version[]> {
    return this.session.getHistory({
      ...options,
      editor: this.editor,
    });
  }

  /**
   * Get history filtered by metadata (for this editor's changes only)
   */
  async getHistoryByMetadata(
    filter: MetadataFilter,
    options?: HistoryOptions
  ): Promise<Version[]> {
    const history = await this.session.getHistoryByMetadata(filter, options);
    return history.filter((v) => v.editor === this.editor);
  }

  /**
   * Get complete timeline for a file (all editors)
   */
  async getFileTimeline(file: string, options?: HistoryOptions): Promise<FileTimelineEntry[]> {
    return this.session.getFileTimeline(file, options);
  }

  /**
   * Get content at a specific version
   */
  async getContentAtVersion(file: string, version: VersionNum): Promise<string> {
    return this.session.getContentAtVersion(file, version);
  }

  /**
   * Get the diff for a specific version
   */
  async getDiff(version: VersionNum): Promise<string> {
    return this.session.getDiff(version);
  }

  // ============ Sync API ============

  /**
   * Sync tracked files with filesystem, detecting external changes.
   */
  async sync(options?: SyncOptions): Promise<SyncResult> {
    return this.session.sync(options);
  }

  // ============ Surgical Revert API ============

  /**
   * Check if a version can be reverted surgically.
   */
  async canRevertVersion(version: VersionNum): Promise<CanRevertResult> {
    return this.session.canRevertVersion(version);
  }

  /**
   * Surgically revert a specific version by applying its inverse patch.
   * Returns conflict info for manual resolution if the patch cannot be applied.
   */
  async revertVersion(version: VersionNum): Promise<RevertVersionResult> {
    return this.session.revertVersion(version);
  }

  // ============ Lock Management ============

  /**
   * Lock a file for editing.
   * Returns { acquired: true, lock } on success.
   * Returns { acquired: false, holder, expiresAt } if locked by another editor.
   */
  async lock(file: string, options?: LockOptions): Promise<LockResult> {
    return this.session.acquireLock(file, this.editor, options);
  }

  /**
   * Unlock a file after editing.
   * Returns true if lock was released, false if not held by this editor.
   */
  async unlock(file: string): Promise<boolean> {
    return this.session.releaseLock(file, this.editor);
  }

  /**
   * Check if a file is locked.
   * Returns lock info if locked, null if not locked.
   */
  async isLocked(file: string): Promise<FileLock | null> {
    return this.session.isLocked(file);
  }

  /**
   * Cleanup - close the session
   */
  async cleanup(): Promise<void> {
    await this.session.close();
  }
}
