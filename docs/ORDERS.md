# Orders — what actually happens, end to end

**Read this before touching any order code.** The order pipeline is the one place in Sillage that
spends money, and every confusing part of the dashboard — the statuses, the "dots", "dry-run vs
live", "why is it stuck at approved" — traces back to three settings and two background loops. This
file explains the model in plain language, then gives the code map and the invariants you must not
break.

---

## 1. The mental model

A shopper places **one WooCommerce order**. That one order may contain products that Sillage buys
from **BeautyFort**, from **BTS**, or from **both**. Sillage cannot send "one order" to a vendor
because the vendors are different companies with different APIs and different stock — so it **splits**
the WooCommerce order into one *vendor leg* per vendor:

```
WooCommerce order #52075
├── leg #32 → BTS          (the BTS products)
└── leg #33 → BeautyFort   (the BeautyFort products)
```

- **One leg = one row in `sil_vendor_orders` = one vendor API submission.**
- A leg has its own status, its own vendor order number, its own tracking, its own items, its own
  cost/revenue.
- The dashboard shows **one row per WooCommerce order** (with vendor chips and per-vendor status in
  the list), and **one tab per vendor** when you open an order. So all three scenarios — BF only,
  BTS only, both — are the same screen.

This is why the old UI's `ID32 / ID33` confusion existed: those were *leg* ids, not WooCommerce
order ids. The reference `SIL-52075-BTS` / `SIL-52075-BF` is the leg's correlation key
(`SIL-<wc_order_id>-<vendor_sku_prefix>`), and it must be unique **forever** (BeautyFort treats it
as an idempotency key).

---

## 2. The three settings that decide everything

| Setting key | Meaning | Fail-closed default |
|---|---|---|
| `orders_dry_run` | Rehearsal vs real. **On**: dispatch builds and validates the payload but does **not** commit to the vendor. **Off**: a submit is a real order. | `1` (on) |
| `orders_auto_dispatch` | Manual vs automatic. **Off**: a human presses Approve / Dry-run / Live. **On**: the cron dispatches every due leg on its own. | `0` (off) |
| `orders_poll_minutes` | How often live legs are polled for tracking (min 5). | `15` |

**These are independent.** The two most important combinations:

| dry_run | auto_dispatch | Behaviour |
|---|---|---|
| on | off | **The safe test mode (what the shop is in today).** Legs sit at `approved` until you click Dry-run/Live. Nothing real is ever sent. |
| on | on | The cron auto-*rehearses* every due leg (dry-run submit), but still never places a real order. |
| off | off | Manual live dispatch. Each Live click spends from the vendor's account balance. |
| off | on | **Fully hands-off live:** cron places every due leg automatically. This is the only combination that spends money with no click. |

> **"The money is already in their API account."** Correct — BeautyFort and BTS are prepaid, so a
> live submit deducts an existing balance rather than charging a card. It is still a *real spend*:
> it creates a real order the vendor will pack and ship. `dry_run` exists so testing does not
> consume that balance or create phantom shipments. Whether to go live is an operator decision; the
> engine never decides it for you.

**The Dry-run / Live buttons always override the setting.** `POST /orders/:id/dispatch` sends
`dryRun: !live` explicitly, so a human can always rehearse (Dry-run) or always place (Live) one leg,
whatever `orders_dry_run` says. Only **auto-dispatch and the CLI** read the setting.

---

## 3. The status lifecycle

Each leg lives in exactly one status. `sil_vendor_orders.status` enum:

```
received → approved → submitting → submitted → confirmed → dispatched → delivered
                          └───────────→ failed / needs_attention
(cancelled is a manual/terminal close, set from anywhere pre-dispatch)
```

Who sets each one, and what it means:

| Status | Set by | Meaning |
|---|---|---|
| `received` | ingest (machine) | The WooCommerce order was just imported and split; nothing reviewed yet. |
| `approved` | dispatch (machine, or Approve button) | Coverage/country/ceiling/cap rails passed; waiting to be sent. |
| `submitting` | dispatch (machine) | The API request is in flight right now (transient). |
| `submitted` | dispatch (machine) | Sent to the vendor. **This is the money step in live mode.** In dry-run it's a rehearsal with no vendor call. |
| `confirmed` | tracking poller (machine) | The vendor accepted the order. |
| `dispatched` | tracking poller (machine) | The vendor shipped; tracking parcel(s) now exist. |
| `delivered` | tracking poller (machine) | The courier delivered. |
| `failed` | dispatch (machine) | A rail refused it, or the vendor rejected it. Terminal until a human reopens. |
| `needs_attention` | dispatch / tracking (machine) | Ambiguous outcome (e.g. network dropped after a BTS submit) or a daily cap hit. A human must look — it is never auto-retried. |
| `cancelled` | human (bulk "mark done", or override) | Closed without sending. Reversible from the override. |

**The rules that matter:**

1. **Forward-only.** The tracking poller only ever advances `submitted → confirmed → dispatched →
   delivered` (rank comparison), and only when the vendor's own API reports the next stage. Nothing
   fabricates progress; `delivered` means the courier delivered, which takes real days.
2. **The machine does the work; the human only corrects.** In the normal live flow the operator
   touches nothing: ingest → `received`, auto-dispatch → `approved`/`submitted`, poller →
   `confirmed`/`dispatched`/`delivered`.
3. **A dry-run leg never passes `submitted`, and stays "to do".** "To do" is computed as *not*
   `(status ∈ submitted/confirmed/dispatched/delivered/cancelled)`, with one exception: a dry-run
   `submitted` is still "to do" (a rehearsal is not a placement). This is why the test orders sit in
   the "To do" chip even after you Dry-run them.

---

## 4. The two background loops

Both run every cron tick (5 minutes) from `runScheduledSync` in `src/sync/schedule.ts`, **before**
any catalogue work:

```
recoverStuckSubmits()          # legs stuck in `submitting` after a crash → needs_attention
sweepDispatchableOrders(20)    # import any new WooCommerce order (wc-processing/completed) with no leg
dispatchDueOrders(10)          # the dispatch loop (below)
pollDueOrders(50)              # the tracking loop (below)
```

### 4a. Dispatch loop — `dispatchDueOrders` (`src/orders/dispatch.ts`)

- `orders_auto_dispatch` off → promote every `received` leg to `approved` (if rails pass), then
  **stop and wait for a human**. This is exactly why a freshly placed order sits at `approved`.
- `orders_auto_dispatch` on → for every `received`/`approved` leg (no vendor filter — **both
  vendors**), run `dispatchVendorOrder(force)`: rails → `approved` → `submitting` → `submitted`
  (using `orders_dry_run` to decide live vs rehearsal).

So a mixed order, when auto-dispatch is on, is routed to **both** vendors automatically.

### 4b. Tracking loop — `pollDueOrders` (`src/orders/tracking.ts`)

- Selects **live** legs (`dry_run = 0`) with a `vendor_order_number` in
  `submitted`/`confirmed`/`dispatched`, older than `orders_poll_minutes` since last poll.
- Calls that leg's vendor adapter `poll()`:
  - **BeautyFort** — `getOrder` returns `detail.parcels[]` (`trackingCode`, `trackingURL`,
    `courierName`).
  - **BTS** — `getOrder` status + `getTrackings` bulk endpoint (falls back; often `null` for
    24–72 h).
- Advances the leg forward (`nextVendorOrderStatus`, rank-only), records new parcels into
  `sil_vendor_order_tracking`, pushes each new parcel to WooCommerce via
  `POST /wp-json/sillage/v1/order-update` (HMAC-signed, handled by the `sillage-bridge` plugin),
  then marks it `pushed_to_wc`.
- When **every live leg** of a WooCommerce order is `delivered`/`cancelled`, marks the WooCommerce
  order `completed` (`maybeCompleteWooOrder`).

So a mixed order produces **two independent tracking streams** — BF tracking on the BF leg, BTS
tracking on the BTS leg — exactly as you'd expect. They never mix.

> **Why tracking has never run for real yet:** every order so far has been `dry_run=1`, and
> `pollVendorOrder` returns immediately for dry-run legs. The machinery is complete and wired at both
> ends, but end-to-end proof requires a live order (real spend). It has not happened.

---

## 5. The dashboard page (current design)

List (`web/src/pages/Orders.tsx`, `GET /api/orders`):

- **One row per WooCommerce order** (grouped by `wc_order_id`), not per leg.
- Columns: `WC · Vendors · Status · Cost`.
- Vendors cell = vendor chips (`BTS`, `BF` — the `sil_vendors.sku_prefix`) + `dry` when dry-run.
- Status cell = one line: `to do` pill (when any leg is still to do) + each leg's status badge,
  prefixed by its code when the order is mixed.
- Amber left accent marks "to do"; `All / To do / Done` chips filter at **order** level (an order
  is "done" only when every leg is done).
- Bulk bar: **Mark N done** (closes the selected/all-to-do orders as `cancelled` — reversible, no
  spend) and **Delete** (whole order, all legs + items + events + tracking; requires the operator's
  dashboard password; writes a tombstone so the order is not re-imported).

Detail panel (`GET /api/orders/:id`):

- **One tab per vendor leg** when the order is mixed (tabs switch `selected` → refetch that leg).
- Per-leg: Approve / Dry-run / Live buttons (the manual path), the read-only **Progress** stepper,
  a **Manual override** select (only for correcting stuck states), WooCommerce customer address
  (read-only), **Delivery (vendor ship-to)** editor, **Billing/invoice (company)** editor, line
  items, tracking parcels, event log.

Bulk close/delete is `POST /api/orders/bulk`. Delete is password-gated (`verifyPassword`) and
writes `sil_order_ingest_ignore` tombstones once an order has no leg left, so the sweep does not
resurrect it.

---

## 6. What must never change (invariants)

1. **WooCommerce is authoritative after any mutation.** Preserve cookies, cart tokens, nonces,
   `credentials: include`. Never store customer credentials.
2. **A leg already live-submitted is never bulk-closed or deleted.** `placedSql` =
   `dry_run = 0 AND status IN (submitted, confirmed, dispatched, delivered)`. Bulk actions skip it.
3. **Never delete a WooCommerce order** — Sillage only deletes its own rows. Deleting rows for a
   WooCommerce order still `wc-processing`/`wc-completed` would otherwise resurrect via
   `sweepDispatchableOrders`; the tombstone table prevents that.
4. **The delivery/billing editors are Sillage-only.** They write `delivery_address_json` /
   `billing_address_json` (and the per-vendor company billing profiles in `sil_settings`); they never
   write WooCommerce. The customer-name override is intentional (dropship "from the shop").
5. **The vendor suffix in `SIL-<order>-<PREFIX>` is load-bearing.** Two legs of one order must never
   share a reference.
6. **Never invent a "delivered" or auto-advance a status.** Status only moves from vendor-reported
   data (or an explicit human override). No code fakes shipment progress.
7. **Fail closed.** `orders_dry_run=1` + `orders_auto_dispatch=0` is the safe default. The only
   no-click spend is dry-run **off** + auto-dispatch **on**.

---

## 7. Code map

| Concern | Path |
|---|---|
| Ingest & split | `src/orders/ingest.ts` (`ingestOrder`, `sweepDispatchableOrders`) |
| Dispatch / rails | `src/orders/dispatch.ts`, `src/orders/rails.ts`, `src/orders/pollRules.ts` |
| Tracking | `src/orders/tracking.ts` |
| Addresses & billing | `src/orders/addresses.ts` |
| Vendor adapters | `src/orders/adapter.ts`, `src/orders/adapters/{beautyfort,bts,index}.ts` |
| Types | `src/orders/types.ts` |
| API routes | `src/server/routes/api.ts` (`/orders*`) |
| Scheduler | `src/sync/schedule.ts` (order housekeeping at top of `runScheduledSync`) |
| Settings | `src/db/settings.ts` (`orders_dry_run`, `orders_auto_dispatch`, `orders_poll_minutes`, caps) |
| Dashboard page | `web/src/pages/Orders.tsx`, `web/src/lib/api.ts` |
| WooCommerce tracking receive | `plugins/sillage-bridge` (`sillage/v1/order-update`) |

Key DB tables: `sil_vendor_orders` (one row per leg), `sil_vendor_order_items`,
`sil_vendor_order_tracking`, `sil_order_events`, `sil_order_ingest_ignore` (delete tombstones),
`sil_vendors` (`sku_prefix` = BF / BTS / WPF).
