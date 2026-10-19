# Tracking — where numbers come from, where they land, what the customer sees

A single spec for the whole tracking feature, from "the vendor gave us a tracking number" to "the
customer looked it up on the storefront". This is **already built** end to end — read this before
touching any of it, because the pieces live in three different repos/plugins and the flow only makes
sense as a whole.

---

## The answer in one paragraph

1. The Sillage **engine** polls BTS and BeautyFort every few minutes and receives `(courier, code,
   url?)` per shipped parcel.
2. It stores each parcel in its own table `sil_vendor_order_tracking`, then **pushes** it to
   WordPress through the **`sillage-bridge`** plugin's HMAC-signed `order-update` endpoint.
3. The bridge writes the parcel into the WooCommerce order's **`_sillage_tracking`** meta and adds a
   **customer note** ("Shipped via … Tracking number: …").
4. That customer note fires the **`sillage-tracking`** plugin, which sends a **branded tracking
   email** (instead of WooCommerce's generic note).
5. The storefront **`/order-tracking`** page asks for an **order number + billing email**, POSTs to
   the public **`/sillage/v1/track`** endpoint (served by `sillage-tracking`), and shows the order
   status, each parcel's courier + code, a "track with carrier" link when the vendor gave a URL, and
   the items.

```
vendor API (BTS / BeautyFort)
        │  poll() every orders_poll_minutes (tracking.ts)
        ▼
sil_vendor_order_tracking  (engine's own DB)
        │  pushToWooCommerce()  →  POST /wp-json/sillage/v1/order-update  (HMAC)
        ▼
sillage-bridge  (class-sillage-orders.php · apply_tracking)
        │  writes _sillage_tracking meta  +  customer note
        ├──► sillage-tracking email  (woocommerce_new_customer_note)
        └──► sillage-tracking lookup  (POST /sillage/v1/track)
                 ▲
                 │  trackOrder({order, email})
storefront  /order-tracking  (OrderTracking.jsx)
```

---

## 1. Upstream — where a tracking number comes from

`src/orders/tracking.ts` → `pollDueOrders()` every cron tick, `orders_poll_minutes` apart (min 5).
It selects **live** legs only (`dry_run = 0`) that have a `vendor_order_number` and are in
`submitted`/`confirmed`/`dispatched`, then calls the leg's vendor adapter `poll()`:

| Vendor | `poll()` source | What we get |
|---|---|---|
| **BeautyFort** | `getOrder` → `detail.parcels[]` | `trackingCode`, `trackingURL`, `courierName` — **has a link** |
| **BTS** | `getOrder` status + `getTrackings` bulk (fallback, often `null` 24–72 h) | courier + code — **no URL** |

This is why a BeautyFort parcel can render a "track with carrier" link and a BTS parcel cannot (see §4).

The poll also advances the leg's status forward-only (`submitted → confirmed → dispatched →
delivered`) from what the vendor reports, and when **every live leg** of a WooCommerce order is
`delivered`/`cancelled`, it asks the bridge to mark the WooCommerce order `completed`.

---

## 2. Where a tracking number is put

Two places, deliberately:

### a. The engine's own DB — `sil_vendor_order_tracking`
One row per parcel, per leg: `vendor_order_id, courier, tracking_code, tracking_url, dispatched_at,
pushed_to_wc`. This is the engine's source of truth, shown in the dashboard's Orders → Tracking
section. Dry-run legs are never written here (they were never placed).

### b. WooCommerce — via the bridge plugin
`pushToWooCommerce()` POSTs to `/wp-json/sillage/v1/order-update` with an HMAC header
(`X-Sillage-Signature`, shared secret `SILLAGE_SHARED_SECRET`). The **`sillage-bridge`** plugin
(`Sillage_Orders::handle_order_update` → `apply_tracking`) then:

- dedupes by `code` (the poller re-reads the vendor, so the same parcel must not be recorded twice);
- appends `{vendor, courier, code, url, added}` to the order's **`_sillage_tracking`** meta;
- adds a **customer note** `Shipped via {courier}. Tracking number: {code}` (+ the URL when present),
  flagged `notify` per the operator's `orders_notify_customer` setting.

The bridge also handles `status: "completed"` from the engine — but **only forward** (never moves a
WooCommerce order backward; that stays a human decision).

---

## 3. The customer-facing side

### `sillage-tracking` plugin (WordPress)
`plugins/sillage-tracking/` — three files:

- **`class-sillage-tracking-lookup.php`** — the public `POST /wp-json/sillage/v1/track` route.
  - Input: `{order, email}`. The order term may be the **order number**, the **order id**, or a
    **tracking number** (matched against `_sillage_tracking` meta with a LIKE). The email must match
    the order's billing email.
  - **Rate-limited**: 30 lookups / 600 s per client IP (via `X-Forwarded-For`, falling back to the
    socket; a missing IP is never limited).
  - **Obfuscates**: an unknown order and a wrong email return the same `not_found`, so the reply
    never reveals whether the order exists.
  - Returns `{ok, order:{number,status,status_label,placed,currency}, parcels:[{warehouse,courier,code,url}],
    items:[{name,quantity,image,warehouse}]}`. `warehouse` is the **location letter** (`A`/`B`), not a
    name: the storefront translates "Warehouse Blossom" / "Warehouse Fern" itself. Parcels are read
    from `_sillage_tracking` by `sillage_tracking_parcels()`; each item's letter comes from its
    `_sillage_location` meta (falling back to `_sillage_vendor` on older orders).
- **`sillage-tracking.php`** — `sillage_tracking_parcels()` (read `_sillage_tracking`),
  `sillage_tracking_vendor_letter()` / `sillage_tracking_warehouse_name()` (the vendor→letter→name
  map, shared with `sillage-warehouses` when it is active), the email class registration, and two
  hooks:
  - on `woocommerce_new_customer_note` → if the note contains a tracking code we know, send the
    **branded email** instead of WooCommerce's generic one;
  - filter `woocommerce_email_recipient_customer_note` → suppress WooCommerce's own generic note for
    tracking notes (so the customer gets one email, not two; turning the tracking email off restores
    the generic one).
- **`class-sillage-tracking-email.php`** — the `WC_Email` subclass ("your parcel has shipped"). It
  names each parcel's warehouse, and prints **only the parcel whose code the triggering note carries**,
  so a mixed order's second shipment does not repeat the first warehouse's parcel.

### Storefront page (`react_store/frontend`)
- `src/features/content/pages/OrderTracking.jsx` — the interactive panel on **`/order-tracking`**
  (rendered by `ContentPage`). Two fields: **order number** + **email**. On submit it calls
  `trackOrder({order, email})`.
- `src/shared/lib/woo.js` → `trackOrder()` → `POST /sillage/v1/track` against the WordPress base
  (public, no nonce/cart token).
- The result renders: order number, a status pill, placed date, the parcels and the order's line
  items. A **mixed** order (both warehouses) groups parcels and items under warehouse headings; a
  single-warehouse order shows one flat list per section with the warehouse named on each parcel
  card. `src/shared/ui/TrackingParcels.jsx` holds the parcel cards and headings;
  `groupByWarehouse()` in `src/shared/lib/warehouse.js` decides when to group.
- The **account order detail** (`src/features/account/pages/OrderDetail.jsx`) shows the same Parcels
  section and the same grouping for its item list. It reads `parcels` and each item's `warehouse`
  from the authenticated route `GET /wc/store/v1/customer/orders/{id}` (the
  `cereve-storefront-auth` MU plugin) — no second request.
- All copy is i18n (`track.*`, `account.*` keys in `src/locales/*.json`); the warehouse name reuses
  `cart.warehouse` (`"Warehouse {{name}}"`).

---

## 4. What the page shows — and what it deliberately does not

**Shows:** the WooCommerce order's status label, the placed date, each parcel (courier, code, and a
carrier link if the vendor supplied a URL), and the items.

**Does not show:** a live carrier event timeline ("collected → in transit → delivered"). We only ever
hold the code + (BeautyFort) a URL. Real-time carrier status would need a third-party tracking
aggregator (AfterShip / Shippo / 17track …), which is **not** integrated — this is the one real gap
if you want richer tracking.

**BTS gap:** BTS returns no tracking URL, so BTS parcels show courier + code with no link. Options if
you want a link: build one per courier from `courier + code` (e.g. DPD/PostNL public trackers), or
record the URL when the operator fills it manually.

### Mixed orders (BeautyFort + BTS in one order)

Works end to end: the two legs are polled by their own adapters, each parcel is tagged
`vendor: "beautyfort" | "bts"` in `_sillage_tracking`, all parcels land on the same WooCommerce
order, one email fires per vendor as each ships, and the WC order only reaches `completed` when
every live leg is delivered/cancelled.

The `vendor` tag is now **surfaced** as the location letter (`A` = Warehouse Blossom, `B` = Warehouse
Fern) by both the public `/track` payload and the authenticated account route. Parcels and items are
grouped under warehouse headings wherever a mixed order shows them (account order detail, tracking
page, email), and an email announces only the parcel its triggering note names. Customers still see
**only** "Warehouse Blossom" / "Warehouse Fern" — never "BTS" / "BeautyFort" or the letters.

---

## 5. Code map

| Layer | Path | Role |
|---|---|---|
| Engine poll | `sillage-core/src/orders/tracking.ts` | Poll vendors, store parcels, push to WC, complete order |
| Engine adapters | `sillage-core/src/orders/adapters/{beautyfort,bts}.ts` | `poll()` → parcels |
| Engine parcel table | `sil_vendor_order_tracking` | `courier, tracking_code, tracking_url, dispatched_at, pushed_to_wc` |
| Bridge REST | `…/plugins/sillage-bridge/includes/class-sillage-rest.php` | `/sillage/v1/order-update` (HMAC) |
| Bridge tracking | `…/plugins/sillage-bridge/includes/class-sillage-orders.php` (`apply_tracking`) | `_sillage_tracking` meta + customer note |
| Public lookup | `Sillage/plugins/sillage-tracking/class-sillage-tracking-lookup.php` | `POST /sillage/v1/track` |
| Email | `Sillage/plugins/sillage-tracking/{sillage-tracking.php, class-sillage-tracking-email.php}` | branded email on `woocommerce_new_customer_note`, labelled by warehouse |
| Account route | `Sillage/mu-plugins/cereve-storefront-auth.php` (`cereve_auth_order`) | `GET /wc/store/v1/customer/orders/{id}` — parcels + item warehouse |
| Storefront page | `react_store/frontend/src/features/content/pages/OrderTracking.jsx` | `/order-tracking` form + result |
| Storefront account | `react_store/frontend/src/features/account/pages/OrderDetail.jsx` | Parcels section + warehouse-grouped items |
| Storefront parcels | `react_store/frontend/src/shared/ui/TrackingParcels.jsx` | Parcel cards + warehouse headings |
| Storefront grouping | `react_store/frontend/src/shared/lib/warehouse.js` | warehouse names + `groupByWarehouse()` |
| Storefront client | `react_store/frontend/src/shared/lib/woo.js` (`trackOrder`, `getCustomerOrder`) | POST to `/sillage/v1/track`; account route |

---

## 6. Invariants (do not break)

1. **Never reveal whether an order exists.** `not_found` covers both "no such order" and "wrong
   email", identically.
2. **Never push dry-run tracking.** `pollVendorOrder` returns immediately for `dry_run=1` legs.
3. **Dedupe by tracking code.** The poller re-reads the vendor every N minutes; a parcel is recorded
   once, in both `sil_vendor_order_tracking` (INSERT IGNORE) and `_sillage_tracking` (code check).
4. **Forward-only.** Status moves only `submitted → confirmed → dispatched → delivered` (or
   `cancelled`), and the WC order only ever moves *toward* `completed`, never back.
5. **Customer notification is a setting** (`orders_notify_customer`). Off → the note is private and
   no email is sent; the tracking is still recorded and still visible via the public lookup.
6. **The lookup is public and unauthenticated** (no nonce/token) — that's why it requires the billing
   email and is rate-limited. Do not add a capability check that would lock shoppers out.

---

## 7. What "developing this feature" would actually mean now

The feature is built. Realistic follow-up work is one of:

- **Live carrier events** — add an aggregator (AfterShip/Shippo/17track), store the event timeline
  in a new table, expose it in the `/track` payload and render a progress timeline in
  `OrderTracking.jsx`. This is the only way to show "out for delivery" rather than a carrier link.
- **BTS carrier links** — build a public tracker URL from `courier + code` for the known couriers.
- **Operator manual tracking entry** — a dashboard field to attach a tracking code/URL to a leg the
  vendor never reported automatically.
- **Multiple parcels per leg** — already stored as multiple rows; the UI already loops `parcels`, so
  this is only a data question.
