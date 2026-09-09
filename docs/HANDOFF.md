# HANDOFF — pick up after a month

Canonical resume doc for operators and agents. Read this first, then [`CONTEXT.md`](CONTEXT.md) for
schema facts and [`OPERATOR-DASHBOARD.md`](OPERATOR-DASHBOARD.md) for UI controls.

---

## Memory — do not invent a different procedure

These are operator rules. If a later message seems to contradict them, **this section wins**.
Read this checklist and execute it in order. Do not skip an item because a later doc looks older.

1. **Empty VPS is first-class.** Hand this repo to an agent with a blank Ubuntu box and it
   must bring up WordPress, WooCommerce, HPOS, Caddy, MariaDB, Valkey, the image CDN
   (`lps-media` → `~/ecom_sites/data/media` → `images.prinscosmetic.eu`), and sillage-core
   without cloning the live shop. That JPEG folder is **this retail shop**: BTS has no vendor
   photos, so files you host there are Sillage’s. Wholesale-perfumes uses catalog `flask_front`
   URLs and must not mount this directory. Recipe: `bootstrap-host.sh` as root, then
   `deploy-vps.sh --host <new> --shop … --dash … --images …` (default builds **core + WordPress**).
   `--core-only` is a **day-2** engine bump on an already-running shop — never the first boot.
   WordPress is **pinned** in `wordpress-image/Dockerfile` (`wordpress:7.1-php8.3-apache`). Do
   not float `wordpress:latest`. First boot runs `scripts/wp-fresh-install.php` (EUR, Blocksy,
   WooCommerce, HPOS on, Coming soon off, permalinks).
2. **Engine changes ship with one command: `scripts/ship.sh` ([`SHIP.md`](SHIP.md)).** It runs the
   gates, builds and pushes on the box that holds the Hub login (`ovhe`), pins the tag on each
   target, restarts, waits for `/health`, rolls back if it does not answer, and proves no operator
   setting moved. About ninety seconds. Never hand-run rsync / `docker build` / `compose up` to
   deploy the engine, and never edit `SILLAGE_CORE_IMAGE` by hand. `build-push-images.sh` remains
   only for the **WordPress** image, which `deploy-vps.sh` handles when a box is built.
   Docker Hub builds always happen on a VPS that is already `docker login` as `unseencurtain`.
   - Do **not** install Docker in a cloud-agent pod.
   - Do **not** copy `~/.docker/config.json` off the VPS.
   - Do **not** build Hub images on a laptop or agent “because the VPS has only 4 GB”.
   - Do **not** skip the push because free RAM looks tight — that is how `2269d11`, `51ecd77`,
     and later tags were pushed from ovhe.
   - Live `wholesale-core` already runs `unseencurtain/sillage-b2b:082d695`. Do not point it back
     at `sillage-core:*`. Recreating **live** `ecom` onto a new WordPress tag is a deliberate shop
     change; an empty VPS must still pull and install `sillage-wordpress:ab5ead8`.
3. **This repo is the retail shop only** (BeautyFort + BTS, `prinscosmetic.eu`). Wholesale-perfumes
   is a **separate product** in [unseencurtain/sillage-b2b](https://github.com/unseencurtain/sillage-b2b)
   with its own compose, Hub image, and WordPress. Do not add wholesale vendor code, compose
   profiles, or Caddy blocks here. Do not add BeautyFort/BTS there. A new wholesale VPS is
   bootstrapped from sillage-b2b alone — it must not look at this repo.
4. **Retail MariaDB is `ecom-db` only** (`earth` / `sillage`). Do not put `earth_wpf` / `sillage_wpf`
   on this database. Wholesale’s database lives in the sillage-b2b stack (`wholesale-db`).
5. **Both boxes are production. There is no development tier and no role flag.** `ovh`
   (`51.79.255.226`) and `ovhe` (`139.99.61.71`) each run both shops from `~/sillage/` and
   `~/sillage-wholesale/`, on the same compose files and the same image tags, differing only in
   their hostnames. Both hold the same vendor credentials against APIs that have never offered a
   sandbox, so a Live dispatch is a real order on either one and the Orders page dry-run setting
   is the only gate. **Each box's settings are its own** — one may be syncing while the other is
   off; never reconcile them ([`SYNC-RULES.md`](SYNC-RULES.md)). Work on `ovhe` and ship to
   whatever else exists. Copy a box with `~/pack.sh` on it and download the result — nothing backs
   itself up on a timer. Rules: [`ENVIRONMENTS.md`](ENVIRONMENTS.md). Each stack owns one file
   under `/etc/caddy/sites/`, so the two never fight over a shared Caddyfile.
6. **Bind mounts only. Never a Docker named volume for WordPress or MariaDB.** Both boxes keep
   WordPress core and the database files under `<stack>/data/wp/` and `<stack>/data/wp-db/`, so a
   `tar` of the home folder is a complete, restorable backup. Volumes live under
   `/var/lib/docker`, where that same `tar` silently omits WordPress, every plugin and theme, and
   the entire database — a backup that looks fine until you restore it and find no shop inside.
   That happened here. Convert any volume-era box with `scripts/to-bind-mounts.sh` before packing
   it, and check `docker volume ls` is empty when you are done.
7. **GitHub** is [unseencurtain/Sillage](https://github.com/unseencurtain/Sillage) for **retail**
   (BeautyFort + BTS) and [unseencurtain/sillage-b2b](https://github.com/unseencurtain/sillage-b2b)
   for **wholesale** (wholesale-perfumes). Do not mix vendor code between the two. Cursor copies
   can have different SHAs; replay onto GitHub `main`, do not merge the remotes. The replay script
   never writes sillage-b2b.

---

## Where things are

| Item | Location |
|---|---|
| **Production VPS** | SSH `ovh` — `ubuntu@51.79.255.226`, hostname `ovh`. Stacks `~/sillage/` and `~/sillage-wholesale/`; each keeps all its data under its own `data/`. |
| **Development VPS** | SSH `ovhe` — `ubuntu@139.99.61.71`, hostname `ovh-experi`. Same two stack directories, restored from a production pack ([`VPS-MIGRATE.md`](VPS-MIGRATE.md)), `SILLAGE_ROLE=development`, scheduled sync off. Disposable: wiped and rebuilt on demand. |
| **Wipe and rebuild** | [`REBUILD-FROM-SCRATCH.md`](REBUILD-FROM-SCRATCH.md) — standing hostnames/usernames, ordered commands, and the traps that cost the first rebuild |
| **Production URLs** | Shop `https://codeinmoon.xyz` · Dashboard `https://sillage.codeinmoon.xyz` · Images `https://images.codeinmoon.xyz` · Wholesale `https://wholesale.codeinmoon.xyz` / `https://sillage-wholesale.codeinmoon.xyz` |
| **Development URLs** | Shop `https://prinscosmetic.eu` · Dashboard `https://sillage.prinscosmetic.eu` · Images `https://images.prinscosmetic.eu` · Wholesale `https://wholesale.mirainikki.xyz` / `https://sillage-wholesale.mirainikki.xyz` |
| **Domain change** | [`DOMAIN-MIGRATION.md`](DOMAIN-MIGRATION.md) · trees: [`FOLDER-STRUCTURE.md`](FOLDER-STRUCTURE.md) |
| **Single env** | Laptop `production-environment/.env` → VPS `~/sillage/.env` (same shape; gitignored) |
| **Compose** | `production-environment/compose.yaml` only |
| **Hub images** | `unseencurtain/sillage-core:<tag>`, `unseencurtain/sillage-wordpress:<tag>` |
| **GitHub** | [unseencurtain/Sillage](https://github.com/unseencurtain/Sillage) (`main`) — **retail** tree. Wholesale shop is [unseencurtain/sillage-b2b](https://github.com/unseencurtain/sillage-b2b). Do not merge remotes; replay with `production-environment/scripts/replay-to-github.sh`. |
| **Git (pricing lock fix)** | `8628eee` on `main` — dedicated `GET_LOCK` connection + Save-only-on-change. Redeploy if VPS image tag lags. |
| **Tag baseline** | `pre-scratch-20260808` — restore marker before catalogue wipe + B2B split ([`SCRATCH-RESET.md`](SCRATCH-RESET.md)) |
| **B2B** | Separate repo [unseencurtain/sillage-b2b](https://github.com/unseencurtain/sillage-b2b). Do not deploy wholesale from this checkout. |
| **Client how-to (humans)** | [`CLIENT-GUIDE.md`](CLIENT-GUIDE.md) — keep in sync with UI |
| **Operator UI guide** | [`OPERATOR-DASHBOARD.md`](OPERATOR-DASHBOARD.md) |
| **Agent runbook** | [`AGENTS-RUNBOOK.md`](AGENTS-RUNBOOK.md) — sync, photos, orders, new VPS |
| **New VPS / photos** | [`VPS-MIGRATE.md`](VPS-MIGRATE.md) · [`specs/S3-images.md`](specs/S3-images.md) |
| **Missing photos by EAN** | [`EAN-IMAGE-SCRAPE.md`](EAN-IMAGE-SCRAPE.md) · VPS `~/sillage/ean-image-scrape/` |
| **BTS tracking** | [`BTS-ORDERS.md`](BTS-ORDERS.md) |
| **Health / recs** | [`RECOMMENDATIONS.md`](RECOMMENDATIONS.md) |
| **Deploy recipe** | [`VPS-DEPLOY.md`](VPS-DEPLOY.md) |
| **Crawler shield** | [`CRAWLER-SHIELD.md`](CRAWLER-SHIELD.md) — copy the Caddy `@heavybot` 403 onto every client VPS |
| **Google / sitemaps** | [`SEO.md`](SEO.md) — static XML, Caddy, not Minutes between syncs |

---

## Right now (2026-09-09) — start here

Two boxes, both production, both running both shops. Work on `ovhe`; ship to whatever else exists.
**`ovh` is not to be touched by hand** — it receives code only through `ship.sh`.

| | `ovhe` (`139.99.61.71`) | `ovh` (`51.79.255.226`) |
|---|---|---|
| Retail shop / dashboard | `prinscosmetic.eu` / `sillage.prinscosmetic.eu` | `codeinmoon.xyz` / `sillage.codeinmoon.xyz` |
| Retail media | `images.prinscosmetic.eu` | `images.codeinmoon.xyz` |
| Wholesale shop / dashboard | `wholesale.mirainikki.xyz` / `sillage-wholesale.mirainikki.xyz` | `wholesale.codeinmoon.xyz` / `sillage-wholesale.codeinmoon.xyz` |
| Layout | `~/sillage`, `~/sillage-wholesale`, bind mounts only | same |
| Settings | the operator's, on this box | the operator's, on this box — **never reconciled** |

Each box hosts its own copy of the 4,228 product JPEGs (388 MB) and points `image_cdn_base_url` at
its own hostname, so neither depends on the other being alive.

### The loop

```bash
# edit code, then:
./production-environment/scripts/ship.sh              # gates → build → push → ovhe (~90s)
./production-environment/scripts/ship.sh --to ovh     # same build, other box
./production-environment/scripts/ship.sh --status
```

[`SHIP.md`](SHIP.md) is the whole story. `deploy-vps.sh` is only for turning an empty VPS into a
shop; `pack-box.sh` + `adopt-box.sh` move a box; `~/pack.sh` on a box makes the download-me
tarball. Nothing else should ever be hand-run to deploy.

### Next work, in order

1. **WordPress image is ~1.1 GB**, nearly all of it `wordpress:7.1-php8.3-apache`. Moving to an
   fpm-alpine base would roughly halve it, but it changes how the shop is served (php-fpm behind
   nginx or Caddy instead of Apache), so it is its own change with its own deploy — not something
   to fold into a code ship. Until then `ship.sh --prune` keeps disk in check.
2. **The bridge plugin and WordPress still ride `deploy-vps.sh`.** A `--plugin-only` path through
   `ship.sh` would close the last gap where a change needs a full box deploy.
3. **Photo coverage.** ~675 retail products are hidden for a missing or weak image; the CSV export
   (`scripts/export-missing-images.py`) lists them with EAN, brand, price and stock so they can be
   sourced in bulk. Wholesale hotlinks vendor URLs and needs none of this.
4. **Order dispatch has never run Live on either box.** When it does, it spends real money on the
   first press — there is no sandbox at either wholesaler.

---

## Right now (2026-09-08) — wholesale engine is cut over

Wholesale-perfumes source is [unseencurtain/sillage-b2b](https://github.com/unseencurtain/sillage-b2b).
Live ovhe still **hosts** both shops (one Caddyfile, two compose services). Engines are split:

| Shop | Container | Hub image |
|---|---|---|
| Retail | `sillage-core` / `sillage-cron` | `unseencurtain/sillage-core:ab5ead8` |
| Wholesale | `wholesale-core` / `wholesale-cron` | `unseencurtain/sillage-b2b:082d695` |
| Both WordPress | `ecom` / `wholesale-ecom` | `unseencurtain/sillage-wordpress:d35613d` (live datadir) |

Empty-VPS WordPress image is on Hub as `unseencurtain/sillage-wordpress:ab5ead8` (pinned WP 7.1 / PHP 8.3). Do **not** recreate live `ecom` onto that tag unless you are deliberately rebuilding the shop. A **new** VPS must pull it and run `wp-fresh-install.php`. Do **not** enable live vendor dispatch on wholesale.

`d35613d` is a stale August build carrying **WordPress 7.0.2**. Live `ecom` reads 7.1 only
because that datadir was upgraded in place afterwards, so the tag looks current on a running box
and installs an old WordPress on an empty one. `deploy-vps.sh` now compares the image's bundled
version against the Dockerfile pin and refuses the mismatch; `26bd779` carries 7.1.

Retail shop rules below are unchanged.

### Test VPS `ovh` (`51.79.255.226`) — both shops from scratch

Two host folders, no cloned WordPress or MariaDB, JPEGs copied from ovhe (388 MB, 4228 files):

| Hostname | Serves | Container |
|---|---|---|
| `codeinmoon.xyz` | retail shop | `ecom` (:104) |
| `images.codeinmoon.xyz` | retail media | `lps-media` (:105) |
| `sillage.codeinmoon.xyz` | retail dashboard | `sillage-core` (:4000) |
| `wholesale.codeinmoon.xyz` | wholesale shop | `wholesale-ecom` (:106) |
| `sillage-wholesale.codeinmoon.xyz` | wholesale dashboard | `wholesale-core` (:4001) |

Both catalogues are **empty on purpose** and wait for the operator's first **Rebuild catalogue**.
Operator logins are in `~/creds-retail.txt` and `~/creds-wholesale.txt` (never `admin`).

Two things this box taught us, both now fixed in code:

- **Swap is not optional.** A full sync peaks near 2 GB. With 3.7 GB of RAM, two MariaDB
  instances and two WordPress containers, the kernel OOM-killed the sync every five minutes and
  took storefront responsiveness with it. `bootstrap-host.sh` now creates 4 GB of swap.
- **DNS host fields append the zone.** Cloudflare's panel turned a pasted
  `sillage.codeinmoon.xyz` into `sillage.codeinmoon.xyz.codeinmoon.xyz`, which resolves for the
  doubled name and NXDOMAINs for the real one — so Let's Encrypt cannot issue and the subdomain
  looks dead while the apex works. Enter the label only (`sillage`, `@` for the apex).

---

## Right now (2026-09-03 evening) — start here

This is the live box `ovhe` (`ovh-experi`). Do not invent a second copy of the shop.

### What customers see

| Thing | State |
|---|---|
| Shop / dashboard / CDN | `prinscosmetic.eu` / `sillage.prinscosmetic.eu` / `images.prinscosmetic.eu` |
| Hide products without image | **On** |
| Orders | **Dry-run on**, auto-dispatch **off** |
| Fast sync | Every **30** minutes (Settings → Minutes between syncs) — **price and stock only** |
| Product photos | **Not** bulk-replaced. Catalogue still hides SKUs with no/weak Woo thumb |
| Google sitemap | **Live.** Caddy serves `~/ecom_sites/data/sitemaps/` (no PHP). Plugin **1.1.2** turns off WP core sitemaps and `noindex`s hidden product HTML |

### The “9,621 already have a file” line (easy to misread)

That number is **not** “9,621 good bottle photos ready to publish.” It means: for the Overview **in-stock + no/weak image** card, a *file or URL exists somewhere on disk*. Breakdown from the live lists (`~/photo-inventory/`):

| What | Count | Quality | On the shop? |
|---|---|---|---|
| **EAN scrape** (`~/sillage/ean-image-scrape/scraped/`) | **9,594** | Unreviewed Bing / Open Facts hits. **~1,943 files are under 8 KB** (icons / empty / generic likely). Applied once before and **reverted**. Treat as junk until inspected | **No** |
| **Brasty real shots** (not the grey camera graphic) | **~31** | Real product photos by EAN filename; camera placeholders skipped | **Yes — copied to CDN and rewritten 2026-09-03** (shop visible **26,005**, hidden-no-image **9,747**) |
| **Nothing anywhere** | **~153** | No CDN, override, scrape, or real Brasty file | Hidden |

**The directory that is allowed to serve shop photos** is `~/ecom_sites/data/media/` (`https://images.prinscosmetic.eu/<file>`). Shopify / BTS / ocean URLs in `image_overrides.json` are hotlinks; they do not need a file on disk.

Do **not** attach the 9,594 scrape files until a human has looked at them. Generic marks / logos / camera icons are not shop photos.

### SEO vs Docker Hub

Static sitemap **is already on the website** (Caddy + files on disk + nightly host cron `0 19 * * *` UTC → `write-sitemaps.py`).

Running Hub image is **`unseencurtain/sillage-core:<tag in ~/sillage/.env>`**.
Rebuild **on ovhe** with `~/sillage/scripts/build-push-images.sh` (or the copy under
`production-environment/scripts/`). That host is `docker login` as `unseencurtain`.
Do not build Hub images anywhere else.

Minutes between syncs does **not** rebuild the sitemap.

### Deleted on ovhe (do not restore)

- `~/ovhe-backup/` (Aug 23 zip)
- `~/sillage/backups/` (Aug 7 pre-scratch SQL)
- Unused Docker tags (`sillage-core` SHAs other than `a0f03e1`, leftover `cailiin/sillage-core`)
- Docker build cache, unused Zed (~430 MB)
- Agent `/tmp` dumps
- **`~/brasty/`** — 3.7 GB dump. Only ~31 EANs matched missing shop photos; those JPEGs now live in `~/ecom_sites/data/media/`. The rest did not match the hidden-no-image catalogue
- Duplicate zips: `sillage-photo-pack.zip`, `photo-inventory.zip`, `ean-image-scrape/scraped-ean-images.zip` (folders kept where needed)

### Keep (source of truth)

| Keep | Why |
|---|---|
| `~/sillage/` + `~/sillage/.env` | Running app |
| `~/ecom_sites/data/{wp,wp-db,media,sitemaps}` | Shop, DB, **CDN photos**, Google XML |
| `~/sillage/sillage-core/data/image_overrides.json` | EAN → URL |
| `~/sillage/ean-image-scrape/scraped/` | Unreviewed scrape (not shop) until inspected or deleted on purpose |
| `~/photo-inventory/` | Live CAN/CANNOT CSVs from 2026-09-03 |
| `~/caddy/Caddyfile` | Symlink to `/etc/caddy/Caddyfile` |

Rebuild lists: `bash ~/sillage/python-analysis/photo-pack/run_on_vps.sh`

---

## What changed (2026-08-31) — ClaudeBot melted the shop

`ecom` at 150%+ CPU was **not** leftover scrape. Anthropic **ClaudeBot**
(`216.73.217.16`, UA `ClaudeBot/1.0`) was walking every public `/product` and
`/?p=` page through Apache prefork. Caddy on the shop host now 403s that class
of crawler. Copy the same block onto every client VPS:
[`CRAWLER-SHIELD.md`](CRAWLER-SHIELD.md). Do not kill MariaDB to “fix CPU”.

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
| **Schedule** | Sync page: **Rebuild catalogue** + **Update prices & stock**; Settings **Minutes between syncs** (check interval, not “minutes a day”). **Daily full catalogue rebuild** is first-class (live `full_sync_enabled=1`, hour 23, `Asia/Dhaka`). Per-vendor cadence is on **Vendors**. Rebuild queues when the schedule is on. BTS 25%/7-day unseen recovery is emergency only. | Update hidden while Sync enabled is on; no silent disk “cache” sync |
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
- **Images:** the only directory the shop CDN serves is `~/ecom_sites/data/media/`
  (`https://images.prinscosmetic.eu/<file>`). Git tracks `image_overrides.json` (EAN → URL),
  not JPEG bytes. The old `~/brasty/` dump was removed 2026-09-03 after copying the ~31
  missing-SKU hits into media. Remaining hidden-no-image SKUs are almost all the unreviewed
  EAN scrape (`~/sillage/ean-image-scrape/scraped/`) — **not** shop photos until inspected.
  Skip Brasty camera-placeholder MD5s in `brasty_placeholders.py`. After override edits:
  recreate `sillage-core` / `sillage-cron`, then
  `--mode=full --source=cache --rewrite-only`.
- **Theme target: Kadence.** Bridge must stay theme-agnostic; Blocksy-specific shims are legacy,
  not the long-term model. Lots of shop UI belongs in **sillage-bridge**, not the theme.

---

## Next work (priority)

1. **Photos still missing on the shop** — in-stock no/weak image ≈ **9,775**. Almost all
   “we have a file” rows are **unreviewed EAN scrape**, not proven product shots. Do not
   apply `scraped/` until inspected. ~153 have nothing. Details in **Right now** above.
   Google listing: [`SEO.md`](SEO.md). Hide-without-image and orders dry-run stay on.
2. **Polish retail UI for Kadence** — replace Blocksy-specific assumptions; guarded theme shims only.
3. **More shop UI through sillage-bridge** — filters, catalog helpers, cart/checkout polish.
4. **Fill company billing** before first live BeautyFort order.
5. **BTS tracking** — after deploy, poll `SIL-54253-BTS` so Cancelled leaves `submitted`
   ([`BTS-ORDERS.md`](BTS-ORDERS.md)).
6. **Optional later:** display-time multiplier (no 53k rewrite) — larger WC redesign; not started.
7. **Wholesale catalogue** — secrets + first sync on `wholesale.mirainikki.xyz` (sandbox dispatch
   stays locked). Old [sillage-b2b](https://github.com/unseencurtain/sillage-b2b) is not this shop.

Polish **this retail shop (BF+BTS) first.** Wholesale sync is a separate next step on the same VPS.

---

## Commands cheat sheet

### Deploy / update (from laptop)

```bash
# Hub images: ssh ovhe, copy sillage-core + wordpress-image, run ~/sillage/scripts/build-push-images.sh
# (docker login as unseencurtain lives there — see Memory). Empty VPS: omit --core-only and --skip-build.
# Day-2 engine bump on a live shop: --core-only then:
./production-environment/scripts/deploy-vps.sh \
  --host ovhe \
  --shop prinscosmetic.eu \
  --dash sillage.prinscosmetic.eu \
  --images images.prinscosmetic.eu \
  --skip-build
```

Day-2 pull on VPS (retail only — this repo has no wholesale compose profile):

```bash
ssh ovhe 'cd ~/sillage && docker compose --env-file .env pull && docker compose --env-file .env up -d'
```

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
| VPS (retail) | `~/sillage/sillage-core/data/secrets.overlay.env` |
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
