# Funcode

AI-friendly version control for tracking AI file changes. Built with Zig + TypeScript.

## Features

- **Track AI Changes** - Record every file modification made by AI agents
- **Undo/Redo** - Revert to any previous version instantly
- **Conflict Detection** - Detect when humans modify files between AI edits
- **Multi-Agent Support** - File locking for coordinating multiple AI agents
- **Fast & Lightweight** - Native Zig core with minimal overhead

## Installation

```bash
bun add @byfungsi/fun
```

> **Note:** Requires [Bun](https://bun.sh) runtime (uses Bun FFI for native bindings)

## Quick Start

```typescript
import { loadOrCreateSession, FileTracker } from "@byfungsi/fun";

// Create a session for your project
const session = await loadOrCreateSession("/path/to/project");
const tracker = new FileTracker(session, "my-ai-agent");

// Track a file change
const beforeContent = await Bun.file("src/main.ts").text();
// ... AI makes changes ...
const afterContent = await Bun.file("src/main.ts").text();

await tracker.track("src/main.ts", beforeContent, afterContent, "Updated imports");

// Revert if needed
await tracker.revert("src/main.ts");

// Or revert to a specific version
await tracker.revert("src/main.ts", 2);
```

## API

### Session

```typescript
import { createSession, loadSession, loadOrCreateSession } from "@byfungsi/fun";

// Create new session
const session = await createSession("/path/to/project");

// Load existing session
const session = await loadSession("session-uuid");

// Load or create (recommended)
const session = await loadOrCreateSession("/path/to/project");
```

### FileTracker

Convenience wrapper for tracking file changes:

```typescript
import { FileTracker } from "@byfungsi/fun";

const tracker = new FileTracker(session, "agent-id");

// Track a change
await tracker.track(filePath, before, after, "commit message");

// Revert to original
await tracker.revert(filePath);

// Revert to specific version
await tracker.revert(filePath, 3);

// Check for conflicts before editing
const check = await tracker.preCheck(filePath);
if (check.hasConflict) {
  console.log("File was modified externally!");
  console.log(check.diff);
}
```

### Low-level Functions

```typescript
import { generateDiff, getDiffStats, hash, version } from "@byfungsi/fun";

// Generate unified diff
const diff = generateDiff(before, after, "file.txt");

// Get diff statistics
const stats = getDiffStats(before, after);
console.log(`+${stats.additions} -${stats.deletions}`);

// Compute Blake3 hash
const contentHash = hash("file content");

// Get library version
console.log(version()); // "0.1.0"
```

## How It Works

Funcode stores session data in `~/.funcode/sessions/{sessionID}/`:

```
~/.funcode/sessions/{uuid}/
├── manifest.json      # Session metadata
├── files.json         # Tracked file states
├── originals/         # Original file contents (content-addressed)
│   └── ab/cdef...     # Stored by Blake3 hash
├── patches/           # Unified diffs
│   ├── 0001.diff
│   └── 0002.diff
└── versions/          # Version metadata
    ├── 0001.json
    └── 0002.json
```

Key design decisions:
- **Separate from Git** - Doesn't touch `.git`, works alongside it
- **Content-addressed storage** - Deduplicates identical files
- **Unified diff format** - Standard patch format, human-readable
- **Session-based** - Each AI session gets isolated tracking

## Development

### Prerequisites

- [Zig](https://ziglang.org) 0.15.2+
- [Bun](https://bun.sh) 1.0+

### Setup

```bash
# Clone the repo
git clone https://github.com/byfungsi/fun.git
cd fun

# First-time setup
./scripts/setup-local.sh

# Or manual setup
cd ts/@byfungsi/fun
bun run dev  # Builds Zig + TypeScript
bun link     # Register for local development
```

### Development Commands

```bash
cd ts/@byfungsi/fun

# Build everything (Zig + TypeScript)
bun run dev

# Build TypeScript only
bun run build

# Build native library only
bun run build:native

# Run tests
bun test
```

### Use in Another Local Project

```bash
cd /path/to/your-project
bun link @byfungsi/fun
```

### Project Structure

```
fun/
├── src/                    # Zig source code
│   ├── lib.zig            # Library entry point
│   ├── patch.zig          # Myers diff algorithm
│   ├── storage.zig        # Content-addressed storage
│   ├── session.zig        # Session management
│   ├── lock.zig           # File locking
│   └── c_api.zig          # C ABI for FFI
├── ts/@byfungsi/fun/      # TypeScript package
│   ├── src/
│   │   ├── index.ts       # Main exports
│   │   ├── ffi.ts         # Bun FFI bindings
│   │   ├── session.ts     # Session class
│   │   └── tracker.ts     # FileTracker class
│   └── native/            # Native libraries (built by CI)
└── .github/workflows/     # CI/CD
```

## Supported Platforms

| OS | Architecture |
|----|--------------|
| macOS | arm64, x64 |
| Linux | arm64, x64 |

## License

MIT
