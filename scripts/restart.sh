#!/usr/bin/env bash
# Start (or restart) the web/UI server in the background. Portable across
# macOS and Linux. The server is not supervised — if it dies, run this again.
# Scheduled battery changes run from cron and do not depend on this server.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8787}"
LOG_FILE="${APP_DIR}/logs/server.out.log"

cd "${APP_DIR}"
mkdir -p logs

# Stop whatever is already listening on the port (our previous instance).
EXISTING_PID="$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)"
if [[ -n "${EXISTING_PID}" ]]; then
  echo "Stopping process on port ${PORT} (pid ${EXISTING_PID})"
  kill ${EXISTING_PID} 2>/dev/null || true
  for _ in $(seq 1 20); do
    sleep 0.25
    lsof -ti "tcp:${PORT}" >/dev/null 2>&1 || break
  done
  if lsof -ti "tcp:${PORT}" >/dev/null 2>&1; then
    kill -9 ${EXISTING_PID} 2>/dev/null || true
    sleep 0.5
  fi
fi

echo "Starting server"
nohup node server.mjs >> "${LOG_FILE}" 2>&1 &
NEW_PID=$!
disown 2>/dev/null || true
echo "Started pid=${NEW_PID}"

for _ in $(seq 1 20); do
  sleep 0.25
  # Any HTTP response means it's up; 401 (auth enabled) counts.
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/api/status" 2>/dev/null || true)"
  if [[ "${code}" != "000" && -n "${code}" ]]; then
    echo "Server up at http://localhost:${PORT} (status ${code})"
    exit 0
  fi
done

echo "Server did not respond on port ${PORT} within 5s. Tail of ${LOG_FILE}:"
tail -20 "${LOG_FILE}" 2>/dev/null || true
exit 1
