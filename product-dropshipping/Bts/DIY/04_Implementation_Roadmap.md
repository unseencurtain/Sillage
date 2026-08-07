# 04 - Implementation Roadmap

## Phase 1: Foundation

1. Initialize project, env loader, config module.
2. Add SQLite connection + schema init.
3. Build BTS client with typed methods.

Exit criteria:
- App starts.
- DB file is created.
- BTS ping endpoint works.

## Phase 2: Sync pipeline

1. Full sync script (`sync`): BTS -> `products_BTS.json` -> DB import.
2. Delta sync (`sync:delta`): since-last-sync stock/price updates.
3. Sync logging.

Exit criteria:
- Full sync fills catalog.
- Delta updates changed products.

## Phase 3: Storefront read paths

1. Product list with filters/pagination.
2. Product detail page.
3. Category/manufacturer filters.

Exit criteria:
- Catalog browse is DB-only and fast.

## Phase 4: Cart + checkout

1. Cookie session cart CRUD.
2. Shipping quote call before order.
3. Order creation + local persistence.
4. UX for slow BTS responses.

Exit criteria:
- Real order number returned and stored.

## Phase 5: Orders + reconciliation

1. Orders list/detail pages.
2. Tracking refresh endpoints/jobs.
3. Status normalization.

Exit criteria:
- Pending orders can be updated later.

## Phase 6: Hardening

1. Logging, retry policy, timeout tuning.
2. Auth/authz.
3. Tests and runbook.
