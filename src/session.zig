//! Session management for Funcode.
//! Handles session lifecycle, version tracking, and file state.

const std = @import("std");
const Allocator = std.mem.Allocator;
const fs = std.fs;

const patch = @import("patch.zig");
const storage = @import("storage.zig");

/// Session ID is a UUID string
pub const SessionId = [36]u8;

/// File path hash for internal keying
pub const FileKey = storage.Hash;

/// Version number (1-indexed)
pub const VersionNum = u32;

/// File state for a tracked file
pub const FileState = struct {
    /// Path relative to project root
    path: []const u8,
    /// Hash of original content (before any AI changes)
    original_hash: storage.Hash,
    /// Hash of current content (after AI changes)
    current_hash: storage.Hash,
    /// Last version that modified this file
    last_version: VersionNum,
    /// Whether the file existed before tracking
    existed_before: bool,
};

/// Version metadata
pub const Version = struct {
    num: VersionNum,
    file_path: []const u8,
    agent_id: []const u8,
    message: []const u8,
    timestamp: i64,
    parent_version: ?VersionNum,
    additions: u32,
    deletions: u32,
};

/// Session metadata
pub const SessionMetadata = struct {
    id: SessionId,
    project_path: []const u8,
    created_at: i64,
    last_modified: i64,
    current_version: VersionNum,
};

/// Error types
pub const SessionError = error{
    SessionNotFound,
    SessionExists,
    InvalidSession,
    FileNotTracked,
    VersionNotFound,
    IoError,
    OutOfMemory,
};

/// A Funcode session
pub const Session = struct {
    allocator: Allocator,
    id: SessionId,
    project_path: []const u8,
    session_path: []const u8,
    store: storage.Storage,
    current_version: VersionNum,
    file_states: std.StringHashMap(FileState),

    const Self = @This();

    /// Create a new session for a project
    pub fn create(allocator: Allocator, project_path: []const u8) !Self {
        const id = generateSessionId();
        const session_path = try getSessionPath(allocator, &id);
        errdefer allocator.free(session_path);

        // Check if session already exists
        if (storage.fileExists(session_path)) {
            return error.SessionExists;
        }

        var store = try storage.Storage.init(allocator, session_path);
        errdefer store.deinit();

        const project_path_owned = try allocator.dupe(u8, project_path);
        errdefer allocator.free(project_path_owned);

        var session = Self{
            .allocator = allocator,
            .id = id,
            .project_path = project_path_owned,
            .session_path = session_path,
            .store = store,
            .current_version = 0,
            .file_states = std.StringHashMap(FileState).init(allocator),
        };

        // Save initial metadata
        try session.saveMetadata();

        return session;
    }

    /// Load an existing session by ID
    pub fn load(allocator: Allocator, id: SessionId) !Self {
        const session_path = try getSessionPath(allocator, &id);
        errdefer allocator.free(session_path);

        if (!storage.fileExists(session_path)) {
            return error.SessionNotFound;
        }

        var store = try storage.Storage.init(allocator, session_path);
        errdefer store.deinit();

        // Load metadata
        const meta_path = try std.fs.path.join(allocator, &.{ session_path, "manifest.json" });
        defer allocator.free(meta_path);

        const meta_json = storage.readFile(allocator, meta_path) catch {
            return error.InvalidSession;
        };
        defer allocator.free(meta_json);

        // Parse metadata (simplified - in production use proper JSON parser)
        const project_path = try extractJsonString(allocator, meta_json, "project_path");
        errdefer allocator.free(project_path);

        const current_version = try extractJsonNumber(meta_json, "current_version");

        var session = Self{
            .allocator = allocator,
            .id = id,
            .project_path = project_path,
            .session_path = session_path,
            .store = store,
            .current_version = current_version,
            .file_states = std.StringHashMap(FileState).init(allocator),
        };

        // Load file states
        try session.loadFileStates();

        return session;
    }

    /// Load or create session for a project path
    pub fn loadOrCreate(allocator: Allocator, project_path: []const u8) !Self {
        // Try to find existing session for this project
        const sessions_dir = try getSessionsDir(allocator);
        defer allocator.free(sessions_dir);

        var dir = fs.openDirAbsolute(sessions_dir, .{ .iterate = true }) catch {
            // No sessions exist yet, create new one
            return create(allocator, project_path);
        };
        defer dir.close();

        var iter = dir.iterate();
        while (try iter.next()) |entry| {
            if (entry.kind != .directory) continue;
            if (entry.name.len != 36) continue; // UUID length

            // Try to load and check project path
            var id: SessionId = undefined;
            @memcpy(&id, entry.name[0..36]);

            var session = load(allocator, id) catch continue;

            if (std.mem.eql(u8, session.project_path, project_path)) {
                return session;
            }

            session.deinit();
        }

        // No matching session found, create new one
        return create(allocator, project_path);
    }

    /// Track a file change
    pub fn trackChange(self: *Self, opts: TrackChangeOptions) !Version {
        const file_path = opts.file_path;
        const before_content = opts.before_content;
        const after_content = opts.after_content;

        // Generate patch
        var diff = try patch.generate(self.allocator, before_content, after_content);
        defer diff.deinit();

        if (diff.isEmpty()) {
            // No changes
            return Version{
                .num = self.current_version,
                .file_path = file_path,
                .agent_id = opts.agent_id,
                .message = opts.message orelse "",
                .timestamp = std.time.timestamp(),
                .parent_version = if (self.current_version > 0) self.current_version else null,
                .additions = 0,
                .deletions = 0,
            };
        }

        // Get or create file state
        const before_hash = storage.computeHash(before_content);
        const after_hash = storage.computeHash(after_content);

        const file_key = try self.allocator.dupe(u8, file_path);
        errdefer self.allocator.free(file_key);

        const file_state = self.file_states.get(file_path);
        if (file_state == null) {
            // First time tracking this file - store original
            _ = try self.store.storeOriginal(before_content);

            const new_state = FileState{
                .path = file_key,
                .original_hash = before_hash,
                .current_hash = after_hash,
                .last_version = self.current_version + 1,
                .existed_before = before_content.len > 0,
            };

            try self.file_states.put(file_key, new_state);
        } else {
            // Update existing state
            var state = file_state.?;
            state.current_hash = after_hash;
            state.last_version = self.current_version + 1;
            try self.file_states.put(file_path, state);
        }

        // Increment version
        self.current_version += 1;

        // Store patch
        const diff_str = try diff.toUnifiedDiff(self.allocator, file_path);
        defer self.allocator.free(diff_str);

        try self.store.storePatch(diff_str, self.current_version);

        // Create version metadata
        const version = Version{
            .num = self.current_version,
            .file_path = file_path,
            .agent_id = opts.agent_id,
            .message = opts.message orelse "",
            .timestamp = std.time.timestamp(),
            .parent_version = if (self.current_version > 1) self.current_version - 1 else null,
            .additions = diff.stats.additions,
            .deletions = diff.stats.deletions,
        };

        // Store version metadata
        const version_json = try serializeVersion(self.allocator, version);
        defer self.allocator.free(version_json);

        try self.store.storeVersionMeta(self.current_version, version_json);

        // Save session metadata
        try self.saveMetadata();
        try self.saveFileStates();

        return version;
    }

    /// Revert a file to a specific version (or original if version is 0/null)
    pub fn revertFile(self: *Self, file_path: []const u8, to_version: ?VersionNum) !void {
        const file_state = self.file_states.get(file_path) orelse {
            return error.FileNotTracked;
        };

        const target_version = to_version orelse 0;

        // Get content at target version
        const content = if (target_version == 0)
            try self.store.getOriginal(file_state.original_hash)
        else
            try self.getContentAtVersion(file_path, target_version);
        defer self.allocator.free(content);

        // Write to file
        const full_path = try std.fs.path.join(self.allocator, &.{ self.project_path, file_path });
        defer self.allocator.free(full_path);

        if (!file_state.existed_before and target_version == 0) {
            // File didn't exist before, delete it
            fs.deleteFileAbsolute(full_path) catch {};
        } else {
            // Write content back
            const file = try fs.createFileAbsolute(full_path, .{});
            defer file.close();
            try file.writeAll(content);
        }

        // Update file state
        var state = file_state;
        state.current_hash = if (target_version == 0) state.original_hash else storage.computeHash(content);
        try self.file_states.put(file_path, state);

        try self.saveFileStates();
    }

    /// Get content at a specific version by applying patches
    pub fn getContentAtVersion(self: *Self, file_path: []const u8, target_version: VersionNum) ![]u8 {
        const file_state = self.file_states.get(file_path) orelse {
            return error.FileNotTracked;
        };

        // Start with original content
        var content = try self.store.getOriginal(file_state.original_hash);
        errdefer self.allocator.free(content);

        // Apply patches from version 1 up to target_version
        var v: VersionNum = 1;
        while (v <= target_version and v <= self.current_version) : (v += 1) {
            // Load version metadata to check if it's for this file
            const version_meta = self.store.getVersionMeta(v) catch continue;
            defer self.allocator.free(version_meta);

            // Check if this version is for the requested file
            const version_file_path = extractJsonString(self.allocator, version_meta, "file_path") catch continue;
            defer self.allocator.free(version_file_path);

            if (!std.mem.eql(u8, version_file_path, file_path)) {
                continue; // This version is for a different file
            }

            // Load and apply patch
            const patch_content = self.store.getPatch(v) catch continue;
            defer self.allocator.free(patch_content);

            // Parse the patch
            var p = patch.parse(self.allocator, patch_content) catch continue;
            defer p.deinit();

            // Apply patch to current content
            const new_content = patch.apply(self.allocator, content, p) catch continue;

            // Replace content with new content
            self.allocator.free(content);
            content = new_content;
        }

        return content;
    }

    /// Get session history (list of versions)
    pub fn getHistory(self: *Self, limit: ?u32) ![]Version {
        const max = limit orelse self.current_version;
        const count = @min(max, self.current_version);

        var versions = try self.allocator.alloc(Version, count);
        errdefer self.allocator.free(versions);

        var loaded: usize = 0;
        var v = self.current_version;
        while (v > 0 and loaded < count) : (v -= 1) {
            const meta_json = self.store.getVersionMeta(v) catch continue;
            defer self.allocator.free(meta_json);

            versions[loaded] = try parseVersion(self.allocator, meta_json);
            loaded += 1;
        }

        // Resize to actual loaded count
        if (loaded < count) {
            const resized = try self.allocator.realloc(versions, loaded);
            return resized;
        }

        return versions;
    }

    /// Get status of all tracked files
    pub fn getStatus(self: *Self) ![]FileState {
        var states = try self.allocator.alloc(FileState, self.file_states.count());
        var i: usize = 0;

        var iter = self.file_states.iterator();
        while (iter.next()) |entry| {
            states[i] = entry.value_ptr.*;
            i += 1;
        }

        return states;
    }

    /// Save session metadata
    fn saveMetadata(self: *Self) !void {
        const meta_json = try std.fmt.allocPrint(self.allocator,
            \\{{
            \\  "id": "{s}",
            \\  "project_path": "{s}",
            \\  "created_at": {d},
            \\  "current_version": {d}
            \\}}
        , .{
            &self.id,
            self.project_path,
            std.time.timestamp(),
            self.current_version,
        });
        defer self.allocator.free(meta_json);

        const meta_path = try std.fs.path.join(self.allocator, &.{ self.session_path, "manifest.json" });
        defer self.allocator.free(meta_path);

        try storage.writeFileAtomic(self.allocator, meta_path, meta_json);
    }

    /// Save file states
    fn saveFileStates(self: *Self) !void {
        var json = std.ArrayList(u8){};
        defer json.deinit(self.allocator);

        try json.appendSlice(self.allocator, "[\n");

        var first = true;
        var iter = self.file_states.iterator();
        while (iter.next()) |entry| {
            if (!first) try json.appendSlice(self.allocator, ",\n");
            first = false;

            const state = entry.value_ptr.*;
            const state_json = try std.fmt.allocPrint(self.allocator,
                \\  {{
                \\    "path": "{s}",
                \\    "original_hash": "{s}",
                \\    "current_hash": "{s}",
                \\    "last_version": {d},
                \\    "existed_before": {s}
                \\  }}
            , .{
                state.path,
                &storage.hashToHex(state.original_hash),
                &storage.hashToHex(state.current_hash),
                state.last_version,
                if (state.existed_before) "true" else "false",
            });
            defer self.allocator.free(state_json);

            try json.appendSlice(self.allocator, state_json);
        }

        try json.appendSlice(self.allocator, "\n]");

        const states_path = try std.fs.path.join(self.allocator, &.{ self.session_path, "files.json" });
        defer self.allocator.free(states_path);

        try storage.writeFileAtomic(self.allocator, states_path, json.items);
    }

    /// Load file states from disk
    fn loadFileStates(self: *Self) !void {
        const states_path = try std.fs.path.join(self.allocator, &.{ self.session_path, "files.json" });
        defer self.allocator.free(states_path);

        const json = storage.readFile(self.allocator, states_path) catch {
            return; // No file states yet
        };
        defer self.allocator.free(json);

        // TODO: Parse JSON and load file states
        // For now, skip parsing
    }

    /// Close and cleanup session
    pub fn deinit(self: *Self) void {
        self.allocator.free(self.project_path);
        self.allocator.free(self.session_path);
        self.store.deinit();

        var iter = self.file_states.iterator();
        while (iter.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
        }
        self.file_states.deinit();
    }

    /// Delete the session and all its data
    pub fn delete(self: *Self) !void {
        try self.store.deleteAll();
    }
};

/// Options for trackChange
pub const TrackChangeOptions = struct {
    file_path: []const u8,
    before_content: []const u8,
    after_content: []const u8,
    agent_id: []const u8,
    message: ?[]const u8 = null,
};

// ============ Helper Functions ============

/// Generate a UUID v4 session ID
fn generateSessionId() SessionId {
    var id: SessionId = undefined;

    // Get random bytes
    var random_bytes: [16]u8 = undefined;
    std.crypto.random.bytes(&random_bytes);

    // Set version (4) and variant (RFC 4122)
    random_bytes[6] = (random_bytes[6] & 0x0f) | 0x40;
    random_bytes[8] = (random_bytes[8] & 0x3f) | 0x80;

    // Format as UUID string
    _ = std.fmt.bufPrint(&id, "{x:0>2}{x:0>2}{x:0>2}{x:0>2}-{x:0>2}{x:0>2}-{x:0>2}{x:0>2}-{x:0>2}{x:0>2}-{x:0>2}{x:0>2}{x:0>2}{x:0>2}{x:0>2}{x:0>2}", .{
        random_bytes[0],  random_bytes[1],  random_bytes[2],  random_bytes[3],
        random_bytes[4],  random_bytes[5],
        random_bytes[6],  random_bytes[7],
        random_bytes[8],  random_bytes[9],
        random_bytes[10], random_bytes[11], random_bytes[12], random_bytes[13], random_bytes[14], random_bytes[15],
    }) catch unreachable;

    return id;
}

/// Get the base funcode directory
fn getFuncodeDir(allocator: Allocator) ![]u8 {
    const home = std.posix.getenv("HOME") orelse return error.IoError;
    return std.fs.path.join(allocator, &.{ home, ".funcode" });
}

/// Get the sessions directory
fn getSessionsDir(allocator: Allocator) ![]u8 {
    const funcode_dir = try getFuncodeDir(allocator);
    defer allocator.free(funcode_dir);
    return std.fs.path.join(allocator, &.{ funcode_dir, "sessions" });
}

/// Get path to a session by ID
fn getSessionPath(allocator: Allocator, id: *const SessionId) ![]u8 {
    const sessions_dir = try getSessionsDir(allocator);
    defer allocator.free(sessions_dir);

    // Ensure sessions directory exists (with parents)
    try storage.ensureDirPath(allocator, sessions_dir);

    return std.fs.path.join(allocator, &.{ sessions_dir, id });
}

/// Extract a string field from JSON (simplified)
fn extractJsonString(allocator: Allocator, json: []const u8, field: []const u8) ![]u8 {
    const search_key = try std.fmt.allocPrint(allocator, "\"{s}\":", .{field});
    defer allocator.free(search_key);

    const key_pos = std.mem.indexOf(u8, json, search_key) orelse return error.InvalidSession;
    const value_start = key_pos + search_key.len;

    // Skip whitespace and opening quote
    var i = value_start;
    while (i < json.len and (json[i] == ' ' or json[i] == '"')) : (i += 1) {}

    // Find closing quote
    const start = i;
    while (i < json.len and json[i] != '"') : (i += 1) {}

    return allocator.dupe(u8, json[start..i]);
}

/// Extract a number field from JSON (simplified)
fn extractJsonNumber(json: []const u8, field: []const u8) !u32 {
    var search_buf: [64]u8 = undefined;
    const search_key = std.fmt.bufPrint(&search_buf, "\"{s}\":", .{field}) catch return error.InvalidSession;

    const key_pos = std.mem.indexOf(u8, json, search_key) orelse return error.InvalidSession;
    const value_start = key_pos + search_key.len;

    // Skip whitespace
    var i = value_start;
    while (i < json.len and json[i] == ' ') : (i += 1) {}

    // Parse number
    var end = i;
    while (end < json.len and json[end] >= '0' and json[end] <= '9') : (end += 1) {}

    return std.fmt.parseInt(u32, json[i..end], 10) catch return error.InvalidSession;
}

/// Serialize version to JSON
fn serializeVersion(allocator: Allocator, version: Version) ![]u8 {
    // Format parent_version as string
    var parent_buf: [16]u8 = undefined;
    const parent_str = if (version.parent_version) |pv|
        std.fmt.bufPrint(&parent_buf, "{d}", .{pv}) catch "null"
    else
        "null";

    return std.fmt.allocPrint(allocator,
        \\{{
        \\  "num": {d},
        \\  "file_path": "{s}",
        \\  "agent_id": "{s}",
        \\  "message": "{s}",
        \\  "timestamp": {d},
        \\  "parent_version": {s},
        \\  "additions": {d},
        \\  "deletions": {d}
        \\}}
    , .{
        version.num,
        version.file_path,
        version.agent_id,
        version.message,
        version.timestamp,
        parent_str,
        version.additions,
        version.deletions,
    });
}

/// Parse version from JSON (simplified)
fn parseVersion(allocator: Allocator, json: []const u8) !Version {
    _ = allocator;
    _ = json;
    // TODO: Implement proper JSON parsing
    return Version{
        .num = 0,
        .file_path = "",
        .agent_id = "",
        .message = "",
        .timestamp = 0,
        .parent_version = null,
        .additions = 0,
        .deletions = 0,
    };
}

// ============ Tests ============

test "generateSessionId format" {
    const id = generateSessionId();
    try std.testing.expectEqual(@as(usize, 36), id.len);
    try std.testing.expectEqual(@as(u8, '-'), id[8]);
    try std.testing.expectEqual(@as(u8, '-'), id[13]);
    try std.testing.expectEqual(@as(u8, '-'), id[18]);
    try std.testing.expectEqual(@as(u8, '-'), id[23]);
}

test "generateSessionId uniqueness" {
    const id1 = generateSessionId();
    const id2 = generateSessionId();
    try std.testing.expect(!std.mem.eql(u8, &id1, &id2));
}

test "extractJsonString" {
    const allocator = std.testing.allocator;
    const json =
        \\{"project_path": "/home/user/project", "version": 1}
    ;

    const value = try extractJsonString(allocator, json, "project_path");
    defer allocator.free(value);

    try std.testing.expectEqualStrings("/home/user/project", value);
}

test "extractJsonNumber" {
    const json =
        \\{"project_path": "/home/user/project", "current_version": 42}
    ;

    const value = try extractJsonNumber(json, "current_version");
    try std.testing.expectEqual(@as(u32, 42), value);
}

test "Session create" {
    const allocator = std.testing.allocator;

    var session = try Session.create(allocator, "/tmp/test-project");
    defer session.deinit();
    defer session.delete() catch {};

    try std.testing.expectEqual(@as(VersionNum, 0), session.current_version);
    try std.testing.expectEqualStrings("/tmp/test-project", session.project_path);
}

test "Session trackChange" {
    const allocator = std.testing.allocator;

    var session = try Session.create(allocator, "/tmp/test-project-track");
    defer session.deinit();
    defer session.delete() catch {};

    const version = try session.trackChange(.{
        .file_path = "src/main.zig",
        .before_content = "const x = 1;\n",
        .after_content = "const x = 2;\n",
        .agent_id = "test-agent",
        .message = "Update x value",
    });

    try std.testing.expectEqual(@as(VersionNum, 1), version.num);
    try std.testing.expectEqual(@as(u32, 1), version.additions);
    try std.testing.expectEqual(@as(u32, 1), version.deletions);
}
