# 09 - Testing, Observability, Operations

## Testing pyramid

1. **Unit**
   - BTS client validation
   - Status normalization
   - DB CRUD/upsert
2. **Integration**
   - live BTS tests (token gated)
   - checkout end-to-end
3. **Manual smoke**
   - sync -> browse -> cart -> checkout -> order view

## Operational checks

1. Sync duration and product counts
2. Delta sync success/failure rate
3. Checkout latency (p50/p95)
4. Order creation failure reasons
5. Tracking refresh coverage

## Logging plan

Use structured logs with fields:
1. `request_id`
2. `route`
3. `bts_endpoint`
4. `duration_ms`
5. `status`
6. `error_code`

## Cron jobs

1. `sync:delta` every 30-60 min
2. tracking refresh every 2-4 hours
3. daily integrity check (missing local orders, stale pending orders)

## Backup policy

1. snapshot `data/*.sqlite` daily
2. keep `data/products_BTS.json` as import artifact
3. test restore monthly
