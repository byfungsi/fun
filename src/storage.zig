//! Content-addressed storage for files and patches.
//! Uses Blake3 for hashing and Zstd for compression.

const std = @import("std");
const Allocator = std.mem.Allocator;
const fs = std.fs;

/// Hash type for content addressing
pub const Hash = [32]u8;

/// Storage errors
pub const StorageError = error{
    InvalidPath,
    CorruptedContent,
    HashMismatch,
    IoError,
};

/// Content-addressed storage manager
pub const Storage = struct {
    allocator: Allocator,
    base_path: []const u8,
    originals_dir: []const u8,
    patches_dir: []const u8,
    versions_dir: []const u8,

    const Self = @This();

    /// Initialize storage for a session
    pub fn init(allocator: Allocator, session_path: []const u8) !Self {
        // Create subdirectories
        const originals_dir = try std.fs.path.join(allocator, &.{ session_path, "originals" });
        errdefer allocator.free(originals_dir);

        const patches_dir = try std.fs.path.join(allocator, &.{ session_path, "patches" });
        errdefer allocator.free(patches_dir);

        const versions_dir = try std.fs.path.join(allocator, &.{ session_path, "versions" });
        errdefer allocator.free(versions_dir);

        const base_path = try allocator.dupe(u8, session_path);
        errdefer allocator.free(base_path);

        // Ensure directories exist
        try ensureDir(session_path);
        try ensureDir(originals_dir);
        try ensureDir(patches_dir);
        try ensureDir(versions_dir);

        return Self{
            .allocator = allocator,
            .base_path = base_path,
            .originals_dir = originals_dir,
            .patches_dir = patches_dir,
            .versions_dir = versions_dir,
        };
    }

    pub fn deinit(self: *Self) void {
        self.allocator.free(self.base_path);
        self.allocator.free(self.originals_dir);
        self.allocator.free(self.patches_dir);
        self.allocator.free(self.versions_dir);
    }

    /// Store original file content, returns content hash
    pub fn storeOriginal(self: Self, content: []const u8) !Hash {
        const hash = computeHash(content);

        // Check if already exists
        const path = try self.getOriginalPath(hash);
        defer self.allocator.free(path);

        if (fileExists(path)) {
            return hash;
        }

        // Compress and write
        const compressed = try compress(self.allocator, content);
        defer self.allocator.free(compressed);

        try writeFileAtomic(self.allocator, path, compressed);

        return hash;
    }

    /// Retrieve original file content by hash
    pub fn getOriginal(self: Self, hash: Hash) ![]u8 {
        const path = try self.getOriginalPath(hash);
        defer self.allocator.free(path);

        const compressed = try readFile(self.allocator, path);
        defer self.allocator.free(compressed);

        const content = try decompress(self.allocator, compressed);

        // Verify hash
        const actual_hash = computeHash(content);
        if (!std.mem.eql(u8, &hash, &actual_hash)) {
            self.allocator.free(content);
            return error.HashMismatch;
        }

        return content;
    }

    /// Check if original exists
    pub fn hasOriginal(self: Self, hash: Hash) !bool {
        const path = try self.getOriginalPath(hash);
        defer self.allocator.free(path);
        return fileExists(path);
    }

    /// Store a patch, returns patch ID
    pub fn storePatch(self: Self, patch_content: []const u8, version_num: u32) !void {
        const filename = try std.fmt.allocPrint(self.allocator, "{d:0>4}.diff.zst", .{version_num});
        defer self.allocator.free(filename);

        const path = try std.fs.path.join(self.allocator, &.{ self.patches_dir, filename });
        defer self.allocator.free(path);

        const compressed = try compress(self.allocator, patch_content);
        defer self.allocator.free(compressed);

        try writeFileAtomic(self.allocator, path, compressed);
    }

    /// Retrieve a patch by version number
    pub fn getPatch(self: Self, version_num: u32) ![]u8 {
        const filename = try std.fmt.allocPrint(self.allocator, "{d:0>4}.diff.zst", .{version_num});
        defer self.allocator.free(filename);

        const path = try std.fs.path.join(self.allocator, &.{ self.patches_dir, filename });
        defer self.allocator.free(path);

        const compressed = try readFile(self.allocator, path);
        defer self.allocator.free(compressed);

        return try decompress(self.allocator, compressed);
    }

    /// Store version metadata as JSON
    pub fn storeVersionMeta(self: Self, version_num: u32, json_content: []const u8) !void {
        const filename = try std.fmt.allocPrint(self.allocator, "{d:0>4}.json", .{version_num});
        defer self.allocator.free(filename);

        const path = try std.fs.path.join(self.allocator, &.{ self.versions_dir, filename });
        defer self.allocator.free(path);

        try writeFileAtomic(self.allocator, path, json_content);
    }

    /// Retrieve version metadata
    pub fn getVersionMeta(self: Self, version_num: u32) ![]u8 {
        const filename = try std.fmt.allocPrint(self.allocator, "{d:0>4}.json", .{version_num});
        defer self.allocator.free(filename);

        const path = try std.fs.path.join(self.allocator, &.{ self.versions_dir, filename });
        defer self.allocator.free(path);

        return try readFile(self.allocator, path);
    }

    /// Get path to original file by hash (content-addressed: ab/cdef...)
    fn getOriginalPath(self: Self, hash: Hash) ![]u8 {
        const hex = std.fmt.bytesToHex(hash, .lower);

        // First 2 chars as directory
        const subdir = try std.fs.path.join(self.allocator, &.{ self.originals_dir, hex[0..2] });
        defer self.allocator.free(subdir);

        try ensureDir(subdir);

        // Rest as filename (without .zst extension for now - no compression)
        const filename = try std.fmt.allocPrint(self.allocator, "{s}.bin", .{hex[2..]});
        defer self.allocator.free(filename);

        return try std.fs.path.join(self.allocator, &.{ subdir, filename });
    }

    /// Get next version number
    pub fn getNextVersionNum(self: Self) !u32 {
        var dir = fs.openDirAbsolute(self.versions_dir, .{ .iterate = true }) catch |err| {
            if (err == error.FileNotFound) return 1;
            return err;
        };
        defer dir.close();

        var max_version: u32 = 0;
        var iter = dir.iterate();
        while (try iter.next()) |entry| {
            if (entry.kind != .file) continue;
            if (!std.mem.endsWith(u8, entry.name, ".json")) continue;

            // Parse version number from filename (0001.json)
            const num_str = entry.name[0..4];
            const num = std.fmt.parseInt(u32, num_str, 10) catch continue;
            if (num > max_version) max_version = num;
        }

        return max_version + 1;
    }

    /// Delete all storage for this session
    pub fn deleteAll(self: Self) !void {
        try fs.deleteTreeAbsolute(self.base_path);
    }
};

// ============ Hash Functions ============

/// Compute Blake3 hash of content
pub fn computeHash(content: []const u8) Hash {
    var hasher = std.crypto.hash.Blake3.init(.{});
    hasher.update(content);
    var result: Hash = undefined;
    hasher.final(&result);
    return result;
}

/// Format hash as hex string
pub fn hashToHex(hash: Hash) [64]u8 {
    return std.fmt.bytesToHex(hash, .lower);
}

/// Parse hash from hex string
pub fn hexToHash(hex: []const u8) !Hash {
    if (hex.len != 64) return error.InvalidHash;

    var hash: Hash = undefined;
    _ = std.fmt.hexToBytes(&hash, hex) catch return error.InvalidHash;
    return hash;
}

// ============ Compression Functions ============
// Storage format is forward-compatible with zstd compression.
// Currently stores data uncompressed for simplicity.
//
// Format:
// - Uncompressed: [4 zero bytes] + raw data
// - Zstd: [zstd magic: 0x28B52FFD] + compressed data
//
// To add compression later, link libzstd and update compress()
// while keeping decompress() backwards-compatible.

/// Compress data for storage
/// Currently stores uncompressed with a 4-byte header for format detection
pub fn compress(allocator: Allocator, data: []const u8) ![]u8 {
    // Format: [4-byte magic: 0x00000000] + raw data
    // Zero magic indicates uncompressed format
    const result = try allocator.alloc(u8, 4 + data.len);
    result[0] = 0x00;
    result[1] = 0x00;
    result[2] = 0x00;
    result[3] = 0x00;
    @memcpy(result[4..], data);
    return result;
}

/// Decompress stored data
/// Handles both uncompressed (zero magic) and zstd formats
pub fn decompress(allocator: Allocator, data: []const u8) ![]u8 {
    if (data.len < 4) return error.CorruptedContent;

    // Check for uncompressed marker (4 zero bytes)
    if (data[0] == 0x00 and data[1] == 0x00 and data[2] == 0x00 and data[3] == 0x00) {
        return try allocator.dupe(u8, data[4..]);
    }

    // Check for zstd magic (0x28B52FFD in little endian)
    if (data[0] == 0x28 and data[1] == 0xB5 and data[2] == 0x2F and data[3] == 0xFD) {
        // TODO: Implement zstd decompression using std.compress.zstd.Decompress
        // The Zig 0.15 API uses: std.compress.zstd.Decompress.init(reader, header, options)
        // For now, return error as we don't write zstd-compressed data yet
        return error.CorruptedContent;
    }

    return error.CorruptedContent;
}

// ============ File System Helpers ============

pub fn ensureDir(path: []const u8) !void {
    fs.makeDirAbsolute(path) catch |err| {
        if (err == error.PathAlreadyExists) return;
        if (err == error.FileNotFound) {
            // Parent doesn't exist, need to create it
            // This is a simplified implementation - proper one would use makePath
            return err;
        }
        return err;
    };
}

/// Create directory and all parent directories
pub fn ensureDirPath(allocator: Allocator, path: []const u8) !void {
    // Try to create the directory
    fs.makeDirAbsolute(path) catch |err| {
        if (err == error.PathAlreadyExists) return;
        if (err == error.FileNotFound) {
            // Parent doesn't exist, create it first
            if (std.fs.path.dirname(path)) |parent| {
                try ensureDirPath(allocator, parent);
                // Now try again
                fs.makeDirAbsolute(path) catch |err2| {
                    if (err2 != error.PathAlreadyExists) return err2;
                };
                return;
            }
        }
        return err;
    };
}

pub fn fileExists(path: []const u8) bool {
    fs.accessAbsolute(path, .{}) catch return false;
    return true;
}

pub fn readFile(allocator: Allocator, path: []const u8) ![]u8 {
    const file = try fs.openFileAbsolute(path, .{});
    defer file.close();

    const stat = try file.stat();
    const size = stat.size;

    const buffer = try allocator.alloc(u8, size);
    errdefer allocator.free(buffer);

    const bytes_read = try file.readAll(buffer);
    if (bytes_read != size) {
        allocator.free(buffer);
        return error.IoError;
    }

    return buffer;
}

pub fn writeFileAtomic(allocator: Allocator, path: []const u8, content: []const u8) !void {
    // Write to temp file, then rename
    const tmp_path = try std.fmt.allocPrint(allocator, "{s}.tmp", .{path});
    defer allocator.free(tmp_path);

    const file = try fs.createFileAbsolute(tmp_path, .{});
    errdefer {
        file.close();
        fs.deleteFileAbsolute(tmp_path) catch {};
    }

    try file.writeAll(content);
    file.close();

    // Atomic rename
    try fs.renameAbsolute(tmp_path, path);
}

// ============ Tests ============

test "computeHash consistency" {
    const content = "Hello, World!";
    const hash1 = computeHash(content);
    const hash2 = computeHash(content);
    try std.testing.expectEqualSlices(u8, &hash1, &hash2);
}

test "computeHash different for different content" {
    const hash1 = computeHash("Hello");
    const hash2 = computeHash("World");
    try std.testing.expect(!std.mem.eql(u8, &hash1, &hash2));
}

test "hashToHex and hexToHash roundtrip" {
    const original = "Test content for hashing";
    const hash = computeHash(original);
    const hex = hashToHex(hash);
    const recovered = try hexToHash(&hex);
    try std.testing.expectEqualSlices(u8, &hash, &recovered);
}

test "Storage init and deinit" {
    const allocator = std.testing.allocator;

    // Use a temp directory
    const tmp_dir = "/tmp/funcode-test-storage";

    var storage = try Storage.init(allocator, tmp_dir);
    defer storage.deinit();
    defer storage.deleteAll() catch {};

    // Verify directories were created
    try std.testing.expect(fileExists(storage.originals_dir));
    try std.testing.expect(fileExists(storage.patches_dir));
    try std.testing.expect(fileExists(storage.versions_dir));
}

test "Storage storeOriginal and getOriginal" {
    const allocator = std.testing.allocator;
    const tmp_dir = "/tmp/funcode-test-storage-original";

    var storage = try Storage.init(allocator, tmp_dir);
    defer storage.deinit();
    defer storage.deleteAll() catch {};

    const content = "Original file content for testing";
    const hash = try storage.storeOriginal(content);

    // Should be able to retrieve it
    const retrieved = try storage.getOriginal(hash);
    defer allocator.free(retrieved);

    try std.testing.expectEqualStrings(content, retrieved);
}

test "Storage storeOriginal deduplication" {
    const allocator = std.testing.allocator;
    const tmp_dir = "/tmp/funcode-test-storage-dedup";

    var storage = try Storage.init(allocator, tmp_dir);
    defer storage.deinit();
    defer storage.deleteAll() catch {};

    const content = "Same content stored twice";
    const hash1 = try storage.storeOriginal(content);
    const hash2 = try storage.storeOriginal(content);

    // Should return same hash
    try std.testing.expectEqualSlices(u8, &hash1, &hash2);
}

test "Storage storePatch and getPatch" {
    const allocator = std.testing.allocator;
    const tmp_dir = "/tmp/funcode-test-storage-patch";

    var storage = try Storage.init(allocator, tmp_dir);
    defer storage.deinit();
    defer storage.deleteAll() catch {};

    const patch_content =
        \\--- a/test.txt
        \\+++ b/test.txt
        \\@@ -1,3 +1,3 @@
        \\ line1
        \\-line2
        \\+modified
        \\ line3
    ;

    try storage.storePatch(patch_content, 1);

    const retrieved = try storage.getPatch(1);
    defer allocator.free(retrieved);

    try std.testing.expectEqualStrings(patch_content, retrieved);
}

test "Storage getNextVersionNum" {
    const allocator = std.testing.allocator;
    const tmp_dir = "/tmp/funcode-test-storage-version";

    var storage = try Storage.init(allocator, tmp_dir);
    defer storage.deinit();
    defer storage.deleteAll() catch {};

    // Initially should be 1
    const v1 = try storage.getNextVersionNum();
    try std.testing.expectEqual(@as(u32, 1), v1);

    // Store a version
    try storage.storeVersionMeta(1, "{}");

    // Should now be 2
    const v2 = try storage.getNextVersionNum();
    try std.testing.expectEqual(@as(u32, 2), v2);
}
