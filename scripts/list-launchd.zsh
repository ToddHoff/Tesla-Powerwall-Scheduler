#!/bin/zsh
# Show the powerwall-scheduler launchd jobs that are currently installed:
# both what launchctl has loaded and what plists exist on disk.
set -euo pipefail

LABEL_PREFIX="powerwall-scheduler"

echo "=== launchctl loaded (${LABEL_PREFIX}*) ==="
printf "%-6s %-6s %s\n" "PID" "EXIT" "LABEL"
launchctl list 2>/dev/null \
  | awk -v p="${LABEL_PREFIX}" '$3 ~ "^"p { printf "%-6s %-6s %s\n", $1, $2, $3 }' \
  | sort -k3
echo

echo "=== plists in ~/Library/LaunchAgents ==="
ls -1 "${HOME}/Library/LaunchAgents" 2>/dev/null | grep "^${LABEL_PREFIX}" || echo "(none)"
