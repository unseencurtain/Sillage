# S4 — Customer tracking: account + email, labelled by warehouse

**Status:** planned · subject to change · every phase is independently revertable.

## Goal

Surface parcel tracking (courier + tracking code + carrier link) to the customer in **two more
places** — their **account order detail** and the **tracking email** — and label each parcel with
its **warehouse** (Blossom / Fern). Today tracking appears only on the public `/order-tracking`
page, and the warehouse name never reaches the customer in any tracking surface.

## What already exists (do not rebuild)

- **Engine** polls vendors → stores parcels in `sil_vendor_order_tracking` → pushes to WooCommerce
  `_sillage_tracking` meta as `{vendor, courier, code, url, added}`. See [`TRACKING.md`](../TRACKING.md).
- **`sillage-tracking`** plugin: `sillage_tracking_parcels()` (read `_sillage_tracking`), public
  `POST /sillage/v1/track`, branded `Sillage_Tracking_Email` (`WC_Email` subclass).
- **`sillage-warehouses`** plugin: `SILLAGE_WH_LOCATIONS` (`bts→A`, `beautyfort→B`),
  `SILLAGE_WH_NAMES` (`A→Blossom`, `B→Fern`), `sillage_wh_location_name()`, and
  `sillage_wh_two_parcels_email()` — a "Delivery in two parcels" notice on the
  processing/on-hold/completed emails for mixed orders.
- **Frontend**: `OrderDetail.jsx` (account order detail, fetched via `getCustomerOrder()` → Store API
  `/wc/store/v1/orders/{id}`), and `WAREHOUSE_NAMES = { A: "Blossom", B: "Fern" }` in
  `cart/constants.js`.

## Warehouse mapping (the single source of truth)

| Supplier | Location | Customer-facing name |
|---|---|---|
| BTS | A | Warehouse Blossom |
| BeautyFort | B | Warehouse Fern |

Customers only ever see **"Warehouse Blossom" / "Warehouse Fern"** — never "BTS" / "BeautyFort".

## The gap (what this feature closes)

1. The tracking **email** shows courier + code + URL, but not which warehouse.
2. The public **`/track`** lookup drops the `vendor` field (returns only courier/code/url).
3. The **account order detail** shows no tracking at all.

---

## Phases

Each phase is a self-contained, shippable change. Any can be reverted on its own without touching the
others, because the underlying data (`_sillage_tracking` meta, item `_sillage_location` meta) is
already written and stored regardless.

### Phase 1 — Authenticated order-tracking endpoint (server)

Add `GET /sillage/v1/order-tracking/{order_id}` to the `sillage-tracking` plugin.

- `permission_callback`: the current user must own the order — compare `get_current_user_id()` to the
  order's customer id (or billing email). The headless storefront already logs customers in via
  `cereve-storefront-auth`, so `is_user_logged_in()` + `get_current_user_id()` work.
- Returns `{ parcels: [ { vendor, warehouse, courier, code, url, added } ] }`, mapping the vendor
  slug → location letter → display name **server-side** (Blossom / Fern), so the frontend stays dumb.
- No writes, no cache. Reuse `sillage_tracking_parcels()`.

**Files:** `plugins/sillage-tracking/sillage-tracking.php` (+ a new class if preferred).
**Done when:** an authenticated customer gets parcels with `warehouse` = "Warehouse Blossom" /
"Warehouse Fern"; anonymous or another user's order returns 401/403.

### Phase 2 — Account order detail shows parcels

In `OrderDetail.jsx`, after the order loads, fetch the Phase 1 endpoint and render a **Parcels**
section: one card per parcel with warehouse name, courier, code, and a "track with carrier" link
when `url` is present. Silent no-op when there are no parcels or the request fails.

- Every new user-facing string must be added to **all 24 catalogues** (`src/locales/*.json`, English
  as source of truth) and rendered via `t(...)` — per `AGENTS.md`.

**Files:** `react_store/frontend/src/features/account/pages/OrderDetail.jsx`,
`src/locales/*.json`.
**Done when:** an account order with a parcel shows warehouse + code + link; a mixed order shows
both warehouses.

### Phase 3 — Warehouse name in the tracking email

In `Sillage_Tracking_Email::parcels_html()` and `get_content_plain()`, prefix each parcel card with
its warehouse name (Blossom / Fern). Because a mixed order can send one email per vendor, each email
should still make clear which warehouse that parcel came from.

**Files:** `plugins/sillage-tracking/class-sillage-tracking-email.php`.
**Done when:** a mixed order's email labels each parcel with its warehouse.

### Phase 4 — Warehouse name on the public `/track` page

In `Sillage_Tracking_Lookup::payload()`, include `vendor`/`warehouse` per parcel (today it returns
only courier/code/url), and render it in `OrderTracking.jsx`.

**Files:** `plugins/sillage-tracking/class-sillage-tracking-lookup.php`,
`react_store/frontend/src/features/content/pages/OrderTracking.jsx`.
**Done when:** `/order-tracking` labels each parcel with its warehouse.

### Phase 5 (optional) — item ↔ warehouse grouping

Order items already carry `_sillage_location` (A/B) meta. Group the account's item list under
"Warehouse Blossom" / "Warehouse Fern", and optionally a "what's in this parcel" list per parcel. The
"two parcels" email notice already exists; extend it only if a per-parcel item list is wanted.

---

## Revert / change notes

- All phases are **additive display** of data already stored (`_sillage_tracking`, item
  `_sillage_location`). No migration, no data change, no pipeline change.
- To revert a phase: revert its commit (or deactivate the plugin / remove the render). The
  poll → store → push pipeline is untouched by all of them.
- The warehouse name map is duplicated in a few spots (`sillage-warehouses` PHP, frontend
  `WAREHOUSE_NAMES`, and this new endpoint). Keep them in step; if it grows beyond these, promote it
  to one shared source.

## Files touched

- `plugins/sillage-tracking/{sillage-tracking.php, class-sillage-tracking-lookup.php, class-sillage-tracking-email.php}`
- `react_store/frontend/src/features/account/pages/OrderDetail.jsx`
- `react_store/frontend/src/features/content/pages/OrderTracking.jsx`
- `react_store/frontend/src/locales/*.json` (24 catalogues)
- `docs/TRACKING.md` (keep in sync)

## Hazards / invariants

- The authenticated endpoint **must verify ownership** — never leak another customer's parcels.
- Preserve the public `/track` obfuscation (unknown order == wrong email) and its rate limit.
- Customer-facing copy is **never** "BTS" / "BeautyFort" — always the warehouse names.
- i18n parity: a missing key falls back to English mid-screen; all 24 catalogues must stay complete.
