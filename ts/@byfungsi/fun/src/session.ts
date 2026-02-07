/**
 * Session class for managing AI file tracking
 */

import { readFile, writeFile, mkdir, rm, stat } from "fs/promises";
import { join, dirname } from "path";
import { homedir } from "os";
import { ffi } from "./ffi";
import type {
  SessionId,
  SessionMetadata,
  FileState,
  Version,
  TrackChangeOptions,
  PreCheckResult,
  StatusInfo,
  VersionNum,
  FileLock,
  LockResult,
  AcquireLockOptions,
  FileTimelineEntry,
  PruneResult,
  RevertByMetadataResult,
  MetadataFilter,
  HistoryOptions,
  SyncProgress,
  SyncOptions,
  SyncResult,
  RevertConflict,
  RevertVersionResult,
  CanRevertResult,
} from "./types";
import { FunError, ErrorCode } from "./types";

/** Get the funcode base directory */
function getFuncodeDir(): string {
  return join(homedir(), ".funcode");
}

/** Get the sessions directory */
function getSessionsDir(): string {
  return join(getFuncodeDir(), "sessions");
}

/** Generate a UUID v4 */
function generateUUID(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A Funcode session for tracking AI file changes
 */
export class Session {
  readonly id: SessionId;
  readonly projectPath: string;
  private sessionPath: string;
  private currentVersion: VersionNum = 0;
  private fileStates: Map<string, FileState> = new Map();
  private initialized = false;

  private constructor(id: SessionId, projectPath: string) {
    this.id = id;
    this.projectPath = projectPath;
    this.sessionPath = join(getSessionsDir(), id);
  }

  /**
   * Create a new session for a project
   */
  static async create(projectPath: string): Promise<Session> {
    const id = generateUUID();
    const session = new Session(id, projectPath);

    // Create session directory
    await mkdir(session.sessionPath, { recursive: true });
    await mkdir(join(session.sessionPath, "originals"), { recursive: true });
    await mkdir(join(session.sessionPath, "patches"), { recursive: true });
    await mkdir(join(session.sessionPath, "versions"), { recursive: true });

    // Save initial metadata
    await session.saveMetadata();
    session.initialized = true;

    return session;
  }

  /**
   * Load an existing session by ID
   */
  static async load(id: SessionId): Promise<Session> {
    const sessionPath = join(getSessionsDir(), id);

    try {
      await stat(sessionPath);
    } catch {
      throw new FunError(ErrorCode.SessionNotFound, `Session not found: ${id}`);
    }

    // Load metadata
    const metaPath = join(sessionPath, "manifest.json");
    const metaJson = await readFile(metaPath, "utf-8");
    const meta = JSON.parse(metaJson);

    const session = new Session(id, meta.project_path);
    session.currentVersion = meta.current_version || 0;
    session.initialized = true;

    // Load file states
    await session.loadFileStates();

    return session;
  }

  /**
   * Load or create a session for a project path
   */
  static async loadOrCreate(projectPath: string): Promise<Session> {
    const sessionsDir = getSessionsDir();

    try {
      await mkdir(sessionsDir, { recursive: true });
      const { readdir } = await import("fs/promises");
      const entries = await readdir(sessionsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.length !== 36) continue;

        try {
          const session = await Session.load(entry.name);
          if (session.projectPath === projectPath) {
            return session;
          }
          // Not a match, close this one
        } catch {
          // Failed to load, try next
        }
      }
    } catch {
      // Sessions dir doesn't exist yet
    }

    // No matching session found, create new one
    return Session.create(projectPath);
  }

  /**
   * Track a file change
   */
  async trackChange(opts: TrackChangeOptions): Promise<Version> {
    this.ensureInitialized();

    const { filePath, beforeContent, afterContent, editor, message, metadata } = opts;

    // Generate diff using native library
    const result = ffi.patchGenerate(beforeContent, afterContent, filePath);
    if (!result.success) {
      throw new FunError(
        result.errorCode ?? ErrorCode.InternalError,
        "Failed to generate patch"
      );
    }

    const stats = ffi.patchStats(beforeContent, afterContent);

    if (stats.isEmpty) {
      // No changes
      return {
        num: this.currentVersion,
        filePath,
        editor,
        message: message || "",
        timestamp: Date.now(),
        parentVersion: this.currentVersion > 0 ? this.currentVersion : null,
        additions: 0,
        deletions: 0,
        metadata,
      };
    }

    // Compute hashes
    const beforeHash = this.computeHash(beforeContent);
    const afterHash = this.computeHash(afterContent);

    // Get or create file state
    let fileState = this.fileStates.get(filePath);
    if (!fileState) {
      // First time tracking this file - store original
      await this.storeOriginal(beforeContent, beforeHash);

      fileState = {
        path: filePath,
        originalHash: beforeHash,
        currentHash: afterHash,
        lastVersion: this.currentVersion + 1,
        existedBefore: beforeContent.length > 0,
      };
    } else {
      fileState = {
        ...fileState,
        currentHash: afterHash,
        lastVersion: this.currentVersion + 1,
      };
    }

    this.fileStates.set(filePath, fileState);

    // Increment version
    this.currentVersion += 1;

    // Store patch
    await this.storePatch(result.diff!, this.currentVersion);

    // Create version metadata
    const version: Version = {
      num: this.currentVersion,
      filePath,
      editor,
      message: message || "",
      timestamp: Date.now(),
      parentVersion:
        this.currentVersion > 1 ? this.currentVersion - 1 : null,
      additions: stats.additions,
      deletions: stats.deletions,
      metadata,
    };

    // Store version metadata
    await this.storeVersionMeta(this.currentVersion, version);

    // Save session state
    await this.saveMetadata();
    await this.saveFileStates();

    return version;
  }

  /**
   * Revert a file to a specific version (or original if version is 0/undefined)
   */
  async revertFile(filePath: string, toVersion?: VersionNum): Promise<void> {
    this.ensureInitialized();

    const fileState = this.fileStates.get(filePath);
    if (!fileState) {
      throw new FunError(
        ErrorCode.FileNotTracked,
        `File not tracked: ${filePath}`
      );
    }

    const targetVersion = toVersion ?? 0;

    // Get content at target version
    const content =
      targetVersion === 0
        ? await this.getOriginal(fileState.originalHash)
        : await this.getContentAtVersion(filePath, targetVersion);

    // Write to file
    const fullPath = join(this.projectPath, filePath);

    if (!fileState.existedBefore && targetVersion === 0) {
      // File didn't exist before, delete it
      try {
        await rm(fullPath);
      } catch {
        // Ignore if already deleted
      }
    } else {
      // Ensure directory exists
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, "utf-8");
    }

    // Update file state
    const newHash =
      targetVersion === 0
        ? fileState.originalHash
        : this.computeHash(content);

    this.fileStates.set(filePath, {
      ...fileState,
      currentHash: newHash,
    });

    await this.saveFileStates();
  }

  /**
   * Revert all files to original state
   */
  async revertAll(): Promise<void> {
    for (const filePath of this.fileStates.keys()) {
      await this.revertFile(filePath, 0);
    }
  }

  /**
   * Get content at a specific version by applying patches
   */
  async getContentAtVersion(
    filePath: string,
    targetVersion: VersionNum
  ): Promise<string> {
    const fileState = this.fileStates.get(filePath);
    if (!fileState) {
      throw new FunError(
        ErrorCode.FileNotTracked,
        `File not tracked: ${filePath}`
      );
    }

    // Start with original content
    let content = await this.getOriginal(fileState.originalHash);

    // Apply patches from version 1 up to targetVersion
    for (let v = 1; v <= targetVersion && v <= this.currentVersion; v++) {
      try {
        const versionMeta = await this.loadVersionMeta(v);
        
        // Only apply patches for this file
        if (versionMeta.filePath !== filePath) {
          continue;
        }

        // Load and apply patch
        const patchContent = await this.getPatch(v);
        const applyResult = ffi.patchApply(content, patchContent);
        
        if (applyResult.success && applyResult.result) {
          content = applyResult.result;
        }
      } catch {
        // Skip if version metadata or patch is missing
        continue;
      }
    }

    return content;
  }

  /**
   * Get session metadata
   */
  async getMetadata(): Promise<SessionMetadata> {
    return {
      id: this.id,
      projectPath: this.projectPath,
      createdAt: Date.now(), // TODO: Load from storage
      lastModified: Date.now(),
      currentVersion: this.currentVersion,
    };
  }

  /**
   * Get status of all tracked files
   */
  async getStatus(): Promise<StatusInfo> {
    return {
      files: Array.from(this.fileStates.values()),
      currentVersion: this.currentVersion,
      hasUndo: this.currentVersion > 0,
    };
  }

  /**
   * Get version history
   */
  async getHistory(options?: HistoryOptions): Promise<Version[]> {
    const limit = options?.limit ?? this.currentVersion;
    const versions: Version[] = [];

    for (
      let v = this.currentVersion;
      v > 0 && versions.length < limit;
      v--
    ) {
      try {
        const meta = await this.loadVersionMeta(v);
        
        // Apply filters
        if (options?.editor && meta.editor !== options.editor) {
          continue;
        }
        if (options?.includeDeleted === false && meta.deleted) {
          continue;
        }
        
        versions.push(meta);
      } catch {
        // Skip if version metadata is missing
      }
    }

    return versions;
  }

  // ============ Time-Travel API ============

  /**
   * Get version history filtered by metadata fields.
   * Returns versions where all specified metadata fields match.
   */
  async getHistoryByMetadata(
    filter: MetadataFilter,
    options?: HistoryOptions
  ): Promise<Version[]> {
    const allVersions = await this.getHistory(options);
    
    return allVersions.filter((version) => {
      if (!version.metadata) return false;
      
      // Check if all filter keys match
      for (const [key, value] of Object.entries(filter)) {
        if (version.metadata[key] !== value) {
          return false;
        }
      }
      return true;
    });
  }

  /**
   * Revert all files that were changed by versions matching the metadata filter.
   * For each affected file, reverts to the state just before the first matching version.
   */
  async revertByMetadata(
    filter: MetadataFilter
  ): Promise<RevertByMetadataResult> {
    this.ensureInitialized();

    // Get all versions (oldest first for proper ordering)
    const allVersions = await this.getHistory();
    allVersions.reverse(); // Now oldest first

    // Find versions matching the filter
    const matchingVersions = allVersions.filter((version) => {
      if (!version.metadata) return false;
      for (const [key, value] of Object.entries(filter)) {
        if (version.metadata[key] !== value) {
          return false;
        }
      }
      return true;
    });

    if (matchingVersions.length === 0) {
      return { revertedFiles: [], versionsMatched: 0 };
    }

    // Group by file and find the target version for each file
    // (the version just before the first matching version for that file)
    const fileTargetVersions = new Map<string, VersionNum>();

    for (const version of matchingVersions) {
      if (!fileTargetVersions.has(version.filePath)) {
        // Find the version just before this one for this file
        const previousVersion = allVersions
          .filter(v => v.filePath === version.filePath && v.num < version.num)
          .pop(); // Last one before the matching version

        fileTargetVersions.set(
          version.filePath,
          previousVersion?.num ?? 0 // 0 means revert to original
        );
      }
    }

    // Revert each file
    const revertedFiles: string[] = [];
    for (const [filePath, targetVersion] of fileTargetVersions) {
      try {
        await this.revertFile(filePath, targetVersion);
        revertedFiles.push(filePath);
      } catch {
        // Skip files that can't be reverted
      }
    }

    return {
      revertedFiles,
      versionsMatched: matchingVersions.length,
    };
  }

  /**
   * Get the unified diff for a specific version.
   */
  async getDiff(version: VersionNum): Promise<string> {
    this.ensureInitialized();
    
    if (version < 1 || version > this.currentVersion) {
      throw new FunError(
        ErrorCode.InvalidArgument,
        `Version ${version} not found (current: ${this.currentVersion})`
      );
    }

    return this.getPatch(version);
  }

  /**
   * Get history for a specific file only.
   */
  async getFileHistory(filePath: string, options?: HistoryOptions): Promise<Version[]> {
    const allVersions = await this.getHistory(options);
    return allVersions.filter((v) => v.filePath === filePath);
  }

  /**
   * Get complete timeline for a file, including content at each version.
   * Useful for time-travel UI with a slider.
   */
  async getFileTimeline(filePath: string, options?: HistoryOptions): Promise<FileTimelineEntry[]> {
    this.ensureInitialized();

    const fileState = this.fileStates.get(filePath);
    if (!fileState) {
      throw new FunError(
        ErrorCode.FileNotTracked,
        `File not tracked: ${filePath}`
      );
    }

    // Get all versions for this file, sorted by version number ascending
    const fileVersions = await this.getFileHistory(filePath, options);
    fileVersions.reverse(); // Now oldest first

    const timeline: FileTimelineEntry[] = [];

    // Start with original content
    let content = await this.getOriginal(fileState.originalHash);

    for (const version of fileVersions) {
      try {
        const diff = await this.getPatch(version.num);
        
        // Apply patch to get content at this version
        const applyResult = ffi.patchApply(content, diff);
        if (applyResult.success && applyResult.result) {
          content = applyResult.result;
        }

        timeline.push({
          version: version.num,
          timestamp: version.timestamp,
          editor: version.editor,
          message: version.message,
          diff,
          content,
          additions: version.additions,
          deletions: version.deletions,
          metadata: version.metadata,
          deleted: version.deleted,
        });
      } catch {
        // Skip versions with missing patches
      }
    }

    return timeline;
  }

  /**
   * Prune old versions, keeping only the last N versions.
   * Versions are renumbered 1 to N after pruning.
   */
  async prune(keepVersions: number): Promise<PruneResult> {
    this.ensureInitialized();

    if (keepVersions < 0) {
      throw new FunError(
        ErrorCode.InvalidArgument,
        "keepVersions must be non-negative"
      );
    }

    if (this.currentVersion <= keepVersions) {
      // Nothing to prune
      return {
        deletedVersions: 0,
        freedBytes: 0,
        newCurrentVersion: this.currentVersion,
      };
    }

    const versionsToDelete = this.currentVersion - keepVersions;
    let freedBytes = 0;

    // Delete old version files and patch files
    for (let v = 1; v <= versionsToDelete; v++) {
      const versionFile = join(
        this.sessionPath,
        "versions",
        `${String(v).padStart(4, "0")}.json`
      );
      const patchFile = join(
        this.sessionPath,
        "patches",
        `${String(v).padStart(4, "0")}.diff`
      );

      try {
        const vStat = await stat(versionFile);
        freedBytes += vStat.size;
        await rm(versionFile);
      } catch {
        // File doesn't exist
      }

      try {
        const pStat = await stat(patchFile);
        freedBytes += pStat.size;
        await rm(patchFile);
      } catch {
        // File doesn't exist
      }
    }

    // Renumber remaining versions: versionsToDelete+1 -> 1, versionsToDelete+2 -> 2, etc.
    for (let oldV = versionsToDelete + 1; oldV <= this.currentVersion; oldV++) {
      const newV = oldV - versionsToDelete;

      const oldVersionFile = join(
        this.sessionPath,
        "versions",
        `${String(oldV).padStart(4, "0")}.json`
      );
      const newVersionFile = join(
        this.sessionPath,
        "versions",
        `${String(newV).padStart(4, "0")}.json`
      );
      const oldPatchFile = join(
        this.sessionPath,
        "patches",
        `${String(oldV).padStart(4, "0")}.diff`
      );
      const newPatchFile = join(
        this.sessionPath,
        "patches",
        `${String(newV).padStart(4, "0")}.diff`
      );

      try {
        // Update version metadata with new version number
        const versionMeta = await this.loadVersionMeta(oldV);
        versionMeta.num = newV;
        versionMeta.parentVersion = newV > 1 ? newV - 1 : null;
        await writeFile(newVersionFile, JSON.stringify(versionMeta, null, 2), "utf-8");
        
        if (oldVersionFile !== newVersionFile) {
          await rm(oldVersionFile);
        }
      } catch {
        // Version file doesn't exist
      }

      try {
        // Rename patch file
        const patchContent = await readFile(oldPatchFile, "utf-8");
        await writeFile(newPatchFile, patchContent, "utf-8");
        
        if (oldPatchFile !== newPatchFile) {
          await rm(oldPatchFile);
        }
      } catch {
        // Patch file doesn't exist
      }
    }

    // Update file states to reflect new version numbers
    for (const [path, state] of this.fileStates) {
      if (state.lastVersion > versionsToDelete) {
        this.fileStates.set(path, {
          ...state,
          lastVersion: state.lastVersion - versionsToDelete,
        });
      }
    }

    // Update current version
    this.currentVersion = keepVersions;

    // Save updated state
    await this.saveMetadata();
    await this.saveFileStates();

    return {
      deletedVersions: versionsToDelete,
      freedBytes,
      newCurrentVersion: this.currentVersion,
    };
  }

  // ============ Sync API ============

  /**
   * Sync tracked files with filesystem, detecting external changes.
   * Call this after mass external changes (git operations, etc).
   */
  async sync(options?: SyncOptions): Promise<SyncResult> {
    this.ensureInitialized();

    const result: SyncResult = {
      checkedFiles: 0,
      externalChanges: 0,
      deletedFiles: 0,
      capturedVersions: [],
    };

    const files = Array.from(this.fileStates.entries());
    const total = files.length;

    // Scanning phase
    options?.onProgress?.({ phase: 'scanning', current: 0, total });

    for (let i = 0; i < files.length; i++) {
      const [filePath, fileState] = files[i];
      const fullPath = join(this.projectPath, filePath);

      // Checking phase
      options?.onProgress?.({
        phase: 'checking',
        current: i + 1,
        total,
        currentFile: filePath,
      });

      result.checkedFiles++;

      try {
        const actualContent = await readFile(fullPath, "utf-8");
        const actualHash = this.computeHash(actualContent);

        if (actualHash !== fileState.currentHash) {
          // Capturing phase - file changed externally
          options?.onProgress?.({
            phase: 'capturing',
            current: i + 1,
            total,
            currentFile: filePath,
          });

          const expectedContent = await this.getContentAtVersion(
            filePath,
            fileState.lastVersion
          );

          const version = await this.trackChange({
            filePath,
            beforeContent: expectedContent,
            afterContent: actualContent,
            editor: "unknown",
            message: "External change detected",
          });

          result.externalChanges++;
          result.capturedVersions.push(version.num);
        }
      } catch (e: unknown) {
        const error = e as NodeJS.ErrnoException;
        if (error.code === 'ENOENT') {
          // File deleted externally
          options?.onProgress?.({
            phase: 'capturing',
            current: i + 1,
            total,
            currentFile: filePath,
          });

          const version = await this._trackDeletion(filePath);
          result.deletedFiles++;
          result.capturedVersions.push(version.num);
        }
      }
    }

    return result;
  }

  /**
   * Track a file deletion (internal helper)
   */
  private async _trackDeletion(filePath: string): Promise<Version> {
    const fileState = this.fileStates.get(filePath);
    if (!fileState) {
      throw new FunError(
        ErrorCode.FileNotTracked,
        `File not tracked: ${filePath}`
      );
    }

    const lastContent = await this.getContentAtVersion(
      filePath,
      fileState.lastVersion
    );

    return this.trackChange({
      filePath,
      beforeContent: lastContent,
      afterContent: "",
      editor: "unknown",
      message: "File deleted externally",
      metadata: { deleted: true },
    });
  }

  // ============ Surgical Revert API ============

  /**
   * Check if a version can be reverted surgically.
   */
  async canRevertVersion(versionNum: VersionNum): Promise<CanRevertResult> {
    this.ensureInitialized();

    if (versionNum < 1 || versionNum > this.currentVersion) {
      return {
        canRevert: false,
        reason: `Version ${versionNum} not found (current: ${this.currentVersion})`,
      };
    }

    try {
      const versionMeta = await this.loadVersionMeta(versionNum);
      const filePath = versionMeta.filePath;
      const fullPath = join(this.projectPath, filePath);

      // Get the diff for this version and invert it
      const diff = await this.getPatch(versionNum);
      const inverseDiff = this.invertPatch(diff);

      // Read current file content
      let currentContent: string;
      try {
        currentContent = await readFile(fullPath, "utf-8");
      } catch {
        return {
          canRevert: false,
          reason: "File does not exist",
        };
      }

      // Try to apply inverse patch
      const applyResult = ffi.patchApply(currentContent, inverseDiff);

      if (!applyResult.success) {
        return {
          canRevert: false,
          reason: "Inverse patch cannot be applied cleanly - file has diverged",
        };
      }

      return { canRevert: true };
    } catch (e) {
      return {
        canRevert: false,
        reason: `Error checking version: ${e}`,
      };
    }
  }

  /**
   * Surgically revert a specific version by applying its inverse patch.
   * Returns conflict info for manual resolution if the patch cannot be applied.
   */
  async revertVersion(versionNum: VersionNum): Promise<RevertVersionResult> {
    this.ensureInitialized();

    if (versionNum < 1 || versionNum > this.currentVersion) {
      throw new FunError(
        ErrorCode.InvalidArgument,
        `Version ${versionNum} not found (current: ${this.currentVersion})`
      );
    }

    const versionMeta = await this.loadVersionMeta(versionNum);
    const filePath = versionMeta.filePath;
    const fullPath = join(this.projectPath, filePath);

    // Get the diff for this version
    const diff = await this.getPatch(versionNum);

    // Invert the patch
    const inverseDiff = this.invertPatch(diff);

    // Read current file content
    let currentContent: string;
    try {
      currentContent = await readFile(fullPath, "utf-8");
    } catch {
      currentContent = "";
    }

    // Try to apply inverse patch
    const applyResult = ffi.patchApply(currentContent, inverseDiff);

    if (!applyResult.success) {
      // Get content at version and before version for conflict info
      const expectedContent = await this.getContentAtVersion(
        filePath,
        versionNum
      );
      const revertedContent = versionMeta.parentVersion
        ? await this.getContentAtVersion(filePath, versionMeta.parentVersion)
        : await this.getOriginal(
            this.fileStates.get(filePath)?.originalHash ?? ""
          );

      // Generate conflict markers
      const conflictMarkers = this.generateConflictMarkers(
        currentContent,
        revertedContent,
        versionNum
      );

      return {
        success: false,
        conflict: {
          filePath,
          currentContent,
          expectedContent,
          revertedContent,
          inversePatch: inverseDiff,
          conflictMarkers,
        },
      };
    }

    // Write new content
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, applyResult.result!, "utf-8");

    // Track this revert as a new version
    const newVersion = await this.trackChange({
      filePath,
      beforeContent: currentContent,
      afterContent: applyResult.result!,
      editor: "system",
      message: `Reverted version ${versionNum}`,
      metadata: {
        revertedVersion: versionNum,
        originalMessage: versionMeta.message,
      },
    });

    return { success: true, newVersion };
  }

  /**
   * Invert a unified diff (swap + and - lines, swap hunk headers)
   */
  private invertPatch(diff: string): string {
    const lines = diff.split('\n');
    const inverted: string[] = [];

    for (const line of lines) {
      if (line.startsWith('--- ')) {
        inverted.push(line.replace('--- ', '+++ '));
      } else if (line.startsWith('+++ ')) {
        inverted.push(line.replace('+++ ', '--- '));
      } else if (line.startsWith('@@')) {
        // Swap hunk headers: @@ -old,count +new,count @@ -> @@ -new,count +old,count @@
        const match = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@(.*)/);
        if (match) {
          const [, oldStart, oldCount, newStart, newCount, rest] = match;
          const oldPart = oldCount ? `${oldStart},${oldCount}` : oldStart;
          const newPart = newCount ? `${newStart},${newCount}` : newStart;
          inverted.push(`@@ -${newPart} +${oldPart} @@${rest || ''}`);
        } else {
          inverted.push(line);
        }
      } else if (line.startsWith('-')) {
        inverted.push('+' + line.slice(1));
      } else if (line.startsWith('+')) {
        inverted.push('-' + line.slice(1));
      } else {
        inverted.push(line);
      }
    }

    return inverted.join('\n');
  }

  /**
   * Generate git-style conflict markers
   */
  private generateConflictMarkers(
    current: string,
    reverted: string,
    versionNum: VersionNum
  ): string {
    return `<<<<<<< CURRENT
${current}
=======
${reverted}
>>>>>>> REVERT (v${versionNum})`;
  }

  /**
   * Pre-check for conflicts before editing
   */
  async preCheck(
    filePath: string,
    _editor: string
  ): Promise<PreCheckResult> {
    const fileState = this.fileStates.get(filePath);
    if (!fileState) {
      // File not tracked yet, no conflict possible
      return { hasConflict: false };
    }

    // Read current file content
    const fullPath = join(this.projectPath, filePath);
    let actualContent: string;
    try {
      actualContent = await readFile(fullPath, "utf-8");
    } catch {
      // File doesn't exist
      actualContent = "";
    }

    const actualHash = this.computeHash(actualContent);

    // Check if content matches what we expect
    if (actualHash !== fileState.currentHash) {
      const expectedContent = await this.getOriginal(fileState.currentHash);
      const diffResult = ffi.patchGenerate(
        expectedContent,
        actualContent,
        filePath
      );

      return {
        hasConflict: true,
        expectedContent,
        actualContent,
        diff: diffResult.diff,
      };
    }

    return { hasConflict: false };
  }

  // ============ Lock Management ============

  /**
   * Acquire a lock on a file.
   * Returns { acquired: true, lock } on success.
   * Returns { acquired: false, holder, expiresAt } if locked by another editor.
   */
  async acquireLock(
    filePath: string,
    editor: string,
    options?: AcquireLockOptions
  ): Promise<LockResult> {
    this.ensureInitialized();

    const timeoutSeconds = options?.timeoutSeconds;
    const result = timeoutSeconds
      ? ffi.lockAcquireWithTimeout(this.sessionPath, filePath, editor, timeoutSeconds)
      : ffi.lockAcquire(this.sessionPath, filePath, editor);

    if (result.acquired) {
      return {
        acquired: true,
        lock: {
          filePath,
          editor,
          acquiredAt: Math.floor(Date.now() / 1000), // Approximate, actual is in Zig
          expiresAt: result.expiresAt,
        },
      };
    }

    return {
      acquired: false,
      holder: result.holder ?? "unknown",
      expiresAt: result.expiresAt,
    };
  }

  /**
   * Release a lock on a file.
   * Returns true if lock was released, false if not held by this editor.
   */
  async releaseLock(filePath: string, editor: string): Promise<boolean> {
    this.ensureInitialized();
    return ffi.lockRelease(this.sessionPath, filePath, editor);
  }

  /**
   * Check if a file is locked.
   * Returns lock info if locked, null if not locked.
   */
  async isLocked(filePath: string): Promise<FileLock | null> {
    this.ensureInitialized();
    const info = ffi.lockIsLocked(this.sessionPath, filePath);

    if (!info.isLocked) {
      return null;
    }

    return {
      filePath,
      editor: info.agentId ?? "unknown",
      acquiredAt: info.acquiredAt,
      expiresAt: info.expiresAt,
    };
  }

  /**
   * Close the session
   */
  async close(): Promise<void> {
    // Save any pending state
    await this.saveMetadata();
    await this.saveFileStates();
  }

  /**
   * Delete the session and all its data
   */
  async delete(): Promise<void> {
    await rm(this.sessionPath, { recursive: true, force: true });
  }

  // ============ Private Methods ============

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new FunError(ErrorCode.InvalidArgument, "Session not initialized");
    }
  }

  private computeHash(content: string): string {
    const data = new TextEncoder().encode(content);
    const hash = ffi.hash(data);
    return ffi.hashToHex(hash);
  }

  private async storeOriginal(content: string, hash: string): Promise<void> {
    const dir = join(this.sessionPath, "originals", hash.slice(0, 2));
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${hash.slice(2)}.bin`);
    await writeFile(path, content, "utf-8");
  }

  private async getOriginal(hash: string): Promise<string> {
    const path = join(
      this.sessionPath,
      "originals",
      hash.slice(0, 2),
      `${hash.slice(2)}.bin`
    );
    return readFile(path, "utf-8");
  }

  private async storePatch(diff: string, version: VersionNum): Promise<void> {
    const filename = `${String(version).padStart(4, "0")}.diff`;
    const path = join(this.sessionPath, "patches", filename);
    await writeFile(path, diff, "utf-8");
  }

  private async getPatch(version: VersionNum): Promise<string> {
    const filename = `${String(version).padStart(4, "0")}.diff`;
    const path = join(this.sessionPath, "patches", filename);
    return readFile(path, "utf-8");
  }

  private async storeVersionMeta(
    version: VersionNum,
    meta: Version
  ): Promise<void> {
    const filename = `${String(version).padStart(4, "0")}.json`;
    const path = join(this.sessionPath, "versions", filename);
    await writeFile(path, JSON.stringify(meta, null, 2), "utf-8");
  }

  private async loadVersionMeta(version: VersionNum): Promise<Version> {
    const filename = `${String(version).padStart(4, "0")}.json`;
    const path = join(this.sessionPath, "versions", filename);
    const json = await readFile(path, "utf-8");
    const meta = JSON.parse(json);
    
    // Backward compatibility: map agentId to editor
    if (meta.agentId && !meta.editor) {
      meta.editor = meta.agentId;
      delete meta.agentId;
    }
    
    return meta;
  }

  private async saveMetadata(): Promise<void> {
    const meta = {
      id: this.id,
      project_path: this.projectPath,
      created_at: Date.now(),
      current_version: this.currentVersion,
    };

    const path = join(this.sessionPath, "manifest.json");
    await writeFile(path, JSON.stringify(meta, null, 2), "utf-8");
  }

  private async saveFileStates(): Promise<void> {
    const states = Array.from(this.fileStates.values()).map((s) => ({
      path: s.path,
      original_hash: s.originalHash,
      current_hash: s.currentHash,
      last_version: s.lastVersion,
      existed_before: s.existedBefore,
    }));

    const path = join(this.sessionPath, "files.json");
    await writeFile(path, JSON.stringify(states, null, 2), "utf-8");
  }

  private async loadFileStates(): Promise<void> {
    try {
      const path = join(this.sessionPath, "files.json");
      const json = await readFile(path, "utf-8");
      const states = JSON.parse(json);

      for (const s of states) {
        this.fileStates.set(s.path, {
          path: s.path,
          originalHash: s.original_hash,
          currentHash: s.current_hash,
          lastVersion: s.last_version,
          existedBefore: s.existed_before,
        });
      }
    } catch {
      // No file states yet
    }
  }
}

// Convenience exports
export const createSession = Session.create.bind(Session);
export const loadSession = Session.load.bind(Session);
export const loadOrCreateSession = Session.loadOrCreate.bind(Session);
