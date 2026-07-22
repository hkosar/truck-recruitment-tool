#!/usr/bin/env bash
set -euo pipefail
node scripts/verify-migration-baseline.mjs
node scripts/check-hosted-fixtures.mjs
