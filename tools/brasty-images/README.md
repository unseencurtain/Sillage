# brasty-images

Standalone **Node.js + TypeScript + Playwright** tool that downloads Brasty wholesale
product images by EAN and feeds them into Sillage’s `image_overrides.json` map.

This package is intentionally **not** a dependency of `sillage-core`. Playwright /
Chromium must not ship inside the Bun sync container.

Brasty has **no product detail pages**. Products exist only in a searchable listing;
the large preview is triggered from the row. Do **not** guess how that preview works —
run the investigation harness first.

## Install

```bash
cd tools/brasty-images
cp .env.example .env
# edit .env — CSV path, PUBLIC_URL_BASE, optional LOGO_PATH, etc.

npm install
npx playwright install chromium
```

Never commit `.env`, `storageState.json`, downloaded images, or findings dumps.

## 1. Login (once per session lifetime)

```bash
npm run login
```

Opens **headed** Chromium at `https://wholesale.brasty.com/`. Log in manually, then
press Enter in the terminal. Playwright saves `storageState.json` (gitignored).

Every later command reuses that file and **must not** force a re-login. If the session
expires, commands fail with a clear `run npm run login again` message instead of
scraping a logged-out page.

## 2. Investigate (GATE — do this before download)

Supply a few known-good EANs:

```bash
# via .env
# INVESTIGATE_EANS=4011700747597,3605521666958

npm run investigate
# or:
npm run investigate -- 4011700747597 3605521666958
```

The harness reports, with evidence, whether the large image is:

- (a) already in the DOM  
- (b) in a `data-*` attribute  
- (c) injected after hover  
- (d) a CSS `background-image`  
- (e) requested over the network after hover  
- (f) returned by an API/JSON endpoint  
- (g) derivable from the thumbnail URL via a predictable rewrite  

Output (gitignored):

- `findings/investigate-report.md` — readable  
- `findings/investigate-report.json` — machine-readable answers  
- `findings/investigate-raw.json` — per-EAN DOM/network dumps  

### Operator action after investigate

1. Open the markdown report and confirm which of (a)–(g) is true.  
2. Implement a concrete `ExtractionStrategy` in `src/imageExtractor.ts` from that
   evidence (there is a `strategySkeletonFromFindings` stub).  
3. Call `setExtractionStrategy(...)` so `getExtractionStrategy()` no longer returns
   `pending-investigation`.  
4. Refine `PENDING_SEARCH_SELECTORS` / `PENDING_HOVER_SELECTORS` if search/hover failed.  
5. Only then run download on a **tiny** CSV slice.

Until step 3, `npm run download` will refuse to invent selectors and log
`unexpected_page_structure` for each product.

## 3. Download

Point `BRASTY_CSV_PATH` at the Brasty product CSV (BOM + `,` / `;` tolerated; EAN and
name columns auto-detected).

```bash
npm run download
```

Behaviour:

- Search by EAN → wait until **exactly one** matching row → verify row EAN  
- Hover / trigger preview → extract largest original image URL → HTTP download  
- Save as `output/EAN.jpg` (`EAN-1.jpg`, `EAN-2.jpg` for duplicates)  
- Missing products are logged and skipped (never fatal)  
- Resume via append-only `logs/manifest.jsonl`  
- Concurrency = pool of browser contexts (`CONCURRENCY`, default **1**) +
  `POLITENESS_DELAY_MS` (default 1500) — keep low; CSV may reach 100k+ rows  
- Retries with exponential backoff on download failures  

Structured log categories: `downloaded`, `already_exists`, `missing_image`,
`search_failed`, `hover_failed`, `network_timeout`, `unexpected_page_structure`.

## 4. Watermark (optional LPS logo)

The client wants his own logo on the images (Brasty’s watermark is why he dislikes
their photos).

```bash
# Set LOGO_PATH in .env to the LPS logo file, then:
npm run watermark
```

Writes to `watermarked/` without touching originals. If `LOGO_PATH` is empty or
missing, this step **no-ops** with a clear message.

## 5. Build overrides (merge into Sillage)

```bash
# PUBLIC_URL_BASE must match how the shop will serve the files, e.g.
# PUBLIC_URL_BASE=https://your-shop.example/lps-media
npm run build-overrides
```

Builds an EAN → public URL map from `watermarked/` (or `output/` if empty) and
**merges** into `production-environment/sillage-core/data/image_overrides.json`
without clobbering existing BeautyFort/Ocean keys. Backs up the file first.

## 6. Hosting recommendation (`/lps-media/`)

Keep media **out of** `production-environment/ecom_sites/data/wp/` (hard agent rule).

Recommended arrangement (describe-only — do **not** edit `compose.yaml` from this tool):

1. Create a host directory, e.g. `production-environment/ecom_sites/data/media/`.  
2. Copy watermarked (or original) `EAN.jpg` files there.  
3. Bind-mount that directory **read-only** into the `ecom` container, e.g.
   `./data/media:/var/www/lps-media:ro`.  
4. Configure the web server / WordPress stack to serve that path at **`/lps-media/`**.  
5. Set `PUBLIC_URL_BASE=https://<shop-host>/lps-media` before `build-overrides`.

## 7. Storefront sync

`image_overrides.json` is consumed by sillage-core’s image resolver
(`src/sync/images.ts`). After merging new URLs, run a **fast/rewrite sync** so
WooCommerce product images update. Overrides alone do not push pixels to the shop.

## Scripts

| Command | Purpose |
|---|---|
| `npm run login` | Manual headed login → `storageState.json` |
| `npm run investigate` | Evidence gate for image preview mechanism |
| `npm run download` | Production CSV → `output/EAN.jpg` |
| `npm run watermark` | LPS logo composite → `watermarked/` |
| `npm run build-overrides` | Merge EAN→URL into `image_overrides.json` |
| `npm run typecheck` | `tsc --noEmit` |

## Layout

```
tools/brasty-images/
  package.json
  tsconfig.json
  .env.example
  .gitignore
  README.md
  src/
    login.ts
    investigate.ts
    download-images.ts
    search.ts
    hover.ts
    imageExtractor.ts   ← pluggable strategy (pending investigation)
    downloader.ts
    logger.ts
    config.ts
    watermark.ts
    build-overrides.ts
    …
  findings/              ← investigate output (gitignored)
  output/                ← downloaded originals (gitignored)
  watermarked/           ← logo composites (gitignored)
  logs/                  ← manifest + logs (gitignored)
```
