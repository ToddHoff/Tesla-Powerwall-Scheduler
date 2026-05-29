#!/bin/zsh
set -euo pipefail

# Repo root = parent of this script's directory, so the agent works regardless
# of where the project is cloned.
APP_DIR="${0:A:h:h}"
LABEL="powerwall-scheduler"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
NODE_PATH="$(command -v node)"

mkdir -p "${HOME}/Library/LaunchAgents" "${APP_DIR}/logs"

# Migrate: remove the previous personalized server agent if it exists.
OLD_PLIST="${HOME}/Library/LaunchAgents/com.toddhoff.tesla-scheduler.plist"
if [[ -e "${OLD_PLIST}" ]]; then
  launchctl unload "${OLD_PLIST}" 2>/dev/null || true
  rm -f "${OLD_PLIST}"
fi

cat > "${PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>WorkingDirectory</key>
  <string>${APP_DIR}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${APP_DIR}/server.mjs</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${APP_DIR}/logs/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${APP_DIR}/logs/launchd.err.log</string>
</dict>
</plist>
PLIST

launchctl unload "${PLIST}" 2>/dev/null || true
launchctl load "${PLIST}"
launchctl start "${LABEL}"

echo "Installed and started ${LABEL}"
echo "Open http://localhost:8787"
