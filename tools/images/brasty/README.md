# brasty-images

Standalone **Node.js + TypeScript + Playwright** tool that downloads product
photographs from Brasty wholesale by EAN and feeds them into Sillage’s
`image_overrides.json` map.

Brasty is an **image source only** — not a Sillage vendor. There is no catalogue
sync, order API, or shipping integration. Photos are matched to shop products by
**EAN alone**, so a Brasty photo can illustrate a BeautyFort or
wholesale-perfumes.eu product and vice versa. The override map is
vendor-agnostic.

This package is intentionally **not** a dependency of `sillage-core`. Playwright /
Chromium must not ship inside the Bun sync container.

Brasty has **no product detail pages**. Products exist only as `.c-product` list rows.
The list shows a small `/images/w60/` thumb; the real large image (`/images/w700/…`)
appears **on hover** (also stored on `picture[data-image]`). Scraping the thumb `src`
without hover is wrong. The registered strategy is `list-row-hover-large`.

## Install (including a fresh headless VPS)

```bash
cd tools/images/brasty
cp .env.example .env
# edit .env — set BRASTY_EMAIL, BRASTY_PASSWORD, CSV path, PUBLIC_URL_BASE, etc.

npm install
# Fresh VPS / no display: install Chromium + OS deps (one-time):
npx playwright install --with-deps chromium
```

Never commit `.env`, `storageState.json`, downloaded images, or findings dumps.

The whole pipeline (login → investigate → download → watermark → build-overrides)
runs **headless** with no X server. Default `CONCURRENCY=1` and Chromium’s
`--disable-dev-shm-usage` keep memory use safe on a small VPS (~4 GB shared with
WordPress, MariaDB, Valkey, and Bun). Do not raise concurrency on that box.

## 1. Login (headless, credential-driven)

```bash
npm run login
```

Uses `BRASTY_EMAIL` / `BRASTY_PASSWORD` from `.env`, opens **headless** Chromium at
`https://wholesale.brasty.com/`, dismisses the cookie-consent banner (prefers
Reject all), discovers the login form via the header “Log in” link, submits, then
asserts an authenticated session before saving `storageState.json` (gitignored).

Later commands call `ensureSession()`: they load that file, cheaply check it is
still authenticated, and **transparently re-run headless login** if it has expired.
A stale session alone never fails a run (wrong credentials / missing env still do).

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

### Hover extraction (implemented)

`list-row-hover-large` is registered by default: search `.c-product` → hover
`.c-product__img` → take the post-hover `/images/w700/` URL (network / DOM /
`data-image`), never `/images/w60/`. Re-run `npm run investigate` only if markup
changes.

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
  `POLITENESS_DELAY_MS` (default 1500) — keep at 1 on the VPS; CSV may reach 100k+ rows  
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
without clobbering existing BeautyFort/wholesale-perfumes keys. Backs up the file first.

## 6. Hosting (`/lps-media/`)

Keep media **out of** `production-environment/ecom_sites/data/wp/` (hard agent rule).

Stack (owned by `ecom_sites/compose.yaml` + deploy script — do not reinvent from this tool):

1. Host directory: `production-environment/ecom_sites/data/media/` (bind-mount, not a Docker volume).
2. Copy watermarked (or original) `EAN.jpg` files there — served immediately by `lps-media`.
3. Dedicated `lps-media` (`nginx:alpine`) mounts that path as its document root.
4. Public URL path stays **`/lps-media/`** via edge proxy (`shop-gateway` locally, host Caddy on VPS).
5. Set `PUBLIC_URL_BASE=https://<shop-host>/lps-media` before `build-overrides`.

## 7. Storefront sync

`image_overrides.json` is consumed by sillage-core’s image resolver
(`src/sync/images.ts`). After merging new URLs, run a **fast/rewrite sync** so
WooCommerce product images update. Overrides alone do not push pixels to the shop.

## VPS end-to-end (headless)

```bash
cd tools/images/brasty
# one-time on a fresh box:
npm install && npx playwright install --with-deps chromium
cp .env.example .env   # set BRASTY_EMAIL, BRASTY_PASSWORD, paths, PUBLIC_URL_BASE

npm run login            # headless; writes storageState.json
npm run investigate      # gate — register ExtractionStrategy from findings
npm run download         # CONCURRENCY=1 by default; resume-safe
npm run watermark        # optional LPS logo
npm run build-overrides  # merge EAN→URL into image_overrides.json
# then fast/rewrite sync in sillage-core so the shop picks up URLs
```

## Scripts

| Command | Purpose |
|---|---|
| `npm run login` | Headless credential login → `storageState.json` |
| `npm run investigate` | Evidence gate for image preview mechanism |
| `npm run download` | Production CSV → `output/EAN.jpg` |
| `npm run watermark` | LPS logo composite → `watermarked/` |
| `npm run build-overrides` | Merge EAN→URL into `image_overrides.json` |
| `npm run typecheck` | `tsc --noEmit` |

## Layout

```
tools/images/brasty/
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
    session.ts           ← ensureSession() + auth checks
    watermark.ts
    build-overrides.ts
    …
  findings/              ← investigate output (gitignored)
  output/                ← downloaded originals (gitignored)
  watermarked/           ← logo composites (gitignored)
  logs/                  ← manifest + logs (gitignored)
```
