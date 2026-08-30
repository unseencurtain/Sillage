# BTS orders and tracking (API v2.1)

Canonical vendor doc (operator portal, July 2026): **BTSWholesaler API v2.1**.
Catalogue side already uses JWT `getListProducts` / `getProductChanges`. This page is the
**order + tracking** half.

Live default: `orders_dry_run=1`, `orders_auto_dispatch=0`. There is **no sandbox**.
`setCreateOrder` spends real money.

---

## Endpoints we use

| Call | When | Notes |
|---|---|---|
| `getProductStock` | Before submit | Max 100 SKUs; keyed by **EAN** |
| `getShippingPrices` | Before submit | `shipping_cost_id` must match country/postcode |
| `setCreateOrder` | Submit (live only) | Returns a 12-digit `order_number`. No client reference. No list-orders. |
| `getOrder` | Every tracking poll | Status, shipping company, tracking when the field is filled |
| `getTrackings` | Same poll, if `getOrder.tracking` is empty | Bulk; v2.1 “ideal for tracking queries” |

Code: `src/vendors/bts/BtsClient.ts`, `src/orders/adapters/bts.ts`, `src/orders/tracking.ts`.

---

## Status mapping

BTS `order_status` is normalised in `orderStatus.ts` then mapped:

| BTS | Sillage poll | `sil_vendor_orders.status` |
|---|---|---|
| Pending Payment | `pending` | stays `submitted` (no rank advance) |
| Paid | `confirmed` | `confirmed` |
| Shipped | `dispatched` | `dispatched` |
| Delivered | `delivered` | `delivered` |
| Cancelled | `cancelled` | `cancelled` |

**Bug that bit us (fixed in tracking):** `cancelled` was not in the forward rank table, so a
BTS order whose portal status was already `Cancelled` stayed `submitted` forever. Live example
checked 2026-08-30: vendor order `179330441368` (`SIL-54253-BTS`) — `getOrder` = Cancelled,
Sillage row still `submitted` until this fix is deployed. Tracking list was empty
(`tracking: null`); that is correct for a cancelled unpaid/unshipped order.

Cron selects `submitted` / `confirmed` / `dispatched` only. Once cancelled, polling stops.

---

## `getTrackings` vs “order not found”

v2.1 text:

> Tracking is assigned after the carrier picks up the package (typically 24–72 hours).
> Poll every 2–4 hours. If an order doesn't have tracking yet, you'll receive
> `order_not_found`.

That error means **no tracking yet**, not “this order number is invalid”.

We:

1. Always `getOrder` for status (a real order returns 200 even with empty tracking).
2. Call `getTrackings` only when `getOrder.tracking` is empty.
3. Treat JSON `tracking: null`, empty string, and HTTP `order_not_found` as “no parcel yet”.
4. Do **not** park the Sillage row for that case.

A true missing `getOrder` (wrong number) can still park via `isPermanentPollFailure`
(`/order not found/i`) — same as BeautyFort’s empty GetOrderDetail.

Sillage poll interval is Settings **Orders poll minutes** (live **15**). That is more often
than BTS’s 2–4h hint. Fine at current volume (one-digit live rows). Do not drop below 5
minutes (BeautyFort’s own cap).

BTS does not return a tracking URL. We store courier + code and push that to WooCommerce;
the customer note has no carrier deep-link unless BeautyFort supplied one.

---

## Ambiguous submit (do not auto-retry)

BTS accepts no `yourOrderReference` and has no list-orders. A timeout after
`setCreateOrder` left the network → row goes `needs_attention`, never auto-retry.
A human checks the BTS portal. Decision 20 in [`DECISIONS.md`](DECISIONS.md).

---

## How to verify (read-only)

On `ovhe`, inside `sillage-core` (uses the container JWT; prints **no** address fields):

```bash
docker exec sillage-core bun -e '
import { BTSClient } from "./src/vendors/bts/BtsClient.ts";
import { env } from "./src/config/env.ts";
const c = new BTSClient({ token: env.bts.token, baseUrl: env.bts.baseUrl });
const n = process.env.N ?? "179330441368";
const o = await c.getOrder(n);
console.log({ status: o.order_status, tracking: o.tracking, company: o.shipping_company });
try { console.log(await c.getTrackings([n])); }
catch (e) { console.log("getTrackings", String(e)); }
'
```

Then compare `sillage.sil_vendor_orders` for that `vendor_order_number`.

Force one poll after deploy:

```bash
docker exec sillage-core bun run orders -- poll --id=3
```

(`id` is `sil_vendor_orders.id`. Dry-run rows are skipped by the poller.)

---

## Operator checklist before first **live** BTS dispatch

- [ ] `orders_dry_run=0` only for that window, then turn it back on
- [ ] Wallet / banktransfer agreed with the BTS account manager
- [ ] Destination is in BTS `getCountries` / vendor `serviceable_countries`
- [ ] Lines keyed by EAN, stock checked
- [ ] Company billing is portal-side; Settings BTS billing is ops-only
