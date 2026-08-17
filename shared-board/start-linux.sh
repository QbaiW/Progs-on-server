#!/usr/bin/env bash
set -euo pipefail

project_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$project_directory"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node.js 20 or newer in BaoTa first." >&2
  exit 1
fi

export NODE_ENV="${NODE_ENV:-production}"
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-8787}"
export BOARD_DATA_DIR="${BOARD_DATA_DIR:-$project_directory/data}"

exec node server.js
