#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../" && pwd)"
SERVER_DATA_DIR="$PROJECT_DIR/.vscode-server-data"

cd "$PROJECT_DIR"

echo "Building extension..."
rm -f playwright-*.vsix
npm run package

VSIX_FILE=$(ls -t playwright-*.vsix 2>/dev/null | head -n1)
if [ -z "$VSIX_FILE" ]; then
  echo "Error: No .vsix file found"
  exit 1
fi
echo "Found: $VSIX_FILE"

# Create server data directory
mkdir -p "$SERVER_DATA_DIR"

# Install extension to custom extensions directory
echo "Installing extension to server data directory..."
code-insiders --extensions-dir "$SERVER_DATA_DIR/extensions" --install-extension "$VSIX_FILE"

# Start serve-web with the custom data directory
echo "Starting VS Code in browser..."
TODOMVC_DIR="$(cd "$PROJECT_DIR/../playwright/examples/todomvc" 2>/dev/null && pwd)"
if [ -n "$TODOMVC_DIR" ]; then
  echo "Open http://localhost:8000?folder=$TODOMVC_DIR in your browser, e.g. using playwright-cli"
else
  echo "Open http://localhost:8000 in your browser, e.g. using playwright-cli"
fi
echo "After making changes to the extension, kill this process and run it again to reload."
code-insiders serve-web \
  --port=8000 \
  --server-data-dir "$SERVER_DATA_DIR" \
  --accept-server-license-terms \
  --without-connection-token
