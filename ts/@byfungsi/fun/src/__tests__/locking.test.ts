/**
 * Locking integration tests
 * 
 * Tests file locking for multi-editor coordination.
 * Note: Locking is advisory - trackChange() does NOT automatically reject
 * writes to locked files. Editors must check acquireLock() before writing.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { Session } from "../session";
import { createTestSession, createTempProject, cleanupTempProject } from "./helpers";

describe("Lock Acquisition", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("acquireLock() returns { acquired: true } when file unlocked", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const lockResult = await result.session.acquireLock("src/main.ts", "editor-1");

    expect(lockResult.acquired).toBe(true);
    if (lockResult.acquired) {
      expect(lockResult.lock.filePath).toBe("src/main.ts");
      expect(lockResult.lock.editor).toBe("editor-1");
      expect(lockResult.lock.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    }
  });

  it("acquireLock() same editor can re-acquire (extend)", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const lock1 = await result.session.acquireLock("src/main.ts", "editor-1");
    expect(lock1.acquired).toBe(true);

    // Same editor acquires again - should succeed (extend)
    const lock2 = await result.session.acquireLock("src/main.ts", "editor-1");
    expect(lock2.acquired).toBe(true);
  });

  it("acquireLock() different editor gets { acquired: false, holder }", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    // Editor 1 acquires lock
    const lock1 = await result.session.acquireLock("src/main.ts", "editor-1");
    expect(lock1.acquired).toBe(true);

    // Editor 2 tries to acquire - should fail
    const lock2 = await result.session.acquireLock("src/main.ts", "editor-2");
    expect(lock2.acquired).toBe(false);
    if (!lock2.acquired) {
      expect(lock2.holder).toBe("editor-1");
      expect(lock2.expiresAt).toBeGreaterThan(0);
    }
  });

  it("acquireLock() with custom timeout sets expiry correctly", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const now = Math.floor(Date.now() / 1000);
    const lockResult = await result.session.acquireLock("src/main.ts", "editor-1", {
      timeoutSeconds: 60,
    });

    expect(lockResult.acquired).toBe(true);
    if (lockResult.acquired) {
      // Expiry should be approximately 60 seconds from now
      expect(lockResult.lock.expiresAt).toBeGreaterThanOrEqual(now + 59);
      expect(lockResult.lock.expiresAt).toBeLessThanOrEqual(now + 61);
    }
  });
});

describe("Lock Release", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("releaseLock() returns true when held by editor", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    await result.session.acquireLock("src/main.ts", "editor-1");

    const released = await result.session.releaseLock("src/main.ts", "editor-1");
    expect(released).toBe(true);
  });

  it("releaseLock() returns false when not held by this editor", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    // Editor 1 acquires lock
    await result.session.acquireLock("src/main.ts", "editor-1");

    // Editor 2 tries to release - should fail
    const released = await result.session.releaseLock("src/main.ts", "editor-2");
    expect(released).toBe(false);
  });

  it("releaseLock() allows other editor to acquire after", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    // Editor 1 acquires and releases
    await result.session.acquireLock("src/main.ts", "editor-1");
    await result.session.releaseLock("src/main.ts", "editor-1");

    // Editor 2 should now be able to acquire
    const lock2 = await result.session.acquireLock("src/main.ts", "editor-2");
    expect(lock2.acquired).toBe(true);
    if (lock2.acquired) {
      expect(lock2.lock.editor).toBe("editor-2");
    }
  });
});

describe("Lock Status", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("isLocked() returns null when unlocked", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    const lockInfo = await result.session.isLocked("src/main.ts");
    expect(lockInfo).toBeNull();
  });

  it("isLocked() returns FileLock info when locked", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    await result.session.acquireLock("src/main.ts", "editor-1");

    const lockInfo = await result.session.isLocked("src/main.ts");
    expect(lockInfo).not.toBeNull();
    expect(lockInfo?.filePath).toBe("src/main.ts");
    expect(lockInfo?.editor).toBe("editor-1");
    expect(lockInfo?.expiresAt).toBeGreaterThan(0);
  });
});

describe("Lock + TrackChange Integration", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("Editor A locks file, Editor B cannot acquire lock", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    // Editor A acquires lock
    const lockA = await result.session.acquireLock("shared.ts", "editor-A");
    expect(lockA.acquired).toBe(true);

    // Editor B tries to acquire - blocked
    const lockB = await result.session.acquireLock("shared.ts", "editor-B");
    expect(lockB.acquired).toBe(false);
    if (!lockB.acquired) {
      expect(lockB.holder).toBe("editor-A");
    }
  });

  it("Editor A locks file, both can check isLocked()", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    await result.session.acquireLock("shared.ts", "editor-A");

    // Both editors can check lock status
    const lockInfo = await result.session.isLocked("shared.ts");
    expect(lockInfo).not.toBeNull();
    expect(lockInfo?.editor).toBe("editor-A");
  });

  it("Editor A releases lock, Editor B can acquire", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    // Editor A locks and releases
    await result.session.acquireLock("shared.ts", "editor-A");
    await result.session.releaseLock("shared.ts", "editor-A");

    // Editor B can now acquire
    const lockB = await result.session.acquireLock("shared.ts", "editor-B");
    expect(lockB.acquired).toBe(true);
  });

  it("Lock persists across session reload", async () => {
    const projectPath = await createTempProject();
    cleanup = () => cleanupTempProject(projectPath);

    // Create session 1, acquire lock
    const session1 = await Session.create(projectPath);
    await session1.acquireLock("shared.ts", "editor-A");
    const sessionId = session1.id;
    await session1.close();

    // Load session 2, check lock persists
    const session2 = await Session.load(sessionId);

    // Check lock is still visible
    const lockInfo = await session2.isLocked("shared.ts");
    expect(lockInfo).not.toBeNull();
    expect(lockInfo?.editor).toBe("editor-A");

    // Different editor still cannot acquire
    const lockB = await session2.acquireLock("shared.ts", "editor-B");
    expect(lockB.acquired).toBe(false);

    await session2.delete();
  });

  it("Advisory locking pattern: check lock before tracking", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    // Editor A acquires lock
    const lockA = await result.session.acquireLock("shared.ts", "editor-A");
    expect(lockA.acquired).toBe(true);

    // Editor B checks if locked before tracking
    const lockCheck = await result.session.isLocked("shared.ts");
    if (lockCheck && lockCheck.editor !== "editor-B") {
      // Editor B knows it shouldn't track changes
      expect(lockCheck.editor).toBe("editor-A");
    }

    // Editor A can track changes
    const version = await result.session.trackChange({
      filePath: "shared.ts",
      beforeContent: "const x = 1;",
      afterContent: "const x = 2;",
      editor: "editor-A",
    });
    expect(version.num).toBe(1);

    // Release lock
    await result.session.releaseLock("shared.ts", "editor-A");

    // Now Editor B can acquire and track
    const lockB = await result.session.acquireLock("shared.ts", "editor-B");
    expect(lockB.acquired).toBe(true);

    const versionB = await result.session.trackChange({
      filePath: "shared.ts",
      beforeContent: "const x = 2;",
      afterContent: "const x = 3;",
      editor: "editor-B",
    });
    expect(versionB.num).toBe(2);
    expect(versionB.editor).toBe("editor-B");
  });
});

describe("Multi-Editor Scenarios", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("Two editors working on different files (no conflict)", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    // Editor A locks file1
    const lockA = await result.session.acquireLock("file1.ts", "editor-A");
    expect(lockA.acquired).toBe(true);

    // Editor B locks file2 - no conflict
    const lockB = await result.session.acquireLock("file2.ts", "editor-B");
    expect(lockB.acquired).toBe(true);

    // Both can track changes to their respective files
    const versionA = await result.session.trackChange({
      filePath: "file1.ts",
      beforeContent: "a",
      afterContent: "b",
      editor: "editor-A",
    });

    const versionB = await result.session.trackChange({
      filePath: "file2.ts",
      beforeContent: "x",
      afterContent: "y",
      editor: "editor-B",
    });

    expect(versionA.editor).toBe("editor-A");
    expect(versionB.editor).toBe("editor-B");
  });

  it("Sequential editing after lock release", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    // Editor A makes changes
    await result.session.acquireLock("shared.ts", "editor-A");
    await result.session.trackChange({
      filePath: "shared.ts",
      beforeContent: "v1",
      afterContent: "v2",
      editor: "editor-A",
    });
    await result.session.releaseLock("shared.ts", "editor-A");

    // Editor B takes over
    await result.session.acquireLock("shared.ts", "editor-B");
    await result.session.trackChange({
      filePath: "shared.ts",
      beforeContent: "v2",
      afterContent: "v3",
      editor: "editor-B",
    });
    await result.session.releaseLock("shared.ts", "editor-B");

    // History shows both editors
    const history = await result.session.getHistory();
    expect(history.length).toBe(2);
    expect(history[0].editor).toBe("editor-B");
    expect(history[1].editor).toBe("editor-A");
  });

  it("Multiple files locked by same editor", async () => {
    const result = await createTestSession();
    cleanup = result.cleanup;

    // Editor A locks multiple files
    const lock1 = await result.session.acquireLock("file1.ts", "editor-A");
    const lock2 = await result.session.acquireLock("file2.ts", "editor-A");
    const lock3 = await result.session.acquireLock("file3.ts", "editor-A");

    expect(lock1.acquired).toBe(true);
    expect(lock2.acquired).toBe(true);
    expect(lock3.acquired).toBe(true);

    // Editor B cannot acquire any of them
    const lockB1 = await result.session.acquireLock("file1.ts", "editor-B");
    const lockB2 = await result.session.acquireLock("file2.ts", "editor-B");

    expect(lockB1.acquired).toBe(false);
    expect(lockB2.acquired).toBe(false);
  });
});
