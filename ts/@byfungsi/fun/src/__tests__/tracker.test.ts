/**
 * FileTracker wrapper integration tests
 */

import { describe, it, expect, afterEach } from "bun:test";
import { FileTracker } from "../tracker";
import { createTestSession, writeTestFile, readTestFile } from "./helpers";

describe("FileTracker Basic Operations", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("track() calls session.trackChange with correct editor", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const tracker = new FileTracker(result.session, "my-agent");

    const version = await tracker.track("test.txt", "before\n", "after\n", {
      message: "Test change",
    });

    expect(version.editor).toBe("my-agent");
    expect(version.filePath).toBe("test.txt");
    expect(version.message).toBe("Test change");
  });

  it("track() with metadata stores it", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const tracker = new FileTracker(result.session, "my-agent");

    const version = await tracker.track("test.txt", "a", "b", {
      message: "Change",
      metadata: { toolCallId: "call_123" },
    });

    expect(version.metadata?.toolCallId).toBe("call_123");
  });

  it("revert() reverts to version 0", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const tracker = new FileTracker(result.session, "my-agent");

    await tracker.track("test.txt", "original\n", "modified\n");

    await tracker.revert("test.txt");

    const content = await readTestFile(result.projectPath, "test.txt");
    expect(content).toBe("original\n");
  });

  it("revertToVersion() reverts to specific version", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const tracker = new FileTracker(result.session, "my-agent");

    await tracker.track("test.txt", "v0\n", "v1\n");
    await tracker.track("test.txt", "v1\n", "v2\n");
    await tracker.track("test.txt", "v2\n", "v3\n");

    await tracker.revertToVersion("test.txt", 2);

    const content = await readTestFile(result.projectPath, "test.txt");
    expect(content).toBe("v2\n");
  });

  it("cleanup() closes session", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const tracker = new FileTracker(result.session, "my-agent");

    await tracker.track("test.txt", "a", "b");

    // Should not throw
    await tracker.cleanup();
  });
});

describe("FileTracker History (Editor Scoped)", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("getHistory() filters by this editor", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const trackerA = new FileTracker(result.session, "agent-A");
    const trackerB = new FileTracker(result.session, "agent-B");

    await trackerA.track("test.txt", "a", "b");
    await trackerB.track("test.txt", "b", "c");
    await trackerA.track("test.txt", "c", "d");

    const historyA = await trackerA.getHistory();
    const historyB = await trackerB.getHistory();

    expect(historyA.length).toBe(2);
    expect(historyA.every((v) => v.editor === "agent-A")).toBe(true);

    expect(historyB.length).toBe(1);
    expect(historyB[0].editor).toBe("agent-B");
  });

  it("getHistoryByMetadata() filters by editor AND metadata", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const trackerA = new FileTracker(result.session, "agent-A");
    const trackerB = new FileTracker(result.session, "agent-B");

    await trackerA.track("test.txt", "a", "b", {
      metadata: { type: "edit" },
    });
    await trackerB.track("test.txt", "b", "c", {
      metadata: { type: "edit" },
    });
    await trackerA.track("test.txt", "c", "d", {
      metadata: { type: "refactor" },
    });

    // Agent A's edit-type changes only
    const edits = await trackerA.getHistoryByMetadata({ type: "edit" });
    expect(edits.length).toBe(1);
    expect(edits[0].editor).toBe("agent-A");
    expect(edits[0].metadata?.type).toBe("edit");
  });

  it("getFileTimeline() returns all editors' changes", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const trackerA = new FileTracker(result.session, "agent-A");
    const trackerB = new FileTracker(result.session, "agent-B");

    await trackerA.track("test.txt", "a\n", "b\n");
    await trackerB.track("test.txt", "b\n", "c\n");

    // FileTimeline shows all editors
    const timeline = await trackerA.getFileTimeline("test.txt");

    expect(timeline.length).toBe(2);
    const editors = timeline.map((t) => t.editor);
    expect(editors).toContain("agent-A");
    expect(editors).toContain("agent-B");
  });

  it("getContentAtVersion() returns correct content", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const tracker = new FileTracker(result.session, "my-agent");

    await tracker.track("test.txt", "v0\n", "v1\n");
    await tracker.track("test.txt", "v1\n", "v2\n");

    const content = await tracker.getContentAtVersion("test.txt", 1);
    expect(content).toBe("v1\n");
  });

  it("getDiff() returns diff for version", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const tracker = new FileTracker(result.session, "my-agent");

    await tracker.track("test.txt", "hello\n", "hello world\n");

    const diff = await tracker.getDiff(1);
    expect(diff).toContain("-hello");
    expect(diff).toContain("+hello world");
  });
});

describe("FileTracker Lock Wrapper", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("lock() uses tracker's editor", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const tracker = new FileTracker(result.session, "my-agent");

    const lockResult = await tracker.lock("test.txt");

    expect(lockResult.acquired).toBe(true);
    if (lockResult.acquired) {
      expect(lockResult.lock.editor).toBe("my-agent");
    }
  });

  it("unlock() uses tracker's editor", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const tracker = new FileTracker(result.session, "my-agent");

    await tracker.lock("test.txt");
    const released = await tracker.unlock("test.txt");

    expect(released).toBe(true);
  });

  it("isLocked() delegates to session", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const trackerA = new FileTracker(result.session, "agent-A");
    const trackerB = new FileTracker(result.session, "agent-B");

    await trackerA.lock("test.txt");

    const lockInfo = await trackerB.isLocked("test.txt");
    expect(lockInfo).not.toBeNull();
    expect(lockInfo?.editor).toBe("agent-A");
  });

  it("lock() with custom timeout", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const tracker = new FileTracker(result.session, "my-agent");
    const now = Math.floor(Date.now() / 1000);

    const lockResult = await tracker.lock("test.txt", { timeoutSeconds: 30 });

    expect(lockResult.acquired).toBe(true);
    if (lockResult.acquired) {
      expect(lockResult.lock.expiresAt).toBeGreaterThanOrEqual(now + 29);
      expect(lockResult.lock.expiresAt).toBeLessThanOrEqual(now + 31);
    }
  });

  it("two trackers cannot lock same file", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const trackerA = new FileTracker(result.session, "agent-A");
    const trackerB = new FileTracker(result.session, "agent-B");

    const lockA = await trackerA.lock("shared.txt");
    expect(lockA.acquired).toBe(true);

    const lockB = await trackerB.lock("shared.txt");
    expect(lockB.acquired).toBe(false);
    if (!lockB.acquired) {
      expect(lockB.holder).toBe("agent-A");
    }
  });
});

describe("FileTracker Sync & Surgical Revert", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("sync() delegates to session", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const tracker = new FileTracker(result.session, "my-agent");

    const content = "content\n";
    await writeTestFile(result.projectPath, "test.txt", content);
    await tracker.track("test.txt", "placeholder\n", content);

    // Modify externally
    await writeTestFile(result.projectPath, "test.txt", "modified\n");

    const syncResult = await tracker.sync();

    expect(syncResult.externalChanges).toBe(1);
  });

  it("canRevertVersion() delegates to session", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const tracker = new FileTracker(result.session, "my-agent");

    await writeTestFile(result.projectPath, "test.txt", "before\n");
    await tracker.track("test.txt", "before\n", "after\n");
    await writeTestFile(result.projectPath, "test.txt", "after\n");

    const canRevert = await tracker.canRevertVersion(1);
    expect(canRevert.canRevert).toBe(true);
  });

  it("revertVersion() delegates to session", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const tracker = new FileTracker(result.session, "my-agent");

    await writeTestFile(result.projectPath, "test.txt", "before\n");
    await tracker.track("test.txt", "before\n", "after\n");
    await writeTestFile(result.projectPath, "test.txt", "after\n");

    const revertResult = await tracker.revertVersion(1);

    expect(revertResult.success).toBe(true);

    const content = await readTestFile(result.projectPath, "test.txt");
    expect(content).toBe("before\n");
  });
});
