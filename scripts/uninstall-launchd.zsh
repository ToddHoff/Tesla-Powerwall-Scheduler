#!/bin/zsh
set -euo pipefail

PLIST="${HOME}/Library/LaunchAgents/com.toddhoff.tesla-scheduler.plist"

launchctl unload "${PLIST}" 2>/dev/null || true
rm -f "${PLIST}"

echo "Uninstalled com.toddhoff.tesla-scheduler"
