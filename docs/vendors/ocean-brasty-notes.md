# Ocean (wholesale-perfumes.eu) and Brasty — integration notes

No credentials in this file. Put secrets in `python-analysis/.env` or `sillage-core/.env`.

## wholesale-perfumes.eu (Ocean / SoleLuna)

| Feed | URL pattern | Cadence |
|---|---|---|
| Catalog (pictures) | `/xml/catalog/LovelyXml/en` | Daily ~05:00 — download ≤1×/day |
| Stock + price | `/xml/store/LovelyXml/EUR` | Hourly |
| CSV pricelist | `/export_pricelist/csv` | Semicolon, UTF-8 |
| Cart / order API | `/api/v1/...` | HTTP Basic `email:api_token` |

### Sillage connector (slug `ocean`, sku_prefix `OC`, storefront `LPS03`)

Implemented in `sillage-core/src/vendors/ocean/` + `src/orders/adapters/ocean.ts`. Seeded **inactive**
by migration `013_ocean_vendor.sql` until an operator turns it on.

- Catalog + store joined on vendor `id`. Store feed alone powers `fetchPriceStock`.
- Live gates: catalog max 1/day (`ocean_live_max_per_day`); store hourly
  (`ocean_store_live_min_minutes` / `ocean_store_live_max_per_day`).
- Offline: `--source=local` reads `ocean_catalog.xml` + `ocean_store.xml` from `FIXTURES_DIR`,
  falling back to `tests/fixtures/ocean_*.xml`.
- Pricing: store publishes `price_no_vat`. `sil_vendors.vat_rate` defaults to **0** (operator must
  confirm the correct fraction before live retail prices are right). Cost =
  `vendorPrice × fxRate × (1 + vat_rate)` before markup tiers.
- Orders: cart is account-global — submit runs under `GET_LOCK('sillage:ocean-cart')`. Dry-run
  performs **no** remote mutation (not even `DELETE /cart`). No idempotency key → same
  needs_attention rails as BTS (decision 25).
- Cart line `code` is assumed to be the catalog `id` (`oceanCartCode` in the order adapter) —
  **verify with a real dry-run before going live.**

### Operator-confirmable seed guesses (migration 013)

| Field | Seeded value | Status |
|---|---|---|
| `min_order_value_eur` | `100` | Guess — client confirmed a MOQ exists, not the amount |
| `serviceable_countries` | AT BE CZ DE DK ES FI FR HU IE IT LU NL PL PT SE SK | Guess — confirm against Ocean account |
| `vat_rate` | `0` | Deliberately unset — do not invent a rate |

Docs: https://www.wholesale-perfumes.eu/api/docs/ · https://www.wholesale-perfumes.eu/xml-export/

Env placeholders: `OCEAN_USER`, `OCEAN_TOKEN`, `OCEAN_CATALOG_URL`, `OCEAN_STOCK_URL`,
`OCEAN_API_BASE_URL` in `sillage-core/.env.example`.

## Brasty (wholesale.brasty.com)

| Feed | Notes |
|---|---|
| Product CSV | Full range; **no image URLs** |
| Availability CSV | Stock deltas |

Images are watermarked on the site. Client may later want LPS logo overlay. Image acquisition needs
a **Playwright** scrape (search by EAN on the product list — no PDP pages). Spec:
`beastly-image.md` (operator notes, not in repo).

### Brasty image tool (`tools/brasty-images/`)

Standalone Node/Playwright package (not a sillage-core dependency). Operator flow:

1. `npm run login` — headed session → gitignored `storageState.json`
2. `npm run investigate` — evidence gate for how the large preview loads (DOM / data-* /
   hover inject / CSS bg / network / API / thumb→full URL). Writes `findings/`.
3. Operator pastes a concrete extraction strategy into `src/imageExtractor.ts` from findings
4. `npm run download` → `output/EAN.jpg` (resume via JSONL manifest; low concurrency)
5. Optional `npm run watermark` — LPS logo via sharp into `watermarked/`
6. `npm run build-overrides` — merge EAN→`PUBLIC_URL_BASE` URLs into
   `sillage-core/data/image_overrides.json` (never clobber existing keys)
7. Host files under `ecom_sites/data/media/` bind-mounted RO into `ecom` at `/lps-media/`
   (compose change described in the tool README; keep media out of `data/wp/`)
8. Fast/rewrite sync so the storefront picks up the new override URLs

### Shipping (Brasty)

- Pack weight: **one box per 26 kg** (42 kg → 2 boxes, 53 kg → 3 boxes).
- Orders **over 120 kg** → pallet, individual price.
- Per-country DHL / PPL / GLS rates: see operator `beastly-shipping.md`.

## Next steps

1. Done: Ocean XML → BeautyFort `image_overrides.json`.
2. Done (this slice): Ocean catalogue connector + cart order adapter (inactive until operator enable).
3. Brasty Playwright scaffold lives in `tools/brasty-images/` — operator must run
   investigate on the live site, then register the extraction strategy before bulk download.
4. Later: Brasty catalogue/order adapters; confirm Ocean MOQ / countries / VAT / cart `code`.
