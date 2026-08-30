# Missing-image products — fill by EAN

Shop products hidden by **Hide products without image** are exported, then
photos are fetched **by EAN only**. “Barcode” in this kit means the product
**EAN** (EAN-13 / UPC / GTIN digits in `primary_ean` and extra `eans`).

We do **not** search Google/Bing by product name. A source photo is saved only
when that source says it belongs to the **same EAN**.

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
3. `apply_scraped.py` — copy onto `~/ecom_sites/data/media/`, merge EAN → CDN URL, rewrite

After apply, dashboard **Sync** shop writes should show those SKUs as updated when
the rewrite runs. Hide-without-image stays **on**.
