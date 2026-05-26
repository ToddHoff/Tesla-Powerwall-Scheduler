#!/bin/zsh
set -euo pipefail

APP_DIR="${0:A:h:h}"
LOG_FILE="${APP_DIR}/logs/server.out.log"
PORT="${PORT:-8787}"

cd "${APP_DIR}"
mkdir -p logs

EXISTING_PID="$(lsof -ti :${PORT} 2>/dev/null || true)"
if [[ -n "${EXISTING_PID}" ]]; then
  echo "Stopping node on :${PORT} (pid ${EXISTING_PID})"
  kill "${EXISTING_PID}" 2>/dev/null || true
  for _ in {1..20}; do
    sleep 0.25
    lsof -ti :${PORT} >/dev/null 2>&1 || break
  done
  if lsof -ti :${PORT} >/dev/null 2>&1; then
    echo "Process did not exit, sending SIGKILL"
    kill -9 "${EXISTING_PID}" 2>/dev/null || true
    sleep 0.5
  fi
fi

echo "Starting node server.mjs"
nohup node server.mjs > "${LOG_FILE}" 2>&1 &
NEW_PID=$!
disown
echo "Started pid=${NEW_PID}"

for _ in {1..20}; do
  sleep 0.25
  if curl -sf "http://localhost:${PORT}/api/status" >/dev/null 2>&1; then
    echo "Server up at http://localhost:${PORT}"
    exit 0
  fi
done

echo "Server did not respond on :${PORT} within 5s; tail of ${LOG_FILE}:"
tail -20 "${LOG_FILE}" || true
exit 1
