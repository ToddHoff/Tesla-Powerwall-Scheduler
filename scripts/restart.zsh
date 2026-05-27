#!/bin/zsh
# Restart the tesla-scheduler server via launchd. The server is supposed to be
# managed as a LaunchAgent (see scripts/install-launchd.zsh). Using `launchctl
# kickstart -k` instead of nohup means the supervisor restarts the process on
# crash and after wake, which is what keeps it alive overnight.
set -euo pipefail

APP_DIR="${0:A:h:h}"
LABEL="com.toddhoff.tesla-scheduler"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
PORT="${PORT:-8787}"
DOMAIN="gui/$(id -u)"

cd "${APP_DIR}"

if [[ ! -f "${PLIST}" ]]; then
  echo "LaunchAgent plist not found: ${PLIST}"
  echo "Run scripts/install-launchd.zsh once to register the supervised server."
  exit 1
fi

if ! launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  echo "Loading ${LABEL} into ${DOMAIN}"
  launchctl bootstrap "${DOMAIN}" "${PLIST}"
fi

echo "Restarting ${LABEL}"
launchctl kickstart -k "${DOMAIN}/${LABEL}"

for _ in {1..20}; do
  sleep 0.25
  if curl -sf "http://localhost:${PORT}/api/status" >/dev/null 2>&1; then
    echo "Server up at http://localhost:${PORT}"
    exit 0
  fi
done

echo "Server did not respond on :${PORT} within 5s."
echo "Tail of logs/launchd.err.log:"
tail -20 "${APP_DIR}/logs/launchd.err.log" 2>/dev/null || true
exit 1
