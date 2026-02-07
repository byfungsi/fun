//! File locking for multi-agent coordination.
//! Provides file-level locking with expiry for AI agents.

const std = @import("std");
const Allocator = std.mem.Allocator;
const fs = std.fs;

const storage = @import("storage.zig");

/// Lock expiry time in seconds (5 minutes)
const LOCK_EXPIRY_SECONDS: i64 = 5 * 60;

/// A file lock
pub const FileLock = struct {
    file_path: []const u8,
    agent_id: []const u8,
    acquired_at: i64,
    expires_at: i64,
};

/// Lock acquisition result
pub const LockResult = union(enum) {
    acquired: FileLock,
    already_locked: struct {
        holder: []const u8,
        expires_at: i64,
    },
};

/// Lock manager for a session
pub const LockManager = struct {
    allocator: Allocator,
    locks_path: []const u8,
    locks: std.StringHashMap(FileLock),

    const Self = @This();

    /// Initialize lock manager
    pub fn init(allocator: Allocator, session_path: []const u8) !Self {
        const locks_path = try std.fs.path.join(allocator, &.{ session_path, "locks.json" });
        errdefer allocator.free(locks_path);

        var manager = Self{
            .allocator = allocator,
            .locks_path = locks_path,
            .locks = std.StringHashMap(FileLock).init(allocator),
        };

        // Load existing locks
        try manager.load();

        return manager;
    }

    pub fn deinit(self: *Self) void {
        var iter = self.locks.iterator();
        while (iter.next()) |entry| {
            // Key and file_path share the same allocation, so only free once
            self.allocator.free(entry.key_ptr.*);
            self.allocator.free(entry.value_ptr.agent_id);
        }
        self.locks.deinit();
        self.allocator.free(self.locks_path);
    }

    /// Try to acquire a lock on a file
    pub fn acquire(self: *Self, file_path: []const u8, agent_id: []const u8) !LockResult {
        const now = std.time.timestamp();

        // Clean up expired locks first
        try self.cleanupExpired();

        // Check if already locked
        if (self.locks.getPtr(file_path)) |existing| {
            if (std.mem.eql(u8, existing.agent_id, agent_id)) {
                // Same agent, extend the lock
                existing.expires_at = now + LOCK_EXPIRY_SECONDS;
                try self.save();
                return .{ .acquired = existing.* };
            }

            // Different agent holds the lock
            return .{
                .already_locked = .{
                    .holder = existing.agent_id,
                    .expires_at = existing.expires_at,
                },
            };
        }

        // Acquire new lock - key and file_path are the same string (shared)
        const key = try self.allocator.dupe(u8, file_path);
        errdefer self.allocator.free(key);

        const agent_owned = try self.allocator.dupe(u8, agent_id);
        errdefer self.allocator.free(agent_owned);

        const lock = FileLock{
            .file_path = key, // Key and file_path share the same allocation
            .agent_id = agent_owned,
            .acquired_at = now,
            .expires_at = now + LOCK_EXPIRY_SECONDS,
        };

        try self.locks.put(key, lock);
        try self.save();

        return .{ .acquired = lock };
    }

    /// Release a lock
    pub fn release(self: *Self, file_path: []const u8, agent_id: []const u8) !bool {
        if (self.locks.fetchRemove(file_path)) |kv| {
            if (std.mem.eql(u8, kv.value.agent_id, agent_id)) {
                // Key and file_path share the same allocation
                self.allocator.free(kv.key);
                self.allocator.free(kv.value.agent_id);
                try self.save();
                return true;
            } else {
                // Different agent, put it back
                try self.locks.put(kv.key, kv.value);
                return false;
            }
        }
        return false;
    }

    /// Check if a file is locked
    pub fn isLocked(self: *Self, file_path: []const u8) !?FileLock {
        try self.cleanupExpired();
        return self.locks.get(file_path);
    }

    /// Get all active locks
    pub fn getAll(self: *Self) ![]FileLock {
        try self.cleanupExpired();

        var result = try self.allocator.alloc(FileLock, self.locks.count());
        var i: usize = 0;

        var iter = self.locks.iterator();
        while (iter.next()) |entry| {
            result[i] = entry.value_ptr.*;
            i += 1;
        }

        return result;
    }

    /// Clean up expired locks
    fn cleanupExpired(self: *Self) !void {
        const now = std.time.timestamp();
        var to_remove = std.ArrayList([]const u8){};
        defer to_remove.deinit(self.allocator);

        var iter = self.locks.iterator();
        while (iter.next()) |entry| {
            if (entry.value_ptr.expires_at < now) {
                try to_remove.append(self.allocator, entry.key_ptr.*);
            }
        }

        var changed = false;
        for (to_remove.items) |key| {
            if (self.locks.fetchRemove(key)) |kv| {
                // Key and file_path share the same allocation
                self.allocator.free(kv.key);
                self.allocator.free(kv.value.agent_id);
                changed = true;
            }
        }

        if (changed) {
            try self.save();
        }
    }

    /// Save locks to disk
    fn save(self: *Self) !void {
        var json = std.ArrayList(u8){};
        defer json.deinit(self.allocator);

        try json.appendSlice(self.allocator, "[\n");

        var first = true;
        var iter = self.locks.iterator();
        while (iter.next()) |entry| {
            if (!first) try json.appendSlice(self.allocator, ",\n");
            first = false;

            const lock = entry.value_ptr.*;
            const lock_json = try std.fmt.allocPrint(self.allocator,
                \\  {{
                \\    "file_path": "{s}",
                \\    "agent_id": "{s}",
                \\    "acquired_at": {d},
                \\    "expires_at": {d}
                \\  }}
            , .{
                lock.file_path,
                lock.agent_id,
                lock.acquired_at,
                lock.expires_at,
            });
            defer self.allocator.free(lock_json);

            try json.appendSlice(self.allocator, lock_json);
        }

        try json.appendSlice(self.allocator, "\n]");

        try storage.writeFileAtomic(self.allocator, self.locks_path, json.items);
    }

    /// Load locks from disk
    fn load(self: *Self) !void {
        const json = storage.readFile(self.allocator, self.locks_path) catch {
            return; // No locks file yet
        };
        defer self.allocator.free(json);

        // TODO: Implement proper JSON parsing
        // For now, skip parsing - locks will be empty on load
    }
};

// ============ Tests ============

test "LockManager init and deinit" {
    const allocator = std.testing.allocator;
    const tmp_dir = "/tmp/funcode-test-locks";

    try storage.ensureDirPath(allocator, tmp_dir);
    defer fs.deleteTreeAbsolute(tmp_dir) catch {};

    var manager = try LockManager.init(allocator, tmp_dir);
    defer manager.deinit();
}

test "LockManager acquire and release" {
    const allocator = std.testing.allocator;
    const tmp_dir = "/tmp/funcode-test-locks-acquire";

    try storage.ensureDirPath(allocator, tmp_dir);
    defer fs.deleteTreeAbsolute(tmp_dir) catch {};

    var manager = try LockManager.init(allocator, tmp_dir);
    defer manager.deinit();

    // Acquire lock
    const result = try manager.acquire("src/main.zig", "agent-1");
    try std.testing.expect(result == .acquired);
    try std.testing.expectEqualStrings("src/main.zig", result.acquired.file_path);

    // Same agent can extend lock
    const result2 = try manager.acquire("src/main.zig", "agent-1");
    try std.testing.expect(result2 == .acquired);

    // Different agent cannot acquire
    const result3 = try manager.acquire("src/main.zig", "agent-2");
    try std.testing.expect(result3 == .already_locked);

    // Release lock
    const released = try manager.release("src/main.zig", "agent-1");
    try std.testing.expect(released);

    // Now agent-2 can acquire
    const result4 = try manager.acquire("src/main.zig", "agent-2");
    try std.testing.expect(result4 == .acquired);
}

test "LockManager isLocked" {
    const allocator = std.testing.allocator;
    const tmp_dir = "/tmp/funcode-test-locks-islocked";

    try storage.ensureDirPath(allocator, tmp_dir);
    defer fs.deleteTreeAbsolute(tmp_dir) catch {};

    var manager = try LockManager.init(allocator, tmp_dir);
    defer manager.deinit();

    // Not locked initially
    const lock1 = try manager.isLocked("src/main.zig");
    try std.testing.expect(lock1 == null);

    // Acquire and check
    _ = try manager.acquire("src/main.zig", "agent-1");
    const lock2 = try manager.isLocked("src/main.zig");
    try std.testing.expect(lock2 != null);
    try std.testing.expectEqualStrings("agent-1", lock2.?.agent_id);
}
