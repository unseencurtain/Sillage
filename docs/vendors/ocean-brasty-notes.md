# Ocean (wholesale-perfumes.eu) and Brasty — integration notes

No credentials in this file. Put secrets in `python-analysis/.env` or `sillage-core/.env`.

## wholesale-perfumes.eu (Ocean / SoleLuna)

| Feed | URL pattern | Cadence |
|---|---|---|
| Catalog (pictures) | `/xml/catalog/LovelyXml/en` | Daily ~05:00 — download ≤1×/day |
| Stock + price | `/xml/store/LovelyXml/EUR` | Hourly |
| CSV pricelist | `/export_pricelist/csv` | Semicolon, UTF-8 |
| Cart / order API | `/api/v1/...` | HTTP Basic `email:api_token` |

Catalog products carry `ean`, `all_eans`, and `pictures` (prefer `flask_front`). Used today only for
**image overrides** via `beautyfort-enriched/fetch_ocean.py` + `enrich.py`. Full Sillage vendor
connector is backlog P1.

Docs: https://www.wholesale-perfumes.eu/api/docs/ · https://www.wholesale-perfumes.eu/xml-export/

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

1. Done in this slice: Ocean XML → BeautyFort `image_overrides.json`.
2. Brasty Playwright scaffold lives in `tools/brasty-images/` — operator must run
   investigate on the live site, then register the extraction strategy before bulk download.
3. Later: full Ocean + Brasty catalogue/order adapters in sillage-core; LPS01/LPS02 naming.
