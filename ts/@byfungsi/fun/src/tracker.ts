/**
 * FileTracker - Convenience wrapper for tracking AI file changes
 */

import { Session } from "./session";
import type { Version, PreCheckResult, Resolution, FileLock, LockResult } from "./types";

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
 * Convenience wrapper for tracking file changes by an agent
 */
export class FileTracker {
  constructor(
    private session: Session,
    private agentId: string
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
      agentId: this.agentId,
      message: options?.message,
      metadata: options?.metadata,
    });
  }

  /**
   * Pre-check for conflicts before editing
   */
  async preCheck(file: string): Promise<PreCheckResult> {
    return this.session.preCheck(file, this.agentId);
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

  // ============ Lock Management ============

  /**
   * Lock a file for editing.
   * Returns { acquired: true, lock } on success.
   * Returns { acquired: false, holder, expiresAt } if locked by another agent.
   */
  async lock(file: string, options?: LockOptions): Promise<LockResult> {
    return this.session.acquireLock(file, this.agentId, options);
  }

  /**
   * Unlock a file after editing.
   * Returns true if lock was released, false if not held by this agent.
   */
  async unlock(file: string): Promise<boolean> {
    return this.session.releaseLock(file, this.agentId);
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
