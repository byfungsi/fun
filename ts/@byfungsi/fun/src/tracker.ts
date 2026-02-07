/**
 * FileTracker - Convenience wrapper for tracking AI file changes
 */

import { Session } from "./session";
import type { Version, PreCheckResult, Resolution } from "./types";

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
    message?: string
  ): Promise<Version> {
    return this.session.trackChange({
      filePath: file,
      beforeContent: before,
      afterContent: after,
      agentId: this.agentId,
      message,
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

  /**
   * Cleanup - close the session
   */
  async cleanup(): Promise<void> {
    await this.session.close();
  }
}
