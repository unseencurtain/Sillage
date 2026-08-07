# 01 - Problem And Principles

## Product goal

Build a BTS-powered ecommerce backend/web app that:
1. Syncs product catalog to local DB.
2. Serves fast product pages from local DB.
3. Places real orders through BTS API.
4. Tracks status/tracking updates.
5. Handles failures without losing order state.

## Core mental model

Treat system as 3 bounded systems:
1. **Ingestion**: BTS -> JSON artifact -> SQLite.
2. **Transaction**: Cart/checkout/order creation.
3. **Reconciliation**: Tracking refresh + delta sync + recovery.

If each subsystem is stable, whole app is stable.

## Non-negotiable rules

1. **BTS is source of truth** for fulfillment/live stock.
2. **Local DB is read/cache layer** for your storefront UX.
3. **Never expose BTS token in client-side code**.
4. **Normalize API responses at SDK boundary**.
5. **Idempotent writes** for sync/order persistence.

## Success criteria

1. Full sync imports products/categories reliably.
2. Delta sync updates stock/price.
3. Checkout returns an order number and persists order locally.
4. Tracking/status updates can be refreshed independently.
5. System remains usable when BTS is slow.
