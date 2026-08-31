#!/usr/bin/env bash
set -Eeo pipefail

# The Git checkout contains code. Runtime JSON data is kept outside Git.
REPO_ROOT="${QE_REPO_ROOT:-/www/wwwroot/qe-star-bottle}"
BRANCH="${QE_DEPLOY_BRANCH:-main}"
APP_DIR="${QE_APP_DIR:-$REPO_ROOT/shared-board}"
APP_NAME="${QE_PM2_APP:-qe-star-bottle}"
# The default target is an existing, readable inode in the checkout. Opening
# it read-only lets root and a normal deployment user share the same flock
# without changing ownership or permissions on a /tmp file.
DEFAULT_LOCK_TARGET="$REPO_ROOT/.git"
LOCK_TARGET="${QE_DEPLOY_LOCK:-$DEFAULT_LOCK_TARGET}"
ALLOW_DATA_CHANGES="${QE_ALLOW_DATA_CHANGES:-0}"

# Resolve the script before a possible sudo re-exec. This keeps invocations
# such as `bash shared-board/deploy-server.sh` working from any directory.
SCRIPT_PATH="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/$(basename -- "${BASH_SOURCE[0]}")"

# Some server profiles reference optional variables. Source them before
# enabling nounset so a harmless shell customization cannot stop deployment.
[ -f /etc/profile ] && . /etc/profile || true
set -u

# The checkout and PM2 daemon must use one account. If an administrator runs
# the script against a root-owned checkout, transparently re-run as that
# owner instead of creating a second user's PM2 process set.
if [[ "$(id -u)" -ne 0 ]]; then
  repo_owner="$(stat -c '%U' "$REPO_ROOT" 2>/dev/null || true)"
  current_user="$(id -un)"
  if [[ -n "$repo_owner" && "$repo_owner" != "UNKNOWN" && "$repo_owner" != "$current_user" ]]; then
    if ! command -v sudo >/dev/null 2>&1; then
      printf '[deploy] repository is owned by %s; run this script as that user or install sudo\n' "$repo_owner" >&2
      exit 1
    fi
    printf '[deploy] repository is owned by %s; re-running as that user\n' "$repo_owner"
    exec sudo -u "$repo_owner" -- env \
      "QE_REPO_ROOT=$REPO_ROOT" \
      "QE_DEPLOY_BRANCH=$BRANCH" \
      "QE_APP_DIR=$APP_DIR" \
      "QE_PM2_APP=$APP_NAME" \
      "QE_DEPLOY_LOCK=$LOCK_TARGET" \
      "QE_ALLOW_DATA_CHANGES=$ALLOW_DATA_CHANGES" \
      bash "$SCRIPT_PATH" "$@"
  fi
fi

cd "$REPO_ROOT"

if command -v flock >/dev/null 2>&1; then
  if ! exec 9<"$LOCK_TARGET"; then
    if [[ "$LOCK_TARGET" != "$DEFAULT_LOCK_TARGET" ]]; then
      printf '[deploy] lock target is unavailable; falling back to %s\n' "$DEFAULT_LOCK_TARGET" >&2
      LOCK_TARGET="$DEFAULT_LOCK_TARGET"
    fi
    if ! exec 9<"$LOCK_TARGET"; then
      printf '[deploy] cannot open deployment lock target: %s\n' "$LOCK_TARGET" >&2
      exit 1
    fi
  fi
  if ! flock -n 9; then
    printf '[deploy] another deployment is already running (lock: %s)\n' "$LOCK_TARGET" >&2
    exit 0
  fi
fi

git fetch --prune origin "$BRANCH"

current="$(git rev-parse HEAD)"
target="$(git rev-parse "origin/$BRANCH")"

# Local data edits are allowed, but all other local edits stop deployment. npm
# creates an untracked package-lock.json here because this project deliberately
# installs from package.json without committing a lockfile.
while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  status="${entry:0:2}"
  path="${entry:3}"
  if [[ "$status" == "??" && "$path" == "shared-board/package-lock.json" ]]; then
    printf '[deploy] ignoring generated untracked lockfile: %s\n' "$path"
    continue
  fi
  case "$path" in
    shared-board/data|shared-board/data/*) ;;
    *)
      printf '[deploy] refusing dirty non-data path: %s\n' "$path" >&2
      exit 1
      ;;
  esac
done < <(git status --porcelain=v1 --untracked-files=all)

if [[ "$current" == "$target" ]]; then
  printf '[deploy] already up to date at %s\n' "$(git rev-parse --short "$current")"
  exit 0
fi

incoming_paths="$(git diff --name-only "$current" "$target")"
while IFS= read -r path; do
  [ -z "$path" ] && continue
  case "$path" in
    shared-board/data|shared-board/data/*)
      if [[ "$ALLOW_DATA_CHANGES" != "1" ]]; then
        printf '[deploy] refusing a commit that changes runtime data: %s\n' "$path" >&2
        printf '[deploy] set QE_ALLOW_DATA_CHANGES=1 only for the one-time migration.\n' >&2
        exit 1
      fi
      ;;
  esac
done <<< "$incoming_paths"

needs_install=false
if printf '%s\n' "$incoming_paths" | grep -Eq '^shared-board/(package\.json|package-lock\.json)$'; then
  needs_install=true
fi

git merge --ff-only "$target"
cd "$APP_DIR"

if [[ "$needs_install" == true || ! -d node_modules ]]; then
  npm install --omit=dev --no-audit --no-fund --package-lock=false
fi

# Re-evaluate the ecosystem file so changes in the app-local .env (including
# site access credentials) are applied instead of reusing PM2's stored env.
pm2 startOrRestart "$APP_DIR/ecosystem.config.cjs" --only "$APP_NAME" --update-env
health=""
for attempt in {1..15}; do
  if health="$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8787/api/health 2>/dev/null)"; then
    break
  fi
  sleep 1
done
[ -n "$health" ] || {
  printf '[deploy] health check failed after restart\n' >&2
  exit 1
}
printf '[deploy] %s\n' "$health"
