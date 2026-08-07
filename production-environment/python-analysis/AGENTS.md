# AGENTS.md

## What This Is

Cross-vendor image enrichment tool. Matches BeautyFort products against multiple external
catalogs (wholesale-perfumes.eu XML, oceanfragrances CSV, Shopify, BTS) to find real
product images, then writes Bun-ready `image_overrides.json`.

BeautyFort CDN images are often placeholders forever. This pipeline stays outside the Bun app.

## Commands

```bash
cd production-environment/python-analysis

# optional: copy .env.example → .env and set WHOLESALE_PERFUMES_USER / WHOLESALE_PERFUMES_TOKEN
python3 beautyfort-enriched/test.py
python3 beautyfort-enriched/fetch_wholesale_perfumes.py
python3 beautyfort-enriched/enrich.py --fetch-wholesale-perfumes --install-core
```

After `--install-core`, run a **fast / rewrite sync** on the shop so `_external_thumbnail_url`
updates for existing products.

wholesale-perfumes catalog etiquette: download at most once per day (script caches ~20h).

## Structure

```
beautyfort-enriched/
  enrich.py
  fetch_wholesale_perfumes.py  — wholesale-perfumes.eu catalog download + parse
  test.py
  fixtures/
    wholesale_perfumes_catalog_sample.xml  — tiny fixture for tests
  data/
    image_overrides.json
  products/                    — gitignored dumps (beautyfort.json, wholesale_perfumes_catalog.xml, …)
  output/
```

## Source priority

1. seed `data/image_overrides.json`
2. **wholesale-perfumes XML** (`products/wholesale_perfumes_catalog.xml` from `--fetch-wholesale-perfumes`)
3. oceanfragrances.csv (image source only — not a vendor)
4. Shopify CSV
5. BTS JSON

Multi-EAN fan-out: any hit maps **all** barcodes on that BeautyFort product to the same URL.

## Bun consumption

`sillage-core/src/sync/images.ts` loads `sillage-core/data/image_overrides.json` at sync time.

## Watch Out For

- `WHOLESALE_PERFUMES_TOKEN` is the API token from wholesale-perfumes **user settings**, not necessarily the shop password.
- "Ocean" in this folder means **oceanfragrances.csv** (image CSV), never the wholesaler.
- Large fixtures under `products/` are not committed.
- Next vendor image work: Brasty Playwright scraper (CSV has no images).
