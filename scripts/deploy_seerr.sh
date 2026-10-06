#!/bin/bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="/config/lobotomite/seerr-localapp"
RELEASE_ROOT="/config/lobotomite/seerr-releases"
DATA_ROOT="/config/lobotomite/seerr-release-data"
CANDIDATE_ROOT="/config/lobotomite/seerr-release-candidates"
CANDIDATE_CONFIG_ROOT="/config/lobotomite/seerr-release-candidate-configs"
CONFIG_DIRECTORY="/config/lobotomite/seerr-staging-20260322-111334"
SESSION_NAME="seerr-staging-prod"
STATUS_URL="http://127.0.0.1:20829/api/v1/status"
PORT="20829"
NODE_BIN="/mnt/mpathae/lobotomite/.nvm/versions/node/v22.19.0/bin/node"
PNPM_BIN="/usr/bin/pnpm"
PYTHON_BIN="/usr/bin/python3"
BWRAP_BIN="/home/lobotomite/.local/bin/bwrap"
RUNTIME_SCRIPT="/mnt/mpathae/lobotomite/scripts/seerr_runtime.py"
TRANSACTION_HELPER="/mnt/mpathae/lobotomite/scripts/seerr_transaction.py"
GATEWAY_SCRIPT="/mnt/mpathae/lobotomite/scripts/seerr_gateway_gate.py"
RESOURCE_GUARD="/mnt/mpathae/lobotomite/scripts/codex_resource_guard.sh"
LOG_DIR="/config/lobotomite/logs"
LOG_FILE="$LOG_DIR/seerr_deploy.log"
STATE_FILE="$TARGET_DIR/.deployed-commit"
SOURCE_STATE_FILE="$TARGET_DIR/.deployed-source-state"
FAILED_MARKER="/config/lobotomite/seerr-deploy-maintenance.failed"
DEPLOY_LOCK="${XDG_RUNTIME_DIR:-/tmp}/seerr_deploy.singleton.lock"
MAINTENANCE_JOB_LOCK="${XDG_RUNTIME_DIR:-/tmp}/seerr_deploy.maintenance.lock"
SWITCH_LOCK="${XDG_RUNTIME_DIR:-/tmp}/seerr_runtime.switch.lock"
BRANCH_NAME="lobotomite-seerr"

trigger="manual"
force="false"
allow_dirty="false"
adopt_current="false"
recover_accepted="false"
candidate_prepared="false"
candidate_directory=""
release_id=""
head_commit="unknown"
current_branch="unknown"

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
    --adopt-current)
      adopt_current="true"
      shift
      ;;
    --recover-accepted)
      recover_accepted="true"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 64
      ;;
  esac
done

mkdir -p "$LOG_DIR"
source /mnt/mpathae/lobotomite/scripts/cron/resource_guard.sh

log() {
  echo "$(date '+%F %T') [${trigger}] $*" | tee -a "$LOG_FILE"
}

notify_deploy_failure() {
  local exit_code="$1"
  local line_no="$2"
  "$PYTHON_BIN" - "$exit_code" "$line_no" "$trigger" "$head_commit" "$current_branch" "$LOG_FILE" <<'PY'
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
send_pushover("Seerr deploy failed", message, priority=1, app="SEERR")
PY
}

cleanup_candidate() {
  if [[ -n "$candidate_directory" && -d "$candidate_directory" ]]; then
    "$PYTHON_BIN" "$TRANSACTION_HELPER" discard \
      --candidate-root "$CANDIDATE_ROOT" \
      --candidate-directory "$candidate_directory" \
      --release-id "$release_id" \
      --commit "$head_commit" >>"$LOG_FILE" 2>&1 || true
  fi
}

on_deploy_exit() {
  local exit_code=$?
  local line_no="${1:-unknown}"
  trap - EXIT
  cleanup_candidate
  resource_guard_cleanup

  if [[ "$exit_code" -eq 0 ]]; then
    return
  fi
  if [[ "$exit_code" -eq 75 ]]; then
    log "Guard admission deferred this Seerr deployment; no failure alert sent."
    exit 75
  fi

  log "Deploy failed with exit code $exit_code at line $line_no; sending Pushover if configured."
  if notify_deploy_failure "$exit_code" "$line_no" >>"$LOG_FILE" 2>&1; then
    log "Deploy failure Pushover notification completed."
  else
    log "Deploy failure Pushover notification failed; see log output above."
  fi
  exit "$exit_code"
}
trap 'on_deploy_exit "$LINENO"' EXIT
# This entrypoint owns the composed EXIT handler. Admission must not replace
# candidate cleanup/failure alerts with its holder-only handler.
RESOURCE_GUARD_TRAP_INSTALLED=1

if [[ -e "$FAILED_MARKER" && "$recover_accepted" != "true" ]]; then
  log "A prior Seerr transaction requires manual recovery; refusing another deployment."
  exit 1
fi
if [[ "$recover_accepted" != "true" && ! -d "$SOURCE_DIR/.git" ]]; then
  log "Source repo is missing: $SOURCE_DIR"
  exit 1
fi
if [[ ! -e "$TARGET_DIR" && ! -L "$TARGET_DIR" ]]; then
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
if [[ "$recover_accepted" != "true" && ! -x "$PNPM_BIN" ]]; then
  log "Configured pnpm binary is missing or not executable: $PNPM_BIN"
  exit 1
fi
if [[ "$recover_accepted" != "true" && ! -x "$BWRAP_BIN" ]]; then
  log "Bubblewrap is missing or not executable: $BWRAP_BIN"
  exit 1
fi
if [[ ! -x "$PYTHON_BIN" || ! -f "$TRANSACTION_HELPER" || ! -f "$RUNTIME_SCRIPT" || ! -f "$GATEWAY_SCRIPT" ]]; then
  log "Seerr recovery/runtime helpers are unavailable."
  exit 1
fi

if [[ "$recover_accepted" == "true" ]]; then
  resource_guard_enter_maintenance "seerr_deploy" "$MAINTENANCE_JOB_LOCK" || {
    guard_status=$?
    log "Seerr service maintenance admission deferred with status $guard_status."
    exit "$guard_status"
  }
  exec 9>"$DEPLOY_LOCK"
  if ! flock -n 9; then
    log "Another Seerr deployment/recovery is already active; skipping."
    exit 0
  fi
  log "Recovering only a verified already-accepted release; production data will remain intact."
  "$PYTHON_BIN" "$TRANSACTION_HELPER" recover-accepted \
    --target "$TARGET_DIR" \
    --release-root "$RELEASE_ROOT" \
    --data-root "$DATA_ROOT" \
    --config-directory "$CONFIG_DIRECTORY" \
    --session "$SESSION_NAME" \
    --node "$NODE_BIN" \
    --runtime-script "$RUNTIME_SCRIPT" \
    --python "$PYTHON_BIN" \
    --gateway-script "$GATEWAY_SCRIPT" \
    --runtime-log "/config/lobotomite/logs/seerr_runtime.log" \
    --status-url "$STATUS_URL" \
    --port "$PORT" \
    --failure-marker "$FAILED_MARKER" \
    --switch-lock "$SWITCH_LOCK" \
    --readiness-seconds 180 >>"$LOG_FILE" 2>&1
  log "Accepted Seerr release recovery is healthy; gateway and maintenance marker cleared."
  exit 0
fi

current_branch="$(git -C "$SOURCE_DIR" branch --show-current)"
head_commit="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
if [[ "$current_branch" != "$BRANCH_NAME" && "$adopt_current" != "true" ]]; then
  log "Skipping deploy because current branch is '$current_branch', expected '$BRANCH_NAME'."
  exit 0
fi

# This deploy-only singleton prevents duplicate candidate builds. It does not
# intersect the watchdog's shared admission or switch lock.
exec 9>"$DEPLOY_LOCK"
if ! flock -n 9; then
  log "Another Seerr deployment is already preparing or switching a release; skipping."
  exit 0
fi

if [[ "$adopt_current" != "true" ]]; then
  if [[ "$allow_dirty" != "true" ]] && [[ -n "$(git -C "$SOURCE_DIR" status --porcelain --untracked-files=all)" ]]; then
    log "Skipping deploy because source repo has uncommitted changes."
    exit 0
  fi
  source_signature="$("$PYTHON_BIN" "$TRANSACTION_HELPER" source-signature --source "$SOURCE_DIR")"
  last_deployed_commit=""
  last_source_signature=""
  if [[ -f "$STATE_FILE" ]]; then
    last_deployed_commit="$(head -n 1 "$STATE_FILE" | tr -d '\n')"
  fi
  if [[ -f "$SOURCE_STATE_FILE" ]]; then
    last_source_signature="$(head -n 1 "$SOURCE_STATE_FILE" | tr -d '\n')"
  fi
  if [[ "$force" != "true" && "$last_deployed_commit" == "$head_commit" && "$last_source_signature" == "$source_signature" ]]; then
    log "Skipping deploy because source commit and source state $head_commit are already accepted."
    exit 0
  fi
  release_id="${head_commit:0:12}-$(date -u '+%Y%m%dT%H%M%SZ')-$$"
  candidate_directory="$CANDIDATE_ROOT/$release_id"
  log "Preparing isolated candidate $release_id from $head_commit before service maintenance."
  "$RESOURCE_GUARD" run --heavy --wait-seconds 600 -- timeout 2700 \
    "$PYTHON_BIN" "$TRANSACTION_HELPER" prepare \
    --source "$SOURCE_DIR" \
    --candidate-root "$CANDIDATE_ROOT" \
    --candidate-config-root "$CANDIDATE_CONFIG_ROOT" \
    --config-directory "$CONFIG_DIRECTORY" \
    --node "$NODE_BIN" \
    --pnpm "$PNPM_BIN" \
    --python "$PYTHON_BIN" \
    --runtime-script "$RUNTIME_SCRIPT" \
    --bwrap "$BWRAP_BIN" \
    --status-url "$STATUS_URL" \
    --candidate-timeout 120 \
    --release-id "$release_id" \
    --commit "$head_commit" \
    --source-signature "$source_signature" >>"$LOG_FILE" 2>&1
  candidate_prepared="true"
  current_signature="$("$PYTHON_BIN" "$TRANSACTION_HELPER" source-signature --source "$SOURCE_DIR")"
  if [[ "$current_signature" != "$source_signature" || "$(git -C "$SOURCE_DIR" rev-parse HEAD)" != "$head_commit" ]]; then
    log "Source changed during candidate preparation; refusing activation."
    exit 1
  fi
else
  head_commit="$(head -n 1 "$STATE_FILE" 2>/dev/null | tr -d '\n' || true)"
  if [[ ! "$head_commit" =~ ^[0-9a-f]{7,40}$ ]]; then
    log "Current runtime has no valid deployed commit marker for adoption."
    exit 1
  fi
  release_id="${head_commit:0:12}-adopt-$(date -u '+%Y%m%dT%H%M%SZ')-$$"
  source_signature="adopted-current"
  log "Validating existing accepted artifact $head_commit in an isolated disposable config before adoption."
  "$RESOURCE_GUARD" run --heavy --wait-seconds 600 -- timeout 180 \
    "$PYTHON_BIN" "$TRANSACTION_HELPER" probe-existing \
    --target "$TARGET_DIR" \
    --release-root "$RELEASE_ROOT" \
    --candidate-config-root "$CANDIDATE_CONFIG_ROOT" \
    --config-directory "$CONFIG_DIRECTORY" \
    --node "$NODE_BIN" \
    --python "$PYTHON_BIN" \
    --runtime-script "$RUNTIME_SCRIPT" \
    --bwrap "$BWRAP_BIN" \
    --status-url "$STATUS_URL" \
    --candidate-timeout 120 \
    --app-directory "$TARGET_DIR" \
    --release-id "$release_id" \
    --commit "$head_commit" >>"$LOG_FILE" 2>&1
fi

# This is the only service-maintenance admission. It is intentionally after
# frozen install/build and isolated candidate readiness.
resource_guard_enter_maintenance "seerr_deploy" "$MAINTENANCE_JOB_LOCK" || {
  guard_status=$?
  log "Seerr service maintenance admission deferred with status $guard_status."
  exit "$guard_status"
}

log "Admitted Seerr transaction $release_id; gateway barrier and paired rollback are managed by the transaction helper."
activate_args=(
  activate
  --target "$TARGET_DIR"
  --release-root "$RELEASE_ROOT"
  --data-root "$DATA_ROOT"
  --candidate-root "$CANDIDATE_ROOT"
  --candidate-config-root "$CANDIDATE_CONFIG_ROOT"
  --config-directory "$CONFIG_DIRECTORY"
  --session "$SESSION_NAME"
  --node "$NODE_BIN"
  --runtime-script "$RUNTIME_SCRIPT"
  --python "$PYTHON_BIN"
  --gateway-script "$GATEWAY_SCRIPT"
  --runtime-log "/config/lobotomite/logs/seerr_runtime.log"
  --status-url "$STATUS_URL"
  --port "$PORT"
  --failure-marker "$FAILED_MARKER"
  --switch-lock "$SWITCH_LOCK"
  --release-id "$release_id"
  --commit "$head_commit"
  --source-signature "$source_signature"
  --readiness-seconds 180
)
if [[ "$adopt_current" == "true" ]]; then
  activate_args+=(--adopt-current)
else
  activate_args+=(--candidate-directory "$candidate_directory")
fi
"$PYTHON_BIN" "$TRANSACTION_HELPER" "${activate_args[@]}" >>"$LOG_FILE" 2>&1
candidate_prepared="false"

log "Accepted release $release_id. Running the existing Seerr request audit."
if "$PYTHON_BIN" /mnt/mpathae/lobotomite/scripts/seerr_request_audit.py --notify >>"$LOG_FILE" 2>&1; then
  log "Post-deploy Seerr request audit completed cleanly."
else
  log "Post-deploy Seerr request audit found stale completed TV-season request rows; notification sent if cooldown allowed."
fi
exit 0
