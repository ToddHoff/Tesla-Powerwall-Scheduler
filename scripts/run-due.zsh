#!/bin/zsh
set -euo pipefail

cd "${HOME}/tesla"
exec npm run due -- "$@"
