# Funcode v0.4.0 Plan: Robust Time-Travel

> **Status**: FINALIZED - Ready for implementation
> 
> **Note**: This release bundles v0.3.0 (time-travel API) and v0.4.0 features together.

## Key Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Conflict handling | Return diff for manual resolution | Let implementor decide how to present conflicts |
| Sync performance | Progress callback | Keep user informed during long syncs |
| Session architecture | One session per project | Implementors filter by metadata |
| Backward compatibility | Breaking change | Not widely used yet, clean break |

## Overview

This release addresses critical gaps in the time-travel API:

1. **Rename `agentId` to `editor`** - Generic field for implementors (breaking change)
2. **Auto-capture external changes** - Detect and record changes made outside funcode
3. **Filter timeline by editor** - Allow filtering history by who made changes
4. **Sync with progress callback** - Detect mass external changes with progress reporting
5. **Handle file deletions** - Track when files are deleted externally
6. **Surgical revert with conflict info** - Revert specific versions, return conflict markers on failure

---

## Current Gaps

### Gap 1: External Changes Not Tracked

**Problem:** If a human (or another tool) edits a file between AI edits, funcode doesn't capture it.

```
v1: AI changes x=1 → x=2
-- Human manually changes x=2 → x=100 (NOT TRACKED) --
v2: AI changes x=2 → x=3 (but actual file has x=100)
```

**Timeline shows wrong content** because we assume patches apply sequentially from original.

### Gap 2: No Way to Filter by Editor

**Problem:** In multi-agent scenarios, user wants to see only their agent's changes.

```typescript
// Current: Returns ALL versions
const timeline = await session.getFileTimeline("app.ts");

// Needed: Filter by editor
const timeline = await session.getFileTimeline("app.ts", { editor: "my-agent" });
```

### Gap 3: No Surgical Revert

**Problem:** Current `revertFile(path, version)` does full file replacement.

```typescript
// Current behavior:
await session.revertFile("app.ts", 3);
// Replaces ENTIRE file with content at v3

// Needed:
await session.revertVersion(4);
// Only undoes v4's changes, keeps everything else
```

**Why this matters:**

```
v1: AI changes line 10: x=1 → x=2
v2: AI changes line 50: y=1 → y=2
v3: Human changes line 30: z=1 → z=100
v4: AI changes line 10: x=2 → x=3

User wants to undo ONLY v4:
- Expected: line 10 reverts x=3 → x=2, lines 30 and 50 unchanged
- Current: revertFile("app.ts", 3) restores entire file to v3 state
```

### Gap 4: Mass External Changes Not Detected

**Problem:** If user runs `git restore .`, `git stash apply`, or deletes files, funcode doesn't know.

---

## Proposed Solutions

### Solution 1: Rename `agentId` to `editor`

More generic field name. Implementors decide the meaning (could be agent ID, user ID, tool name, etc.).

**Changes:**
- `Version.agentId` → `Version.editor`
- `TrackChangeOptions.agentId` → `TrackChangeOptions.editor`
- `FileTimelineEntry.agentId` → `FileTimelineEntry.editor`
- `FileLock.agentId` → `FileLock.editor`
- `FileTracker` constructor: `agentId` → `editor`

**Backward compatibility:** When loading old version JSON files, map `agentId` → `editor`.

### Solution 2: Auto-Capture External Changes

#### A. On `trackChange()` - Detect Drift

Before tracking a change, check if the "before" content matches what we expect:

```typescript
async trackChange(opts: TrackChangeOptions): Promise<Version> {
  const fileState = this.fileStates.get(filePath);
  
  if (fileState) {
    const expectedHash = fileState.currentHash;
    const beforeHash = this.computeHash(beforeContent);
    
    if (beforeHash !== expectedHash) {
      // External change detected - capture it first
      const expectedContent = await this.getContentAtVersion(filePath, fileState.lastVersion);
      
      await this._createVersion({
        filePath,
        beforeContent: expectedContent,
        afterContent: beforeContent,
        editor: "unknown",
        message: "External change detected",
      });
    }
  }
  
  // Continue with normal tracking...
}
```

#### B. On Session Load - Sync All Files

Check all tracked files for external changes:

```typescript
static async load(id: SessionId): Promise<Session> {
  // ... existing load logic ...
  
  // Auto-sync to detect external changes
  await session.sync();
  
  return session;
}
```

#### C. Manual `sync()` API

```typescript
interface SyncProgress {
  phase: 'scanning' | 'checking' | 'capturing';
  current: number;
  total: number;
  currentFile?: string;
}

interface SyncOptions {
  onProgress?: (progress: SyncProgress) => void;
}

interface SyncResult {
  checkedFiles: number;
  externalChanges: number;
  deletedFiles: number;
  capturedVersions: VersionNum[];
}

async sync(options?: SyncOptions): Promise<SyncResult> {
  const result: SyncResult = { 
    checkedFiles: 0, 
    externalChanges: 0, 
    deletedFiles: 0, 
    capturedVersions: [] 
  };
  
  const files = Array.from(this.fileStates.entries());
  const total = files.length;
  
  // Scanning phase
  options?.onProgress?.({ phase: 'scanning', current: 0, total });
  
  for (let i = 0; i < files.length; i++) {
    const [filePath, fileState] = files[i];
    const fullPath = join(this.projectPath, filePath);
    
    // Checking phase
    options?.onProgress?.({ 
      phase: 'checking', 
      current: i + 1, 
      total, 
      currentFile: filePath 
    });
    
    result.checkedFiles++;
    
    try {
      const actualContent = await readFile(fullPath, "utf-8");
      const actualHash = this.computeHash(actualContent);
      
      if (actualHash !== fileState.currentHash) {
        // Capturing phase
        options?.onProgress?.({ 
          phase: 'capturing', 
          current: i + 1, 
          total, 
          currentFile: filePath 
        });
        
        const expectedContent = await this.getContentAtVersion(filePath, fileState.lastVersion);
        
        const version = await this.trackChange({
          filePath,
          beforeContent: expectedContent,
          afterContent: actualContent,
          editor: "unknown",
          message: "External change detected",
        });
        
        result.externalChanges++;
        result.capturedVersions.push(version.num);
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        // File deleted externally
        options?.onProgress?.({ 
          phase: 'capturing', 
          current: i + 1, 
          total, 
          currentFile: filePath 
        });
        
        const version = await this._trackDeletion(filePath);
        result.deletedFiles++;
        result.capturedVersions.push(version.num);
      }
    }
  }
  
  return result;
}
```

### Solution 3: Handle File Deletions

Track when files are deleted externally:

```typescript
interface Version {
  // ... existing fields
  deleted?: boolean;  // True if this version represents a file deletion
}

async _trackDeletion(filePath: string): Promise<Version> {
  const fileState = this.fileStates.get(filePath);
  const lastContent = await this.getContentAtVersion(filePath, fileState.lastVersion);
  
  return this.trackChange({
    filePath,
    beforeContent: lastContent,
    afterContent: "",  // Empty = deleted
    editor: "unknown",
    message: "File deleted externally",
    metadata: { deleted: true },
  });
}
```

### Solution 4: Filter Timeline by Editor

Add optional filter to timeline methods:

```typescript
interface TimelineFilterOptions {
  editor?: string;
  limit?: number;
}

async getFileTimeline(filePath: string, options?: TimelineFilterOptions): Promise<FileTimelineEntry[]> {
  let timeline = await this._buildFullTimeline(filePath);
  
  if (options?.editor) {
    timeline = timeline.filter(e => e.editor === options.editor);
  }
  
  if (options?.limit) {
    timeline = timeline.slice(0, options.limit);
  }
  
  return timeline;
}
```

Also update:
- `getHistory(options?: HistoryOptions)` - add `editor` filter
- `getFileHistory(filePath, options?)` - add `editor` filter
- `getHistoryByMetadata(filter, options?)` - already has options

### Solution 5: Surgical Revert with Conflict Info

When the inverse patch cannot be applied cleanly, return detailed conflict information
including git-style conflict markers. The implementor can then present this to the user
for manual resolution.

#### A. New Types

```typescript
interface RevertConflict {
  filePath: string;
  currentContent: string;      // What's in the file now
  expectedContent: string;     // What we expected (base for inverse patch)
  revertedContent: string;     // What we're trying to revert to
  inversePatch: string;        // The inverse patch that failed to apply
  conflictMarkers: string;     // Git-style conflict markers for manual resolution
}

interface RevertVersionResult {
  success: boolean;
  newVersion?: Version;        // If success
  conflict?: RevertConflict;   // If conflict - returned for manual resolution
}
```

#### B. Conflict Markers Format

When a conflict occurs, `conflictMarkers` contains git-style markers:

```
<<<<<<< CURRENT
current file content here
=======
attempted revert content here
>>>>>>> REVERT (v5)
```

The implementor can:
- Display this to the user for manual resolution
- Write it to the file and let user fix it
- Use their own merge strategy
- Show a side-by-side diff

#### C. New Method: `revertVersion(versionNum)`

Apply the **inverse patch** of a specific version to the current file:

```typescript
interface RevertVersionResult {
  success: boolean;
  newVersion?: Version;
  conflict?: RevertConflict;
}

async revertVersion(versionNum: VersionNum): Promise<RevertVersionResult> {
  const versionMeta = await this.loadVersionMeta(versionNum);
  const filePath = versionMeta.filePath;
  const fullPath = join(this.projectPath, filePath);
  
  // Get the diff for this version
  const diff = await this.getDiff(versionNum);
  
  // Invert the patch
  const inverseDiff = this.invertPatch(diff);
  
  // Read current file content
  const currentContent = await readFile(fullPath, "utf-8");
  
  // Try to apply inverse patch
  const applyResult = ffi.patchApply(currentContent, inverseDiff);
  
  if (!applyResult.success) {
    // Get content we expected and content we're trying to revert to
    const expectedContent = await this.getContentAtVersion(filePath, versionNum);
    const revertedContent = await this.getContentAtVersion(filePath, versionMeta.parentVersion);
    
    // Generate git-style conflict markers
    const conflictMarkers = this.generateConflictMarkers(
      currentContent,
      revertedContent,
      versionNum
    );
    
    return {
      success: false,
      conflict: {
        filePath,
        currentContent,
        expectedContent,
        revertedContent,
        inversePatch: inverseDiff,
        conflictMarkers,
      },
    };
  }
  
  // Write new content
  await writeFile(fullPath, applyResult.result, "utf-8");
  
  // Track this revert as a new version
  const newVersion = await this.trackChange({
    filePath,
    beforeContent: currentContent,
    afterContent: applyResult.result,
    editor: "system",
    message: `Reverted version ${versionNum}`,
    metadata: { 
      revertedVersion: versionNum,
      originalMessage: versionMeta.message,
    },
  });
  
  return { success: true, newVersion };
}

// Helper to generate git-style conflict markers
private generateConflictMarkers(
  current: string, 
  reverted: string, 
  versionNum: VersionNum
): string {
  return `<<<<<<< CURRENT
${current}
=======
${reverted}
>>>>>>> REVERT (v${versionNum})`;
}
```

#### B. Patch Inversion

Implement in TypeScript (or Zig for performance):

```typescript
function invertPatch(diff: string): string {
  const lines = diff.split('\n');
  const inverted: string[] = [];
  
  for (const line of lines) {
    if (line.startsWith('---')) {
      inverted.push(line.replace('--- a/', '+++ b/'));
    } else if (line.startsWith('+++')) {
      inverted.push(line.replace('+++ b/', '--- a/'));
    } else if (line.startsWith('@@')) {
      // Swap line numbers: @@ -old,count +new,count @@
      // Becomes: @@ -new,count +old,count @@
      const match = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
      if (match) {
        const [_, oldStart, oldCount, newStart, newCount] = match;
        inverted.push(`@@ -${newStart},${newCount || ''} +${oldStart},${oldCount || ''} @@`);
      } else {
        inverted.push(line);
      }
    } else if (line.startsWith('-')) {
      inverted.push('+' + line.slice(1));
    } else if (line.startsWith('+')) {
      inverted.push('-' + line.slice(1));
    } else {
      inverted.push(line);
    }
  }
  
  return inverted.join('\n');
}
```

#### C. Check Before Revert

```typescript
async canRevertVersion(versionNum: VersionNum): Promise<boolean> {
  const versionMeta = await this.loadVersionMeta(versionNum);
  const diff = await this.getDiff(versionNum);
  const inverseDiff = this.invertPatch(diff);
  
  const fullPath = join(this.projectPath, versionMeta.filePath);
  const currentContent = await readFile(fullPath, "utf-8");
  
  const result = ffi.patchApply(currentContent, inverseDiff);
  return result.success;
}
```

---

## API Summary

### New Types

```typescript
interface SyncProgress {
  phase: 'scanning' | 'checking' | 'capturing';
  current: number;
  total: number;
  currentFile?: string;
}

interface SyncOptions {
  onProgress?: (progress: SyncProgress) => void;
}

interface SyncResult {
  checkedFiles: number;
  externalChanges: number;
  deletedFiles: number;
  capturedVersions: VersionNum[];
}

interface TimelineFilterOptions {
  editor?: string;
  limit?: number;
}

interface RevertConflict {
  filePath: string;
  currentContent: string;
  expectedContent: string;
  revertedContent: string;
  inversePatch: string;
  conflictMarkers: string;  // Git-style <<<< ==== >>>> format
}

interface RevertVersionResult {
  success: boolean;
  newVersion?: Version;
  conflict?: RevertConflict;
}
```

### Updated Types

```typescript
interface Version {
  num: VersionNum;
  filePath: string;
  editor: string;        // Renamed from agentId
  message: string;
  timestamp: number;
  parentVersion: VersionNum | null;
  additions: number;
  deletions: number;
  metadata?: Record<string, unknown>;
}

interface HistoryOptions {
  limit?: number;
  editor?: string;       // NEW
}
```

### New Session Methods

| Method | Description |
|--------|-------------|
| `sync(options?)` | Check all tracked files for external changes, with progress callback |
| `revertVersion(v)` | Surgical revert - apply inverse of version v's diff, return conflict info on failure |
| `canRevertVersion(v)` | Check if inverse patch would apply cleanly |
| `invertPatch(diff)` | Invert a unified diff (private helper) |

### Updated Session Methods

| Method | Change |
|--------|--------|
| `getHistory(options?)` | Add `editor` filter |
| `getFileHistory(path, options?)` | Add `editor` filter |
| `getFileTimeline(path, options?)` | Add `TimelineFilterOptions` |
| `trackChange(opts)` | Auto-detect external changes |
| `load()` | Auto-call `sync()` |

### FileTracker Changes

| Change | Description |
|--------|-------------|
| Constructor | `agentId` → `editor` |
| All methods | Use `this.editor` |

---

## File Changes Summary

| File | Changes |
|------|---------|
| `types.ts` | Rename `agentId` → `editor`, add new types |
| `session.ts` | Add sync, surgical revert, filters, auto-capture |
| `tracker.ts` | Rename `agentId` → `editor` |
| `index.ts` | Export new types |
| `ffi.ts` | Add `patchInvert` if implemented in Zig |
| `README.md` | Update all examples, document new features |
| `package.json` | Bump to `0.4.0` |
| `c_api.zig` | Update version, optionally add `fun_patch_invert` |

---

## Breaking Changes

1. **`agentId` renamed to `editor`** - All API consumers must update
2. **`FileTracker` constructor** - Second param renamed
3. **Stored JSON compatibility** - Old files still work (backward compat in loader)

---

## Migration Guide

### Before (v0.3.x)

```typescript
const tracker = new FileTracker(session, "my-agent-id");

await tracker.track("file.ts", before, after, {
  message: "Updated",
  metadata: { toolCallId: "123" }
});

const history = await session.getHistory();
console.log(history[0].agentId);
```

### After (v0.4.0)

```typescript
const tracker = new FileTracker(session, "my-editor");

await tracker.track("file.ts", before, after, {
  message: "Updated",
  metadata: { toolCallId: "123" }
});

const history = await session.getHistory({ editor: "my-editor" });
console.log(history[0].editor);

// Surgical revert with conflict handling
const result = await session.revertVersion(5);
if (!result.success) {
  // Show conflict to user for manual resolution
  console.log(result.conflict.conflictMarkers);
}

// Sync after mass changes with progress
await session.sync({
  onProgress: ({ phase, current, total, currentFile }) => {
    console.log(`[${phase}] ${current}/${total} - ${currentFile}`);
  }
});
```

---

## Implementation Order

1. **Phase 1: Rename `agentId` → `editor`**
   - Update all types
   - Update session.ts
   - Update tracker.ts
   - Add backward compat in loadVersionMeta

2. **Phase 2: Add `sync()` and auto-capture**
   - Implement `sync()` method with progress callback
   - Add `SyncProgress`, `SyncOptions`, `SyncResult` types
   - Add auto-capture in `trackChange()`
   - Handle file deletions
   - Call sync on session load

3. **Phase 3: Add filters**
   - Update `HistoryOptions`
   - Add `TimelineFilterOptions`
   - Update `getHistory`, `getFileHistory`, `getFileTimeline`

4. **Phase 4: Surgical revert with conflict info**
   - Implement `invertPatch()`
   - Implement `generateConflictMarkers()`
   - Implement `revertVersion()` returning `RevertConflict` on failure
   - Implement `canRevertVersion()`

5. **Phase 5: Documentation and release**
   - Update README
   - Bump version to 0.4.0
   - Test all features
   - Release

---

## Test Scenarios

### Scenario 1: External Edit Detection

```typescript
// Setup
const session = await loadOrCreateSession("/project");
const tracker = new FileTracker(session, "ai-agent");

// AI makes a change
await tracker.track("app.ts", "x=1", "x=2");

// Human edits the file directly (outside funcode)
writeFileSync("/project/app.ts", "x=100");

// AI makes another change - should auto-capture human edit
await tracker.track("app.ts", "x=100", "x=200");

// Timeline should show:
// v1: ai-agent: x=1 → x=2
// v2: unknown: x=2 → x=100 (auto-captured)
// v3: ai-agent: x=100 → x=200
```

### Scenario 2: Sync with Progress Callback

```typescript
// After mass external changes (e.g., git stash apply)
const result = await session.sync({
  onProgress: ({ phase, current, total, currentFile }) => {
    const pct = Math.round((current / total) * 100);
    console.log(`[${phase}] ${pct}% - ${currentFile || ''}`);
  }
});

console.log(`Synced: ${result.externalChanges} changes, ${result.deletedFiles} deletions`);
// Output:
// [scanning] 0% -
// [checking] 25% - src/app.ts
// [checking] 50% - src/config.ts
// [capturing] 50% - src/config.ts
// [checking] 75% - src/utils.ts
// [checking] 100% - src/index.ts
// Synced: 1 changes, 0 deletions
```

### Scenario 3: File Deletion Detection

```typescript
// Setup
await tracker.track("config.ts", "", "key=value");

// Human deletes file
rmSync("/project/config.ts");

// Session sync detects deletion
const result = await session.sync();
// result.deletedFiles = 1

// Timeline shows deletion version
```

### Scenario 4: Surgical Revert - Success

```typescript
// v1: changed line 10
// v2: changed line 50
// v3: changed line 30

// Revert only v2
const result = await session.revertVersion(2);
if (result.success) {
  console.log("Reverted successfully, new version:", result.newVersion.num);
}
// Only line 50 is reverted, lines 10 and 30 unchanged
```

### Scenario 5: Surgical Revert - Conflict with Manual Resolution

```typescript
// v1: changed line 10: x=1 → x=2
// Later: line 10 was modified again (x=2 → x=999)
// Now trying to revert v1

const result = await session.revertVersion(1);

if (!result.success) {
  console.log("Conflict detected!");
  console.log("File:", result.conflict.filePath);
  
  // Option 1: Show conflict markers to user for manual resolution
  console.log(result.conflict.conflictMarkers);
  // Output:
  // <<<<<<< CURRENT
  // x=999
  // =======
  // x=1
  // >>>>>>> REVERT (v1)
  
  // Option 2: Write conflict markers to file
  await writeFile(
    result.conflict.filePath + ".conflict", 
    result.conflict.conflictMarkers
  );
  
  // Option 3: Show side-by-side diff in UI
  showDiff({
    current: result.conflict.currentContent,
    reverted: result.conflict.revertedContent,
  });
  
  // Option 4: Let user choose which version to keep
  const userChoice = await promptUser("Keep current or reverted?");
  if (userChoice === "reverted") {
    await writeFile(fullPath, result.conflict.revertedContent);
    // Optionally track this as a new version
    await session.trackChange({
      filePath: result.conflict.filePath,
      beforeContent: result.conflict.currentContent,
      afterContent: result.conflict.revertedContent,
      editor: "user",
      message: "Manual conflict resolution for v1 revert",
    });
  }
}
```

### Scenario 6: Filter by Editor

```typescript
const tracker1 = new FileTracker(session, "agent-1");
const tracker2 = new FileTracker(session, "agent-2");

await tracker1.track("app.ts", "a", "b");
await tracker2.track("app.ts", "b", "c");
await tracker1.track("app.ts", "c", "d");

// Filter by editor
const agent1History = await session.getFileTimeline("app.ts", { editor: "agent-1" });
// Only shows v1 and v3
```

---

## Resolved Decisions

| Question | Decision |
|----------|----------|
| **Sync performance** | Progress callback with `SyncProgress` interface |
| **Conflict resolution for surgical revert** | Return `RevertConflict` with git-style conflict markers for manual resolution |
| **Session architecture** | One session per project - implementors filter by metadata |
| **External editor name** | Hardcoded as `"unknown"` for now (can be made configurable later) |
| **Backward compatibility** | Breaking change - rename `agentId` → `editor` directly |

---

## Timeline

| Phase | Estimated Effort |
|-------|------------------|
| Phase 1: Rename | 1 hour |
| Phase 2: Sync | 2 hours |
| Phase 3: Filters | 1 hour |
| Phase 4: Surgical revert | 2 hours |
| Phase 5: Docs & release | 1 hour |
| **Total** | **~7 hours** |
