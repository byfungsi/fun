/**
 * FFI bindings for the Funcode native library
 */

import { dlopen, FFIType, suffix, ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

// Find the native library
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Get the platform-specific library name
 * Format: libfuncode-{platform}-{arch}.{ext}
 * Examples:
 *   - libfuncode-darwin-arm64.dylib
 *   - libfuncode-linux-x64.so
 *   - funcode-win32-x64.dll
 */
function getLibraryName(): string {
  const platform = process.platform;  // 'darwin', 'linux', 'win32'
  const arch = process.arch;          // 'arm64', 'x64'
  
  const ext = suffix; // 'dylib', 'so', or 'dll'
  const prefix = platform === 'win32' ? '' : 'lib';
  
  return `${prefix}funcode-${platform}-${arch}.${ext}`;
}

/**
 * Get the generic library name (for local development)
 * Format: libfuncode.{ext}
 */
function getGenericLibraryName(): string {
  const platform = process.platform;
  const prefix = platform === 'win32' ? '' : 'lib';
  return `${prefix}funcode.${suffix}`;
}

// Try multiple paths for the native library
function findLibrary(): string {
  const platformLibName = getLibraryName();
  const genericLibName = getGenericLibraryName();
  
  // Base directories to search
  const baseDirs = [
    join(__dirname, "..", "native"),      // From src/ → native/
    join(__dirname, "native"),            // From dist/ → native/
    join(__dirname, "..", "..", "native"), // From dist/esm/ → native/
  ];
  
  // Try platform-specific name first, then generic name
  const libNames = [platformLibName, genericLibName];
  
  const searchedPaths: string[] = [];
  
  for (const baseDir of baseDirs) {
    for (const libName of libNames) {
      const p = join(baseDir, libName);
      searchedPaths.push(p);
      if (existsSync(p)) {
        return p;
      }
    }
  }
  
  // Provide a helpful error message
  const platform = process.platform;
  const arch = process.arch;
  throw new Error(
    `Could not find Funcode native library for ${platform}-${arch}.\n` +
    `Looked for: ${platformLibName} or ${genericLibName}\n` +
    `Searched paths:\n${searchedPaths.map(p => `  - ${p}`).join("\n")}\n\n` +
    `To build the native library:\n` +
    `  cd <project-root> && zig build -Doptimize=ReleaseFast\n` +
    `  cp zig-out/lib/${genericLibName} ts/@byfungsi/fun/native/${platformLibName}`
  );
}

const libPath = findLibrary();

// Define FFI symbols
const symbols = {
  // Memory management
  fun_free: {
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.void,
  },
  fun_result_free: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },

  // Version
  fun_version: {
    args: [],
    returns: FFIType.cstring,
  },

  // Hashing
  fun_hash: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr],
    returns: FFIType.void,
  },
  fun_hash_to_hex: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.void,
  },

  // Patch generation
  fun_patch_generate: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.cstring],
    returns: FFIType.ptr, // CResult struct
  },
  fun_patch_stats: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.ptr, // PatchStats struct pointer
  },
  fun_patch_apply: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.ptr, // CResult struct pointer
  },

  // Session management
  fun_session_create: {
    args: [FFIType.cstring],
    returns: FFIType.ptr,
  },
  fun_session_load: {
    args: [FFIType.cstring],
    returns: FFIType.ptr,
  },
  fun_session_load_or_create: {
    args: [FFIType.cstring],
    returns: FFIType.ptr,
  },
  fun_session_close: {
    args: [FFIType.cstring],
    returns: FFIType.ptr,
  },

  // Lock management
  fun_lock_acquire: {
    args: [FFIType.cstring, FFIType.cstring, FFIType.cstring],
    returns: FFIType.ptr, // LockResult struct
  },
  fun_lock_release: {
    args: [FFIType.cstring, FFIType.cstring, FFIType.cstring],
    returns: FFIType.bool,
  },
  fun_lock_acquire_with_timeout: {
    args: [FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.i64],
    returns: FFIType.ptr, // LockResult struct
  },
  fun_lock_is_locked: {
    args: [FFIType.cstring, FFIType.cstring],
    returns: FFIType.ptr, // LockInfo struct
  },
  fun_lock_result_free: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  fun_lock_info_free: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
} as const;

// Load the library
let lib: ReturnType<typeof dlopen<typeof symbols>> | null = null;

function getLib() {
  if (!lib) {
    try {
      lib = dlopen(libPath, symbols);
    } catch (error) {
      throw new Error(
        `Failed to load Funcode native library from ${libPath}: ${error}`
      );
    }
  }
  return lib;
}

// CResult struct layout:
// - success: bool (1 byte, padded to 4)
// - error_code: i32 (4 bytes)
// - data: ptr (8 bytes)
// - data_len: usize (8 bytes)
// Total: 24 bytes with padding

interface CResult {
  success: boolean;
  errorCode: number;
  data: ArrayBuffer | null;
}

function parseCResult(resultPtr: Pointer): CResult {
  const view = new DataView(toArrayBuffer(resultPtr, 0, 24));
  const success = view.getUint8(0) !== 0;
  const errorCode = view.getInt32(4, true);
  const dataPtr = Number(view.getBigUint64(8, true));
  const dataLen = Number(view.getBigUint64(16, true));

  let data: ArrayBuffer | null = null;
  if (dataPtr !== 0 && dataLen > 0) {
    data = toArrayBuffer(dataPtr as unknown as Pointer, 0, dataLen);
  }

  return { success, errorCode, data };
}

// PatchStats struct layout:
// - additions: u32 (4 bytes)
// - deletions: u32 (4 bytes)
// - hunks: u32 (4 bytes)
// - is_empty: bool (1 byte)
// Total: 13 bytes

interface PatchStatsRaw {
  additions: number;
  deletions: number;
  hunks: number;
  isEmpty: boolean;
}

function parsePatchStats(statsPtr: Pointer): PatchStatsRaw {
  const view = new DataView(toArrayBuffer(statsPtr, 0, 16));
  return {
    additions: view.getUint32(0, true),
    deletions: view.getUint32(4, true),
    hunks: view.getUint32(8, true),
    isEmpty: view.getUint8(12) !== 0,
  };
}

// LockResult struct layout (from c_api.zig):
// - acquired: bool (1 byte, padded to 8)
// - holder_ptr: ?[*]u8 (8 bytes)
// - holder_len: usize (8 bytes)
// - expires_at: i64 (8 bytes)
// Total: 32 bytes with padding

interface LockResultRaw {
  acquired: boolean;
  holder: string | null;
  expiresAt: number;
}

function parseLockResult(resultPtr: Pointer): LockResultRaw {
  const view = new DataView(toArrayBuffer(resultPtr, 0, 32));
  const acquired = view.getUint8(0) !== 0;
  const holderPtr = Number(view.getBigUint64(8, true));
  const holderLen = Number(view.getBigUint64(16, true));
  const expiresAt = Number(view.getBigInt64(24, true));

  let holder: string | null = null;
  if (holderPtr !== 0 && holderLen > 0) {
    const holderBuf = toArrayBuffer(holderPtr as unknown as Pointer, 0, holderLen);
    holder = new TextDecoder().decode(holderBuf);
  }

  return { acquired, holder, expiresAt };
}

// LockInfo struct layout (from c_api.zig):
// - is_locked: bool (1 byte, padded to 8)
// - agent_id_ptr: ?[*]u8 (8 bytes)
// - agent_id_len: usize (8 bytes)
// - acquired_at: i64 (8 bytes)
// - expires_at: i64 (8 bytes)
// Total: 40 bytes with padding

interface LockInfoRaw {
  isLocked: boolean;
  agentId: string | null;
  acquiredAt: number;
  expiresAt: number;
}

function parseLockInfo(infoPtr: Pointer): LockInfoRaw {
  const view = new DataView(toArrayBuffer(infoPtr, 0, 40));
  const isLocked = view.getUint8(0) !== 0;
  const agentIdPtr = Number(view.getBigUint64(8, true));
  const agentIdLen = Number(view.getBigUint64(16, true));
  const acquiredAt = Number(view.getBigInt64(24, true));
  const expiresAt = Number(view.getBigInt64(32, true));

  let agentId: string | null = null;
  if (agentIdPtr !== 0 && agentIdLen > 0) {
    const agentIdBuf = toArrayBuffer(agentIdPtr as unknown as Pointer, 0, agentIdLen);
    agentId = new TextDecoder().decode(agentIdBuf);
  }

  return { isLocked, agentId, acquiredAt, expiresAt };
}

// Export FFI functions
export const ffi = {
  get lib() {
    return getLib();
  },

  /** Get library version */
  version(): string {
    const cstr = getLib().symbols.fun_version();
    // fun_version returns a pointer to a null-terminated string
    if (typeof cstr === "number" || typeof cstr === "bigint") {
      // Read the string from the pointer
      const cstrNum = Number(cstr);
      if (cstrNum === 0) return "0.0.0";
      // Read bytes until null terminator
      const view = new DataView(toArrayBuffer(cstrNum as unknown as Pointer, 0, 16));
      let result = "";
      for (let i = 0; i < 16; i++) {
        const byte = view.getUint8(i);
        if (byte === 0) break;
        result += String.fromCharCode(byte);
      }
      return result;
    }
    return String(cstr);
  },

  /** Compute Blake3 hash */
  hash(data: Uint8Array): Uint8Array {
    const hashBuf = new Uint8Array(32);
    getLib().symbols.fun_hash(ptr(data), data.length, ptr(hashBuf));
    return hashBuf;
  },

  /** Convert hash to hex string */
  hashToHex(hash: Uint8Array): string {
    const hexBuf = new Uint8Array(64);
    getLib().symbols.fun_hash_to_hex(ptr(hash), ptr(hexBuf));
    return new TextDecoder().decode(hexBuf);
  },

  /** Generate a unified diff */
  patchGenerate(
    before: string,
    after: string,
    filePath?: string
  ): { success: boolean; diff?: string; errorCode?: number } {
    const beforeBuf = new TextEncoder().encode(before);
    const afterBuf = new TextEncoder().encode(after);

    // For optional file path, we need to pass a proper null pointer (0) or an encoded buffer
    let filePathArg: ReturnType<typeof ptr> | null = null;
    let filePathBuf: Uint8Array | null = null;
    if (filePath) {
      // Encode with null terminator
      filePathBuf = new TextEncoder().encode(filePath + "\0");
      filePathArg = ptr(filePathBuf);
    }

    const resultPtr = getLib().symbols.fun_patch_generate(
      ptr(beforeBuf),
      beforeBuf.length,
      ptr(afterBuf),
      afterBuf.length,
      filePathArg
    );

    const result = parseCResult(resultPtr as Pointer);

    if (result.success && result.data) {
      const diff = new TextDecoder().decode(result.data);
      // Free the result
      getLib().symbols.fun_result_free(resultPtr);
      return { success: true, diff };
    }

    return { success: false, errorCode: result.errorCode };
  },

  /** Get patch statistics */
  patchStats(before: string, after: string): PatchStatsRaw {
    const beforeBuf = new TextEncoder().encode(before);
    const afterBuf = new TextEncoder().encode(after);

    const statsPtr = getLib().symbols.fun_patch_stats(
      ptr(beforeBuf),
      beforeBuf.length,
      ptr(afterBuf),
      afterBuf.length
    );

    return parsePatchStats(statsPtr as Pointer);
  },

  /** Apply a patch to content */
  patchApply(
    content: string,
    diff: string
  ): { success: boolean; result?: string; errorCode?: number } {
    const contentBuf = new TextEncoder().encode(content);
    const diffBuf = new TextEncoder().encode(diff);

    const resultPtr = getLib().symbols.fun_patch_apply(
      ptr(contentBuf),
      contentBuf.length,
      ptr(diffBuf),
      diffBuf.length
    );

    const result = parseCResult(resultPtr as Pointer);

    if (result.success && result.data) {
      const patched = new TextDecoder().decode(result.data);
      getLib().symbols.fun_result_free(resultPtr);
      return { success: true, result: patched };
    }

    return { success: false, errorCode: result.errorCode };
  },

  /** Acquire a lock on a file */
  lockAcquire(
    sessionPath: string,
    filePath: string,
    agentId: string
  ): LockResultRaw {
    const sessionPathBuf = new TextEncoder().encode(sessionPath + "\0");
    const filePathBuf = new TextEncoder().encode(filePath + "\0");
    const agentIdBuf = new TextEncoder().encode(agentId + "\0");

    const resultPtr = getLib().symbols.fun_lock_acquire(
      ptr(sessionPathBuf),
      ptr(filePathBuf),
      ptr(agentIdBuf)
    );

    const result = parseLockResult(resultPtr as Pointer);
    getLib().symbols.fun_lock_result_free(resultPtr);
    return result;
  },

  /** Acquire a lock on a file with custom timeout */
  lockAcquireWithTimeout(
    sessionPath: string,
    filePath: string,
    agentId: string,
    timeoutSeconds: number
  ): LockResultRaw {
    const sessionPathBuf = new TextEncoder().encode(sessionPath + "\0");
    const filePathBuf = new TextEncoder().encode(filePath + "\0");
    const agentIdBuf = new TextEncoder().encode(agentId + "\0");

    const resultPtr = getLib().symbols.fun_lock_acquire_with_timeout(
      ptr(sessionPathBuf),
      ptr(filePathBuf),
      ptr(agentIdBuf),
      BigInt(timeoutSeconds)
    );

    const result = parseLockResult(resultPtr as Pointer);
    getLib().symbols.fun_lock_result_free(resultPtr);
    return result;
  },

  /** Release a lock on a file */
  lockRelease(
    sessionPath: string,
    filePath: string,
    agentId: string
  ): boolean {
    const sessionPathBuf = new TextEncoder().encode(sessionPath + "\0");
    const filePathBuf = new TextEncoder().encode(filePath + "\0");
    const agentIdBuf = new TextEncoder().encode(agentId + "\0");

    return getLib().symbols.fun_lock_release(
      ptr(sessionPathBuf),
      ptr(filePathBuf),
      ptr(agentIdBuf)
    ) as boolean;
  },

  /** Check if a file is locked */
  lockIsLocked(
    sessionPath: string,
    filePath: string
  ): LockInfoRaw {
    const sessionPathBuf = new TextEncoder().encode(sessionPath + "\0");
    const filePathBuf = new TextEncoder().encode(filePath + "\0");

    const infoPtr = getLib().symbols.fun_lock_is_locked(
      ptr(sessionPathBuf),
      ptr(filePathBuf)
    );

    const info = parseLockInfo(infoPtr as Pointer);
    getLib().symbols.fun_lock_info_free(infoPtr);
    return info;
  },
};
