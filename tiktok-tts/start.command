#!/bin/bash
# Mac/Linux launcher: double-click (Mac) or run ./start.command
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get the LTS version from https://nodejs.org and run this again."
  (open https://nodejs.org || xdg-open https://nodejs.org) >/dev/null 2>&1
  read -r -p "Press Enter to close"
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 20 ? 1 : 0)'; then
  echo "Your Node.js is too old. Install the LTS version from https://nodejs.org and run this again."
  read -r -p "Press Enter to close"
  exit 1
fi
[ -d node_modules ] || npm install --omit=dev || { read -r -p "Install failed. Press Enter to close"; exit 1; }
if [ "$1" = "demo" ]; then node server.js --demo --open; else node server.js --open; fi
