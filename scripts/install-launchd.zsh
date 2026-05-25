#!/bin/zsh
set -euo pipefail

APP_DIR="${HOME}/tesla"
PLIST="${HOME}/Library/LaunchAgents/com.toddhoff.tesla-scheduler.plist"
NODE_PATH="$(command -v node)"

mkdir -p "${HOME}/Library/LaunchAgents" "${APP_DIR}/logs"

cat > "${PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.toddhoff.tesla-scheduler</string>
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
launchctl start com.toddhoff.tesla-scheduler

echo "Installed and started com.toddhoff.tesla-scheduler"
echo "Open http://localhost:8787"
