#!/usr/bin/env bash
set -Eeo pipefail

# The Git checkout contains code. Runtime JSON data is kept outside Git.
REPO_ROOT="${QE_REPO_ROOT:-/www/wwwroot/qe-star-bottle}"
BRANCH="${QE_DEPLOY_BRANCH:-main}"
APP_DIR="${QE_APP_DIR:-$REPO_ROOT/shared-board}"
APP_NAME="${QE_PM2_APP:-qe-star-bottle}"
LOCK_FILE="${QE_DEPLOY_LOCK:-/tmp/qe-star-bottle-deploy.lock}"
ALLOW_DATA_CHANGES="${QE_ALLOW_DATA_CHANGES:-0}"

# Some server profiles reference optional variables. Source them before
# enabling nounset so a harmless shell customization cannot stop deployment.
[ -f /etc/profile ] && . /etc/profile || true
set -u

if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  flock -n 9 || exit 0
fi

cd "$REPO_ROOT"
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

pm2 restart "$APP_NAME" --update-env
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
