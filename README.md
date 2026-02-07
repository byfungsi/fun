# Funcode

AI-friendly version control for tracking AI file changes. Built with Zig + TypeScript.

## Why Funcode?

When AI agents edit your code, you need visibility and control:
- What did the AI change?
- Can I undo just this one tool call?
- What happens if I edit a file while the AI is working?
- How do I coordinate multiple AI agents?

Funcode solves these problems.

## Core Capabilities

### 1. Undo/Redo for AI Changes

| Capability | Description |
|------------|-------------|
| Single file revert | Undo AI changes to one file, restore to original or any version |
| Full session revert | "Undo everything the AI did" - restore all files to pre-AI state |
| Selective undo | With metadata: undo just one tool call, or one message's changes |
| Surgical revert | Undo a specific version without affecting other changes |
| Non-destructive | User's manual edits are detected (conflict), not blindly overwritten |

**User story:** "The AI fucked up my auth module. Let me just revert that file."

### 2. AI Change Attribution & Visibility

| Capability | Description |
|------------|-------------|
| Change history | See every file the AI touched, with diffs and timestamps |
| Editor tracking | Know which editor/agent made which change |
| Stats per change | +15 lines, -3 lines per version |
| Message linking | With metadata: "This change came from tool call X in message Y" |
| Filter by editor | Get history for just one agent in multi-agent setups |

**User story:** "Show me what the AI changed in the last 5 tool calls."

### 3. External Change Detection

| Capability | Description |
|------------|-------------|
| Auto-detect changes | Sync detects files modified outside funcode |
| Human edit detection | If user edits a file the AI was tracking, funcode detects it |
| Deletion tracking | Detect when files are deleted externally |
| Progress callback | Track sync progress for large projects |
| Diff between expected/actual | Shows what the human changed |
| Resolution options | Accept human changes, revert to AI's version, or merge |

**User story:** "I edited the file while the AI was thinking. It should know that."

### 4. Multi-Agent Coordination

| Capability | Description |
|------------|-------------|
| File locking | Agent A locks `config.ts`, Agent B waits or skips |
| Lock expiry | 5-minute timeout prevents deadlocks |
| Configurable timeout | Custom lock duration per file |
| Session awareness | Agents can query what files others are touching |

**User story:** "I have 3 AI agents working in parallel - they shouldn't conflict."

```typescript
// Agent 1 locks a file before editing
const lockResult = await tracker.lock("config.ts");
if (!lockResult.acquired) {
  console.log(`File locked by ${lockResult.holder}, expires at ${lockResult.expiresAt}`);
  return; // Skip this file
}

try {
  // Safe to edit - we hold the lock
  const content = await Bun.file("config.ts").text();
  // ... make changes ...
  await tracker.track("config.ts", content, newContent);
} finally {
  await tracker.unlock("config.ts");
}
```

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

// Track a file change with metadata
const beforeContent = await Bun.file("src/main.ts").text();
// ... AI makes changes ...
const afterContent = await Bun.file("src/main.ts").text();

await tracker.track("src/main.ts", beforeContent, afterContent, {
  message: "Updated imports",
  metadata: {
    toolCallId: "call_abc123",
    model: "claude-3-opus",
    promptTokens: 1500,
  }
});

// Revert if needed
await tracker.revert("src/main.ts");

// Or revert to a specific version
await session.revertFile("src/main.ts", 2);
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

const tracker = new FileTracker(session, "my-editor");

// Track a change with metadata
await tracker.track(filePath, before, after, {
  message: "commit message",
  metadata: { toolCallId: "call_123", anyKey: "anyValue" }
});

// Revert to original
await tracker.revert(filePath);

// Check for conflicts before editing
const check = await tracker.preCheck(filePath);
if (check.hasConflict) {
  console.log("File was modified externally!");
  console.log(check.diff);
}

// Lock a file for exclusive editing
const lockResult = await tracker.lock(filePath);
if (lockResult.acquired) {
  // Edit safely, then unlock
  await tracker.unlock(filePath);
}

// Check if a file is locked
const lockInfo = await tracker.isLocked(filePath);
if (lockInfo) {
  console.log(`Locked by ${lockInfo.editor}`);
}
```

### Session Methods

```typescript
// Track change directly on session
const version = await session.trackChange({
  filePath: "src/app.ts",
  beforeContent: oldCode,
  afterContent: newCode,
  editor: "my-agent",
  message: "Refactored auth",
  metadata: { toolCallId: "call_abc123" }
});

// Get version history
const history = await session.getHistory({ limit: 10 }); // last 10 versions
for (const v of history) {
  console.log(`v${v.num}: ${v.filePath} (+${v.additions}/-${v.deletions})`);
  console.log(`  Editor: ${v.editor}, Message: ${v.message}`);
  console.log(`  Metadata:`, v.metadata);
}

// Filter history by editor
const myHistory = await session.getHistory({ editor: "my-agent" });

// Revert a file to specific version
await session.revertFile("src/app.ts", 3);

// Revert all files to original state
await session.revertAll();

// Get status of all tracked files
const status = await session.getStatus();
console.log(`Tracking ${status.files.length} files, version ${status.currentVersion}`);

// Lock management (lower-level API)
const lockResult = await session.acquireLock("file.ts", "agent-1");
const lockInfo = await session.isLocked("file.ts");
await session.releaseLock("file.ts", "agent-1");

// Custom lock timeout (in seconds)
const lockResult = await session.acquireLock("file.ts", "agent-1", { 
  timeoutSeconds: 60  // 1 minute instead of default 5 minutes
});
```

### Sync API

Detect external changes to tracked files:

```typescript
// Sync with progress callback (useful after git operations)
const syncResult = await session.sync({
  onProgress: ({ phase, current, total, currentFile }) => {
    console.log(`[${phase}] ${current}/${total} - ${currentFile}`);
  }
});

console.log(`Checked: ${syncResult.checkedFiles}`);
console.log(`External changes: ${syncResult.externalChanges}`);
console.log(`Deleted files: ${syncResult.deletedFiles}`);
console.log(`Versions created: ${syncResult.capturedVersions.length}`);
```

### Surgical Revert

Undo a specific version without affecting other changes:

```typescript
// Check if a version can be reverted
const canRevert = await session.canRevertVersion(5);
if (!canRevert.canRevert) {
  console.log(`Cannot revert: ${canRevert.reason}`);
}

// Surgically revert a version (applies inverse patch)
const result = await session.revertVersion(5);

if (result.success) {
  console.log(`Reverted to version ${result.newVersion.num}`);
} else {
  // Conflict - show markers for manual resolution
  console.log("Conflict detected!");
  console.log(result.conflict.conflictMarkers);
  
  // Options for handling conflicts:
  // 1. Show to user for manual resolution
  // 2. Write conflict markers to file
  // 3. Let user choose which version to keep
}
```

### Time-Travel API

Query, navigate, and revert changes with precision:

```typescript
// Get history filtered by metadata
const toolCallVersions = await session.getHistoryByMetadata({ 
  toolCallId: "call_abc123" 
});

// Undo all changes from a specific tool call
const result = await session.revertByMetadata({ toolCallId: "call_abc123" });
console.log(`Reverted ${result.revertedFiles.length} files`);

// Get the unified diff for any version
const diff = await session.getDiff(5);

// Get content at any point in history
const oldContent = await session.getContentAtVersion("src/app.ts", 3);

// Get history for a specific file
const fileHistory = await session.getFileHistory("src/app.ts");

// Filter file history by editor
const myFileHistory = await session.getFileHistory("src/app.ts", { 
  editor: "my-agent" 
});
```

### File Timeline (for Time-Travel UI)

Build a slider UI to navigate file history:

```typescript
// Get complete timeline with content at each version
const timeline = await session.getFileTimeline("src/app.ts");

for (const entry of timeline) {
  console.log(`Version ${entry.version}:`);
  console.log(`  Timestamp: ${new Date(entry.timestamp)}`);
  console.log(`  Editor: ${entry.editor}`);
  console.log(`  Message: ${entry.message}`);
  console.log(`  Changes: +${entry.additions}/-${entry.deletions}`);
  console.log(`  Content: ${entry.content.slice(0, 50)}...`);
  console.log(`  Metadata:`, entry.metadata);
}

// Filter timeline by editor
const myTimeline = await session.getFileTimeline("src/app.ts", { 
  editor: "my-agent" 
});

// Jump to any version
await session.revertFile("src/app.ts", timeline[2].version);
```

### Session Cleanup

Prune old versions to save disk space:

```typescript
// Keep only the last 10 versions (renumbers 1-10)
const pruneResult = await session.prune(10);
console.log(`Deleted ${pruneResult.deletedVersions} versions`);
console.log(`Freed ${pruneResult.freedBytes} bytes`);
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
console.log(version()); // "0.4.0"
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
└── versions/          # Version metadata (includes custom metadata)
    ├── 0001.json
    └── 0002.json
```

Key design decisions:
- **Separate from Git** - Doesn't touch `.git`, works alongside it
- **Content-addressed storage** - Deduplicates identical files
- **Unified diff format** - Standard patch format, human-readable
- **Session-based** - Each AI session gets isolated tracking
- **Flexible metadata** - Store any JSON-serializable data with each version

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
