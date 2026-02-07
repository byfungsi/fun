#!/bin/bash
# Local development setup script
# Run this after cloning to build native library for your platform

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TS_PACKAGE="$PROJECT_ROOT/ts/@byfungsi/fun"

echo "=== Funcode Local Development Setup ==="
echo ""

# Check for Zig
if ! command -v zig &> /dev/null; then
    echo "Error: Zig is not installed."
    echo "Install from: https://ziglang.org/download/"
    exit 1
fi

echo "Zig version: $(zig version)"
echo ""

# Build native library
echo "Building native library..."
cd "$PROJECT_ROOT"
zig build -Doptimize=ReleaseFast

# Determine platform-specific library name
PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$PLATFORM" in
    darwin)
        PLATFORM="darwin"
        EXT="dylib"
        ;;
    linux)
        PLATFORM="linux"
        EXT="so"
        ;;
    mingw*|msys*|cygwin*)
        PLATFORM="win32"
        EXT="dll"
        ;;
esac

case "$ARCH" in
    x86_64|amd64)
        ARCH="x64"
        ;;
    arm64|aarch64)
        ARCH="arm64"
        ;;
esac

# Copy with platform-specific name
SRC_LIB="zig-out/lib/libfuncode.$EXT"
if [ "$PLATFORM" = "win32" ]; then
    SRC_LIB="zig-out/lib/funcode.$EXT"
fi

DEST_LIB="$TS_PACKAGE/native/libfuncode-$PLATFORM-$ARCH.$EXT"
if [ "$PLATFORM" = "win32" ]; then
    DEST_LIB="$TS_PACKAGE/native/funcode-$PLATFORM-$ARCH.$EXT"
fi

echo "Copying $SRC_LIB -> $DEST_LIB"
cp "$SRC_LIB" "$DEST_LIB"

# Also copy generic name for convenience
GENERIC_LIB="$TS_PACKAGE/native/libfuncode.$EXT"
if [ "$PLATFORM" = "win32" ]; then
    GENERIC_LIB="$TS_PACKAGE/native/funcode.$EXT"
fi
cp "$SRC_LIB" "$GENERIC_LIB"

echo ""
echo "Building TypeScript..."
cd "$TS_PACKAGE"
bun install
bun run build

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Native library: $DEST_LIB"
echo ""
echo "To use in another local project:"
echo "  cd /path/to/your/project"
echo "  bun link @byfungsi/fun"
echo ""
echo "Or add to package.json:"
echo "  \"@byfungsi/fun\": \"file:$TS_PACKAGE\""
echo ""
