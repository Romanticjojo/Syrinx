#!/usr/bin/env bash
# Thin server wrapper around the cross-platform, behavior-tested release tool.
# Examples:
#   bash scripts/deploy.sh publish --candidate /srv/syrinx-incoming/<id> \
#     --probe-base-url http://127.0.0.1:8090 \
#     --probe-base-url https://romanticjojo.com \
#     --resolve romanticjojo.com:443:127.0.0.1
#   bash scripts/deploy.sh rollback --release-id <previous-id> \
#     --probe-base-url http://127.0.0.1:8090

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "${SCRIPT_DIR}/release.py" "$@"
