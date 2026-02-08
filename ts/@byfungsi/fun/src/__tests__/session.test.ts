/**
 * Session integration tests
 */

import { describe, it, expect, afterEach } from "bun:test";
import { Session, loadOrCreateSession } from "../session";
import { FunError, ErrorCode } from "../types";
import {
  createTestSession,
  writeTestFile,
  readTestFile,
  fileExists,
  cleanupTempProject,
  createTempProject,
} from "./helpers";

describe("Session Lifecycle", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("create() creates new session with proper structure", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    expect(result.session.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(result.session.projectPath).toBe(result.projectPath);

    const status = await result.session.getStatus();
    expect(status.currentVersion).toBe(0);
    expect(status.files).toEqual([]);
    expect(status.hasUndo).toBe(false);
  });

  it("load() loads existing session", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    // Track a change so we have state to verify (use non-empty beforeContent)
    await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "placeholder\n",
      afterContent: "hello\n",
      editor: "test-editor",
      message: "Initial",
    });

    // Load the session by ID
    const loaded = await Session.load(result.session.id);

    expect(loaded.id).toBe(result.session.id);
    expect(loaded.projectPath).toBe(result.projectPath);

    const status = await loaded.getStatus();
    expect(status.currentVersion).toBe(1);
  });

  it("load() throws for non-existent session", async () => {
    try {
      await Session.load("00000000-0000-0000-0000-000000000000");
      expect(true).toBe(false); // Should not reach here
    } catch (e) {
      expect(e).toBeInstanceOf(FunError);
      expect((e as FunError).code).toBe(ErrorCode.SessionNotFound);
    }
  });

  it("loadOrCreate() finds existing session for same projectPath", async () => {
    const projectPath = await createTempProject();
    cleanup = () => cleanupTempProject(projectPath);

    const session1 = await loadOrCreateSession(projectPath);
    const session2 = await loadOrCreateSession(projectPath);

    expect(session2.id).toBe(session1.id);

    await session1.delete();
  });

  it("loadOrCreate() creates new session when none exists", async () => {
    const projectPath = await createTempProject();
    cleanup = () => cleanupTempProject(projectPath);

    const session = await loadOrCreateSession(projectPath);

    expect(session.id).toBeDefined();
    expect(session.projectPath).toBe(projectPath);

    await session.delete();
  });

  it("delete() removes all session data", async () => {
    const result = await createTestSession();
    const sessionId = result.session.id;

    await result.session.delete();
    cleanup = () => cleanupTempProject(result.projectPath);

    // Should not be loadable after delete
    try {
      await Session.load(sessionId);
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(FunError);
      expect((e as FunError).code).toBe(ErrorCode.SessionNotFound);
    }
  });

  it("close() saves pending state", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "placeholder\n",
      afterContent: "content\n",
      editor: "editor",
    });

    await result.session.close();

    // Reload and verify state was saved
    const reloaded = await Session.load(result.session.id);
    const status = await reloaded.getStatus();
    expect(status.currentVersion).toBe(1);
  });
});

describe("Track Changes", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("trackChange() creates version with correct metadata", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const version = await result.session.trackChange({
      filePath: "src/main.ts",
      beforeContent: "const x = 1;",
      afterContent: "const x = 2;",
      editor: "test-agent",
      message: "Update x value",
    });

    expect(version.num).toBe(1);
    expect(version.filePath).toBe("src/main.ts");
    expect(version.editor).toBe("test-agent");
    expect(version.message).toBe("Update x value");
    expect(version.additions).toBe(1);
    expect(version.deletions).toBe(1);
    expect(version.timestamp).toBeGreaterThan(0);
    expect(version.parentVersion).toBeNull();
  });

  it("trackChange() increments version number", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const v1 = await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "a",
      afterContent: "b",
      editor: "editor",
    });

    const v2 = await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "b",
      afterContent: "c",
      editor: "editor",
    });

    expect(v1.num).toBe(1);
    expect(v2.num).toBe(2);
    expect(v2.parentVersion).toBe(1);
  });

  it("trackChange() with empty change returns same version (no-op)", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const version = await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "same content",
      afterContent: "same content",
      editor: "editor",
    });

    expect(version.additions).toBe(0);
    expect(version.deletions).toBe(0);

    const status = await result.session.getStatus();
    expect(status.currentVersion).toBe(0); // No version created
  });

  it("trackChange() with custom metadata stores it", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const version = await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "before",
      afterContent: "after",
      editor: "editor",
      metadata: {
        toolCallId: "call_123",
        model: "gpt-4",
        tokens: 150,
      },
    });

    expect(version.metadata).toEqual({
      toolCallId: "call_123",
      model: "gpt-4",
      tokens: 150,
    });

    // Verify it persists
    const history = await result.session.getHistory();
    expect(history[0].metadata).toEqual({
      toolCallId: "call_123",
      model: "gpt-4",
      tokens: 150,
    });
  });

  it("trackChange() from empty file (new file)", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const version = await result.session.trackChange({
      filePath: "new-file.txt",
      beforeContent: "",
      afterContent: "new content\nline 2\n",
      editor: "editor",
    });

    expect(version.additions).toBe(2);
    expect(version.deletions).toBe(0);

    const status = await result.session.getStatus();
    expect(status.currentVersion).toBe(1);
    expect(status.files.length).toBe(1);
    expect(status.files[0].existedBefore).toBe(false);
  });

  it("trackChange() adding lines to file", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const version = await result.session.trackChange({
      filePath: "file.txt",
      beforeContent: "line1\n",
      afterContent: "line1\nline2\nline3\n",
      editor: "editor",
    });

    expect(version.additions).toBe(2);
    expect(version.deletions).toBe(0);
  });

  it("trackChange() to empty file (file deletion)", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const version = await result.session.trackChange({
      filePath: "file.txt",
      beforeContent: "content\nline 2\n",
      afterContent: "",
      editor: "editor",
    });

    expect(version.additions).toBe(0);
    expect(version.deletions).toBe(2);
  });

  it("trackChange() removing lines from file", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const version = await result.session.trackChange({
      filePath: "file.txt",
      beforeContent: "line1\nline2\nline3\n",
      afterContent: "line1\n",
      editor: "editor",
    });

    expect(version.additions).toBe(0);
    expect(version.deletions).toBe(2);
  });
});

describe("Revert Operations", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("revertFile() to version 0 restores original content", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const originalContent = "original content\n";
    await writeTestFile(result.projectPath, "test.txt", originalContent);

    // Track changes
    await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: originalContent,
      afterContent: "modified content\n",
      editor: "editor",
    });

    // Revert to original
    await result.session.revertFile("test.txt", 0);

    const content = await readTestFile(result.projectPath, "test.txt");
    expect(content).toBe(originalContent);
  });

  it("revertFile() to specific version applies patches correctly", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    // Create a sequence of changes
    await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "v0\n",
      afterContent: "v1\n",
      editor: "editor",
    });

    await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "v1\n",
      afterContent: "v2\n",
      editor: "editor",
    });

    await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "v2\n",
      afterContent: "v3\n",
      editor: "editor",
    });

    // Revert to version 2
    await result.session.revertFile("test.txt", 2);

    const content = await readTestFile(result.projectPath, "test.txt");
    expect(content).toBe("v2\n");
  });

  it("revertFile() for newly created file (from empty) deletes the file", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    // Track creation of new file (empty beforeContent)
    await result.session.trackChange({
      filePath: "new-file.txt",
      beforeContent: "",
      afterContent: "new content\n",
      editor: "editor",
    });

    // Write the file
    await writeTestFile(result.projectPath, "new-file.txt", "new content\n");
    expect(await fileExists(result.projectPath, "new-file.txt")).toBe(true);

    // Revert to version 0 (before file existed)
    await result.session.revertFile("new-file.txt", 0);

    // File should be deleted since it didn't exist before
    expect(await fileExists(result.projectPath, "new-file.txt")).toBe(false);
  });

  it("revertAll() reverts all tracked files", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    // Track changes to multiple files
    await result.session.trackChange({
      filePath: "file1.txt",
      beforeContent: "original1\n",
      afterContent: "modified1\n",
      editor: "editor",
    });

    await result.session.trackChange({
      filePath: "file2.txt",
      beforeContent: "original2\n",
      afterContent: "modified2\n",
      editor: "editor",
    });

    // Revert all
    await result.session.revertAll();

    const content1 = await readTestFile(result.projectPath, "file1.txt");
    const content2 = await readTestFile(result.projectPath, "file2.txt");

    expect(content1).toBe("original1\n");
    expect(content2).toBe("original2\n");
  });
});

describe("Content & History", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("getContentAtVersion() returns correct content", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "v0\n",
      afterContent: "v1\n",
      editor: "editor",
    });

    await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "v1\n",
      afterContent: "v2\n",
      editor: "editor",
    });

    const contentV1 = await result.session.getContentAtVersion("test.txt", 1);
    const contentV2 = await result.session.getContentAtVersion("test.txt", 2);

    expect(contentV1).toBe("v1\n");
    expect(contentV2).toBe("v2\n");
  });

  it("getContentAtVersion() works for newly created files", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    // Create a new file (empty beforeContent)
    await result.session.trackChange({
      filePath: "new-file.txt",
      beforeContent: "",
      afterContent: "initial content\n",
      editor: "editor",
    });

    // Modify the file
    await result.session.trackChange({
      filePath: "new-file.txt",
      beforeContent: "initial content\n",
      afterContent: "modified content\n",
      editor: "editor",
    });

    const contentV1 = await result.session.getContentAtVersion("new-file.txt", 1);
    const contentV2 = await result.session.getContentAtVersion("new-file.txt", 2);

    expect(contentV1).toBe("initial content\n");
    expect(contentV2).toBe("modified content\n");
  });

  it("getHistory() returns versions in reverse order", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "a",
      afterContent: "b",
      editor: "editor",
      message: "First",
    });

    await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "b",
      afterContent: "c",
      editor: "editor",
      message: "Second",
    });

    const history = await result.session.getHistory();

    expect(history.length).toBe(2);
    expect(history[0].message).toBe("Second"); // Most recent first
    expect(history[1].message).toBe("First");
  });

  it("getHistory({ limit }) limits results", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    // Create 5 versions
    for (let i = 1; i <= 5; i++) {
      await result.session.trackChange({
        filePath: "test.txt",
        beforeContent: `v${i - 1}`,
        afterContent: `v${i}`,
        editor: "editor",
      });
    }

    const history = await result.session.getHistory({ limit: 3 });
    expect(history.length).toBe(3);
    expect(history[0].num).toBe(5);
    expect(history[2].num).toBe(3);
  });

  it("getHistory({ editor }) filters by editor", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "a",
      afterContent: "b",
      editor: "alice",
    });

    await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "b",
      afterContent: "c",
      editor: "bob",
    });

    await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "c",
      afterContent: "d",
      editor: "alice",
    });

    const aliceHistory = await result.session.getHistory({ editor: "alice" });
    expect(aliceHistory.length).toBe(2);
    expect(aliceHistory.every((v) => v.editor === "alice")).toBe(true);

    const bobHistory = await result.session.getHistory({ editor: "bob" });
    expect(bobHistory.length).toBe(1);
    expect(bobHistory[0].editor).toBe("bob");
  });

  it("getFileHistory() returns only versions for that file", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    await result.session.trackChange({
      filePath: "file1.txt",
      beforeContent: "a",
      afterContent: "b",
      editor: "editor",
    });

    await result.session.trackChange({
      filePath: "file2.txt",
      beforeContent: "x",
      afterContent: "y",
      editor: "editor",
    });

    await result.session.trackChange({
      filePath: "file1.txt",
      beforeContent: "b",
      afterContent: "c",
      editor: "editor",
    });

    const file1History = await result.session.getFileHistory("file1.txt");
    expect(file1History.length).toBe(2);
    expect(file1History.every((v) => v.filePath === "file1.txt")).toBe(true);
  });

  it("getFileTimeline() includes content at each version", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "original\n",
      afterContent: "modified\n",
      editor: "editor",
      message: "First change",
    });

    await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "modified\n",
      afterContent: "final\n",
      editor: "editor",
      message: "Second change",
    });

    const timeline = await result.session.getFileTimeline("test.txt");

    expect(timeline.length).toBe(2);
    expect(timeline[0].content).toBe("modified\n");
    expect(timeline[0].message).toBe("First change");
    expect(timeline[1].content).toBe("final\n");
    expect(timeline[1].message).toBe("Second change");
    expect(timeline[0].diff).toContain("-original");
    expect(timeline[0].diff).toContain("+modified");
  });

  it("getDiff() returns unified diff for version", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "hello\n",
      afterContent: "hello world\n",
      editor: "editor",
    });

    const diff = await result.session.getDiff(1);

    expect(diff).toContain("-hello");
    expect(diff).toContain("+hello world");
  });

  it("getHistoryByMetadata() filters by metadata fields", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "a",
      afterContent: "b",
      editor: "editor",
      metadata: { toolCallId: "call_1", type: "edit" },
    });

    await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "b",
      afterContent: "c",
      editor: "editor",
      metadata: { toolCallId: "call_2", type: "refactor" },
    });

    await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "c",
      afterContent: "d",
      editor: "editor",
      metadata: { toolCallId: "call_3", type: "edit" },
    });

    const editVersions = await result.session.getHistoryByMetadata({
      type: "edit",
    });

    expect(editVersions.length).toBe(2);
    expect(editVersions.every((v) => v.metadata?.type === "edit")).toBe(true);
  });
});

describe("Pruning", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("prune() deletes old versions and renumbers", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    // Create 5 versions
    for (let i = 1; i <= 5; i++) {
      await result.session.trackChange({
        filePath: "test.txt",
        beforeContent: `v${i - 1}\n`,
        afterContent: `v${i}\n`,
        editor: "editor",
        message: `Change ${i}`,
      });
    }

    // Prune to keep last 2 versions
    const pruneResult = await result.session.prune(2);

    expect(pruneResult.deletedVersions).toBe(3);
    expect(pruneResult.newCurrentVersion).toBe(2);
    expect(pruneResult.freedBytes).toBeGreaterThan(0);

    // Verify history only has 2 versions
    const history = await result.session.getHistory();
    expect(history.length).toBe(2);
    expect(history[0].num).toBe(2);
    expect(history[1].num).toBe(1);
  });

  it("prune() with keepVersions >= currentVersion is no-op", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    await result.session.trackChange({
      filePath: "test.txt",
      beforeContent: "a",
      afterContent: "b",
      editor: "editor",
    });

    const pruneResult = await result.session.prune(10);

    expect(pruneResult.deletedVersions).toBe(0);
    expect(pruneResult.freedBytes).toBe(0);
    expect(pruneResult.newCurrentVersion).toBe(1);
  });
});
