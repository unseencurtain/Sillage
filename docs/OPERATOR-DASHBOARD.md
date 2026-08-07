# Operator dashboard — BeautyFort + BTS

Live UI: `https://sillage.slilverbelt.xyz` (staging `ovhe`). This retail shop syncs **BeautyFort**
and **BTS** only. wholesale-perfumes is parked for a separate B2B site (`b2b-wholesale/`) — inactive,
excluded from `--vendor=all`, `/b2b-wholesale` draft, not editable here.

Source of truth for ops knobs: `sillage.sil_settings` / `sillage.sil_vendors`, edited through this
dashboard (or SQL). Auth is HTTP session cookies against `DASHBOARD_USER` / `DASHBOARD_PASSWORD`
(env, not `sil_settings`).

**Code map**

| Layer | Path |
|---|---|
| Pages | `production-environment/sillage-core/web/src/pages/*` |
| Nav | `web/src/components/Layout.tsx` |
| Client API | `web/src/lib/api.ts` |
| Server routes | `src/server/routes/api.ts` |
| Settings load | `src/db/settings.ts` → `loadSettings()` / `loadVendors()` |
| Scheduler | `src/sync/schedule.ts` + container `crontab` (`*/5`) |
| Orders | `src/orders/{dispatch,rails,tracking,ingest,addresses}.ts` |
| Shop cart fee / MOQ | `sillage-bridge` → `class-sillage-cart-fee.php` |

---

## Money safety (read first)

| Fact | Detail |
|---|---|
| **`orders_dry_run` does not drive the Dry-run / Live buttons** | Dashboard `POST /api/orders/:id/dispatch` always sets `dryRun: !live` and `force: true`. The setting only affects **auto-dispatch** and CLI defaults. Turning dry-run **off** + auto-dispatch **on** spends money without a click. |
| Fail-closed defaults | Seed: `orders_dry_run=1`, `orders_auto_dispatch=0`. Keep them that way unless you intend live spend. |
| No sandbox | BeautyFort and BTS have no vendor sandbox. Live dispatch spends real money. |

```
WC order → HMAC webhook → ingest splits sil_vendor_orders (status=received)
        → cron tick:
             auto_dispatch OFF → promote to approved (rails permitting); wait for human
             auto_dispatch ON  → dispatchVendorOrder(force) with orders_dry_run
        → dashboard:
             Approve = force rails check only
             Dry-run / Live = force + explicit dryRun flag (ignores orders_dry_run)
```

---

## Navigation

| Nav label | Route | Page |
|---|---|---|
| Overview | `/` | Health snapshot |
| Sync | `/sync` | Manual runs + BF/BTS live gates |
| Products | `/products` | Catalogue search (read-only) |
| Vendors | `/vendors` | BeautyFort + BTS editors; WPF parked notice |
| Orders | `/orders` | Per-vendor order dispatch |
| Settings | `/settings` | Schedule, pricing, cart fee, order rails, billing |
| Logs | `/logs` | Event log |
| Sign out | — | `POST /api/auth/logout` |
| (unlisted) Login | `/login` | Cookie session |

---

## Login

| Control | API | Effect |
|---|---|---|
| User / Password / Sign in | `POST /api/auth/login` | Cookie session; creds from env |
| Session check | `GET /api/auth/me` | Guards authenticated routes |

---

## Overview

Read-only. Polls `GET /api/overview` every 15s.

| UI | Meaning |
|---|---|
| Visible in shop | WP publish ∩ not `exclude-from-catalog` |
| Published in WP | Includes catalog-hidden products |
| Sillage products | `COUNT(sil_products)` |
| Sync on/off · orders dry-run/LIVE | Snapshot of rails (edit on Settings) |
| Catalogue visibility stats | Hidden no-image vs stock threshold |
| Last sync | Latest `sil_sync_runs` |
| Vendor orders by status | Counts only |
| Syncs · last 7 days | Activity chart |

No buttons. No writes.

---

## Sync / Runs

| Control | API | Effect |
|---|---|---|
| Run fast sync | `POST /api/sync/run` `{mode:"fast"}` | Clears abort; re-enables `sync_enabled` if off; price/stock-oriented sync |
| Run full sync | same, `mode:"full"` | Full catalogue path (taxonomy, vanish, park WPF, etc.) |
| Stop all sync | `POST /api/sync/stop` | Cooperative abort; **`sync_enabled=0`** until Sync enabled or Run |
| Live API cards (BF / BTS) | `GET /api/sync/live-status` | Read-only gate status for the two retail vendors |
| Runs table + pagination | `GET /api/sync/runs` | History |

**Schedule (not a button):** cron every 5 minutes → only opens catalogue sync in the **:00 / :30**
windows, then applies `sync_enabled`, `full_sync_*`, `fast_sync_minutes`, `sync_source`. Order
housekeeping (approve/dispatch/poll) runs **every** tick regardless of sync window.

`--vendor=all` never includes parked wholesale-perfumes.

---

## Products

| Control | API | Effect |
|---|---|---|
| Search box | `GET /api/products?q=&page=` | Filters SKU / name / EAN |
| Table | same | Read-only. Cost = vendor price on primary offer |
| Pagination | same | 50 per page |

No edit / hide / reprice actions. Retail price and visibility change via sync + Settings/Vendors.

---

## Orders

Rows are **per-vendor** (`sil_vendor_orders`), not WooCommerce orders. Refresh every 10s.

| UI label | API | Effect |
|---|---|---|
| Select row `#id` | `GET /api/orders/:id` | Detail pane |
| Approve | `POST .../approve` | Coverage + ceiling rails; `received`→`approved` (force) |
| Dry-run | `POST .../dispatch` `{live:false}` | Full path **without** spending money |
| Live (+ confirm) | `{live:true}` | **Spends real money.** Confirm required |
| Open in WooCommerce | link | HPOS edit URL |
| Tracking stage chips | `POST .../status` | Manual stage. After live submit, 409 until `confirm:true` |
| Save delivery | `PUT .../address` `{delivery}` | Vendor ship-to; WC unchanged |
| Reset from WooCommerce | `{resetDeliveryFromWoo:true}` | Re-reads HPOS address |
| Save billing | `{billing}` | Invoice address for BeautyFort |
| Use saved company billing | `{useCompanyBilling:true}` | Fills from Settings BF/BTS profiles |
| Tracking / Event log | detail payload | Read-only |

**Editable window:** `received` \| `approved` \| `needs_attention` \| `submitted` (submitted only if
still dry-run). Live submitted addresses are locked.

**Auto path:** every cron tick, if `orders_auto_dispatch=1`, due rows dispatch using
**`orders_dry_run`**. If auto is off, tick still promotes `received`→`approved` when rails allow.

---

## Vendors (BeautyFort + BTS)

Editable cards for `beautyfort` and `bts` only. Save → `PUT /api/vendors/:slug` → optional
rewrite-only sync when multiplier/VAT changes. Confirmation required when changing **Active** or
**Serviceable countries**.

| UI label | Storage | Effect |
|---|---|---|
| Storefront label | `storefront_label` | Customer-facing lane (e.g. LPS01 / LPS02) |
| Price multiplier | `price_multiplier` (null = empty) | Per-vendor override **disables** global price tiers for that vendor |
| Min visible stock | `min_visible_stock` | Stock ≤ threshold → hidden + outofstock |
| FX rate | `fx_rate` | Cost = vendor × FX × (1+VAT) |
| VAT rate (fraction) | `vat_rate` | Use `0.21` for 21% |
| Min order value (EUR) | `order_config.min_order_value_eur` | Bridge hard-blocks checkout under MOQ |
| Serviceable countries | `serviceable_countries` JSON | ISO list; blocks approve/dispatch outside list |
| Live downloads / day | `live_max_per_day` | Catalogue live-fetch daily cap |
| Active | `active` | Inactive = skipped by sync / cannot dispatch |

Not editable: `slug`, `sku_prefix`, `currency`, API credentials (env).

### Parked: wholesale-perfumes

Shown as a **read-only** dashed card: “parked for `b2b-wholesale/` site”. No store-feed knobs, no
Active toggle, no Save. Sync forces `active=0` every run. Do not activate on this shop.

---

## Settings

Save → `PUT /api/settings` (allow-listed keys only). Price/visibility keys mark offers dirty and
start a **cache rewrite-only** sync; `description_mode` / `volume_filter_mode` mark products dirty
and start a **full/cache** sync.

### Schedule & sync source

| UI label | Key | Effect |
|---|---|---|
| Sync enabled | `sync_enabled` | Off → scheduled catalogue sync skipped. Stop sets off; Run / toggling on clears abort |
| Fast sync minutes | `fast_sync_minutes` | Minutes since last success before a fast sync is due (:00/:30 windows only) |
| Full sync enabled | `full_sync_enabled` | Nightly full attempt |
| Full sync hour (UTC) | `full_sync_hour` | Database hour (UTC on this stack) |
| Sync source | `sync_source` | `live` \| `local` (fixtures) |
| Min minutes between live downloads | `live_feed_min_minutes` | Hard gate for BF/BTS; cache until elapsed. Daily caps on Vendors |

### Pricing & catalogue visibility

| UI label | Key | Effect |
|---|---|---|
| Price multiplier | `global_price_multiplier` | Fallback when no tier matches / tiers empty / no vendor override |
| Price tiers (section) | `price_tiers` JSON | Cost bands; last row unbounded (`maxCost: null`) |
| Stock threshold | `global_stock_threshold` | Global floor when vendor min stock is null |
| Hide products without image | `hide_products_without_image` | `exclude-from-catalog` when image missing/placeholder |
| Volume filter | `volume_filter_mode` | `ranges` \| `exact` \| `off` |
| Description mode | `description_mode` | `none` = title in `<p>`; `template` = brand/type/size blurb |

### Cart minimum (storefront fee)

Read by PHP bridge from `sil_settings` (fail-open). Independent of per-vendor MOQ.

| UI label | Key | Effect |
|---|---|---|
| Small-order fee | `cart_min_enabled` | Off by default |
| Cart minimum (EUR) | `cart_min_subtotal_eur` | Global subtotal floor for the fee |
| Small-order fee (EUR) | `cart_min_fee_eur` | Charged once when under floor |
| Small-order fee label | `cart_min_fee_label` | Line item label |
| Small-order fee message | `cart_min_message` | Must include `{remaining}` |

### Orders rails

| UI label | Key | Effect |
|---|---|---|
| Orders dry-run | `orders_dry_run` | Auto-dispatch + CLI default — **not** the dashboard Dry-run/Live buttons |
| Auto-dispatch | `orders_auto_dispatch` | Off = human Approve/Dry-run/Live; on = cron submits (respecting dry-run) |
| Max order value EUR | `orders_max_value_eur` | Blocks approve/dispatch over ceiling |
| Daily spend cap EUR | `orders_daily_cap_eur` | Rolling 24h live spend |
| Tracking poll minutes | `orders_poll_minutes` | How often live vendor orders are polled (min 5) |
| Notify customer on tracking | `orders_notify_customer` | Email flag into bridge REST |

### Company billing profiles

| UI | Key | Used by |
|---|---|---|
| BeautyFort form | `company_billing_beautyfort` | BeautyFort InvoiceAddress |
| BTS form | `company_billing_bts` | Ops / dry-run payload (BTS invoice is portal-side) |

---

## Logs

| Control | API | Effect |
|---|---|---|
| Level filter | `GET /api/logs?level=&page=` | Filters `sil_events.level` |
| Table | same | When / level / scope / message |

---

## Not on the Settings UI (by design)

| Key / control | Status |
|---|---|
| `image_cdn_base_url` | **Removed from UI.** Not read by sync; product URLs come from `image_overrides.json` / feeds. Tools use env `LPS_MEDIA_BASE_URL` / `PUBLIC_URL_BASE`. DB key may still exist — harmless. |
| `max_rrp_ratio` | **Unused** in pricing (`void` in `computePricing`). Not shown. |
| WPF store-feed caps / live-status card | Parked with B2B — not on Sync or Settings |
| `dedupe_by_ean`, `primary_offer_strategy`, `write_batch_size`, `max_statement_bytes` | Used in code; change via SQL if needed |
| Legacy `beautyfort_live_max_per_day` / `bts_live_max_per_day` | Fallback if vendor row caps null (prefer `sil_vendors.live_max_per_day`) |

---

## Env-only knobs (not on dashboard)

| Env | Role |
|---|---|
| `DASHBOARD_USER` / `DASHBOARD_PASSWORD` / `SESSION_SECRET` | Dashboard auth |
| `SILLAGE_SHARED_SECRET` | HMAC between Bun ↔ bridge |
| `BEAUTYFORT_*` / `BTS_*` | Vendor API credentials (retail) |
| `WHOLESALE_PERFUMES_*` | Parked B2B only — unused while WPF inactive |
| `WP_BASE_URL` / `WORDPRESS_INTERNAL_URL` | Shop URLs |
| `LPS_MEDIA_BASE_URL` / `PUBLIC_URL_BASE` / `IMAGE_HOST_BASE_URL` | Image tooling defaults |
| `DB_*` / `SILLAGE_DB_*` / `REDIS_URL` | Infrastructure |
| `FIXTURES_DIR` | Local/fixture sync root |
| `BEAUTYFORT_TEST_MODE` | BeautyFort SOAP test flag |

Internal runtime keys (not operator UI): `sync_abort`, `last_live_fetch_*`, `live_fetch_count_*_*`.

---

## Quick operator recipes

1. **Pause catalogue sync** — Settings → Sync enabled off, or Sync → Stop all sync.
2. **Resume** — Sync enabled on, or press Run fast/full (re-enables).
3. **Change retail markup** — Settings tiers/multiplier and/or Vendors multiplier → wait for auto rewrite toast, or Sync → fast.
4. **Safe order test** — keep dry-run on; Orders → Dry-run; inspect payload/events.
5. **First live order** — prefer auto **off**, then Live with confirm on one row. Never flip dry-run off while auto-dispatch is on unless you mean it.
6. **CDN / image hostname** — set tool env `LPS_MEDIA_BASE_URL` / `PUBLIC_URL_BASE`; regenerate `image_overrides.json`; sync `--rewrite-all`. There is no Settings CDN field.
