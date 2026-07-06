#!/bin/bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="/config/lobotomite/seerr-localapp"
CONFIG_DIRECTORY="/config/lobotomite/seerr-staging-20260322-111334"
SESSION_NAME="seerr-staging-prod"
STATUS_URL="http://127.0.0.1:20829/api/v1/status"
PORT="20829"
NODE_BIN="/mnt/mpathae/lobotomite/.nvm/versions/node/v22.19.0/bin/node"
PNPM_BIN="/usr/bin/pnpm"
NODE_OPTIONS="--max-old-space-size=8192"
LOG_DIR="/config/lobotomite/logs"
LOG_FILE="$LOG_DIR/seerr_deploy.log"
STATE_FILE="$TARGET_DIR/.deployed-commit"
LOCK_FILE="${XDG_RUNTIME_DIR:-/tmp}/seerr_deploy.lock"
BRANCH_NAME="lobotomite-seerr"

trigger="manual"
force="false"
allow_dirty="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --trigger)
      trigger="${2:?missing trigger value}"
      shift 2
      ;;
    --force)
      force="true"
      shift
      ;;
    --allow-dirty)
      allow_dirty="true"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 64
      ;;
  esac
done

mkdir -p "$LOG_DIR"

log() {
  echo "$(date '+%F %T') [${trigger}] $*" | tee -a "$LOG_FILE"
}

notify_deploy_failure() {
  local exit_code="$1"
  local line_no="$2"
  local commit="${head_commit:-unknown}"
  local branch="${current_branch:-unknown}"

  /usr/bin/python3 - "$exit_code" "$line_no" "$trigger" "$commit" "$branch" "$LOG_FILE" <<'PY'
import sys

sys.path.insert(0, "/mnt/mpathae/lobotomite/scripts")

from arr_manual_watchdog import send_pushover

exit_code, line_no, trigger, commit, branch, log_file = sys.argv[1:7]
message = (
    f"Nightly Seerr deploy failed.\n"
    f"Trigger: {trigger}\n"
    f"Commit: {commit}\n"
    f"Branch: {branch}\n"
    f"Exit: {exit_code} at line {line_no}\n"
    f"Log: {log_file}"
)
send_pushover("Seerr deploy failed", message, priority=1)
PY
}

on_deploy_exit() {
  local exit_code=$?
  local line_no="${1:-unknown}"

  if [[ "$exit_code" -eq 0 ]]; then
    return
  fi

  trap - EXIT
  log "Deploy failed with exit code $exit_code at line $line_no; sending Pushover if configured."
  if notify_deploy_failure "$exit_code" "$line_no" >>"$LOG_FILE" 2>&1; then
    log "Deploy failure Pushover notification completed."
  else
    log "Deploy failure Pushover notification failed; see log output above."
  fi
  exit "$exit_code"
}

trap 'on_deploy_exit "$LINENO"' EXIT

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "Another Seerr deploy is already running; skipping."
  exit 0
fi

if [[ ! -d "$SOURCE_DIR/.git" ]]; then
  log "Source repo is missing: $SOURCE_DIR"
  exit 1
fi

if [[ ! -d "$TARGET_DIR" ]]; then
  log "Runtime target is missing: $TARGET_DIR"
  exit 1
fi

if [[ ! -d "$CONFIG_DIRECTORY" ]]; then
  log "Config directory is missing: $CONFIG_DIRECTORY"
  exit 1
fi

if [[ ! -x "$NODE_BIN" ]]; then
  log "Configured Node binary is missing or not executable: $NODE_BIN"
  exit 1
fi

if [[ ! -x "$PNPM_BIN" ]]; then
  log "Configured pnpm binary is missing or not executable: $PNPM_BIN"
  exit 1
fi

current_branch="$(git -C "$SOURCE_DIR" branch --show-current)"
head_commit="$(git -C "$SOURCE_DIR" rev-parse HEAD)"

if [[ "$current_branch" != "$BRANCH_NAME" ]]; then
  log "Skipping deploy because current branch is '$current_branch', expected '$BRANCH_NAME'."
  exit 0
fi

if [[ "$allow_dirty" != "true" ]] && [[ -n "$(git -C "$SOURCE_DIR" status --porcelain)" ]]; then
  log "Skipping deploy because source repo has uncommitted changes."
  exit 0
fi

last_deployed_commit=""
if [[ -f "$STATE_FILE" ]]; then
  last_deployed_commit="$(head -n 1 "$STATE_FILE" | tr -d '\n')"
fi

if [[ "$force" != "true" ]] && [[ "$last_deployed_commit" == "$head_commit" ]]; then
  log "Skipping deploy because commit $head_commit is already deployed."
  exit 0
fi

log "Deploying commit $head_commit from $SOURCE_DIR to $TARGET_DIR."

rsync -a --delete \
  --exclude '.git' \
  --exclude '.githooks' \
  --exclude '.next' \
  --exclude 'dist' \
  --exclude 'node_modules' \
  --exclude '.deployed-commit' \
  "$SOURCE_DIR"/ "$TARGET_DIR"/ >>"$LOG_FILE" 2>&1

log "Source sync complete. Building runtime app."
rm -rf "$TARGET_DIR/.next" "$TARGET_DIR/dist"
(
  cd "$TARGET_DIR"
  export CI="true"
  export NODE_OPTIONS="$NODE_OPTIONS"
  export PATH="$(dirname "$NODE_BIN"):$PATH"
  "$PNPM_BIN" install --frozen-lockfile
  "$PNPM_BIN" build
) >>"$LOG_FILE" 2>&1

if ! find "$TARGET_DIR/.next/static/css" -maxdepth 1 -type f -name '*.css' | grep -q .; then
  log "Build did not produce any Next CSS assets; refusing to restart."
  exit 1
fi

if ! find "$TARGET_DIR/.next/static/chunks" -maxdepth 1 -type f -name '*.js' | grep -q .; then
  log "Build did not produce any Next JS chunks; refusing to restart."
  exit 1
fi

test_artifacts="$(find "$TARGET_DIR/dist" -type f \( -name '*.test.js' -o -name '*.spec.js' -o -path '*/test/*' \) -print)"
if [[ -n "$test_artifacts" ]]; then
  log "Server build produced test artifacts under dist; refusing to restart."
  printf '%s\n' "$test_artifacts" >>"$LOG_FILE"
  exit 1
fi

log "Build complete. Restarting tmux session '$SESSION_NAME'."
{
  tmux kill-session -t "$SESSION_NAME" >/dev/null 2>&1 || true
  tmux new-session -d -s "$SESSION_NAME" \
    "cd $TARGET_DIR && exec env CONFIG_DIRECTORY=$CONFIG_DIRECTORY PORT=$PORT NODE_ENV=production NODE_OPTIONS=$NODE_OPTIONS $NODE_BIN dist/index.js >>/config/lobotomite/logs/seerr_runtime.log 2>&1"
} 9>&-

for _ in 1 2 3 4 5; do
  sleep 2
  if curl -fsS --max-time 5 "$STATUS_URL" >/dev/null 2>&1; then
    printf '%s\n' "$head_commit" >"$STATE_FILE"
    log "Deploy successful. Status endpoint is healthy for commit $head_commit."
    if /usr/bin/python3 /mnt/mpathae/lobotomite/scripts/seerr_request_audit.py --notify >>"$LOG_FILE" 2>&1; then
      log "Post-deploy Seerr request audit completed cleanly."
    else
      log "Post-deploy Seerr request audit found stale completed TV season request rows; notification sent if cooldown allowed."
    fi
    exit 0
  fi
done

log "Deploy failed health check after restart for commit $head_commit."
exit 1
