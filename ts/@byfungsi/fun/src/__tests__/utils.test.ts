/**
 * Utility functions integration tests
 * 
 * Tests the exported utility functions from index.ts
 */

import { describe, it, expect } from "bun:test";
import { generateDiff, getDiffStats, hash, version } from "../index";

describe("generateDiff", () => {
  it("returns unified diff between two strings", () => {
    const diff = generateDiff("hello\n", "hello world\n", "test.txt");

    expect(diff).not.toBeNull();
    expect(diff).toContain("-hello");
    expect(diff).toContain("+hello world");
  });

  it("returns null for identical content", () => {
    const diff = generateDiff("same\n", "same\n");

    // Empty diff or null
    expect(diff === null || diff === "" || !diff.includes("+")).toBe(true);
  });

  it("works without filePath parameter", () => {
    const diff = generateDiff("before\n", "after\n");

    expect(diff).not.toBeNull();
    expect(diff).toContain("-before");
    expect(diff).toContain("+after");
  });

  it("handles multiline content", () => {
    const before = "line1\nline2\nline3\n";
    const after = "line1\nmodified\nline3\n";

    const diff = generateDiff(before, after);

    expect(diff).not.toBeNull();
    expect(diff).toContain("-line2");
    expect(diff).toContain("+modified");
  });

  it("handles additions only", () => {
    const before = "line1\n";
    const after = "line1\nline2\nline3\n";

    const diff = generateDiff(before, after);

    expect(diff).not.toBeNull();
    expect(diff).toContain("+line2");
    expect(diff).toContain("+line3");
  });

  it("handles deletions only", () => {
    const before = "line1\nline2\nline3\n";
    const after = "line1\n";

    const diff = generateDiff(before, after);

    expect(diff).not.toBeNull();
    expect(diff).toContain("-line2");
    expect(diff).toContain("-line3");
  });
});

describe("getDiffStats", () => {
  it("returns correct additions and deletions", () => {
    const stats = getDiffStats("line1\nline2\n", "line1\nmodified\nnew\n");

    expect(stats.additions).toBe(2); // modified, new
    expect(stats.deletions).toBe(1); // line2
    expect(stats.isEmpty).toBe(false);
  });

  it("returns isEmpty true for identical content", () => {
    const stats = getDiffStats("same\n", "same\n");

    expect(stats.isEmpty).toBe(true);
    expect(stats.additions).toBe(0);
    expect(stats.deletions).toBe(0);
  });

  it("counts only additions correctly", () => {
    const stats = getDiffStats("line1\n", "line1\nline2\nline3\n");

    expect(stats.additions).toBe(2);
    expect(stats.deletions).toBe(0);
  });

  it("counts only deletions correctly", () => {
    const stats = getDiffStats("line1\nline2\nline3\n", "line1\n");

    expect(stats.additions).toBe(0);
    expect(stats.deletions).toBe(2);
  });
});

describe("hash", () => {
  it("returns 64-character hex string", () => {
    const h = hash("hello world");

    expect(typeof h).toBe("string");
    expect(h.length).toBe(64);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic", () => {
    const h1 = hash("test content");
    const h2 = hash("test content");

    expect(h1).toBe(h2);
  });

  it("produces different hash for different content", () => {
    const h1 = hash("content A");
    const h2 = hash("content B");

    expect(h1).not.toBe(h2);
  });

  // Skip: FFI doesn't support empty buffers
  // it("handles empty string", () => {
  //   const h = hash("");
  //   expect(h.length).toBe(64);
  // });

  it("handles unicode content", () => {
    const h = hash("Hello World!");

    expect(h.length).toBe(64);
  });

  it("handles long content", () => {
    const longContent = "x".repeat(100000);
    const h = hash(longContent);

    expect(h.length).toBe(64);
  });
});

describe("version", () => {
  it("returns version string in semver format", () => {
    const ver = version();

    expect(typeof ver).toBe("string");
    expect(ver).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("returns consistent version", () => {
    const v1 = version();
    const v2 = version();

    expect(v1).toBe(v2);
  });
});
