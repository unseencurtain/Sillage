# HANDOFF — pick up after a month

Canonical resume doc for operators and agents. Read this first, then [`CONTEXT.md`](CONTEXT.md) for
schema facts and [`OPERATOR-DASHBOARD.md`](OPERATOR-DASHBOARD.md) for UI controls.

---

## Where things are

| Item | Location |
|---|---|
| **Live VPS** | SSH `ovhe` — `ubuntu@139.99.61.71`, hostname `ovh-experi`. App dir `~/sillage/`; data `~/ecom_sites/data/`. |
| **Unused VPS** | SSH `ovh` — `51.79.255.226`. Empty; do not deploy here unless deliberately repurposed. |
| **Public URLs** | Shop `https://cosmetic.slilverbelt.xyz` · Dashboard `https://sillage.slilverbelt.xyz` · Images `https://images.slilverbelt.xyz` |
| **Single env** | Laptop `production-environment/.env` → VPS `~/sillage/.env` (same shape; gitignored) |
| **Compose** | `production-environment/compose.yaml` only |
| **Hub images** | `unseencurtain/sillage-core:<tag>`, `unseencurtain/sillage-wordpress:<tag>` |
| **Git (pricing lock fix)** | `8628eee` on `main` — dedicated `GET_LOCK` connection + Save-only-on-change. Redeploy if VPS image tag lags. |
| **Tag baseline** | `pre-scratch-20260808` — restore marker before catalogue wipe + B2B split ([`SCRATCH-RESET.md`](SCRATCH-RESET.md)) |
| **B2B (later)** | [unseencurtain/sillage-b2b](https://github.com/unseencurtain/sillage-b2b) · local pointer `b2b-wholesale/` |
| **Operator UI guide** | [`OPERATOR-DASHBOARD.md`](OPERATOR-DASHBOARD.md) |
| **Deploy recipe** | [`VPS-DEPLOY.md`](VPS-DEPLOY.md) |

---

## What changed (2026-08) — read before touching prices

### Architecture (unchanged on purpose)

- **Bun writes retail into WooCommerce** (`_price` / `_regular_price`). The plugin does **not**
  multiply at display time. Cost stays in `sil_offers`; customer pays WC; vendor dispatch uses cost.
- **No sale/RRP strike-through** — `pricing.ts` ignores vendor RRP; shop shows regular only.
- Dynamic “plugin ×N with no DB rewrite” was discussed and **not** built (WC sort/cart/feeds need
  stored `_price`). Still the rewrite-on-Save model.

### Bug that bit us

Multiplier Save updated `sil_settings` but the shop stayed on the old ×N because MariaDB
`GET_LOCK('sillage:sync')` is **connection-scoped**. Release on a different pool connection left
the lock held on an idle conn → every Save returned **queued** forever (`needs_price_write=1`,
no new `sil_sync_runs` row). Fix: hold lock on one dedicated connection for the whole run;
`destroy()` the conn if `RELEASE_LOCK` fails; Settings Save only kicks rewrites when values
**actually change** (whole-form POST was also queuing content rewrites). Commit **`8628eee`**.

### If shop prices ≠ Settings multiplier again

```bash
ssh ovhe
# lock stuck?
docker exec -e MYSQL_PWD="$(grep ^MYSQL_ROOT_PWD= ~/sillage/.env | cut -d= -f2-)" ecom-db \
  mariadb -uroot -N -e 'SELECT IS_USED_LOCK("sillage:sync");'
# if non-NULL and no sync running: restart to drop pool
cd ~/sillage && docker compose --env-file .env restart sillage-core sillage-cron
# then Save multiplier again, or:
docker exec sillage-core bun -e 'import { runSync } from "./src/sync/run.ts";
  console.log(await runSync({ mode:"fast", source:"cache", rewriteOnly:true }));'
```

Expect a new `sil_sync_runs` row `mode=fast` `source=cache` with `prices_updated≈53151`, then
`needs_price_write=0` and `_price ≈ vendor_price × multiplier` (FX/VAT/tiers apply when set).

---

## Live settings health (verified 2026-08-07)

Spot-checked on `ovhe` after the lock fix. Re-check with the SQL below if you change knobs.

| Area | Live state then | Verdict |
|---|---|---|
| **Price multiplier** | `1.5`; run **8** rewrite-only success; sample `_price` = cost×1.5; dirty=0; lock free | OK — Save → shop works |
| **Price tiers** | `[]` | OK — falls back to global multiplier |
| **Hide without image** | `1` | OK — rewrite path; ~14k hidden-no-image on last rewrite |
| **Stock threshold** | `0` global; vendor min stock NULL | OK |
| **Cart small-order fee** | `cart_min_enabled=0` (min 50 / fee 5 configured) | OK — bridge reads `sil_settings` (60s object-cache TTL). Enable in Settings to charge; does not block checkout |
| **Vendor MOQ** | BF/BTS `order_config` has **no** `min_order_value_eur`; WPF has 100 but parked | OK — no hard MOQ on retail lanes |
| **Orders dry-run / auto** | `orders_dry_run=1`, `orders_auto_dispatch=0` | OK — keep unless intentional live spend |
| **Order ceilings** | max/daily 10000 EUR; poll 15m; notify on | OK — rails only |
| **Schedule** | Sync page: **Rebuild catalogue** + **Update prices & stock**; Settings **Minutes between syncs** (check interval, not “minutes a day”). Per-vendor cadence is on **Vendors**. Rebuild queues when the schedule is on. Optional nightly rebuild under Schedule → Advanced. | Update hidden while Sync enabled is on; no silent disk “cache” sync |
| **Live feed gate** | same minutes as schedule; **no daily download cap** | OK — do **not** start a live sync just to reprice (use Settings multiplier Save) |
| **Description / volume** | `none` / `ranges` | OK — Save of these kicks **full/cache** content rewrite (heavier) |
| **Shop / CDN URLs** | `wp_base_url` + `image_cdn_base_url` set | Shop URL hot-applies. **Image CDN does not rewrite existing product image URLs** — needs overrides + content rewrite |
| **Company billing** | BF + BTS profiles **empty** | Gap for **live** BeautyFort invoice address — fill before first live BF dispatch |
| **WPF** | `active=0`, excluded from `--vendor=all` | Parked — leave alone |
| **Sale prices in WP** | 0 rows with `_sale_price` | Expected |

```sql
-- quick parity check (replace 1.5 with current global_price_multiplier; ignores FX/VAT/tiers)
SELECT setting_value FROM sillage.sil_settings WHERE setting_key='global_price_multiplier';
SELECT IS_USED_LOCK('sillage:sync');
SELECT COUNT(*) dirty FROM sillage.sil_products WHERE needs_price_write=1;
SELECT id, mode, source, status, prices_updated, started_at
  FROM sillage.sil_sync_runs ORDER BY id DESC LIMIT 5;
```

---

## Product decisions (do not reverse casually)

- **Retail shop = BeautyFort + BTS only.** wholesale-perfumes (WPF/B2B) is parked — inactive,
  excluded from `--vendor=all`, no `/b2b-wholesale` on this WordPress install.
- **No LPS\*** as `product_cat` or visible product attributes. Internal `_sillage_vendor` postmeta
  only; storefront labels LPS01/LPS02 live in `sil_vendors.storefront_label`.
- **B2B is a separate project** — own compose / own repo when ready; not bolted onto this shop.
- **`orders_dry_run` stays `1`** unless you intentionally dispatch live vendor orders (no sandbox).
- **Images:** host volume `~/ecom_sites/data/media` → `lps-media`; public CDN
  `images.slilverbelt.xyz`. Brasty Playwright crawl may still run on the laptop
  (`tools/images/brasty/`).
- **Theme target: Kadence.** Bridge must stay theme-agnostic; Blocksy-specific shims are legacy,
  not the long-term model. Lots of shop UI belongs in **sillage-bridge**, not the theme.

---

## Next work (priority)

1. **Polish retail UI for Kadence** — replace Blocksy-specific assumptions; guarded theme shims only.
2. **More shop UI through sillage-bridge** — filters, catalog helpers, cart/checkout polish.
3. **Fill company billing** before first live BeautyFort order.
4. **Optional later:** display-time multiplier (no 53k rewrite) — larger WC redesign; not started.
5. **B2B separately** — new stack in [sillage-b2b](https://github.com/unseencurtain/sillage-b2b);
   own compose; do not expand this retail repo for WPF.

Polish **this retail shop (BF+BTS) first.** B2B later on its own infrastructure.

---

## Commands cheat sheet

### Deploy / update (from laptop)

```bash
./production-environment/scripts/deploy-vps.sh \
  --host ovhe \
  --shop cosmetic.slilverbelt.xyz \
  --dash sillage.slilverbelt.xyz \
  --images images.slilverbelt.xyz \
  --skip-build   # omit to build+push Hub images first
```

Day-2 pull on VPS: `ssh ovhe 'cd ~/sillage && docker compose --env-file .env pull && docker compose --env-file .env up -d'`

Full recipe: [`VPS-DEPLOY.md`](VPS-DEPLOY.md). Dashboard login file: `.deploy/vps-dashboard-ovhe.txt`.

### Sync (operator)

Dashboard **Sync**: **Rebuild catalogue** (full, first import) or **Update prices & stock** (fast).
Both respect **Minutes between syncs** cooldown. Overview’s button is Update prices & stock.
CLI offline: `cd production-environment/sillage-core && bun run sync -- --source=local --vendor=all`.

**Pricing Save:** Settings (global multiplier/tiers) or Vendors (per-vendor multiplier/FX/VAT/min
stock) → automatic **rewrite-only** price write from `sil_offers` (no live API). If a sync is
already running, a follow-up is queued — do not mash Run fast sync. Retail is stored in Woo
`_price` / `_regular_price` on purpose (cart/sort/filters); cost stays in offers. See
[`OPERATOR-DASHBOARD.md`](OPERATOR-DASHBOARD.md) “Why shop prices are stored”.

**Operator timezone:** Settings → `schedule_timezone` (IANA, default `UTC`). Full-sync hour is
local to that zone; Sync/Orders/Logs clocks follow it. MariaDB and vendor APIs stay UTC.
Changing TZ alone does not rewrite the catalogue.

### Secrets overlay (vendor API keys)

| Where | Path |
|---|---|
| VPS | `~/sillage/sillage-core/data/secrets.overlay.env` |
| Laptop | `production-environment/sillage-core/data/secrets.overlay.env` |
| Container | `/app/data/secrets.overlay.env` (`SILLAGE_SECRETS_FILE`) |

Set/clear via dashboard **Secrets** (overlay wins over compose `.env`). `touch` the file before
first `compose up` so Docker bind-mounts a file, not a directory.

### Migrate

```bash
# VPS
ssh ovhe 'docker exec sillage-core bun run migrate'

# Local dev
cd production-environment/sillage-core && bun run migrate
```

### Local dev stack

```bash
cd production-environment/sillage-core && bun install && bun run dev   # :4000
cd production-environment && docker compose --env-file .env up -d
```

See [`AGENTS.md`](../AGENTS.md) for hard rules (no PHP product writes, HPOS, dry-run safety).
