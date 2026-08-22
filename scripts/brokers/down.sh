#!/usr/bin/env bash
# Stops the lab. The certificates stay put; delete scripts/brokers/certs to regenerate them.
set -euo pipefail
cd "$(dirname "$0")"
docker compose -f compose.yml down --remove-orphans "$@"
