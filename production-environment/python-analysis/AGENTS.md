# AGENTS.md

## What This Is

Cross-vendor image enrichment tool. Matches BeautyFort products against multiple external
catalogs (Ocean / wholesale-perfumes.eu XML, OceanFragrances CSV, Shopify, BTS) to find real
product images, then writes Bun-ready `image_overrides.json`.

BeautyFort CDN images are often placeholders forever. This pipeline stays outside the Bun app.

## Commands

```bash
cd production-environment/python-analysis

# optional: copy .env.example → .env and set OCEAN_USER / OCEAN_TOKEN
python3 beautyfort-enriched/test.py
python3 beautyfort-enriched/fetch_ocean.py
python3 beautyfort-enriched/enrich.py --fetch-ocean --install-core
```

After `--install-core`, run a **fast / rewrite sync** on the shop so `_external_thumbnail_url`
updates for existing products.

Ocean catalog etiquette: download at most once per day (script caches ~20h).

## Structure

```
beautyfort-enriched/
  enrich.py
  fetch_ocean.py               — wholesale-perfumes.eu catalog download + parse
  test.py
  fixtures/
    ocean_catalog_sample.xml   — tiny fixture for tests
  data/
    image_overrides.json
  products/                    — gitignored dumps (beautyfort.json, ocean_catalog.xml, …)
  output/
```

## Source priority

1. seed `data/image_overrides.json`
2. **Ocean XML** (`products/ocean_catalog.xml` from `--fetch-ocean`)
3. oceanfragrances.csv (legacy)
4. Shopify CSV
5. BTS JSON

Multi-EAN fan-out: any hit maps **all** barcodes on that BeautyFort product to the same URL.

## Bun consumption

`sillage-core/src/sync/images.ts` loads `sillage-core/data/image_overrides.json` at sync time.

## Watch Out For

- `OCEAN_TOKEN` is the API token from wholesale-perfumes **user settings**, not necessarily the shop password.
- Large fixtures under `products/` are not committed.
- Next vendor image work: Brasty Playwright scraper (CSV has no images).
