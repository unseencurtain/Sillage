# S3 — product image playbook

Ordered guide for filling missing product photos. Read `../CONTEXT.md` §6 ("Vendors versus image
sources") and `S3-remaining-work.md` §0 (naming + VPS rules) first.

**Vendors vs image sources.** Only three vendors exist (`bts`, `beautyfort`, `wholesale-perfumes`).
Everything else in this document is an *image source*: EAN → URL, no stock, no prices, no orders.
**"Ocean" means `oceanfragrances.csv` only** — never wholesale-perfumes.eu.

**VPS hosts.**

| SSH host | Role | What you may do |
|---|---|---|
| `ovhe` | Staging | Deploy, migrate, sync, run image tools freely |
| `ovh` | **Production** | Read-only inspection unless the operator explicitly approves writes |

---

## Resolution order (how the shop picks a photo)

At sync time, `sillage-core/src/sync/images.ts` resolves each product's image URL in this order:

| Priority | Source | Where it lives |
|---|---|---|
| 1 | **Curated overrides** | `production-environment/sillage-core/data/image_overrides.json` |
| 2 | **Cross-vendor EAN fill** | Another vendor's offer image for the same EAN in `sil_offers` |

The override file is built *offline* by the steps below. Populate it in source priority order so
earlier, higher-quality sources win when keys collide (merge scripts never clobber existing keys).

---

## Step 1 — wholesale-perfumes.eu catalog XML (`flask_front`)

The wholesaler is vendor `wholesale-perfumes` (SKU prefix `WPF`). Its catalog XML includes
`pictures/flask_front` URLs — use these as the first-choice image source for WPF products and for
any EAN that appears in the feed.

1. Fetch or replay the catalog (live token auth or local fixture — see vendor connector).
2. Extract EAN → `flask_front` URL pairs.
3. **Host under `/lps-media/`** — see [Hosting](#hosting-lps-media) below.
4. Merge EAN → public URL into `image_overrides.json` (do not overwrite existing keys).

The Python enricher under `production-environment/python-analysis/` already owns much of this path
for BeautyFort rows; follow the same merge → sync loop.

---

## Step 2 — oceanfragrances CSV

**"Ocean" = this CSV only:** `python-analysis/.../products/oceanfragrances.csv`.

Image-only index: EAN → external image URL. Not a vendor, not wholesale-perfumes.eu.

1. Read the CSV (EAN + image URL columns).
2. Download or link URLs as needed; prefer hosting copies under `/lps-media/` when URLs are fragile.
3. Merge into `image_overrides.json` (skip keys already set by step 1).

---

## Step 3 — Brasty (Playwright scrape)

Brasty is an **image source only** — no vendor row, no catalogue sync, no orders. Photos match
products by **EAN alone** and can illustrate any vendor's product.

Tool location after reorg: **`tools/images/brasty/`** (standalone Node + Playwright; not a
`sillage-core` dependency).

### Site constraints

- **No product detail pages.** Products exist only in a searchable logged-in list.
- **Hover for the large image**, not the row thumbnail. The preview mechanism must be verified —
  do not guess selectors.
- Always download the **original largest file** from its URL (HTTP GET). Never screenshot or crop
  the preview element.

### Operator flow

```bash
cd tools/images/brasty
cp .env.example .env          # BRASTY_EMAIL, BRASTY_PASSWORD, paths — never commit
npm install
npx playwright install --with-deps chromium   # once per host

npm run login                 # headless → storageState.json (gitignored)
npm run investigate           # evidence gate — see findings/
# implement ExtractionStrategy in src/imageExtractor.ts from findings
npm run download              # trial 10–20 EANs first; then scale on ovhe
npm run watermark             # optional LPS logo → watermarked/
npm run build-overrides       # merge into sillage-core/data/image_overrides.json
```

### Brasty rules (non-negotiable)

| Rule | Detail |
|---|---|
| Login | `BRASTY_EMAIL` / `BRASTY_PASSWORD` in gitignored `.env` |
| Session | `npm run login` writes `storageState.json`; `ensureSession()` re-logins headlessly on expiry |
| Scope | **List rows only** — search by EAN, match exactly one row, verify row EAN before save |
| Extraction | **Hover → large preview URL** — not the thumbnail; strategy must come from `investigate` findings |
| Rate limits | Default `CONCURRENCY=1`, `POLITENESS_DELAY_MS=1500`; do not raise on VPS — blocked account > slow crawl |
| Resume | Append-only `logs/manifest.jsonl`; safe to restart |
| Output | `output/EAN.jpg` → optional watermark → **`build-overrides` → `image_overrides.json`** |
| Cookie banner | Dismiss before clicking "Log in" — banner intercepts clicks if ignored |

Full script reference: `tools/images/brasty/README.md`. Deep implementation task:
`S3-remaining-work.md` §3 Task 1.

---

## Step 4 — cross-vendor EAN fill (automatic at sync)

No manual step. During every full and fast sync, `buildImageLookup()` in
`sillage-core/src/sync/images.ts` fills a missing, placeholder, or weak vendor thumb from **another
vendor's offer** with the same EAN in `sil_offers`.

This runs after overrides are loaded. It cannot beat a curated override URL but covers gaps when
only one vendor ships a real photo.

---

## Hosting (`/lps-media/`)

Product images are **external URLs** — WordPress never creates attachments. Host scraped or
watermarked files outside `data/wp/`:

1. Directory: `production-environment/ecom_sites/data/media/`
2. Bind-mount read-only into `ecom` at `/var/www/lps-media` (see `compose.yaml`)
3. Served at **`/lps-media/`** (Apache locally, Caddy on VPS)
4. Set `PUBLIC_URL_BASE=https://<shop>/lps-media` in tool `.env` before `build-overrides`

Brasty watermark asset: `tools/images/brasty/assets/lps-logo.png`.

---

## After overrides change

1. Copy/host any new files under `data/media/` if using self-hosted URLs.
2. Run sync so WooCommerce picks up URLs — **`bun run sync -- --rewrite-all`** when image rules
   or override keys changed materially (hashes cover vendor data only).
3. Check sync summary `hiddenNoImage` if `hide_products_without_image` is on (default).

---

## Tool layout (`tools/images/`)

| Path | Purpose |
|---|---|
| `tools/images/brasty/` | Brasty Playwright scrape (this playbook §3) |
| `production-environment/python-analysis/` | Bulk download, oceanfragrances, enricher sandbox |
| `production-environment/sillage-core/data/image_overrides.json` | Canonical EAN → URL map consumed at sync |
| `production-environment/sillage-core/src/sync/images.ts` | Override load + cross-vendor fill |

Do **not** move or duplicate sync-time image logic out of `sillage-core`; tools only feed
`image_overrides.json`.

---

## Verification

```bash
cd production-environment/sillage-core
bun run typecheck
bun test

cd ../../tools/images/brasty
npm run typecheck
```

For Brasty work: trial-run 10–20 EANs, inspect output URLs, then scale on **`ovhe`** — not
production **`ovh`** unless read-only inspection.
