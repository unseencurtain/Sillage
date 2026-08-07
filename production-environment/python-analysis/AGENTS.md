# AGENTS.md

## What This Is

Cross-vendor image enrichment tool. Matches BeautyFort products against multiple external
catalogs (OceanFragrances, Shopify, BTS Wholesaler) to find real product images, then writes:

1. WooCommerce-ready CSVs (analysis / optional import)
2. **`image_overrides.json`** — Bun-ready EAN → HTTPS URL map for `sillage-core`

BeautyFort CDN images are often placeholders forever. This pipeline stays outside the Bun app.

## Commands

```bash
cd production-environment/python-analysis

python3 beautyfort-enriched/test.py
python3 beautyfort-enriched/enrich.py
python3 beautyfort-enriched/enrich.py --install-core
# copies output/image_overrides.json → sillage-core/data/image_overrides.json
```

After `--install-core`, run a **fast / rewrite sync** on the shop so `_external_thumbnail_url`
updates for existing products.

## Structure

```
beautyfort-enriched/
  enrich.py                    — main script (multi-EAN fan-out + --install-core)
  test.py                      — unit + integration tests
  data/
    image_overrides.json       — seed + regenerated map (also installed into sillage-core)
  products/                    — local fixtures (large; gitignored)
    beautyfort.json
    bts_wholeseller.json
    bts_wholeseller_categories.json
    oceanfragrances.csv
    products_export_1.csv
  output/
    image_overrides.json       — Bun-facing map (all EANs on a matched product)
    beautyfort_normalized.csv
    beautyfort_woocommerce.csv
    report.json
```

## How Image Enrichment Works

Each BeautyFort product can have multiple comma-separated barcodes. For each product, EANs are
checked against sources in priority order:

1. **seed `data/image_overrides.json`**
2. **oceanfragrances.csv** — every EAN listed on the row
3. **products_export_1.csv** — Shopify barcode
4. **bts_wholeseller.json** — primary EAN (+ optional all_eans)

On the first real image hit, **every** EAN on that BeautyFort product is written into the
overrides map with the same URL (so Bun matches whichever EAN is on `sil_offers` / the index).

No thumbnail / `no_image` / `woocommerce-placeholder` URLs are kept.

## Bun consumption

[`sillage-core/src/sync/images.ts`](../sillage-core/src/sync/images.ts) loads
`sillage-core/data/image_overrides.json` at sync time, then falls back to other vendors' live
offer URLs by EAN.

## Watch Out For

- German-encoded strings (e.g. `Ã¶`) — handled by `fix_encoding()`
- BeautyFort products without any barcode are skipped
- Large JSON/CSV fixtures under `products/` are regenerable inputs — do not commit them
