# Sillage — agent entry point

Multi-vendor dropshipping sync between two wholesale APIs and a WooCommerce storefront
(**BeautyFort + BTS** retail). Wholesale-perfumes is a **separate product** in
[unseencurtain/sillage-b2b](https://github.com/unseencurtain/sillage-b2b) — do not add it here.

**New here or handing off? Read [`docs/CODEBASE-STATE.md`](docs/CODEBASE-STATE.md) first** — it maps
what exists, what is done, what is safe vs dangerous, where secrets live, and what may / may not be
committed. Do not assume; it lists the traps.

**Changed code? Ship it with one command: [`docs/SHIP.md`](docs/SHIP.md).**

```bash
./production-environment/scripts/ship.sh --to <ssh-alias>  # gates → build → push → selected box
./production-environment/scripts/ship.sh --status --to <ssh-alias>
```

Never hand-run rsync / docker build / compose up to deploy the engine again. `ship.sh` does the
whole sequence and verifies the result, including that no operator setting moved. `deploy-vps.sh`
is only for turning an empty VPS into a shop.

**Building a new VPS from scratch? Read [`docs/NEW-VPS-PLAN.md`](docs/NEW-VPS-PLAN.md) first.**
It is the current ordered process. Historical trial-and-error notes are archived and are not a
setup recipe.

**Read [`docs/HANDOFF.md`](docs/HANDOFF.md) first — including the Memory section.** Hub images are
built on the explicitly selected builder host (`docker login` lives there). This repo is the **retail** shop only. Wholesale-perfumes
is [unseencurtain/sillage-b2b](https://github.com/unseencurtain/sillage-b2b) — do not add it here.

**Read [`docs/AGENTS-RUNBOOK.md`](docs/AGENTS-RUNBOOK.md)** for the whole-project loop (sync, photos,
new VPS, orders). **Read `docs/CONTEXT.md` before touching anything.** It is the canonical fact sheet:
container names, database credentials, WooCommerce schema quirks, and the complete list of tables we
write to. Then read only the one spec under `docs/specs/` that covers your task. Do not go exploring —
everything you need is in those files.

**Sync, the cadence, and the Rebuild button: [`docs/SYNC-RULES.md`](docs/SYNC-RULES.md).** Those
are the owner's rules; that file wins over any other doc or comment.

**Operator dashboard:** every Settings / Vendors / Sync / Orders control for this retail shop is
documented in [`docs/OPERATOR-DASHBOARD.md`](docs/OPERATOR-DASHBOARD.md) (engineers).

**Client / human how-to:** [`docs/CLIENT-GUIDE.md`](docs/CLIENT-GUIDE.md). If you change dashboard
copy, Settings sections, order buttons, or shopper rules (cart, checkout, tracking, hide-without-image),
**update `CLIENT-GUIDE.md` in the same commit** so clients and the owner stay in sync.

**Change shop / dashboard / image hostnames:** [`docs/DOMAIN-MIGRATION.md`](docs/DOMAIN-MIGRATION.md).
What lives where: [`docs/FOLDER-STRUCTURE.md`](docs/FOLDER-STRUCTURE.md).
**Shop CPU / AI crawlers:** [`docs/CRAWLER-SHIELD.md`](docs/CRAWLER-SHIELD.md) — required on every VPS.
**Google / product sitemaps:** [`docs/SEO.md`](docs/SEO.md) — Googlebot must stay allowed; bridge patches WP sitemap 404s.

## Layout

| Path | What it is |
|---|---|
| `production-environment/sillage-core/` | Bun/TypeScript sync engine, HTTP API, React dashboard |
| `production-environment/ecom_sites/data/wp/wp-content/plugins/sillage-bridge/` | Thin WooCommerce plugin |
| `production-environment/compose.yaml` | Single Docker Compose stack (ecom, db, valkey, media, sillage) |
| `production-environment/ecom_sites/` | Host data mounts + WP/nginx/MariaDB config (`lps-media` media dir) |
| `.feedscratch/` | Real downloaded vendor feeds, used as offline test fixtures (gitignored) |
| `product-dropshipping/` | Original standalone vendor clients. Reference only — do not edit |
| `docs/` | Client how-to [`CLIENT-GUIDE.md`](docs/CLIENT-GUIDE.md); engineers start at `CONTEXT.md` |
| `tools/images/` | Offline image tools (Brasty Playwright scrape, etc.) |

## Hard rules

1. **Never change a setting the operator set.** `sil_settings` belongs to whoever runs the shop:
   not `sync_enabled`, not the cadence, not dry-run, not the nightly rebuild. Each box is set
   independently — one may be syncing while the other is off, and that is a choice, not drift to
   reconcile. Seed a missing row, never overwrite a present one. Read
   [`docs/SYNC-RULES.md`](docs/SYNC-RULES.md) before touching the scheduler, the interval gate,
   the Sync page, or anything named `*_minutes`.
2. **Bind mounts only. Never a Docker named volume** for WordPress or MariaDB. Every stack keeps
   its state under its own `data/` (`data/wp/`, `data/wp-db/`, `data/media/`, `data/sitemaps/`) so
   a `tar` of the home folder is a complete backup — a volume-era box looked backed up and
   restored with no shop inside. Never hand-edit WordPress core or raw DB files; patch
   `wp-config.php` with `scripts/wp-config-patch.php` inside the container. The `sillage-bridge`
   plugin source is edited in this repo and shipped by the deploy.
3. **Never commit secrets.** All credentials live in gitignored `.env` files.
4. **Bun writes products via raw SQL; PHP never does.** The plugin's job list is closed and
   enumerated in `docs/CONTEXT.md`. Adding write logic to PHP is a design violation.
5. **Orders are HPOS.** WooCommerce 11 stores orders in `wp_wc_orders`, not `wp_posts`.
6. **Placing a vendor order spends real money.** Neither wholesaler has ever offered a sandbox,
   so every box — however it is labelled — talks to the live ordering API on live credentials. The
   Orders page Dry-run / Live choice is the only gate; nothing may overrule it in either
   direction, and no banner may claim a box is safe.
7. **Client-facing behaviour has a human doc.** Keep [`docs/CLIENT-GUIDE.md`](docs/CLIENT-GUIDE.md)
   matching the live UI and shop rules in the same change.
8. **Hub images are built and pushed on the explicitly selected builder VPS.** Do not build Hub
   images in a cloud-agent VM or copy Docker Hub credentials off the VPS. See [`docs/SHIP.md`](docs/SHIP.md).
   Empty VPS: `bootstrap-host.sh` then `deploy-vps.sh` (core + WordPress). Wholesale is
   [sillage-b2b](https://github.com/unseencurtain/sillage-b2b).
9. **Automate the second time.** If a task takes more than one hand-run command and will happen
   again, it becomes a script in `production-environment/scripts/` with a doc line, in the same
   change. Shipping code is `ship.sh`; building a box is `deploy-vps.sh`; moving a box is
   `pack-box.sh` is for disaster-recovery archives only. A new host is provisioned from source with
   `replicate-headless-vps.sh`; never restore a database into a fresh replacement VPS.

## Commands

```bash
cd production-environment/sillage-core
bun install
bun run migrate            # apply sillage DB migrations
bun run sync -- --source=local --vendor=all   # offline, uses .feedscratch fixtures
bun run sync -- --source=live --vendor=bts
bun run dev                # API + dashboard on :4000
bun test
```

## Production deploy (one compose + one `.env`)

Canonical env: `production-environment/.env.example` → laptop
`production-environment/.env` → VPS `~/sillage/.env`.
Compose: `production-environment/compose.yaml` only (legacy
`ecom_sites/compose.yaml` / `redis/compose.yaml` are thin includes).
Hub images: `unseencurtain/sillage-core:<sha>`, `unseencurtain/sillage-wordpress:<sha>`.

```bash
bash production-environment/scripts/replicate-headless-vps.sh \
  --host <ssh-alias> --shop shop.example.com --images images.example.com \
  --dashboard-path /sillagedash
```

Full recipe: `docs/NEW-VPS-PLAN.md`; script reference: `docs/VPS-DEPLOY.md`. **Rules that apply to every box:
[`docs/ENVIRONMENTS.md`](docs/ENVIRONMENTS.md) — read it before deploying.** SSH aliases and
public domains are inputs for each run; do not assume or hard-code a particular VPS. New VPS setup
is a clean deploy; never copy a runtime folder or database. Copy product photos only when requested.
Split `ecom_sites/.env` / `sillage-core/.env` are local-dev / migration leftovers only.
