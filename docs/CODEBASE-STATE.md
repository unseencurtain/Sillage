# CODEBASE-STATE.md — Sillage (read this before assuming anything)

> Master state-of-the-codebase document. Written 2026-10-14. It records **what exists, what is
> done, what is not, what is safe, what is dangerous, and what may / may not be committed.**
> Everything here was verified by reading the tree unless explicitly marked *(uncertain)*.
> When this file disagrees with another doc, prefer the more specific doc named in the row
> (e.g. `SYNC-RULES.md` wins on cadence; `ENVIRONMENTS.md` wins on per-box rules).
>
> Companion: `docs/DEPLOYMENT-CHRONOLOGY.md` (what happened, in order),
> `docs/NEW-VPS-PLAN.md` (how to build a box), `docs/STOREFRONT-OPERATIONS.md` (retail ops).

---

## 1. What this repository IS

A **multi-vendor dropshipping sync system** for a WooCommerce beauty/perfume retail shop:

- **3 wholesale vendors in code, 2 live on retail:**
  - `beautyfort` (BF) — SOAP v4, SKU prefix `BF`, storefront label **LPS02**
  - `bts` (BTS Wholesaler) — REST + JWT, prefix `BTS`, storefront label **LPS01**
  - `wholesale-perfumes` (prefix `WPF`) — **PARKED for retail.** Lives in the separate
    [unseencurtain/sillage-b2b](https://github.com/unseencurtain/sillage-b2b) repo. Do NOT add it here.
- **Engine:** `production-environment/sillage-core` — Bun/TypeScript. Writes products into MariaDB
  (`earth` DB, WordPress) via **raw SQL**, maintains the `sillage.*` tables, serves an HTTP API and
  a React dashboard.
- **WordPress** is a *thin bridge* only. The live plugin is **`sillage-bridge`** (source in
  `production-environment/ecom_sites/data/wp/wp-content/plugins/sillage-bridge/`), plus the
  standalone **`sillage-warehouses`** plugin. **PHP must never grow product-write paths.**
- **Storefront** is a **separate repo** (`unseencurtain/storefront`, checked out here at
  `../react_store/frontend`). It is NOT part of this repo.
- **Data model:** one MariaDB (12.3.2) with two DBs — `earth` (WP/Woo, prefix `wp_`) and `sillage`
  (engine, prefix `sil_`). ~55,320 raw offers dedupe by EAN to ~52,674 products.

**Hard rule (from `AGENTS.md`):** placing a vendor order **spends real money**. There is no sandbox.
Safety defaults on a fresh box: `orders_dry_run=1`, `orders_auto_dispatch=0`, `sync_enabled=0`,
`full_sync_enabled=0`.

---

## 2. Directory map (top level)

| Path | What it is |
|---|---|
| `AGENTS.md` | Agent entry point: hard rules, layout, commands, deploy pointers. **Read first.** |
| `README.md` | Project overview / quickstart. |
| `docs/` | Engineer + client docs (see §7). |
| `ops/test/` | Empty-VPS Docker test harness (`Dockerfile`, `seed/seed.php`, `setup.sh`, `up.sh`). |
| `plugins/` | Standalone WP plugin sources (see §3). |
| `product/` | Raw vendor sample dumps (`beautyfort_products.json`, `bts_*.json`). Fixtures/reference. |
| `product-dropshipping/` | Original standalone vendor clients. **Reference only — do not edit.** |
| `production-environment/` | The actual stack (compose, scripts, python pipelines, WP/nginx config, `sillage-core`). |
| `tools/images/brasty/` | Offline Brasty image scrape (Playwright/TS). |
| `assets/` | ⚠️ contained one stray PNG; see §9 cleanup. |
| `.feedscratch/` | **(gitignored)** real downloaded vendor feeds used as offline test fixtures. |
| `.deploy/` | **(gitignored)** operator credential/scratch store — secrets live here, never in git. |

---

## 3. `plugins/` — plugin inventory

| Plugin | Status | Notes |
|---|---|---|
| `sillage-bridge` | **LIVE** (the WooCommerce bridge) | Source under `ecom_sites/data/wp/wp-content/plugins/sillage-bridge/`. Closed job list. |
| `sillage-warehouses/` | **LIVE** | 2 files: `sillage-warehouses.php` (841 lines) + `sillage-shipping.php`. Deployed by the **storefront** repo's `tools/sillage-deploy.ts` (`SILLAGE_PLUGINS=sillage-warehouses`), **not** by this repo's `ship.sh`/`deploy-vps.sh`. |
| `sillage-storefront/` | referenced by the storefront deploy tool | No refs inside this repo (cross-repo). |
| `headless-core/`, `headless-woocommerce/` | **LIVE — verified installed on the `ecom` box (2026-10-14).** Also copied/activated by the `ops/test/` harness. **NOT dead weight.** | `plugins/README.md` says "Not installed" — that line is stale. |
| `storefront-ean/` | **LIVE** (EAN-only) | Serves `/cereve/v1/ean/{ean}` + `/cereve/v1/products/{id}/ean` via `sillage.sil_ean_index`, with `wc_get_product_id_by_global_unique_id` fallback. Deployed by the **storefront** repo's `tools/sillage-deploy.ts` (`storefront-ean`, active). |
| `purelymail-smtp/` | **LIVE** (SMTP only) | Portable, store-agnostic encrypted SMTP transport; no order-email notices or branding. Deployed active by `tools/sillage-deploy.ts`. Fails closed: no saved connection blocks WordPress email. |
| `storefront-legal-notice/` | **LIVE** | `storefront_legal_notice_email` on `woocommerce_email_after_order_table` adds the EU legal-guarantee notice to customer order emails. Kept separate from `purelymail-smtp` so the SMTP plugin stays reusable without it. |
| `plugins/README.md` line 11 says `sillage-warehouses` is **"Not installed"** — **STALE.** It is live on the retail box. |

### `sillage-warehouses` facts (verified)
- Constants: `SILLAGE_WH_LOCATIONS = ['bts'=>'A','beautyfort'=>'B']`; display names `A=Blossom`,
  `B=Fern`; TTLs `FRESH=3600`, `STALE=3600`, `TAXONOMY=86400`, `LOCK=30`.
- Public REST routes (namespace `sillage/v1`, `permission_callback => __return_true`):
  `GET /delivery`, `GET /products/catalog-meta?ids=`, `GET /products/catalog-counts`.
- **Risk:** activation runs `ALTER TABLE wp_postmeta ADD INDEX … (meta_key(191), post_id)` — an
  additive but real change to a **WordPress core table** (gated by option `sillage_wh_postmeta_index_version`).
- **Risk:** the country-count SQL self-joins `wp_postmeta` heavily — a prior incident hit ~198% MariaDB CPU.
- `/delivery` trusts `CF-IPCountry` / `X-Country-Code` headers (validated; returns country code only).

---

## 4. `production-environment/` map

- `compose.yaml` + `.env.example` — the single canonical stack config. Real `.env` is gitignored.
- `ecom_sites/` — host data mounts + WP/nginx/Caddy config. WP runtime data under `data/` is
  gitignored **except** the `sillage-bridge` plugin and one mu-plugin (see §8).
- `sillage-core/` — the Bun engine (§5).
- `wordpress-image/` — Docker image for WordPress.
- `python-analysis/` — three data pipelines (§6).
- `scripts/` — deploy/ops tooling (§7).

---

## 5. `sillage-core` internals

- **Runtime:** Bun. Scripts: `dev`, `start`, `migrate`, `sync`, `sitemap`, `orders`, `doctor`,
  `identity`, `test`, `typecheck`, `web:dev`, `web:build`.
- **Depends on:** `fast-xml-parser`, `hono`, `mysql2`, `php-serialize`. Dashboard: React 19 + Vite 6 +
  TanStack + Tailwind + Recharts + react-router-dom 7 (under `web/`).
- **Migrations:** `001_init.sql` … `024_pause_fresh_sync_schedules.sql` (24 total; **024 was untracked**).
- **Dockerfile:** 3 stages (`supercronic` alpine, `web` bun, `runtime` bun). `CMD` runs
  `supercronic -passthrough-logs /app/crontab` — **absolute path is required** (see `docs/CONTEXT.md`).
- **Secrets overlay** (`src/config/secrets.ts`): allow-list `MANAGED_SECRETS = [BEAUTYFORT_USER,
  BEAUTYFORT_SECRET, BTS_JWT_TOKEN]`; persists to bind-mounted `data/secrets.overlay.env` (0600);
  re-applied at boot and each sync; API returns only `set`/`source`/`masked`, never values. Overlay wins.
- **Operating rules:** never overwrite operator `sil_settings`; 30-min feed floor; both vendors start
  together or neither; dry-run is the only order gate.
- *(uncertain)*: internal architecture of the ~71 `src/**` files was not fully read.

---

## 6. Python pipelines — `production-environment/python-analysis/`

| Pipeline | Purpose | State |
|---|---|---|
| `beautyfort-enriched/` | Cross-vendor EAN image fill. `enrich.py` orchestrator; writes `data/image_overrides.json` (tracked). | **Done/active.** |
| `ean-image-scrape/` | Fill imageless products by EAN: `scrape_ean_images.py`, `apply_scraped.py`. | Active. |
| `photo-pack/` | VPS CSV builds + one-shot download server (`serve.py`, `build_index.py`, `run_on_vps.sh`). Writes `~/photo-inventory/` on the VPS. | Active. |

- Image overrides are tracked on purpose (`.gitignore` re-includes `data/image_overrides.json` and
  `output/image_overrides.json`); timestamped `*.bak-*` next to them are gitignored.
- *(uncertain)*: exact runtime ordering between the three pipelines.

---

## 7. Deploy / ops — `production-environment/scripts/`

| Script | Role |
|---|---|
| **`ship.sh`** | **Canonical engine deploy.** `--to <alias>`, `--status`. gates → build → push → box, verifies no operator setting moved. Use this. |
| `deploy-vps.sh` | **Empty VPS → shop only.** Build core+WP, beetsync, compose up. **Not** a code-redeploy path. |
| `replicate-headless-vps.sh` | Provision a new headless host from source (required per `AGENTS.md` rule 9). |
| `bootstrap-host.sh`, `vps-bootstrap.sh` | Host bootstrap. |
| `pack-box.sh` | Disaster-recovery archive only. |
| `adopt-box.sh` | Adopt an existing box. |
| `apply-grants.sh` | Post-migrate DB grants (`config/sillage-grants.sql`). |
| `build-push-images.sh` | Build/push Docker Hub tags. |
| `porkbun-dns.sh` | DNS via Porkbun API (reads `.deploy/porkbun.env`). |
| `replay-to-github.sh` | Git replay via env-var `GITHUB_TOKEN` + SSH key. |
| `wp-*.php`, `wp-*.sh`, `fix-wp-content-perms.sh`, `to-bind-mounts.sh` | WP infra helpers. |
| `export-missing-images.py`, `write-sitemaps.py`, `test-empty-vps-contract.sh` | Utilities. |
| **Untracked/new:** `bump-wordpress.sh`, `configure-image-domain.sh`, `copy-vendor-secrets.sh`, `reload-caddy.sh`, `ssh-config-for-aliases.py`, `update-docker-host.sh`, `update-wordpress-core.sh` | See §10. All are source, no secrets. |

**Secret handling (verified):** `deploy-vps.sh` excludes `data/secrets.overlay.env` from rsync and
preserves DB/dashboard secrets on re-deploy. `copy-vendor-secrets.sh` reads `DASHBOARD_PASSWORD`
from env, PUTs the 3 allow-listed keys, prints only `source=overlay`. **No hardcoded creds in any script.**

---

## 8. 🔒 SAFE vs DANGEROUS

### Safe (normal work)
- Editing TypeScript under `production-environment/sillage-core/src/` and running `bun test`.
- Editing docs, plugin PHP (then `php -l`), deploy scripts.
- Committing source, migrations, scripts, docs, config templates.

### Dangerous — think twice, and never do casually
| Area | Danger |
|---|---|
| **Orders** (`orders`, BTS/BF order adapters) | Placing an order **spends real money**. Only the dashboard Dry-run/Live toggle gates it. Nothing may override it. |
| **`sil_settings`** | The operator owns it. **Seed a missing row, never overwrite a present one.** Applies to `sync_enabled`, cadence `*_minutes`, dry-run, nightly rebuild. |
| **Raw SQL product writes** | The engine writes `wp_posts`/`wp_postmeta`/lookups/`sil_ean_index` directly. A bad write corrupts the shop. PHP must not gain write paths. |
| **`ALTER TABLE wp_postmeta`** (warehouses activation) | Touches a WordPress core table. Additive only; never make it destructive. |
| **Docker named volumes** | **Forbidden** for WP/MariaDB — bind mounts only (`AGENTS.md` rule 2). A volume-era box "restored" empty. |
| **`secrets.overlay.env`** | Holds live vendor API creds. **Never commit.** Never print. |
| **`.deploy/`** | Holds dashboard passwords, VPS IP, wp admin creds, private keys. **Never commit.** Gitignored. |
| **Hub image builds** | Must happen on the **explicitly selected builder VPS**; never in a cloud-agent VM; never copy Hub creds off the VPS. |
| **Replacing a VPS** | **Never restore a DB into a fresh replacement.** Provision from source with `replicate-headless-vps.sh`. |
| **`assets/` stray PNG** | Was dead weight; removed in this cleanup (see §9). |
| **`docs/CLIENT_*` / binary client deliverables in the frontend repo** | One client `.docx` had been committed against an explicit "do not commit" instruction; it was untracked and gitignored on 2026-10-14 — see the frontend `CODEBASE-STATE.md`. |

---

## 9. Commit policy — what MAY / MAY NOT be committed

### ✅ May be committed
- `plugins/**` and `mu-plugins/**` source, `production-environment/sillage-core/**` (source, migrations, dashboard),
  `production-environment/scripts/**`, `production-environment/python-analysis/**` (code + tracked
  override data), `docs/**`, `AGENTS.md`, `README.md`, `compose.yaml`, `*.example`, DB config.

### ⛔ MUST NOT be committed (all are gitignored — keep it that way)
- `.env` and `.env.*` (only `.env.example` is tracked).
- `production-environment/sillage-core/data/secrets.overlay.env` and `…secrets.overlay.wpf.env`.
- `.deploy/**` (dashboard passwords, VPS creds, private keys, snapshots).
- `*.pem`, `*.log`, `/data/`, `.recovery/`, `.feedscratch/`.
- Raw WP/MariaDB runtime data under `ecom_sites/data/**` — **except** the deliberate re-include:
  the `sillage-bridge` plugin. The storefront auth MU plugin is tracked under `mu-plugins/`, not
  under the runtime tree.
- Runtime image bytes (`/photo-pack/`, `tmp-image-inventory/`, `tools/images/brasty/{output,watermarked,*.jpg,...}`).

### ⚠️ Grey — decide, do not assume
- `assets/645e08fa-*.png` — **unreferenced**, verified dead; deleted 2026-10-14.
- ~~`plugins/headless-core`, `plugins/headless-woocommerce`~~ — **NOT dead.** Verified live on the
  `ecom` box and used by the `ops/test/` harness. Do not delete. (An earlier guess called them
  legacy; that was wrong.)
- `product/` and `product-dropshipping/` — reference material, not build inputs. Keep unless the
  owner says otherwise.

---

## 10. Working-tree state at time of writing (2026-10-14)

`git status` on branch `main` (tracking `origin/main`, HEAD `c64f2f7`):
**~61 modified tracked files, 3 deleted, 17 untracked. Nothing staged.** This is a large, coherent
uncommitted change set (catalogue/dashboard identity work + docs reorganisation + new ops scripts).

Untracked (all source/docs, **no secrets**):
```
docs/DEPLOYMENT-CHRONOLOGY.md, docs/NEW-VPS-PLAN.md, docs/STOREFRONT-OPERATIONS.md,
docs/archive/{HEALTH-RECOMMENDATIONS-2026-08,REBUILD-HISTORY-2026-10,SCRATCH-RESET-2026-08,VPS-MIGRATE-LEGACY}.md,
production-environment/ecom_sites/data/wp/wp-content/mu-plugins/sillage-disable-wc-admin.php,
production-environment/scripts/{bump-wordpress,configure-image-domain,copy-vendor-secrets,reload-caddy,
  replicate-headless-vps,update-docker-host,update-wordpress-core}.sh,
production-environment/scripts/ssh-config-for-aliases.py,
production-environment/sillage-core/migrations/024_pause_fresh_sync_schedules.sql
```
Deleted (content preserved under `docs/archive/` as untracked renames):
`docs/RECOMMENDATIONS.md`, `docs/SCRATCH-RESET.md`, `docs/VPS-MIGRATE.md`.

The mu-plugin `sillage-disable-wc-admin.php` (10 lines) sets `woocommerce_admin_disabled => true`
to stop WC Admin's background CPU churn. It is deliberately re-included by `.gitignore`.

---

## 11. Secrets map (where credentials actually live)

| Secret | Location | In git? |
|---|---|---|
| BF/BTS vendor API creds | `sillage-core/data/secrets.overlay.env` (0600) + dashboard Secrets page | ❌ |
| Dashboard login | `.deploy/vps-dashboard-<alias>.txt` on the operator machine | ❌ |
| DB / WP admin | box `~/sillage/.env`, `.deploy/*` | ❌ |
| Porkbun DNS | `.deploy/porkbun.env` | ❌ |
| GitHub replay | env vars `GITHUB_TOKEN`, SSH key | ❌ |

Nothing secret is tracked. `.env.example`, `*.example`, and doc placeholders contain names only.

---

## 12. DONE / IN PROGRESS / NOT DONE

**DONE:** product write path (raw SQL) · storefront labels & tiered markup · cross-vendor EAN image
fill · warehouse split-shipping plugin live · image host + dashboard routing · order adapter state
machine + BTS tracking/cancelled fix · clean-VPS rebuild procedure (`NEW-VPS-PLAN.md`).

**IN PROGRESS / WATCH:** catalogue verification on the test box (schedules paused, `sync_enabled=0`) ·
photo coverage gaps (some SKUs imageless; ~12k leftover SKUs lack EANs) · dashboard session-check UX.

**NOT DONE / PARKED:** enable schedules + first full sync review · fill Settings company billing
before first live BF dispatch · attach `product_brand` term links to ~71 products · wholesale-perfumes
B2B (separate repo) · Brasty catalogue/order connectors and Shopify/Brasty shipping rules (dropped).

---

## 13. Do NOT assume (traps)

1. `plugins/README.md` says warehouses is "Not installed" — **it is installed and live.**
2. **Two vendors, not three.** wholesale-perfumes is a different repo.
3. `ship.sh` ships the **engine**; the **warehouses plugin** is shipped from the **storefront repo**.
4. `deploy-vps.sh` is for an **empty** VPS, not a redeploy.
5. Docker **named volumes are forbidden**; everything is bind mounts under each box's `data/`.
6. Orders are **HPOS** (`wp_wc_orders`), not `wp_posts`.
7. Every box talks to **live** vendor APIs — "test box" is not a safety boundary.
8. `supercronic` must be the **absolute path** in the container CMD.
9. Migrations are **not idempotent helpers** — read the numbered file; `022` fixed cadence drift,
   `023` added shipping quotes, `024` pauses fresh sync schedules.
10. Never overwrite operator settings to "make it match" another box.

---

## 14. Verification commands

```bash
# engine
cd production-environment/sillage-core && bun install && bun test && bun run typecheck
# plugin syntax (no local PHP): pipe to a container
ssh <alias> 'docker exec -i ecom php -l' < plugins/sillage-warehouses/sillage-warehouses.php
# ship engine code
./production-environment/scripts/ship.sh --to <ssh-alias>
```

---

## 15. Gaps in this document (not yet verified)

- Internals of `sillage-core/src/**` (server routes, vendor clients, order adapters) — read via docs only.
- Full internals of `deploy-vps.sh` (52 KB) and `ship.sh`.
- `python-analysis`, `product-dropshipping`, `tools/images/brasty`, `ops/test` internals.
- Which override file is authoritative (`data/` vs `output/`).
- ~~Whether `headless-core` / `headless-woocommerce` plugins are truly dead.~~ Resolved 2026-10-14:
  they are live on the box. Not dead.
