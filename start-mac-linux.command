#!/bin/sh
# Starts the Inventory Register on this computer (macOS or Linux).
# Double-click it on a Mac, or run:  sh start-mac-linux.command
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node.js is not installed on this computer yet."
  echo "Install the LTS version from https://nodejs.org , then start this file again."
  echo
  exit 1
fi
exec node scripts/laptop.js
