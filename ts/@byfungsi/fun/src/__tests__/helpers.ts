/**
 * Test utilities for @byfungsi/fun integration tests
 */

import { mkdir, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Session } from "../session";

/** Generate a unique temp directory path */
function generateTempPath(): string {
  const id = Math.random().toString(36).substring(2, 10);
  return join(tmpdir(), `funcode-test-${id}`);
}

/** Create a temp directory for a test project */
export async function createTempProject(): Promise<string> {
  const projectPath = generateTempPath();
  await mkdir(projectPath, { recursive: true });
  return projectPath;
}

/** Clean up temp directory */
export async function cleanupTempProject(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/** Create a session in a temp directory with automatic cleanup */
export async function createTestSession(): Promise<{
  session: Session;
  projectPath: string;
  cleanup: () => Promise<void>;
}> {
  const projectPath = await createTempProject();
  const session = await Session.create(projectPath);

  const cleanup = async () => {
    try {
      await session.delete();
    } catch {
      // Session may already be deleted
    }
    await cleanupTempProject(projectPath);
  };

  return { session, projectPath, cleanup };
}

/** Write a test file to the project */
export async function writeTestFile(
  projectPath: string,
  relativePath: string,
  content: string
): Promise<void> {
  const fullPath = join(projectPath, relativePath);
  const dir = join(fullPath, "..");
  await mkdir(dir, { recursive: true });
  await writeFile(fullPath, content, "utf-8");
}

/** Read a test file from the project */
export async function readTestFile(
  projectPath: string,
  relativePath: string
): Promise<string> {
  const fullPath = join(projectPath, relativePath);
  return readFile(fullPath, "utf-8");
}

/** Check if a file exists */
export async function fileExists(
  projectPath: string,
  relativePath: string
): Promise<boolean> {
  const fullPath = join(projectPath, relativePath);
  try {
    await readFile(fullPath);
    return true;
  } catch {
    return false;
  }
}

/** Sleep for specified milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
