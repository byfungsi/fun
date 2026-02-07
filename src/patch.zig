//! Patch generation and manipulation using unified diff format.
//! Implements Myers diff algorithm for efficient diff computation.

const std = @import("std");
const Allocator = std.mem.Allocator;

/// A single line in a diff hunk
pub const DiffLine = struct {
    type: LineType,
    content: []const u8,

    pub const LineType = enum {
        context,
        add,
        remove,
    };
};

/// A hunk in a unified diff
pub const Hunk = struct {
    old_start: u32,
    old_count: u32,
    new_start: u32,
    new_count: u32,
    lines: []const DiffLine,

    pub fn deinit(self: *Hunk, allocator: Allocator) void {
        allocator.free(self.lines);
    }
};

/// Statistics about a patch
pub const Stats = struct {
    additions: u32,
    deletions: u32,

    pub fn changedLines(self: Stats) u32 {
        return self.additions + self.deletions;
    }
};

/// A complete patch
pub const Patch = struct {
    allocator: Allocator,
    hunks: []Hunk,
    stats: Stats,

    pub fn deinit(self: *Patch) void {
        for (self.hunks) |*hunk| {
            self.allocator.free(hunk.lines);
        }
        self.allocator.free(self.hunks);
    }

    pub fn isEmpty(self: Patch) bool {
        return self.hunks.len == 0;
    }

    /// Generate unified diff string
    pub fn toUnifiedDiff(self: Patch, allocator: Allocator, file_path: ?[]const u8) ![]u8 {
        var result = std.ArrayList(u8){};
        errdefer result.deinit(allocator);

        const writer = result.writer(allocator);

        // Write header if file path provided
        if (file_path) |path| {
            try writer.print("--- a/{s}\n", .{path});
            try writer.print("+++ b/{s}\n", .{path});
        }

        // Write hunks
        for (self.hunks) |hunk| {
            try writer.print("@@ -{d},{d} +{d},{d} @@\n", .{
                hunk.old_start,
                hunk.old_count,
                hunk.new_start,
                hunk.new_count,
            });

            for (hunk.lines) |line| {
                const prefix: u8 = switch (line.type) {
                    .context => ' ',
                    .add => '+',
                    .remove => '-',
                };
                try writer.writeByte(prefix);
                try writer.writeAll(line.content);
                try writer.writeByte('\n');
            }
        }

        return result.toOwnedSlice(allocator);
    }
};

/// Edit operation for the diff
const Edit = struct {
    type: EditType,
    old_idx: usize,
    new_idx: usize,

    const EditType = enum {
        equal,
        insert,
        delete,
    };
};

/// Split content into lines
fn splitLines(allocator: Allocator, content: []const u8) ![][]const u8 {
    var lines = std.ArrayList([]const u8){};
    errdefer lines.deinit(allocator);

    var start: usize = 0;
    for (content, 0..) |c, i| {
        if (c == '\n') {
            try lines.append(allocator, content[start..i]);
            start = i + 1;
        }
    }

    // Handle last line without newline
    if (start < content.len) {
        try lines.append(allocator, content[start..]);
    }

    return lines.toOwnedSlice(allocator);
}

/// Myers diff algorithm implementation
/// Returns the shortest edit script to transform `old` into `new`
fn myersDiff(allocator: Allocator, old: []const []const u8, new: []const []const u8) ![]Edit {
    const n = old.len;
    const m = new.len;
    const max = n + m;

    if (max == 0) {
        return &[_]Edit{};
    }

    // V array: stores the furthest reaching D-path endpoints
    // We need indices from -max to +max, so we offset by max
    const v_size = 2 * max + 1;
    const v = try allocator.alloc(isize, v_size);
    defer allocator.free(v);

    // Initialize V[1] = 0 (starting point for first diagonal)
    @memset(v, 0);
    v[1 + max] = 0;

    // Store trace for backtracking
    var trace = std.ArrayList([]isize){};
    defer {
        for (trace.items) |t| {
            allocator.free(t);
        }
        trace.deinit(allocator);
    }

    // Find the shortest edit script
    outer: for (0..max + 1) |d| {
        // Save current V state for backtracking
        const v_copy = try allocator.dupe(isize, v);
        try trace.append(allocator, v_copy);

        const d_signed: isize = @intCast(d);
        var k: isize = -d_signed;
        while (k <= d_signed) : (k += 2) {
            const k_idx: usize = @intCast(k + @as(isize, @intCast(max)));

            var x: isize = undefined;
            if (k == -d_signed or (k != d_signed and v[k_idx - 1] < v[k_idx + 1])) {
                x = v[k_idx + 1]; // Move down
            } else {
                x = v[k_idx - 1] + 1; // Move right
            }

            var y = x - k;

            // Follow diagonal (equal elements)
            while (x < @as(isize, @intCast(n)) and y < @as(isize, @intCast(m))) {
                const x_u: usize = @intCast(x);
                const y_u: usize = @intCast(y);
                if (!std.mem.eql(u8, old[x_u], new[y_u])) {
                    break;
                }
                x += 1;
                y += 1;
            }

            v[k_idx] = x;

            // Check if we've reached the end
            if (x >= @as(isize, @intCast(n)) and y >= @as(isize, @intCast(m))) {
                break :outer;
            }
        }
    }

    // Backtrack to build edit script
    var edits = std.ArrayList(Edit){};
    errdefer edits.deinit(allocator);

    var x: isize = @intCast(n);
    var y: isize = @intCast(m);

    var d_idx = trace.items.len;
    while (d_idx > 0) {
        d_idx -= 1;
        const d: isize = @intCast(d_idx);
        const v_prev = trace.items[d_idx];
        const k = x - y;
        const k_idx: usize = @intCast(k + @as(isize, @intCast(max)));

        var prev_k: isize = undefined;
        if (k == -d or (k != d and v_prev[k_idx - 1] < v_prev[k_idx + 1])) {
            prev_k = k + 1; // Came from above (insert)
        } else {
            prev_k = k - 1; // Came from left (delete)
        }

        const prev_k_idx: usize = @intCast(prev_k + @as(isize, @intCast(max)));
        const prev_x = v_prev[prev_k_idx];
        const prev_y = prev_x - prev_k;

        // Add diagonal moves (equal elements)
        while (x > prev_x and y > prev_y) {
            x -= 1;
            y -= 1;
            try edits.append(allocator, .{
                .type = .equal,
                .old_idx = @intCast(x),
                .new_idx = @intCast(y),
            });
        }

        if (d_idx > 0) {
            if (x == prev_x) {
                // Insert
                y -= 1;
                try edits.append(allocator, .{
                    .type = .insert,
                    .old_idx = @intCast(x),
                    .new_idx = @intCast(y),
                });
            } else {
                // Delete
                x -= 1;
                try edits.append(allocator, .{
                    .type = .delete,
                    .old_idx = @intCast(x),
                    .new_idx = @intCast(y),
                });
            }
        }
    }

    // Reverse to get forward order
    std.mem.reverse(Edit, edits.items);

    return edits.toOwnedSlice(allocator);
}

/// Context lines to include around changes
const CONTEXT_LINES: usize = 3;

/// Generate hunks from edit script
fn generateHunks(
    allocator: Allocator,
    old: []const []const u8,
    new: []const []const u8,
    edits: []const Edit,
) ![]Hunk {
    if (edits.len == 0) {
        return &[_]Hunk{};
    }

    var hunks = std.ArrayList(Hunk){};
    errdefer {
        for (hunks.items) |*h| {
            allocator.free(h.lines);
        }
        hunks.deinit(allocator);
    }

    var lines = std.ArrayList(DiffLine){};
    defer lines.deinit(allocator);

    var hunk_old_start: u32 = 0;
    var hunk_new_start: u32 = 0;
    var hunk_old_count: u32 = 0;
    var hunk_new_count: u32 = 0;
    var in_hunk = false;
    var context_countdown: usize = 0;

    for (edits, 0..) |edit, i| {
        const is_change = edit.type != .equal;

        if (is_change) {
            if (!in_hunk) {
                // Start new hunk, include preceding context
                in_hunk = true;
                const context_start = if (i >= CONTEXT_LINES) i - CONTEXT_LINES else 0;

                // Add preceding context lines
                for (context_start..i) |j| {
                    if (edits[j].type == .equal) {
                        try lines.append(allocator, .{
                            .type = .context,
                            .content = old[edits[j].old_idx],
                        });
                        hunk_old_count += 1;
                        hunk_new_count += 1;
                    }
                }

                if (lines.items.len > 0) {
                    hunk_old_start = @intCast(edits[context_start].old_idx + 1);
                    hunk_new_start = @intCast(edits[context_start].new_idx + 1);
                } else {
                    hunk_old_start = @intCast(edit.old_idx + 1);
                    hunk_new_start = @intCast(edit.new_idx + 1);
                }
            }

            context_countdown = CONTEXT_LINES;

            switch (edit.type) {
                .insert => {
                    try lines.append(allocator, .{
                        .type = .add,
                        .content = new[edit.new_idx],
                    });
                    hunk_new_count += 1;
                },
                .delete => {
                    try lines.append(allocator, .{
                        .type = .remove,
                        .content = old[edit.old_idx],
                    });
                    hunk_old_count += 1;
                },
                .equal => unreachable,
            }
        } else if (in_hunk) {
            // Add context line
            try lines.append(allocator, .{
                .type = .context,
                .content = old[edit.old_idx],
            });
            hunk_old_count += 1;
            hunk_new_count += 1;

            context_countdown -= 1;
            if (context_countdown == 0) {
                // End hunk
                try hunks.append(allocator, .{
                    .old_start = hunk_old_start,
                    .old_count = hunk_old_count,
                    .new_start = hunk_new_start,
                    .new_count = hunk_new_count,
                    .lines = try lines.toOwnedSlice(allocator),
                });

                lines = std.ArrayList(DiffLine){};
                in_hunk = false;
                hunk_old_count = 0;
                hunk_new_count = 0;
            }
        }
    }

    // Finalize last hunk if still open
    if (in_hunk and lines.items.len > 0) {
        try hunks.append(allocator, .{
            .old_start = hunk_old_start,
            .old_count = hunk_old_count,
            .new_start = hunk_new_start,
            .new_count = hunk_new_count,
            .lines = try lines.toOwnedSlice(allocator),
        });
    }

    return hunks.toOwnedSlice(allocator);
}

/// Generate a patch from before/after content
pub fn generate(allocator: Allocator, before: []const u8, after: []const u8) !Patch {
    // Split into lines
    const old_lines = try splitLines(allocator, before);
    defer allocator.free(old_lines);

    const new_lines = try splitLines(allocator, after);
    defer allocator.free(new_lines);

    // Run Myers diff
    const edits = try myersDiff(allocator, old_lines, new_lines);
    defer allocator.free(edits);

    // Generate hunks
    const hunks = try generateHunks(allocator, old_lines, new_lines, edits);

    // Calculate stats
    var additions: u32 = 0;
    var deletions: u32 = 0;
    for (hunks) |hunk| {
        for (hunk.lines) |line| {
            switch (line.type) {
                .add => additions += 1,
                .remove => deletions += 1,
                .context => {},
            }
        }
    }

    return Patch{
        .allocator = allocator,
        .hunks = hunks,
        .stats = .{
            .additions = additions,
            .deletions = deletions,
        },
    };
}

/// Reverse a patch (swap additions and deletions)
pub fn reverse(allocator: Allocator, patch: Patch) !Patch {
    var reversed_hunks = try allocator.alloc(Hunk, patch.hunks.len);
    errdefer allocator.free(reversed_hunks);

    for (patch.hunks, 0..) |hunk, i| {
        var reversed_lines = try allocator.alloc(DiffLine, hunk.lines.len);

        for (hunk.lines, 0..) |line, j| {
            reversed_lines[j] = .{
                .type = switch (line.type) {
                    .add => .remove,
                    .remove => .add,
                    .context => .context,
                },
                .content = line.content,
            };
        }

        reversed_hunks[i] = .{
            .old_start = hunk.new_start,
            .old_count = hunk.new_count,
            .new_start = hunk.old_start,
            .new_count = hunk.old_count,
            .lines = reversed_lines,
        };
    }

    return Patch{
        .allocator = allocator,
        .hunks = reversed_hunks,
        .stats = .{
            .additions = patch.stats.deletions,
            .deletions = patch.stats.additions,
        },
    };
}

/// Apply a patch to content, returning the new content
/// The patch hunks must be applied in order from first to last
pub fn apply(allocator: Allocator, content: []const u8, p: Patch) ![]u8 {
    // Split content into lines
    const lines = try splitLines(allocator, content);
    defer allocator.free(lines);

    // Build result
    var result = std.ArrayList(u8){};
    errdefer result.deinit(allocator);

    const writer = result.writer(allocator);

    var current_line: usize = 0;

    for (p.hunks) |hunk| {
        // old_start is 1-indexed, convert to 0-indexed
        const hunk_start = if (hunk.old_start > 0) hunk.old_start - 1 else 0;

        // Copy lines before this hunk
        while (current_line < hunk_start and current_line < lines.len) {
            try writer.writeAll(lines[current_line]);
            try writer.writeByte('\n');
            current_line += 1;
        }

        // Process hunk lines
        for (hunk.lines) |line| {
            switch (line.type) {
                .context => {
                    // Context line: copy from original (verify it matches)
                    if (current_line < lines.len) {
                        try writer.writeAll(lines[current_line]);
                        try writer.writeByte('\n');
                        current_line += 1;
                    }
                },
                .remove => {
                    // Skip this line from original
                    current_line += 1;
                },
                .add => {
                    // Add new line
                    try writer.writeAll(line.content);
                    try writer.writeByte('\n');
                },
            }
        }
    }

    // Copy remaining lines after last hunk
    while (current_line < lines.len) {
        try writer.writeAll(lines[current_line]);
        try writer.writeByte('\n');
        current_line += 1;
    }

    return result.toOwnedSlice(allocator);
}

/// Parse a unified diff string into a Patch
/// Note: The returned patch's line content slices point into the diff_text,
/// so diff_text must remain valid for the lifetime of the patch
pub fn parse(allocator: Allocator, diff_text: []const u8) !Patch {
    var hunks = std.ArrayList(Hunk){};
    errdefer {
        for (hunks.items) |*h| {
            allocator.free(h.lines);
        }
        hunks.deinit(allocator);
    }

    var additions: u32 = 0;
    var deletions: u32 = 0;

    // Split diff into lines
    const diff_lines = try splitLines(allocator, diff_text);
    defer allocator.free(diff_lines);

    var i: usize = 0;

    // Skip header lines (--- and +++)
    while (i < diff_lines.len) {
        const line = diff_lines[i];
        if (line.len >= 2 and line[0] == '@' and line[1] == '@') {
            break;
        }
        i += 1;
    }

    // Parse hunks
    while (i < diff_lines.len) {
        const line = diff_lines[i];

        // Check for hunk header: @@ -old_start,old_count +new_start,new_count @@
        if (line.len >= 4 and std.mem.startsWith(u8, line, "@@ ")) {
            // Parse hunk header
            const header = parseHunkHeader(line) orelse {
                i += 1;
                continue;
            };

            i += 1;

            // Collect hunk lines
            var hunk_lines = std.ArrayList(DiffLine){};
            errdefer hunk_lines.deinit(allocator);

            while (i < diff_lines.len) {
                const hunk_line = diff_lines[i];

                // Stop at next hunk or end
                if (hunk_line.len >= 2 and hunk_line[0] == '@' and hunk_line[1] == '@') {
                    break;
                }

                if (hunk_line.len == 0) {
                    // Empty line is treated as context
                    try hunk_lines.append(allocator, .{
                        .type = .context,
                        .content = "",
                    });
                } else {
                    const prefix = hunk_line[0];
                    const content = if (hunk_line.len > 1) hunk_line[1..] else "";

                    const line_type: DiffLine.LineType = switch (prefix) {
                        '+' => blk: {
                            additions += 1;
                            break :blk .add;
                        },
                        '-' => blk: {
                            deletions += 1;
                            break :blk .remove;
                        },
                        ' ' => .context,
                        '\\' => {
                            // "\ No newline at end of file" - skip
                            i += 1;
                            continue;
                        },
                        else => {
                            // Treat as context if no recognized prefix
                            try hunk_lines.append(allocator, .{
                                .type = .context,
                                .content = hunk_line,
                            });
                            i += 1;
                            continue;
                        },
                    };

                    try hunk_lines.append(allocator, .{
                        .type = line_type,
                        .content = content,
                    });
                }

                i += 1;
            }

            try hunks.append(allocator, .{
                .old_start = header.old_start,
                .old_count = header.old_count,
                .new_start = header.new_start,
                .new_count = header.new_count,
                .lines = try hunk_lines.toOwnedSlice(allocator),
            });
        } else {
            i += 1;
        }
    }

    return Patch{
        .allocator = allocator,
        .hunks = try hunks.toOwnedSlice(allocator),
        .stats = .{
            .additions = additions,
            .deletions = deletions,
        },
    };
}

/// Parse hunk header: @@ -old_start,old_count +new_start,new_count @@
fn parseHunkHeader(line: []const u8) ?struct {
    old_start: u32,
    old_count: u32,
    new_start: u32,
    new_count: u32,
} {
    // Format: @@ -1,3 +1,4 @@
    // Find the range specifications
    const at_end = std.mem.indexOf(u8, line[3..], " @@") orelse return null;
    const range_part = line[3 .. 3 + at_end];

    // Split by space
    var iter = std.mem.splitScalar(u8, range_part, ' ');
    const old_range = iter.next() orelse return null;
    const new_range = iter.next() orelse return null;

    // Parse old range: -start,count or -start
    if (!std.mem.startsWith(u8, old_range, "-")) return null;
    const old_nums = old_range[1..];
    var old_start: u32 = 0;
    var old_count: u32 = 1;

    if (std.mem.indexOf(u8, old_nums, ",")) |comma| {
        old_start = std.fmt.parseInt(u32, old_nums[0..comma], 10) catch return null;
        old_count = std.fmt.parseInt(u32, old_nums[comma + 1 ..], 10) catch return null;
    } else {
        old_start = std.fmt.parseInt(u32, old_nums, 10) catch return null;
    }

    // Parse new range: +start,count or +start
    if (!std.mem.startsWith(u8, new_range, "+")) return null;
    const new_nums = new_range[1..];
    var new_start: u32 = 0;
    var new_count: u32 = 1;

    if (std.mem.indexOf(u8, new_nums, ",")) |comma| {
        new_start = std.fmt.parseInt(u32, new_nums[0..comma], 10) catch return null;
        new_count = std.fmt.parseInt(u32, new_nums[comma + 1 ..], 10) catch return null;
    } else {
        new_start = std.fmt.parseInt(u32, new_nums, 10) catch return null;
    }

    return .{
        .old_start = old_start,
        .old_count = old_count,
        .new_start = new_start,
        .new_count = new_count,
    };
}

// ============ Tests ============

test "splitLines basic" {
    const allocator = std.testing.allocator;

    const lines = try splitLines(allocator, "line1\nline2\nline3");
    defer allocator.free(lines);

    try std.testing.expectEqual(@as(usize, 3), lines.len);
    try std.testing.expectEqualStrings("line1", lines[0]);
    try std.testing.expectEqualStrings("line2", lines[1]);
    try std.testing.expectEqualStrings("line3", lines[2]);
}

test "generate simple patch" {
    const allocator = std.testing.allocator;

    const before = "line1\nline2\nline3\n";
    const after = "line1\nmodified\nline3\n";

    var patch = try generate(allocator, before, after);
    defer patch.deinit();

    try std.testing.expectEqual(@as(u32, 1), patch.stats.additions);
    try std.testing.expectEqual(@as(u32, 1), patch.stats.deletions);
    try std.testing.expect(!patch.isEmpty());
}

test "generate patch with additions only" {
    const allocator = std.testing.allocator;

    const before = "line1\nline2\n";
    const after = "line1\nline2\nline3\n";

    var patch = try generate(allocator, before, after);
    defer patch.deinit();

    try std.testing.expectEqual(@as(u32, 1), patch.stats.additions);
    try std.testing.expectEqual(@as(u32, 0), patch.stats.deletions);
}

test "generate patch with deletions only" {
    const allocator = std.testing.allocator;

    const before = "line1\nline2\nline3\n";
    const after = "line1\nline3\n";

    var patch = try generate(allocator, before, after);
    defer patch.deinit();

    try std.testing.expectEqual(@as(u32, 0), patch.stats.additions);
    try std.testing.expectEqual(@as(u32, 1), patch.stats.deletions);
}

test "generate empty patch for identical content" {
    const allocator = std.testing.allocator;

    const content = "line1\nline2\n";

    var patch = try generate(allocator, content, content);
    defer patch.deinit();

    try std.testing.expect(patch.isEmpty());
    try std.testing.expectEqual(@as(u32, 0), patch.stats.additions);
    try std.testing.expectEqual(@as(u32, 0), patch.stats.deletions);
}

test "toUnifiedDiff format" {
    const allocator = std.testing.allocator;

    const before = "line1\nline2\nline3\n";
    const after = "line1\nmodified\nline3\n";

    var p = try generate(allocator, before, after);
    defer p.deinit();

    const diff = try p.toUnifiedDiff(allocator, "test.txt");
    defer allocator.free(diff);

    // Should contain unified diff markers
    try std.testing.expect(std.mem.indexOf(u8, diff, "--- a/test.txt") != null);
    try std.testing.expect(std.mem.indexOf(u8, diff, "+++ b/test.txt") != null);
    try std.testing.expect(std.mem.indexOf(u8, diff, "@@") != null);
    try std.testing.expect(std.mem.indexOf(u8, diff, "-line2") != null);
    try std.testing.expect(std.mem.indexOf(u8, diff, "+modified") != null);
}

test "parse unified diff" {
    const allocator = std.testing.allocator;

    const diff_text =
        \\--- a/test.txt
        \\+++ b/test.txt
        \\@@ -1,3 +1,3 @@
        \\ line1
        \\-line2
        \\+modified
        \\ line3
    ;

    var p = try parse(allocator, diff_text);
    defer p.deinit();

    try std.testing.expectEqual(@as(usize, 1), p.hunks.len);
    try std.testing.expectEqual(@as(u32, 1), p.stats.additions);
    try std.testing.expectEqual(@as(u32, 1), p.stats.deletions);

    const hunk = p.hunks[0];
    try std.testing.expectEqual(@as(u32, 1), hunk.old_start);
    try std.testing.expectEqual(@as(u32, 3), hunk.old_count);
    try std.testing.expectEqual(@as(u32, 1), hunk.new_start);
    try std.testing.expectEqual(@as(u32, 3), hunk.new_count);
}

test "apply patch" {
    const allocator = std.testing.allocator;

    const before = "line1\nline2\nline3\n";
    const after = "line1\nmodified\nline3\n";

    // Generate patch
    var p = try generate(allocator, before, after);
    defer p.deinit();

    // Apply patch to before content
    const result = try apply(allocator, before, p);
    defer allocator.free(result);

    // Should match after content
    try std.testing.expectEqualStrings(after, result);
}

test "apply parsed patch" {
    const allocator = std.testing.allocator;

    const before = "line1\nline2\nline3\n";
    const expected = "line1\nmodified\nline3\n";

    const diff_text =
        \\--- a/test.txt
        \\+++ b/test.txt
        \\@@ -1,3 +1,3 @@
        \\ line1
        \\-line2
        \\+modified
        \\ line3
    ;

    var p = try parse(allocator, diff_text);
    defer p.deinit();

    const result = try apply(allocator, before, p);
    defer allocator.free(result);

    try std.testing.expectEqualStrings(expected, result);
}

test "apply patch with additions only" {
    const allocator = std.testing.allocator;

    const before = "line1\nline2\n";
    const after = "line1\nline2\nline3\n";

    var p = try generate(allocator, before, after);
    defer p.deinit();

    const result = try apply(allocator, before, p);
    defer allocator.free(result);

    try std.testing.expectEqualStrings(after, result);
}

test "apply patch with deletions only" {
    const allocator = std.testing.allocator;

    const before = "line1\nline2\nline3\n";
    const after = "line1\nline3\n";

    var p = try generate(allocator, before, after);
    defer p.deinit();

    const result = try apply(allocator, before, p);
    defer allocator.free(result);

    try std.testing.expectEqualStrings(after, result);
}

test "roundtrip: generate, serialize, parse, apply" {
    const allocator = std.testing.allocator;

    const before = "function hello() {\n  console.log('hello');\n}\n";
    const after = "function hello() {\n  console.log('hello world!');\n  return true;\n}\n";

    // Generate patch
    var p1 = try generate(allocator, before, after);
    defer p1.deinit();

    // Serialize to unified diff
    const diff_text = try p1.toUnifiedDiff(allocator, "test.js");
    defer allocator.free(diff_text);

    // Parse back
    var p2 = try parse(allocator, diff_text);
    defer p2.deinit();

    // Apply
    const result = try apply(allocator, before, p2);
    defer allocator.free(result);

    try std.testing.expectEqualStrings(after, result);
}
