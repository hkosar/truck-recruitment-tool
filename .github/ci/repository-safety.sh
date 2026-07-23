#!/usr/bin/env bash
set -euo pipefail
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node "$repository_root/scripts/verify-migration-baseline.mjs"
node "$repository_root/scripts/check-hosted-fixtures.mjs"
node "$repository_root/scripts/verify-staging-contract.mjs"
node "$repository_root/scripts/verify-baseline-reconciliation.mjs"
