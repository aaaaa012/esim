#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
REMOTE_SCRIPT="$SCRIPT_DIR/ec2-deploy.sh"

EC2_HOST="${VISA_EC2_HOST:-52.66.120.198}"
EC2_USER="${VISA_EC2_USER:-ec2-user}"
EC2_KEY="${VISA_EC2_KEY:-$REPO_DIR/VisacompassEC2.pem}"
RUN_TESTS=0

usage() {
  cat <<'EOF'
Usage: ./scripts/deploy-now.sh [--with-tests]

Deploys the latest samirextra369/esim2.2 with-fonepay commit to the EC2 host.
The default hotfix path installs, generates Prisma, builds, migrates, restarts,
and health-checks. Add --with-tests to run typechecks and tests before build.

Optional overrides:
  VISA_EC2_HOST   EC2 address
  VISA_EC2_USER   SSH user
  VISA_EC2_KEY    path to the private SSH key
EOF
}

case "${1:-}" in
  "") ;;
  --with-tests) RUN_TESTS=1 ;;
  --help|-h)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

[[ -f "$REMOTE_SCRIPT" ]] || { printf 'Missing %s\n' "$REMOTE_SCRIPT" >&2; exit 1; }
[[ -f "$EC2_KEY" ]] || { printf 'SSH key not found: %s\n' "$EC2_KEY" >&2; exit 1; }

key_mode="$(stat --format='%a' "$EC2_KEY")"
if (( (8#$key_mode & 077) != 0 )); then
  printf 'SSH key permissions are too open (%s). Run: chmod 400 %q\n' "$key_mode" "$EC2_KEY" >&2
  exit 1
fi

printf 'Deploying latest samirextra369/esim2.2 with-fonepay to %s@%s\n' "$EC2_USER" "$EC2_HOST"

if [[ "$RUN_TESTS" == "1" ]]; then
  ssh \
    -i "$EC2_KEY" \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    -o StrictHostKeyChecking=accept-new \
    "$EC2_USER@$EC2_HOST" \
    'RUN_TESTS=1 bash -s' < "$REMOTE_SCRIPT"
else
  ssh \
    -i "$EC2_KEY" \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    -o StrictHostKeyChecking=accept-new \
    "$EC2_USER@$EC2_HOST" \
    'RUN_TESTS=0 bash -s' < "$REMOTE_SCRIPT"
fi
