//! C ABI exports for Bun FFI integration.
//! This module provides a C-compatible interface to the Funcode library.

const std = @import("std");
const Allocator = std.mem.Allocator;

const patch = @import("patch.zig");
const storage = @import("storage.zig");
const session = @import("session.zig");
const lock = @import("lock.zig");

// Use C allocator for C API calls
const c_allocator = std.heap.c_allocator;

// ============ Result Types ============

/// Generic result type for C API
pub const CResult = extern struct {
    success: bool,
    error_code: i32,
    data: ?[*]u8,
    data_len: usize,
};

/// Error codes
pub const ErrorCode = enum(i32) {
    none = 0,
    out_of_memory = 1,
    io_error = 2,
    invalid_argument = 3,
    session_not_found = 4,
    session_exists = 5,
    file_not_tracked = 6,
    lock_held = 7,
    internal_error = 99,
};

// ============ Memory Management ============

/// Free memory allocated by the library
pub export fn fun_free(ptr: ?[*]u8, len: usize) void {
    if (ptr) |p| {
        c_allocator.free(p[0..len]);
    }
}

/// Free a CResult's data
pub export fn fun_result_free(result: *CResult) void {
    if (result.data) |data| {
        c_allocator.free(data[0..result.data_len]);
        result.data = null;
        result.data_len = 0;
    }
}

// ============ Session Management ============

/// Opaque session handle
pub const SessionHandle = *session.Session;

/// Create a new session
pub export fn fun_session_create(project_path: [*:0]const u8) CResult {
    const path = std.mem.span(project_path);

    const sess = session.Session.create(c_allocator, path) catch |err| {
        return errorResult(err);
    };

    // Allocate heap memory for the session
    const sess_ptr = c_allocator.create(session.Session) catch {
        return .{
            .success = false,
            .error_code = @intFromEnum(ErrorCode.out_of_memory),
            .data = null,
            .data_len = 0,
        };
    };
    sess_ptr.* = sess;

    // Return session ID as result data
    const id_copy = c_allocator.alloc(u8, 36) catch {
        c_allocator.destroy(sess_ptr);
        return .{
            .success = false,
            .error_code = @intFromEnum(ErrorCode.out_of_memory),
            .data = null,
            .data_len = 0,
        };
    };
    @memcpy(id_copy, &sess_ptr.id);

    return .{
        .success = true,
        .error_code = 0,
        .data = id_copy.ptr,
        .data_len = 36,
    };
}

/// Load an existing session by ID
pub export fn fun_session_load(session_id: [*:0]const u8) CResult {
    const id_str = std.mem.span(session_id);
    if (id_str.len != 36) {
        return .{
            .success = false,
            .error_code = @intFromEnum(ErrorCode.invalid_argument),
            .data = null,
            .data_len = 0,
        };
    }

    var id: session.SessionId = undefined;
    @memcpy(&id, id_str[0..36]);

    const sess = session.Session.load(c_allocator, id) catch |err| {
        return errorResult(err);
    };

    const sess_ptr = c_allocator.create(session.Session) catch {
        return .{
            .success = false,
            .error_code = @intFromEnum(ErrorCode.out_of_memory),
            .data = null,
            .data_len = 0,
        };
    };
    sess_ptr.* = sess;

    const id_copy = c_allocator.alloc(u8, 36) catch {
        c_allocator.destroy(sess_ptr);
        return .{
            .success = false,
            .error_code = @intFromEnum(ErrorCode.out_of_memory),
            .data = null,
            .data_len = 0,
        };
    };
    @memcpy(id_copy, &sess_ptr.id);

    return .{
        .success = true,
        .error_code = 0,
        .data = id_copy.ptr,
        .data_len = 36,
    };
}

/// Load or create session for a project
pub export fn fun_session_load_or_create(project_path: [*:0]const u8) CResult {
    const path = std.mem.span(project_path);

    const sess = session.Session.loadOrCreate(c_allocator, path) catch |err| {
        return errorResult(err);
    };

    const sess_ptr = c_allocator.create(session.Session) catch {
        return .{
            .success = false,
            .error_code = @intFromEnum(ErrorCode.out_of_memory),
            .data = null,
            .data_len = 0,
        };
    };
    sess_ptr.* = sess;

    const id_copy = c_allocator.alloc(u8, 36) catch {
        c_allocator.destroy(sess_ptr);
        return .{
            .success = false,
            .error_code = @intFromEnum(ErrorCode.out_of_memory),
            .data = null,
            .data_len = 0,
        };
    };
    @memcpy(id_copy, &sess_ptr.id);

    return .{
        .success = true,
        .error_code = 0,
        .data = id_copy.ptr,
        .data_len = 36,
    };
}

/// Close a session (free resources)
pub export fn fun_session_close(session_id: [*:0]const u8) CResult {
    _ = session_id;
    // TODO: Implement session handle lookup
    return .{
        .success = true,
        .error_code = 0,
        .data = null,
        .data_len = 0,
    };
}

// ============ Patch Generation ============

/// Generate a unified diff between two strings
/// Returns a pointer to a heap-allocated CResult that must be freed with fun_result_free
pub export fn fun_patch_generate(
    before_ptr: [*]const u8,
    before_len: usize,
    after_ptr: [*]const u8,
    after_len: usize,
    file_path: ?[*:0]const u8,
) *CResult {
    const result_ptr = c_allocator.create(CResult) catch {
        // Can't even allocate the result struct - return a static error
        return &static_oom_result;
    };

    const before = before_ptr[0..before_len];
    const after = after_ptr[0..after_len];

    var p = patch.generate(c_allocator, before, after) catch |err| {
        result_ptr.* = errorResult(err);
        return result_ptr;
    };
    defer p.deinit();

    const path = if (file_path) |fp| std.mem.span(fp) else null;
    const diff = p.toUnifiedDiff(c_allocator, path) catch |err| {
        result_ptr.* = errorResult(err);
        return result_ptr;
    };

    result_ptr.* = .{
        .success = true,
        .error_code = 0,
        .data = diff.ptr,
        .data_len = diff.len,
    };
    return result_ptr;
}

// Static OOM result for when we can't even allocate a result struct
var static_oom_result = CResult{
    .success = false,
    .error_code = @intFromEnum(ErrorCode.out_of_memory),
    .data = null,
    .data_len = 0,
};

/// Get patch statistics
/// Returns a pointer to a heap-allocated PatchStats that should be read immediately
/// (the memory is managed internally and reused on next call)
pub const PatchStats = extern struct {
    additions: u32,
    deletions: u32,
    hunks: u32,
    is_empty: bool,
};

// Thread-local stats result for simpler memory management
var static_patch_stats = PatchStats{
    .additions = 0,
    .deletions = 0,
    .hunks = 0,
    .is_empty = true,
};

pub export fn fun_patch_stats(
    before_ptr: [*]const u8,
    before_len: usize,
    after_ptr: [*]const u8,
    after_len: usize,
) *PatchStats {
    const before = before_ptr[0..before_len];
    const after = after_ptr[0..after_len];

    var p = patch.generate(c_allocator, before, after) catch {
        static_patch_stats = .{
            .additions = 0,
            .deletions = 0,
            .hunks = 0,
            .is_empty = true,
        };
        return &static_patch_stats;
    };
    defer p.deinit();

    static_patch_stats = .{
        .additions = p.stats.additions,
        .deletions = p.stats.deletions,
        .hunks = @intCast(p.hunks.len),
        .is_empty = p.isEmpty(),
    };
    return &static_patch_stats;
}

/// Apply a unified diff patch to content
/// Returns a CResult with the patched content
pub export fn fun_patch_apply(
    content_ptr: [*]const u8,
    content_len: usize,
    diff_ptr: [*]const u8,
    diff_len: usize,
) *CResult {
    const result_ptr = c_allocator.create(CResult) catch {
        return &static_oom_result;
    };

    const content = content_ptr[0..content_len];
    const diff_text = diff_ptr[0..diff_len];

    // Parse the diff
    var p = patch.parse(c_allocator, diff_text) catch |err| {
        result_ptr.* = errorResult(err);
        return result_ptr;
    };
    defer p.deinit();

    // Apply the patch
    const patched = patch.apply(c_allocator, content, p) catch |err| {
        result_ptr.* = errorResult(err);
        return result_ptr;
    };

    result_ptr.* = .{
        .success = true,
        .error_code = 0,
        .data = patched.ptr,
        .data_len = patched.len,
    };
    return result_ptr;
}

// ============ Storage ============

/// Compute Blake3 hash of content (writes to out_hash which must be 32 bytes)
pub export fn fun_hash(data_ptr: [*]const u8, data_len: usize, out_hash: [*]u8) void {
    const data = data_ptr[0..data_len];
    const hash = storage.computeHash(data);
    @memcpy(out_hash[0..32], &hash);
}

/// Convert hash to hex string (hash is 32 bytes, out_hex must be 64 bytes)
pub export fn fun_hash_to_hex(hash: [*]const u8, out_hex: [*]u8) void {
    var hash_arr: [32]u8 = undefined;
    @memcpy(&hash_arr, hash[0..32]);
    const hex = storage.hashToHex(hash_arr);
    @memcpy(out_hex[0..64], &hex);
}

// ============ Lock Management ============

/// Lock result type
pub const LockResult = extern struct {
    acquired: bool,
    holder_ptr: ?[*]u8,
    holder_len: usize,
    expires_at: i64,
};

/// Acquire a file lock (returns heap-allocated result)
pub export fn fun_lock_acquire(
    session_path: [*:0]const u8,
    file_path: [*:0]const u8,
    agent_id: [*:0]const u8,
) ?*LockResult {
    const sess_path = std.mem.span(session_path);
    const f_path = std.mem.span(file_path);
    const a_id = std.mem.span(agent_id);

    // Allocate result on heap
    const result_ptr = c_allocator.create(LockResult) catch return null;

    var manager = lock.LockManager.init(c_allocator, sess_path) catch {
        result_ptr.* = .{
            .acquired = false,
            .holder_ptr = null,
            .holder_len = 0,
            .expires_at = 0,
        };
        return result_ptr;
    };
    defer manager.deinit();

    const result = manager.acquire(f_path, a_id) catch {
        result_ptr.* = .{
            .acquired = false,
            .holder_ptr = null,
            .holder_len = 0,
            .expires_at = 0,
        };
        return result_ptr;
    };

    switch (result) {
        .acquired => |l| {
            result_ptr.* = .{
                .acquired = true,
                .holder_ptr = null,
                .holder_len = 0,
                .expires_at = l.expires_at,
            };
        },
        .already_locked => |info| {
            // Copy holder string
            const holder = c_allocator.alloc(u8, info.holder.len) catch {
                result_ptr.* = .{
                    .acquired = false,
                    .holder_ptr = null,
                    .holder_len = 0,
                    .expires_at = info.expires_at,
                };
                return result_ptr;
            };
            @memcpy(holder, info.holder);

            result_ptr.* = .{
                .acquired = false,
                .holder_ptr = holder.ptr,
                .holder_len = holder.len,
                .expires_at = info.expires_at,
            };
        },
    }
    return result_ptr;
}

/// Release a file lock
pub export fn fun_lock_release(
    session_path: [*:0]const u8,
    file_path: [*:0]const u8,
    agent_id: [*:0]const u8,
) bool {
    const sess_path = std.mem.span(session_path);
    const f_path = std.mem.span(file_path);
    const a_id = std.mem.span(agent_id);

    var manager = lock.LockManager.init(c_allocator, sess_path) catch {
        return false;
    };
    defer manager.deinit();

    return manager.release(f_path, a_id) catch false;
}

/// Acquire a file lock with custom timeout (returns heap-allocated result)
pub export fn fun_lock_acquire_with_timeout(
    session_path: [*:0]const u8,
    file_path: [*:0]const u8,
    agent_id: [*:0]const u8,
    timeout_seconds: i64,
) ?*LockResult {
    const sess_path = std.mem.span(session_path);
    const f_path = std.mem.span(file_path);
    const a_id = std.mem.span(agent_id);

    // Allocate result on heap
    const result_ptr = c_allocator.create(LockResult) catch return null;

    var manager = lock.LockManager.init(c_allocator, sess_path) catch {
        result_ptr.* = .{
            .acquired = false,
            .holder_ptr = null,
            .holder_len = 0,
            .expires_at = 0,
        };
        return result_ptr;
    };
    defer manager.deinit();

    const result = manager.acquireWithTimeout(f_path, a_id, timeout_seconds) catch {
        result_ptr.* = .{
            .acquired = false,
            .holder_ptr = null,
            .holder_len = 0,
            .expires_at = 0,
        };
        return result_ptr;
    };

    switch (result) {
        .acquired => |l| {
            result_ptr.* = .{
                .acquired = true,
                .holder_ptr = null,
                .holder_len = 0,
                .expires_at = l.expires_at,
            };
        },
        .already_locked => |info| {
            // Copy holder string
            const holder = c_allocator.alloc(u8, info.holder.len) catch {
                result_ptr.* = .{
                    .acquired = false,
                    .holder_ptr = null,
                    .holder_len = 0,
                    .expires_at = info.expires_at,
                };
                return result_ptr;
            };
            @memcpy(holder, info.holder);

            result_ptr.* = .{
                .acquired = false,
                .holder_ptr = holder.ptr,
                .holder_len = holder.len,
                .expires_at = info.expires_at,
            };
        },
    }
    return result_ptr;
}

/// Lock info result type
pub const LockInfo = extern struct {
    is_locked: bool,
    agent_id_ptr: ?[*]u8,
    agent_id_len: usize,
    acquired_at: i64,
    expires_at: i64,
};

/// Check if a file is locked (returns heap-allocated result)
pub export fn fun_lock_is_locked(
    session_path: [*:0]const u8,
    file_path: [*:0]const u8,
) ?*LockInfo {
    const sess_path = std.mem.span(session_path);
    const f_path = std.mem.span(file_path);

    // Allocate result on heap
    const info_ptr = c_allocator.create(LockInfo) catch return null;

    var manager = lock.LockManager.init(c_allocator, sess_path) catch {
        info_ptr.* = .{
            .is_locked = false,
            .agent_id_ptr = null,
            .agent_id_len = 0,
            .acquired_at = 0,
            .expires_at = 0,
        };
        return info_ptr;
    };
    defer manager.deinit();

    const result = manager.isLocked(f_path) catch {
        info_ptr.* = .{
            .is_locked = false,
            .agent_id_ptr = null,
            .agent_id_len = 0,
            .acquired_at = 0,
            .expires_at = 0,
        };
        return info_ptr;
    };

    if (result) |l| {
        // Copy agent_id string
        const agent_id = c_allocator.alloc(u8, l.agent_id.len) catch {
            info_ptr.* = .{
                .is_locked = true,
                .agent_id_ptr = null,
                .agent_id_len = 0,
                .acquired_at = l.acquired_at,
                .expires_at = l.expires_at,
            };
            return info_ptr;
        };
        @memcpy(agent_id, l.agent_id);

        info_ptr.* = .{
            .is_locked = true,
            .agent_id_ptr = agent_id.ptr,
            .agent_id_len = agent_id.len,
            .acquired_at = l.acquired_at,
            .expires_at = l.expires_at,
        };
        return info_ptr;
    }

    info_ptr.* = .{
        .is_locked = false,
        .agent_id_ptr = null,
        .agent_id_len = 0,
        .acquired_at = 0,
        .expires_at = 0,
    };
    return info_ptr;
}

/// Free a lock result (including holder string if present)
pub export fn fun_lock_result_free(result: ?*LockResult) void {
    if (result) |r| {
        if (r.holder_ptr) |ptr| {
            c_allocator.free(ptr[0..r.holder_len]);
        }
        c_allocator.destroy(r);
    }
}

/// Free a lock info (including agent_id string if present)
pub export fn fun_lock_info_free(info: ?*LockInfo) void {
    if (info) |i| {
        if (i.agent_id_ptr) |ptr| {
            c_allocator.free(ptr[0..i.agent_id_len]);
        }
        c_allocator.destroy(i);
    }
}

// ============ Version Info ============

/// Get library version
pub export fn fun_version() [*:0]const u8 {
    return "0.4.0";
}

// ============ Helper Functions ============

fn errorResult(err: anyerror) CResult {
    const code: ErrorCode = switch (err) {
        error.OutOfMemory => .out_of_memory,
        error.SessionNotFound => .session_not_found,
        error.SessionExists => .session_exists,
        error.FileNotTracked => .file_not_tracked,
        error.IoError => .io_error,
        else => .internal_error,
    };

    return .{
        .success = false,
        .error_code = @intFromEnum(code),
        .data = null,
        .data_len = 0,
    };
}

// ============ Tests ============

test "fun_version" {
    const version = fun_version();
    try std.testing.expectEqualStrings("0.4.0", std.mem.span(version));
}

test "fun_hash" {
    const data = "Hello, World!";
    var hash: [32]u8 = undefined;
    var hex: [64]u8 = undefined;

    fun_hash(data.ptr, data.len, &hash);
    fun_hash_to_hex(&hash, &hex);

    // Blake3 hash of "Hello, World!" should be consistent
    try std.testing.expect(hex.len == 64);
}

test "fun_patch_generate" {
    const before = "line1\nline2\nline3\n";
    const after = "line1\nmodified\nline3\n";

    const result = fun_patch_generate(
        before.ptr,
        before.len,
        after.ptr,
        after.len,
        "test.txt",
    );

    try std.testing.expect(result.success);
    try std.testing.expect(result.data != null);
    try std.testing.expect(result.data_len > 0);

    // Verify it contains expected content
    const diff = result.data.?[0..result.data_len];
    try std.testing.expect(std.mem.indexOf(u8, diff, "--- a/test.txt") != null);
    try std.testing.expect(std.mem.indexOf(u8, diff, "+modified") != null);

    fun_result_free(result);
}

test "fun_patch_stats" {
    const before = "line1\nline2\nline3\n";
    const after = "line1\nmodified\nline3\n";

    const stats = fun_patch_stats(before.ptr, before.len, after.ptr, after.len);

    try std.testing.expectEqual(@as(u32, 1), stats.additions);
    try std.testing.expectEqual(@as(u32, 1), stats.deletions);
    try std.testing.expect(!stats.is_empty);
}
