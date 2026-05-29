#!/bin/zsh
set -euo pipefail

PLIST="${HOME}/Library/LaunchAgents/powerwall-scheduler.plist"

launchctl unload "${PLIST}" 2>/dev/null || true
rm -f "${PLIST}"

# Also remove the per-step scheduled jobs.
for f in "${HOME}"/Library/LaunchAgents/powerwall-scheduler.step.*.plist; do
  [[ -e "$f" ]] || continue
  launchctl unload "$f" 2>/dev/null || true
  rm -f "$f"
done

echo "Uninstalled powerwall-scheduler and its scheduled jobs."
