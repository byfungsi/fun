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

    const { filePath, beforeContent, afterContent, agentId, message, metadata } = opts;

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
        agentId,
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
      agentId,
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
  async getHistory(limit?: number): Promise<Version[]> {
    const max = limit ?? this.currentVersion;
    const versions: Version[] = [];

    for (
      let v = this.currentVersion;
      v > 0 && versions.length < max;
      v--
    ) {
      try {
        const meta = await this.loadVersionMeta(v);
        versions.push(meta);
      } catch {
        // Skip if version metadata is missing
      }
    }

    return versions;
  }

  /**
   * Pre-check for conflicts before editing
   */
  async preCheck(
    filePath: string,
    _agentId: string
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
   * Returns { acquired: false, holder, expiresAt } if locked by another agent.
   */
  async acquireLock(
    filePath: string,
    agentId: string,
    options?: AcquireLockOptions
  ): Promise<LockResult> {
    this.ensureInitialized();

    const timeoutSeconds = options?.timeoutSeconds;
    const result = timeoutSeconds
      ? ffi.lockAcquireWithTimeout(this.sessionPath, filePath, agentId, timeoutSeconds)
      : ffi.lockAcquire(this.sessionPath, filePath, agentId);

    if (result.acquired) {
      return {
        acquired: true,
        lock: {
          filePath,
          agentId,
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
   * Returns true if lock was released, false if not held by this agent.
   */
  async releaseLock(filePath: string, agentId: string): Promise<boolean> {
    this.ensureInitialized();
    return ffi.lockRelease(this.sessionPath, filePath, agentId);
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
      agentId: info.agentId ?? "unknown",
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
    return JSON.parse(json);
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
