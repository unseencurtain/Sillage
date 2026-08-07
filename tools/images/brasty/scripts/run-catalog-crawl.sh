#!/usr/bin/env bash
# Full IN STOCK Brasty catalog crawl (resume-safe). Prefer laptop; CONCURRENCY=1.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs output
export LOG_PATH="${LOG_PATH:-./logs/catalog.log}"
export CATALOG_STOCK_FILTER="${CATALOG_STOCK_FILTER:-in_stock}"
export CATALOG_MAX_PAGES="${CATALOG_MAX_PAGES:-0}"
export CATALOG_START_PAGE="${CATALOG_START_PAGE:-1}"
export POLITENESS_DELAY_MS="${POLITENESS_DELAY_MS:-1500}"
export CONCURRENCY="${CONCURRENCY:-1}"
export LPS_MEDIA_BASE_URL="${LPS_MEDIA_BASE_URL:-https://images.slilverbelt.xyz}"
exec npm run crawl-catalog
