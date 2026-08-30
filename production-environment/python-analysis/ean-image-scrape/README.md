# EAN image scrape

Fill shop products that have **no photo** by looking up **EAN only**
(EAN-13 / UPC / GTIN — the barcode digits). Name and brand are exported so
you can read the list; they are **never** used as a search key.

A hit is kept only when the source returns the **same EAN** (leading zeros ignored).

## VPS folder

```
~/sillage/ean-image-scrape/
  missing-products.csv     EAN + name + brand (rows without an EAN are omitted)
  scraped/                 photos named {ean}.jpg
  scraped-ean-images.zip   downloadable archive of scraped/
  reports/
```

## Run on `ovhe`

```bash
DIR=~/sillage/ean-image-scrape
mkdir -p "$DIR"
cp -a production-environment/python-analysis/ean-image-scrape/. "$DIR/bin/"

python3 "$DIR/bin/export_missing.py" --out-dir "$DIR"
python3 "$DIR/bin/scrape_ean_images.py" --work-dir "$DIR" --workers 3
python3 "$DIR/bin/apply_scraped.py" --work-dir "$DIR" --rewrite
```

`--rewrite` copies files into `~/ecom_sites/data/media/`, merges
`image_overrides.json` keyed by EAN, recreates core/cron, then content-rewrites
only the dirty rows.
