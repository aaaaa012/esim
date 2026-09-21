#!/usr/bin/env bash

set -Eeuo pipefail

APP_DIR="/home/ec2-user/visaCompass/esim2.2"
BRANCH="with-fonepay"
REPOSITORY="git@github.com:samirextra369/esim2.2.git"
LOCK_FILE="/tmp/visacompass-production-deploy.lock"
DEPLOYED_SHA_FILE="$APP_DIR/.visa-compass-deployed-sha"
READY_URL="http://127.0.0.1:4000/api/v1/health/ready"
OPERATIONAL_URL="http://127.0.0.1:4000/api/v1/health/operational"
CUSTOMER_URL="http://127.0.0.1:3000/"
OPS_URL="http://127.0.0.1:3001/"
RUN_TESTS="${RUN_TESTS:-0}"
DEPLOY_SHA="${DEPLOY_SHA:-}"

SERVICES=(
  visacompass-api.service
  visacompass-ocr-worker.service
  visacompass-customer.service
  visacompass-ops.service
)

previous_sha=""
target_sha=""
deployment_started=0
runtime_changed=0
rollback_started=0
last_deployed_sha=""

log() {
  printf '[deploy] %s\n' "$*"
}

die() {
  printf '[deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

run_with_app_env() {
  node --env-file=.env -e '
    const { spawnSync } = require("node:child_process");
    const result = spawnSync(process.argv[1], process.argv.slice(2), {
      env: process.env,
      stdio: "inherit",
    });
    process.exit(result.status ?? 1);
  ' "$@"
}

wait_for_url() {
  local name="$1"
  local url="$2"
  local attempts="${3:-45}"
  local delay="${4:-2}"
  local attempt

  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl --connect-timeout 2 --max-time 5 --fail --silent --show-error \
      --output /dev/null "$url"; then
      log "$name is healthy"
      return 0
    fi
    sleep "$delay"
  done

  printf '[deploy] ERROR: %s did not become healthy: %s\n' "$name" "$url" >&2
  return 1
}

build_release() {
  log "Installing locked dependencies"
  pnpm install --frozen-lockfile

  log "Generating Prisma client"
  pnpm db:generate

  if [[ "$RUN_TESTS" == "1" ]]; then
    log "Running type checks and tests"
    run_with_app_env pnpm typecheck
    run_with_app_env pnpm test
  fi

  # Two concurrent Next.js production builds can exhaust a small EC2 host and
  # appear hung until the outer Actions timeout kills SSH. Build deterministically
  # and sequentially; CI has already tested the same commit in parallel.
  log "Building shared package"
  run_with_app_env pnpm --filter @visa-compass/shared build
  log "Building API"
  run_with_app_env pnpm --filter @visa-compass/api build
  log "Building customer web"
  run_with_app_env pnpm --filter @visa-compass/customer-web build
  log "Building Ops web"
  run_with_app_env pnpm --filter @visa-compass/ops-web build
}

record_deployed_sha() {
  local sha="$1"
  local temporary="${DEPLOYED_SHA_FILE}.tmp"
  printf '%s\n' "$sha" > "$temporary"
  mv -f "$temporary" "$DEPLOYED_SHA_FILE"
}

restore_known_generated_files() {
  local generated_file="apps/customer-web/next-env.d.ts"
  local committed_contents
  local production_contents
  local working_contents

  git diff --quiet -- "$generated_file" && return 0
  git diff --cached --quiet -- "$generated_file" || return 0
  [[ -f "$generated_file" ]] || return 0

  committed_contents="$(git show "HEAD:$generated_file")" || return 0
  production_contents="${committed_contents/.next-dev\/types\/routes.d.ts/.next\/types\/routes.d.ts}"
  working_contents="$(<"$generated_file")"

  if [[ "$production_contents" != "$committed_contents" && "$working_contents" == "$production_contents" ]]; then
    log "Restoring Next-generated $generated_file change"
    git restore --worktree -- "$generated_file"
  fi
}

show_failure_logs() {
  log "Recent service logs"
  sudo journalctl --no-pager --lines=60 \
    --unit visacompass-api.service \
    --unit visacompass-ocr-worker.service \
    --unit visacompass-customer.service \
    --unit visacompass-ops.service || true
}

restart_and_verify() {
  log "Restarting API"
  sudo systemctl restart visacompass-api.service
  wait_for_url "API readiness" "$READY_URL"

  log "Restarting worker and web applications"
  sudo systemctl restart \
    visacompass-ocr-worker.service \
    visacompass-customer.service \
    visacompass-ops.service

  local service
  for service in "${SERVICES[@]}"; do
    sudo systemctl is-active --quiet "$service" || return 1
  done

  wait_for_url "Customer web" "$CUSTOMER_URL" 30 2
  wait_for_url "Ops web" "$OPS_URL" 30 2
  # Readiness proves the API can serve traffic. Operational health additionally
  # proves each required worker has published a fresh heartbeat for this build.
  wait_for_url "Platform operational health" "$OPERATIONAL_URL" 45 2
}

rollback() {
  local failed_status="$1"

  if [[ "$deployment_started" != "1" || -z "$previous_sha" || "$rollback_started" == "1" ]]; then
    show_failure_logs
    exit "$failed_status"
  fi

  rollback_started=1
  trap - ERR

  # A previous attempt may have checked out this SHA without ever deploying it.
  # In that case there is no known source revision to restore locally; leave the
  # still-running services untouched and force the next attempt to rebuild.
  if [[ "$previous_sha" == "$target_sha" && "$last_deployed_sha" != "$target_sha" ]]; then
    show_failure_logs
    die "deployment of $target_sha did not complete; successful deployment marker was not advanced"
  fi
  log "Deployment failed; restoring code at $previous_sha"

  git reset --hard "$previous_sha"

  if [[ "$runtime_changed" != "1" ]]; then
    die "Deployment of $target_sha failed before migration/restart; running services were not interrupted"
  fi

  log "Database migrations are forward-only and are not reversed by this rollback"
  RUN_TESTS=0
  build_release
  restart_and_verify
  record_deployed_sha "$previous_sha"
  show_failure_logs
  die "Deployment of $target_sha failed; application restored to $previous_sha"
}

on_error() {
  local status=$?
  rollback "$status"
}

trap on_error ERR

[[ "$(id -un)" == "ec2-user" ]] || die "run this script as ec2-user"
[[ -d "$APP_DIR/.git" ]] || die "expected Git checkout at $APP_DIR"
[[ "$RUN_TESTS" == "0" || "$RUN_TESTS" == "1" ]] || die "RUN_TESTS must be 0 or 1"
if [[ -n "$DEPLOY_SHA" && ! "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  die "DEPLOY_SHA must be a full lowercase Git commit SHA"
fi

command -v git >/dev/null || die "git is not installed"
command -v pnpm >/dev/null || die "pnpm is not installed"
command -v node >/dev/null || die "node is not installed"
command -v curl >/dev/null || die "curl is not installed"
command -v flock >/dev/null || die "flock is not installed"

exec 9>"$LOCK_FILE"
flock --nonblock 9 || die "another production deployment is already running"

cd "$APP_DIR"
[[ -f .env ]] || die "$APP_DIR/.env is missing"

# Next.js rewrites this tracked declaration when switching between the custom
# development output directory and the production output directory.
restore_known_generated_files

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  die "tracked files on EC2 have local changes; refusing to overwrite them"
fi

current_branch="$(git branch --show-current)"
[[ "$current_branch" == "$BRANCH" ]] || die "EC2 checkout is on '$current_branch', expected '$BRANCH'"

previous_sha="$(git rev-parse HEAD)"
if [[ -f "$DEPLOYED_SHA_FILE" ]]; then
  last_deployed_sha="$(tr -d '[:space:]' < "$DEPLOYED_SHA_FILE")"
  if [[ ! "$last_deployed_sha" =~ ^[0-9a-f]{40}$ ]]; then
    die "deployed SHA marker is invalid: $DEPLOYED_SHA_FILE"
  fi
fi
log "Fetching $BRANCH from $REPOSITORY"
git fetch --prune "$REPOSITORY" "$BRANCH"
branch_sha="$(git rev-parse FETCH_HEAD)"
target_sha="${DEPLOY_SHA:-$branch_sha}"

git cat-file -e "$target_sha^{commit}" || die "target commit $target_sha was not fetched"
git merge-base --is-ancestor "$target_sha" "$branch_sha" || \
  die "target $target_sha is not contained in $BRANCH"

if [[ "$previous_sha" == "$target_sha" && "$last_deployed_sha" == "$target_sha" ]]; then
  log "Already deployed at $target_sha"
  restart_and_verify
  exit 0
fi

if [[ "$previous_sha" == "$target_sha" ]]; then
  log "Checkout is at $target_sha but no successful deployment is recorded; rebuilding"
  deployment_started=1
fi

if [[ "$previous_sha" != "$target_sha" ]] && git merge-base --is-ancestor "$target_sha" "$previous_sha"; then
  log "Skipping stale deployment $target_sha; $previous_sha is already newer"
  wait_for_url "API readiness" "$READY_URL"
  exit 0
fi

if [[ "$previous_sha" != "$target_sha" ]]; then
  git merge-base --is-ancestor "$previous_sha" "$target_sha" || \
    die "target $target_sha is not a fast-forward from $previous_sha"

  log "Preparing $target_sha (current: $previous_sha)"
  git merge --ff-only "$target_sha"
  deployment_started=1
fi

# Build before touching running processes. Prisma migrations are applied only
# after every application has compiled successfully.
build_release

log "Applying committed Prisma migrations"
runtime_changed=1
pnpm db:deploy

restart_and_verify
record_deployed_sha "$target_sha"
deployment_started=0
runtime_changed=0

deployed_sha="$(git rev-parse HEAD)"
[[ "$deployed_sha" == "$target_sha" ]] || die "deployed SHA changed unexpectedly"

log "SUCCESS: $deployed_sha is live and all four services are healthy"
