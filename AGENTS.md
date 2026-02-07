# AGENTS.md

Instructions for AI agents working on this codebase.

## Project Overview

Funcode is an AI-friendly version control system built with:
- **Zig** - Native core library (diff, storage, session management)
- **TypeScript** - Bun FFI bindings and high-level API
- **Package**: `@byfungsi/fun` on npm

## Repository Structure

```
fun/
├── src/                    # Zig source code
│   ├── lib.zig            # Library entry point & exports
│   ├── patch.zig          # Myers diff algorithm
│   ├── storage.zig        # Content-addressed storage
│   ├── session.zig        # Session lifecycle
│   ├── lock.zig           # File locking
│   ├── c_api.zig          # C ABI exports for FFI
│   └── main.zig           # CLI (optional)
├── ts/@byfungsi/fun/      # TypeScript package
│   ├── src/
│   │   ├── index.ts       # Public API exports
│   │   ├── ffi.ts         # Bun FFI bindings
│   │   ├── session.ts     # Session class
│   │   ├── tracker.ts     # FileTracker convenience class
│   │   └── types.ts       # TypeScript types
│   ├── native/            # Native libraries (gitignored, built by CI)
│   ├── dist/              # Compiled TypeScript (gitignored)
│   └── package.json
├── scripts/
│   └── setup-local.sh     # Local development setup
├── build.zig              # Zig build configuration
└── .github/workflows/     # CI/CD pipelines
```

## Build Commands

### Local Development

```bash
# First-time setup (builds everything, registers bun link)
./scripts/setup-local.sh

# Or from the TypeScript package directory:
cd ts/@byfungsi/fun

# Build everything (Zig + TypeScript)
bun run dev

# Build Zig native library only
bun run build:native

# Build TypeScript only
bun run build

# Run tests
bun test
```

### Zig Commands (from project root)

```bash
# Build library + CLI
zig build

# Build with optimizations
zig build -Doptimize=ReleaseFast

# Run tests
zig build test

# Cross-compile for specific target
zig build -Doptimize=ReleaseFast -Dtarget=x86_64-linux-gnu
```

## CI/CD

### Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | Push/PR to `main` | Run tests, build all platforms |
| `release.yml` | Push `v*` tag | Build, publish to npm, create GitHub release |

### Supported Platforms

| Platform | Zig Target | Output |
|----------|------------|--------|
| macOS arm64 | `aarch64-macos` | `libfuncode-darwin-arm64.dylib` |
| macOS x64 | `x86_64-macos` | `libfuncode-darwin-x64.dylib` |
| Linux x64 | `x86_64-linux-gnu` | `libfuncode-linux-x64.so` |
| Linux arm64 | `aarch64-linux-gnu` | `libfuncode-linux-arm64.so` |

## Deploying a New Version

1. **Update version** in `ts/@byfungsi/fun/package.json`

2. **Commit and push**:
   ```bash
   git add .
   git commit -m "Bump version to X.Y.Z"
   git push origin main
   ```

3. **Create and push tag**:
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

4. **GitHub Actions will automatically**:
   - Build native libraries for all platforms
   - Publish to npm as `@byfungsi/fun`
   - Create GitHub Release with binaries attached

### Required Secrets

| Secret | Description |
|--------|-------------|
| `NPM_TOKEN` | npm automation token with publish access to `@byfungsi` |

## Code Conventions

### Zig

- Use `std.testing.allocator` for tests
- Export C API functions with `pub export fn` prefix `fun_`
- Return pointers for complex types (FFI compatibility)
- Handle errors explicitly, don't panic in library code

### TypeScript

- Use TypeScript strict mode
- Export public API from `index.ts`
- Use `Pointer` type for FFI pointer arguments
- Async/await for all I/O operations

## Testing

### Zig Tests
```bash
zig build test
```

### TypeScript Integration Test
```bash
cd ts/@byfungsi/fun
bun -e "
import { version, hash, loadOrCreateSession } from './dist/index.js';
console.log(version());
const s = await loadOrCreateSession('/tmp/test');
await s.delete();
"
```

## Adding New Features

### Adding a new Zig function

1. Implement in appropriate module (`patch.zig`, `session.zig`, etc.)
2. Add C API wrapper in `c_api.zig` with `pub export fn fun_*`
3. Reference in `lib.zig` comptime block (prevents dead code elimination)
4. Add FFI binding in `ts/@byfungsi/fun/src/ffi.ts`
5. Export from `ts/@byfungsi/fun/src/index.ts`
6. Run `bun run dev` to rebuild

### Adding a new platform

1. Add matrix entry in `.github/workflows/ci.yml` and `release.yml`
2. Update `os` field in `package.json`
3. Test cross-compilation: `zig build -Dtarget=<target>`
