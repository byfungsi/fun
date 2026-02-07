//! Funcode Library - AI-friendly version control
//! Main library entry point exposing all modules.

pub const patch = @import("patch.zig");
pub const storage = @import("storage.zig");
pub const session = @import("session.zig");
pub const lock = @import("lock.zig");
pub const c_api = @import("c_api.zig");

// Re-export commonly used types
pub const Patch = patch.Patch;
pub const Hunk = patch.Hunk;
pub const DiffLine = patch.DiffLine;
pub const Stats = patch.Stats;

pub const Storage = storage.Storage;
pub const Hash = storage.Hash;

pub const Session = session.Session;
pub const Version = session.Version;
pub const FileState = session.FileState;

pub const LockManager = lock.LockManager;
pub const FileLock = lock.FileLock;

/// Generate a patch from before/after content
pub const generate = patch.generate;

/// Reverse a patch
pub const reverse = patch.reverse;

/// Parse a unified diff string into a Patch
pub const parse = patch.parse;

/// Apply a patch to content
pub const apply = patch.apply;

/// Compute content hash
pub const computeHash = storage.computeHash;

// Force C API exports to be included in the binary
// These need to be referenced to prevent dead code elimination
comptime {
    _ = &c_api.fun_free;
    _ = &c_api.fun_result_free;
    _ = &c_api.fun_version;
    _ = &c_api.fun_hash;
    _ = &c_api.fun_hash_to_hex;
    _ = &c_api.fun_patch_generate;
    _ = &c_api.fun_patch_stats;
    _ = &c_api.fun_patch_apply;
    _ = &c_api.fun_session_create;
    _ = &c_api.fun_session_load;
    _ = &c_api.fun_session_load_or_create;
    _ = &c_api.fun_session_close;
    _ = &c_api.fun_lock_acquire;
    _ = &c_api.fun_lock_release;
    _ = &c_api.fun_lock_acquire_with_timeout;
    _ = &c_api.fun_lock_is_locked;
    _ = &c_api.fun_lock_result_free;
    _ = &c_api.fun_lock_info_free;
}

// Tests
test {
    _ = patch;
    _ = storage;
    _ = session;
    _ = lock;
    _ = c_api;
}
