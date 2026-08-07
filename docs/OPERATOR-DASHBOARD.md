# Operator dashboard — full control paper

Live UI: `https://sillage.slilverbelt.xyz` (staging `ovhe`). Source of truth for ops knobs is
`sillage.sil_settings` / `sillage.sil_vendors`, edited only through this dashboard (or SQL). Auth is
HTTP session cookies against `DASHBOARD_USER` / `DASHBOARD_PASSWORD` (env, not `sil_settings`).

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

## Mismatch / redundancy (read first)

| Issue | Severity | Detail |
|---|---|---|
| **`orders_dry_run` does not drive the Dry-run / Live buttons** | High | Dashboard `POST /api/orders/:id/dispatch` always sets `dryRun: !live` and `force: true`. The setting only affects **auto-dispatch** (`dispatchDueOrders` → `dispatchVendorOrder` without overriding dry-run) and CLI defaults. Turning dry-run **off** + auto-dispatch **on** spends money without a click. |
| **`image_cdn_base_url` is written but unused by sync** | Medium | Persisted and returned by `/api/settings`. `loadSettings().imageCdnBaseUrl` is never read in `src/sync/*`. Product URLs come from `image_overrides.json` / vendor feeds (absolute). Tools use env `LPS_MEDIA_BASE_URL` / `PUBLIC_URL_BASE`. Changing the setting alone does nothing to the shop. |
| **`max_rrp_ratio` is dead** | Medium | Loaded into `GlobalSettings`, passed into pricing rules, then discarded (`void rules.maxRrpRatio` in `computePricing`). Not on the Settings page. **UNUSED.** |
| **Sync → live status omits wholesale-perfumes** | Medium | `/api/sync/live-status` and the Sync page cards only show BeautyFort + BTS. Third vendor caps are edited on Vendors but not surfaced on Sync. |
| **Company billing has no wholesale-perfumes profile** | Medium | Settings + API only store `company_billing_beautyfort` / `company_billing_bts`. `companyBillingSettingKey("wholesale-perfumes")` falls back to the BeautyFort key. |
| **`full_sync_hour (UTC)` label vs clock** | Low | UI says UTC. Scheduler uses MariaDB `NOW()` (documented as DB TZ; this stack’s DB/container are UTC). Prefer “database hour (UTC on this stack)”. |
| **Price-tier rewrite hint is half-outdated** | Low | Settings copy still pushes `bun run sync -- --rewrite-all`. Saving tiers / multiplier / hide-without-image already triggers a **cache rewrite-only** sync via the API. CLI rewrite-all remains the escape hatch if that fails. |
| **`description_mode: none` ≠ blank** | Low | Hint says “none (title copy)”. Correct: writer always mirrors the title into `<p>…</p>`. `template` adds brand/type/size boilerplate. |
| **Settings missing used keys** | Low | Honored in code but **not** on the Settings page: `dedupe_by_ean`, `primary_offer_strategy`, `write_batch_size`, `max_statement_bytes`. Change via SQL if needed. |
| **Orders status filter unused in UI** | Low | `api.orders(page, status?)` supports `?status=` but the Orders page never offers a filter. |
| **Products `image_url` unused in UI** | Cosmetic | API returns it; table does not show it. |

---

## Navigation

| Nav label | Route | Page component |
|---|---|---|
| Overview | `/` | `Overview.tsx` |
| Sync | `/sync` | `Sync.tsx` |
| Products | `/products` | `Products.tsx` |
| Vendors | `/vendors` | `Vendors.tsx` |
| Orders | `/orders` | `Orders.tsx` |
| Settings | `/settings` | `Settings.tsx` |
| Logs | `/logs` | `Logs.tsx` |
| Sign out | — | `POST /api/auth/logout` |
| (unlisted) Login | `/login` | `Login.tsx` |

---

## Login

| Control | API | Effect |
|---|---|---|
| User / Password / Sign in | `POST /api/auth/login` | Cookie session; creds from env `DASHBOARD_USER` / `DASHBOARD_PASSWORD` |
| Session check | `GET /api/auth/me` | Guards all authenticated routes |

---

## Overview

Read-only health board. Polls `GET /api/overview` every 15s.

| UI | Source | Meaning |
|---|---|---|
| Visible in shop | WP publish ∩ not `exclude-from-catalog` | Rough catalogue loop count |
| Published in WP | `post_status=publish` | Includes catalog-hidden products |
| Sillage products | `COUNT(sil_products)` | Internal identity rows |
| Sync on/off · orders dry-run/LIVE | `sync_enabled`, `orders_dry_run` | Snapshot of rails (not editable here) |
| Catalogue visibility stats | Term joins on visibility | Hidden no-image vs stock threshold breakdown |
| Last sync | Latest `sil_sync_runs` | Mode, source, counters, duration |
| Vendor orders by status | `sil_vendor_orders` GROUP BY | Counts only |
| auto-dispatch / dry-run footer | settings | Same as Settings toggles |
| Syncs · last 7 days | Chart of run counts | Activity, not success rate |

No buttons. No writes.

---

## Sync / Runs

| Control | API | Code path | Effect |
|---|---|---|---|
| Run fast sync | `POST /api/sync/run` `{mode:"fast"}` | Clears abort; re-enables `sync_enabled` if off; `runSync({mode, source: settings.syncSource})` fire-and-forget | Price/stock-oriented sync. Live downloads still rate-limited. |
| Run full sync | same, `mode:"full"` | Same | Full catalogue path (taxonomy, vanish, etc.) |
| Stop all sync | `POST /api/sync/stop` | `requestSyncAbort()` → `sync_abort=1`, **`sync_enabled=0`**, marks running run as error | Cooperative abort between batches; scheduler stays off until Sync enabled or Run |
| Live API cards (BF / BTS) | `GET /api/sync/live-status` | `checkLiveGate` + cache age + daily max | Read-only gate status. **No WPF card.** |
| Runs table + pagination | `GET /api/sync/runs` | `sil_sync_runs` | History |

**Schedule reality (not a button):** cron every 5 minutes → `schedule.ts` → only opens catalogue sync in the **:00 / :30** minute windows, then applies `sync_enabled`, `full_sync_*`, `fast_sync_minutes`, `sync_source`. Order housekeeping (approve/dispatch/poll) runs **every** tick regardless of sync window.

---

## Products

| Control | API | Effect |
|---|---|---|
| Search box | `GET /api/products?q=&page=` | Filters SKU / name / EAN (`LIKE`) |
| Table (SKU, name, vendor, stock, cost, WP id) | same | Read-only. Cost is vendor price on primary offer, not retail. |
| Pagination | same | 50 per page |

No edit / hide / reprice actions. Retail price and visibility change only via sync + Settings/Vendors.

---

## Orders

Rows are **per-vendor** (`sil_vendor_orders`), not WooCommerce orders. List refreshes every 10s.

### List / detail actions

| UI label | API | Code path | Effect |
|---|---|---|---|
| Select row `#id` | `GET /api/orders/:id` | Join items, events, tracking, WC address | Loads detail pane |
| Approve | `POST /api/orders/:id/approve` | `approveVendorOrder(id, true)` — **force** | Runs coverage + ceiling rails; `received`→`approved`. Bypass auto-dispatch wait. |
| Dry-run | `POST .../dispatch` `{live:false}` | `dispatchVendorOrder(id, {force:true, dryRun:true})` | Full quote/submit path **without** spending money; row `dry_run=1` |
| Live (+ confirm) | `{live:true}` | `{force:true, dryRun:false}` | **Spends real money.** Confirm panel required in UI. |
| Open in WooCommerce | link | `WP_BASE_URL` + HPOS edit URL | External |
| Tracking stage chips | `POST /api/orders/:id/status` | Manual status override | Sets operational stage. After **live** submit, API returns 409 until `confirm:true` |
| Save delivery | `PUT .../address` `{delivery}` | Writes `delivery_address_json` only | Vendor ship-to; **WC unchanged** |
| Reset from WooCommerce | `{resetDeliveryFromWoo:true}` | Re-reads HPOS address | Overwrites Sillage delivery snapshot |
| Save billing | `{billing}` | `billing_address_json` | Invoice address for adapters that use it |
| Use saved company billing | `{useCompanyBilling:true}` | Loads company profile for vendor slug | Fills per-order billing from Settings profiles |
| Tracking / Event log | detail payload | `sil_vendor_order_tracking` / `sil_order_events` | Read-only |

**Editable window:** address edits allowed in `received` \| `approved` \| `needs_attention` \| `submitted` (submitted only if still dry-run). Live submitted addresses are locked.

**Auto path (no UI):** every cron tick, if `orders_auto_dispatch=1`, due rows dispatch using **`orders_dry_run`**. If auto is off, tick still promotes `received`→`approved` when rails allow.

---

## Vendors

One card per `sil_vendors` row. Save → `PUT /api/vendors/:slug` → `updateVendor` + optional rewrite-only sync when multiplier/VAT changes.

Confirmation required when changing **Active** or **Serviceable countries**.

| UI label | Storage | Read path | Effect |
|---|---|---|---|
| Storefront label | `sil_vendors.storefront_label` | Writer / bridge MOQ messages / `pa_vendor` copy | Customer-facing lane name (e.g. LPS01) |
| Price multiplier | `price_multiplier` (null = empty) | `resolveRules` | Per-vendor override **disables** global price tiers for that vendor |
| Min visible stock | `min_visible_stock` | `resolveRules.stockThreshold` | Stock ≤ threshold → hidden + outofstock |
| FX rate | `fx_rate` | Pricing cost = vendor × FX × (1+VAT) | Currency conversion into EUR cost basis |
| VAT rate (fraction) | `vat_rate` | same | Use `0.21` for 21%. WPF publishes ex-VAT |
| Min order value (EUR) | `order_config.min_order_value_eur` | Bridge hard-block + WPF adapter | Independent of global small-order fee |
| Serviceable countries | `serviceable_countries` JSON | `checkCoverage` on dispatch | ISO list; blocks approve/dispatch outside list |
| Live downloads / day | `live_max_per_day` | `liveGate` / `liveLimits` | Catalogue live-fetch daily cap |
| Store feed downloads / day | `store_live_max_per_day` | WPF store gate only | Shown only for `wholesale-perfumes` |
| Store feed min minutes | `store_live_min_minutes` | WPF store gate only | Interval for price/stock XML |
| Active | `active` | Sync selects active vendors; dispatch loads vendor | Inactive = skipped by sync, cannot receive stocked offers / dispatch |

Not editable in UI (read-only / env): `slug`, `sku_prefix`, `currency`, vendor API credentials.

---

## Settings

Save → `PUT /api/settings` (allow-listed keys only). Price/visibility keys mark offers dirty and start a **cache rewrite-only** sync; `description_mode` / `volume_filter_mode` mark products dirty and start a **full/cache** sync.

### Schedule & sync source

| UI label | Key | Reader | Effect |
|---|---|---|---|
| Sync enabled | `sync_enabled` | `schedule.ts` `decide` / `decideSchedule` | Off → scheduled catalogue sync skipped. Stop sets off; Run / toggling on clears abort. |
| Fast sync minutes | `fast_sync_minutes` | `decide()` | Minutes since last success before a fast sync is due (still only in :00/:30 windows) |
| Full sync enabled | `full_sync_enabled` | `decide()` | Nightly full attempt |
| Full sync hour (UTC) | `full_sync_hour` | `loadTiming` via DB `MAKETIME` | Once-per-day full window (attempts, not successes) |
| Sync source | `sync_source` | Scheduled + manual run (unless body overrides) | `live` \| `local` (fixtures). Manual API also accepts `cache` internally for rewrites |
| Min minutes between live downloads | `live_feed_min_minutes` | `liveGate.checkLiveGate` | Hard gate; cache used until elapsed. Per-vendor daily caps on Vendors |

### Pricing & catalogue visibility

| UI label | Key | Reader | Effect |
|---|---|---|---|
| Price multiplier | `global_price_multiplier` | `resolveRules` / `computePricing` | Fallback when no tier matches / tiers empty / no vendor override |
| Price tiers (section) | `price_tiers` JSON | `parsePriceTiers` → `resolveTierMultiplier` | Cost bands; last row unbounded (`maxCost: null`) |
| Stock threshold | `global_stock_threshold` | Pricing `hidden` / OOS | Global floor when vendor min stock is null |
| Hide products without image | `hide_products_without_image` | Writer `shouldHideForMissingImage` | `exclude-from-catalog` when image missing/placeholder |
| Image CDN base URL | `image_cdn_base_url` | **No sync reader** | Documented origin for tools; **does not rewrite product URLs** |
| Volume filter | `volume_filter_mode` | `normalizeVolume` | `ranges` \| `exact` \| `off` |
| Description mode | `description_mode` | `buildDescription` | `none` = title paragraph; `template` = structured blurb |

### Cart minimum (storefront fee)

Read by PHP bridge from `sil_settings` (fail-open).

| UI label | Key | Effect |
|---|---|---|
| Small-order fee | `cart_min_enabled` | Off by default |
| Cart minimum (EUR) | `cart_min_subtotal_eur` | Global subtotal floor for the fee |
| Small-order fee (EUR) | `cart_min_fee_eur` | Charged once when under floor |
| Small-order fee label | `cart_min_fee_label` | Line item label |
| Small-order fee message | `cart_min_message` | Must include `{remaining}` |

Does **not** replace per-vendor MOQ (Vendors → Min order value).

### Orders rails

| UI label | Key | Reader | Effect |
|---|---|---|---|
| Orders dry-run | `orders_dry_run` | Auto-dispatch + CLI default | **Not** the dashboard Dry-run/Live buttons |
| Auto-dispatch | `orders_auto_dispatch` | `checkAutoDispatch` / `dispatchDueOrders` | Off = human Approve/Dry-run/Live; on = cron submits (respecting dry-run) |
| Max order value EUR | `orders_max_value_eur` | `checkOrderCeiling` | Blocks approve/dispatch over ceiling |
| Daily spend cap EUR | `orders_daily_cap_eur` | `checkDailyCap` | Rolling 24h live spend |
| Tracking poll minutes | `orders_poll_minutes` | `pollDueOrders` (min 5) | How often live vendor orders are polled |
| Notify customer on tracking | `orders_notify_customer` | Tracking push / WC complete | Email flag into bridge REST |

### Company billing profiles

| UI | Key | Used by |
|---|---|---|
| BeautyFort form | `company_billing_beautyfort` | BeautyFort invoice address; also fallback for wholesale-perfumes |
| BTS form | `company_billing_bts` | Ops / dry-run payload (BTS invoice is portal-side) |

Saved via `saveCompanyBilling`, not a bare `setSetting` of arbitrary JSON from other keys.

---

## Logs

| Control | API | Effect |
|---|---|---|
| Level filter | `GET /api/logs?level=&page=` | Filters `sil_events.level` |
| Table | same | When / level / scope / message. Context JSON not shown in UI. |

---

## Env-only knobs (not on dashboard)

These never appear as Settings fields. Changing them needs `.env` + container restart (or rebuild).

| Env | Role |
|---|---|
| `DASHBOARD_USER` / `DASHBOARD_PASSWORD` / `SESSION_SECRET` | Dashboard auth |
| `SILLAGE_SHARED_SECRET` | HMAC between Bun ↔ bridge |
| `BEAUTYFORT_*` / `BTS_*` / `WHOLESALE_PERFUMES_*` | Vendor API credentials & endpoints |
| `WP_BASE_URL` / `WORDPRESS_INTERNAL_URL` | Shop URLs (admin links, finalize REST) |
| `LPS_MEDIA_BASE_URL` / `PUBLIC_URL_BASE` / `IMAGE_HOST_BASE_URL` | Tooling default for new image URLs when DB CDN blank |
| `DB_*` / `SILLAGE_DB_*` / `REDIS_URL` | Infrastructure |
| `FIXTURES_DIR` | Local/fixture sync root |
| `BEAUTYFORT_TEST_MODE` | BeautyFort SOAP test flag (vendor-side; still treat money paths carefully) |

Internal runtime keys written by the app (not operator UI): `sync_abort`, `last_live_fetch_*`, `live_fetch_count_*_*`.

---

## Settings present in DB/code but absent from Settings UI

| Key | Default | Status |
|---|---|---|
| `dedupe_by_ean` | `1` | **USED** — `diff.ts` identity / merge |
| `primary_offer_strategy` | `cheapest` | **USED** — primary offer pick (`cheapest` \| `most_stock`) |
| `write_batch_size` | `500` | **USED** — writer batching |
| `max_statement_bytes` | `4194304` | **USED** — INSERT size cap |
| `max_rrp_ratio` | `10` (code default) | **UNUSED** — voided in `computePricing` |
| Legacy `beautyfort_live_max_per_day` / `bts_live_max_per_day` | migration 008 | Fallback if vendor row caps null (post-014 prefer `sil_vendors.live_max_per_day`) |

---

## How money safety actually works

```
WC order → HMAC webhook → ingest splits sil_vendor_orders (status=received)
        → cron tick:
             auto_dispatch OFF → promote to approved (rails permitting); wait for human
             auto_dispatch ON  → dispatchVendorOrder(force) with orders_dry_run
        → dashboard:
             Approve = force rails check only
             Dry-run / Live = force + explicit dryRun flag (ignores orders_dry_run)
```

Fail-closed defaults from seed: `orders_dry_run=1`, `orders_auto_dispatch=0`.

---

## Quick operator recipes

1. **Pause catalogue sync** — Settings → Sync enabled off, or Sync → Stop all sync.
2. **Resume** — Sync enabled on, or press Run fast/full (re-enables).
3. **Change retail markup** — Settings tiers/multiplier and/or Vendors multiplier → wait for auto rewrite toast, or run Sync → fast.
4. **Safe order test** — keep dry-run on; use Orders → Dry-run; inspect payload/events.
5. **First live order** — dry-run off only if you understand auto-dispatch; prefer auto **off**, then Live with confirm on one row.
6. **CDN hostname change** — update `image_cdn_base_url` for documentation + tool env; regenerate `image_overrides.json` / tool `PUBLIC_URL_BASE`; sync with `--rewrite-all` so absolute URLs update.
