#!/bin/zsh
set -euo pipefail
cd "/Users/mingu/.openclaw/workspace-codingbot/windows-jp-ko-translator"
if [ ! -d node_modules ]; then
  echo "Installing desktop dependencies..."
  /usr/bin/env npm install
fi
/usr/bin/env npm start
