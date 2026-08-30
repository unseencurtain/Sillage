# Missing-image products — fill by EAN

Shop products hidden by **Hide products without image** are exported, then
photos are fetched with a mix of tricks. “Barcode” here means the product
**EAN** (EAN-13 / UPC / GTIN). Rows with no EAN are skipped.

Order: Open Facts / Go-UPC **by EAN** → Open Facts search by **brand + name**
(keep only if the result EAN matches) → Bing Images for
`EAN + brand + name`. Files are always `{ean}.jpg`.

## Live VPS work dir

`~/sillage/ean-image-scrape/` on `ovhe`.

| File | What |
|---|---|
| `missing-products.csv` | sku, name, brand, vendor, **EAN**, extras, slug |
| `scraped/{ean}.jpg` | photos found by EAN |
| `scraped-ean-images.zip` | zip of `scraped/` for download |
| `reports/progress.jsonl` | resume log |

Rows with no real EAN are skipped (`skipped_no_barcode` in `export-summary.json`).

## Scripts (in git)

`production-environment/python-analysis/ean-image-scrape/`

1. `export_missing.py` — MariaDB: empty Woo `_external_thumbnail_url` **and** a real EAN
2. `scrape_ean_images.py` — Open Beauty/Products/Food Facts, then Go-UPC, query by EAN
3. `apply_scraped.py` — **zip only** by default. Does **not** write the shop.
   Use `--apply-to-shop` only after the files in `scraped/` have been inspected.

Hide-without-image stays **on**. Do not push unreviewed photos onto the CDN.
