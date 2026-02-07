//! Funcode CLI - AI-friendly version control
//! Command-line interface for funcode operations.

const std = @import("std");
const lib = @import("lib.zig");
const session = @import("session.zig");
const storage = @import("storage.zig");

const Allocator = std.mem.Allocator;

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    var args = try std.process.argsWithAllocator(allocator);
    defer args.deinit();

    // Skip program name
    _ = args.skip();

    const command = args.next() orelse {
        printUsage();
        return;
    };

    if (std.mem.eql(u8, command, "help") or std.mem.eql(u8, command, "--help") or std.mem.eql(u8, command, "-h")) {
        printUsage();
    } else if (std.mem.eql(u8, command, "version") or std.mem.eql(u8, command, "--version") or std.mem.eql(u8, command, "-v")) {
        printVersion();
    } else if (std.mem.eql(u8, command, "diff")) {
        try cmdDiff(allocator, &args);
    } else if (std.mem.eql(u8, command, "init")) {
        try cmdInit(allocator);
    } else if (std.mem.eql(u8, command, "status")) {
        try cmdStatus(allocator);
    } else if (std.mem.eql(u8, command, "log")) {
        try cmdLog(allocator, &args);
    } else if (std.mem.eql(u8, command, "hash")) {
        try cmdHash(allocator, &args);
    } else {
        std.debug.print("Unknown command: {s}\n\n", .{command});
        printUsage();
        std.process.exit(1);
    }
}

fn printUsage() void {
    const usage =
        \\funcode - AI-friendly version control
        \\
        \\Usage: fun <command> [options]
        \\
        \\Commands:
        \\  init                    Initialize a new session for the current directory
        \\  status                  Show tracked files and their status
        \\  log [limit]             Show version history (default: 10)
        \\  diff <file1> <file2>    Show diff between two files
        \\  hash <file>             Compute Blake3 hash of a file
        \\  help                    Show this help message
        \\  version                 Show version
        \\
        \\Options:
        \\  -h, --help              Show help
        \\  -v, --version           Show version
        \\
        \\Examples:
        \\  fun init                Initialize session in current directory
        \\  fun status              Show what files are being tracked
        \\  fun log 5               Show last 5 versions
        \\  fun diff a.txt b.txt    Show diff between two files
        \\  fun hash myfile.txt     Show Blake3 hash of file
        \\
    ;
    const stdout = std.fs.File.stdout().deprecatedWriter();
    stdout.print("{s}", .{usage}) catch {};
}

fn printVersion() void {
    const stdout = std.fs.File.stdout().deprecatedWriter();
    stdout.print("funcode 0.1.0\n", .{}) catch {};
}

fn cmdDiff(allocator: Allocator, args: *std.process.ArgIterator) !void {
    const stdout = std.fs.File.stdout().deprecatedWriter();
    const stderr = std.fs.File.stderr().deprecatedWriter();

    const file1 = args.next() orelse {
        try stderr.print("Error: diff requires two file arguments\n", .{});
        std.process.exit(1);
    };

    const file2 = args.next() orelse {
        try stderr.print("Error: diff requires two file arguments\n", .{});
        std.process.exit(1);
    };

    // Read files
    const content1 = std.fs.cwd().readFileAlloc(allocator, file1, 10 * 1024 * 1024) catch |err| {
        try stderr.print("Error reading {s}: {}\n", .{ file1, err });
        std.process.exit(1);
    };
    defer allocator.free(content1);

    const content2 = std.fs.cwd().readFileAlloc(allocator, file2, 10 * 1024 * 1024) catch |err| {
        try stderr.print("Error reading {s}: {}\n", .{ file2, err });
        std.process.exit(1);
    };
    defer allocator.free(content2);

    // Generate diff
    var patch = try lib.generate(allocator, content1, content2);
    defer patch.deinit();

    if (patch.isEmpty()) {
        try stdout.print("Files are identical\n", .{});
        return;
    }

    // Print unified diff
    const diff = try patch.toUnifiedDiff(allocator, file1);
    defer allocator.free(diff);

    try stdout.print("{s}", .{diff});
    try stdout.print("\n{d} addition(s), {d} deletion(s)\n", .{ patch.stats.additions, patch.stats.deletions });
}

fn cmdInit(allocator: Allocator) !void {
    const stdout = std.fs.File.stdout().deprecatedWriter();
    const stderr = std.fs.File.stderr().deprecatedWriter();

    // Get current working directory
    var cwd_buf: [std.fs.max_path_bytes]u8 = undefined;
    const cwd = std.fs.cwd().realpath(".", &cwd_buf) catch |err| {
        try stderr.print("Error getting current directory: {}\n", .{err});
        std.process.exit(1);
    };

    // Create session
    var sess = session.Session.create(allocator, cwd) catch |err| {
        if (err == error.SessionExists) {
            try stderr.print("Session already exists for this directory\n", .{});
            std.process.exit(1);
        }
        try stderr.print("Error creating session: {}\n", .{err});
        std.process.exit(1);
    };
    defer sess.deinit();

    try stdout.print("Initialized funcode session: {s}\n", .{&sess.id});
    try stdout.print("Project path: {s}\n", .{cwd});
}

fn cmdStatus(allocator: Allocator) !void {
    const stdout = std.fs.File.stdout().deprecatedWriter();
    const stderr = std.fs.File.stderr().deprecatedWriter();

    // Get current working directory
    var cwd_buf: [std.fs.max_path_bytes]u8 = undefined;
    const cwd = std.fs.cwd().realpath(".", &cwd_buf) catch |err| {
        try stderr.print("Error getting current directory: {}\n", .{err});
        std.process.exit(1);
    };

    // Load or create session
    var sess = session.Session.loadOrCreate(allocator, cwd) catch |err| {
        try stderr.print("Error loading session: {}\n", .{err});
        std.process.exit(1);
    };
    defer sess.deinit();

    // Get status
    const states = try sess.getStatus();
    defer allocator.free(states);

    try stdout.print("Session: {s}\n", .{&sess.id});
    try stdout.print("Project: {s}\n", .{sess.project_path});
    try stdout.print("Version: {d}\n\n", .{sess.current_version});

    if (states.len == 0) {
        try stdout.print("No files tracked yet.\n", .{});
        return;
    }

    try stdout.print("Tracked files:\n", .{});
    for (states) |state| {
        const status_char: u8 = if (std.mem.eql(u8, &state.original_hash, &state.current_hash)) ' ' else 'M';
        try stdout.print("  [{c}] {s}\n", .{ status_char, state.path });
    }
}

fn cmdLog(allocator: Allocator, args: *std.process.ArgIterator) !void {
    const stdout = std.fs.File.stdout().deprecatedWriter();
    const stderr = std.fs.File.stderr().deprecatedWriter();

    // Parse optional limit
    var limit: u32 = 10;
    if (args.next()) |limit_str| {
        limit = std.fmt.parseInt(u32, limit_str, 10) catch {
            try stderr.print("Invalid limit: {s}\n", .{limit_str});
            std.process.exit(1);
        };
    }

    // Get current working directory
    var cwd_buf: [std.fs.max_path_bytes]u8 = undefined;
    const cwd = std.fs.cwd().realpath(".", &cwd_buf) catch |err| {
        try stderr.print("Error getting current directory: {}\n", .{err});
        std.process.exit(1);
    };

    // Load session
    var sess = session.Session.loadOrCreate(allocator, cwd) catch |err| {
        try stderr.print("Error loading session: {}\n", .{err});
        std.process.exit(1);
    };
    defer sess.deinit();

    // Get history
    const versions = try sess.getHistory(limit);
    defer allocator.free(versions);

    if (versions.len == 0) {
        try stdout.print("No versions recorded yet.\n", .{});
        return;
    }

    try stdout.print("Version history (showing {d} of {d}):\n\n", .{ versions.len, sess.current_version });

    for (versions) |v| {
        try stdout.print("Version {d}\n", .{v.num});
        try stdout.print("  File:    {s}\n", .{v.file_path});
        try stdout.print("  Agent:   {s}\n", .{v.agent_id});
        try stdout.print("  Message: {s}\n", .{v.message});
        try stdout.print("  Changes: +{d} -{d}\n", .{ v.additions, v.deletions });
        try stdout.print("\n", .{});
    }
}

fn cmdHash(allocator: Allocator, args: *std.process.ArgIterator) !void {
    const stdout = std.fs.File.stdout().deprecatedWriter();
    const stderr = std.fs.File.stderr().deprecatedWriter();

    const file = args.next() orelse {
        try stderr.print("Error: hash requires a file argument\n", .{});
        std.process.exit(1);
    };

    // Read file
    const content = std.fs.cwd().readFileAlloc(allocator, file, 100 * 1024 * 1024) catch |err| {
        try stderr.print("Error reading {s}: {}\n", .{ file, err });
        std.process.exit(1);
    };
    defer allocator.free(content);

    // Compute hash
    const hash = storage.computeHash(content);
    const hex = storage.hashToHex(hash);

    try stdout.print("{s}  {s}\n", .{ &hex, file });
}
