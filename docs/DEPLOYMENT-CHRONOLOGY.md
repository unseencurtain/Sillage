# Deploy chronology

| UTC | Elapsed | Step |
|---|---|---|
| 2026-10-13T19:59:01Z | 0m05s | START host=ovhe shop=prinscosmetic.eu dashboard=prinscosmetic.eu/sillagedash private=1 images=none skip_build=0 wordpress=1 |
| 2026-10-13T19:59:02Z | 0m06s | Public IP 139.99.61.71 |
| 2026-10-13T19:59:02Z | 0m06s | DNS verified for shop/dash/images → 139.99.61.71 |
| 2026-10-13T19:59:08Z | 0m12s | Building core + WordPress unseencurtain/sillage-core:c64f2f7 unseencurtain/sillage-wordpress:c64f2f7 |
| 2026-10-13T20:01:44Z | 0m05s | START host=ovhe shop=prinscosmetic.eu dashboard=prinscosmetic.eu/sillagedash private=1 images=none skip_build=0 wordpress=1 |
| 2026-10-13T20:01:45Z | 0m06s | Public IP 139.99.61.71 |
| 2026-10-13T20:01:45Z | 0m06s | DNS verified for shop/dash/images → 139.99.61.71 |
| 2026-10-13T20:01:51Z | 0m12s | Building core + WordPress unseencurtain/sillage-core:c64f2f7 unseencurtain/sillage-wordpress:c64f2f7 |
| 2026-10-13T20:04:12Z | 0m05s | START host=ovhe shop=prinscosmetic.eu dashboard=prinscosmetic.eu/sillagedash private=1 images=none skip_build=0 wordpress=1 |
| 2026-10-13T20:04:14Z | 0m07s | Public IP 139.99.61.71 |
| 2026-10-13T20:04:14Z | 0m07s | DNS verified for shop/dash/images → 139.99.61.71 |
| 2026-10-13T20:04:21Z | 0m14s | Building core + WordPress unseencurtain/sillage-core:c64f2f7 unseencurtain/sillage-wordpress:c64f2f7 |
| 2026-10-13T20:04:24Z | 0m17s | Pushed Hub images from ovhe |
| 2026-10-13T20:04:43Z | 0m05s | START host=ovhe shop=prinscosmetic.eu dashboard=prinscosmetic.eu/sillagedash private=1 images=none skip_build=0 wordpress=1 |
| 2026-10-13T20:04:44Z | 0m06s | Public IP 139.99.61.71 |
| 2026-10-13T20:04:44Z | 0m06s | DNS verified for shop/dash/images → 139.99.61.71 |
| 2026-10-13T20:04:52Z | 0m14s | Building core + WordPress unseencurtain/sillage-core:c64f2f7 unseencurtain/sillage-wordpress:c64f2f7 |
| 2026-10-13T20:05:32Z | 0m54s | Built images locally on ovhe |
| 2026-10-13T20:05:34Z | 0m56s | WordPress image carries 7.1.3 (matches pin) |
| 2026-10-13T20:06:07Z | 1m29s | Minimal rsync done |
| 2026-10-13T20:08:05Z | 3m27s | Photos copied from ovh (4228 JPEGs) |
| 2026-10-13T20:08:24Z | 0m04s | START host=ovhe shop=prinscosmetic.eu dashboard=prinscosmetic.eu/sillagedash private=1 images=none skip_build=0 wordpress=1 |
| 2026-10-13T20:08:24Z | 0m04s | Public IP 139.99.61.71 |
| 2026-10-13T20:08:24Z | 0m05s | DNS verified for shop/dash/images → 139.99.61.71 |
| 2026-10-13T20:08:31Z | 0m11s | Building core + WordPress unseencurtain/sillage-core:c64f2f7 unseencurtain/sillage-wordpress:c64f2f7 |
| 2026-10-13T20:08:48Z | 0m28s | Built images locally on ovhe |
| 2026-10-13T20:08:50Z | 0m30s | WordPress image carries 7.1.3 (matches pin) |
| 2026-10-13T20:09:22Z | 1m02s | Minimal rsync done |
| 2026-10-13T20:09:25Z | 1m05s | Photos copied from ovh (4228 JPEGs) |
| 2026-10-13T20:09:30Z | 1m10s | Created ~/sillage/.env + /home/sine/Projects/Wordpress/Sillage/.deploy/vps-dashboard-ovhe.txt |
| 2026-10-13T20:10:19Z | 0m05s | START host=ovhe shop=prinscosmetic.eu dashboard=prinscosmetic.eu/sillagedash private=1 images=none skip_build=1 wordpress=1 |
| 2026-10-13T20:10:20Z | 0m06s | Public IP 139.99.61.71 |
| 2026-10-13T20:10:20Z | 0m06s | DNS verified for shop/dash/images → 139.99.61.71 |
| 2026-10-13T20:10:20Z | 0m06s | Skipped image build; using unseencurtain/sillage-core:latest unseencurtain/sillage-wordpress:latest |
| 2026-10-13T20:10:22Z | 0m08s | WordPress image carries 7.1.3 (matches pin) |
| 2026-10-13T20:10:23Z | 0m09s | Engine image matches the checkout's sillage-core/src |
| 2026-10-13T20:10:53Z | 0m39s | Minimal rsync done |
| 2026-10-13T20:10:56Z | 0m42s | Photos copied from ovh (4228 JPEGs) |
| 2026-10-13T20:10:59Z | 0m45s | Updated image tags in existing .env |
| 2026-10-13T20:11:35Z | 1m21s | Remote bring-up finished |
| 2026-10-13T20:11:35Z | 1m21s | DONE total=81s (~1m21s) |
| 2026-10-13T20:12:52Z | 0m04s | START host=ovhe shop=prinscosmetic.eu dashboard=prinscosmetic.eu/sillagedash private=1 images=none skip_build=0 wordpress=0 |
| 2026-10-13T20:12:53Z | 0m05s | Public IP 139.99.61.71 |
| 2026-10-13T20:12:53Z | 0m05s | DNS verified for shop/dash/images → 139.99.61.71 |
| 2026-10-13T20:12:58Z | 0m10s | Building core-only unseencurtain/sillage-core:c64f2f7 |
| 2026-10-13T20:13:14Z | 0m26s | Built images locally on ovhe |
| 2026-10-13T20:13:44Z | 0m56s | Minimal rsync done |
| 2026-10-13T20:13:47Z | 0m59s | Photos copied from ovh (4228 JPEGs) |
| 2026-10-13T20:13:49Z | 1m01s | Updated image tags in existing .env |
| 2026-10-13T20:13:58Z | 1m10s | Remote bring-up finished |
| 2026-10-13T20:13:58Z | 1m10s | DONE total=70s (~1m10s) |

## 2026-10-14 correction and current test state

| UTC | Action | Result |
|---|---|---|
| 2026-10-14 | User clarified the maintenance page adds friction to new-account testing; remove it. | Maintenance MU plugin and compose switch removed from source. Deployment no longer stages or installs it. |
| 2026-10-14 | User clarified Stripe is a later feature after functional testing. | No Stripe plugin/credentials detected on `ovhe`; Stripe intentionally deferred. |
| 2026-10-14 | Investigated browser username/password dialog. | Found Caddy `basic_auth` on `prinscosmetic.eu`; backed it up to `~/sillage/ops/caddy/sillage.before-basic-auth-20261013T203008Z.caddy.bak`, removed block, validated and reloaded Caddy. `/` returned HTTP 200 and `/wp-admin/` HTTP 302 after removal. |
| 2026-10-14 | Preserved current local code before next deployment. | Tracked changes in `source-snapshots/working-tree-20261014.patch`; untracked source in `source-snapshots/untracked-20261014.tar`. These exclude runtime DB and media. |
| 2026-10-13T20:31:55Z | 0m02s | START host=ovhe shop=prinscosmetic.eu dashboard=prinscosmetic.eu/sillagedash images=/sillagedash skip_build=1 wordpress=1 |
| 2026-10-13T20:31:56Z | 0m03s | Public IP 139.99.61.71 |

| 2026-10-13T20:38Z | User reported blank `/sillagedash`; traced dashboard base URL and static-asset routing. | Root cause: assets built for `/` while service is mounted under `/sillagedash`. |
| 2026-10-13T20:40Z | Added local Vite build at `VITE_BASE_PATH=/sillagedash/`, persistent `/app/web/dist` bind mount, and upload step to replication script. | Future builds use a laptop-generated dashboard bundle and keep it across container recreation. |
| 2026-10-13T20:43Z | Built dashboard locally (2.46s), uploaded bundle and compose config, recreated core + cron. | Build completed; dashboard dist is bind-mounted from `~/sillage/sillage-core/web/dist`. |
| 2026-10-13T20:45Z | VPS smoke checks: local dashboard HTML, public dashboard HTML, JS asset, API route, service health. | HTML 200, JS 200, API 401 when unauthenticated (expected), database up. Laptop DNS lookup for public hostname failed. |

| 2026-10-14 03:05 +0600 | User still saw white dashboard; Chromium confirmed the page stayed in a bare session-check state and the auth probe was triggering a full-page reload on `/me` 401. | Diagnosis: browser session-check/reload UX, not missing files or Caddy routing. |
| 2026-10-14 03:05 +0600 | Rebuilt Sillage dashboard on laptop with `/sillagedash/`, changed `/me` 401 to in-app auth navigation, added centered pending-session card with a direct sign-in link; uploaded to `ovhe`. | New JS asset referenced by live HTML; Chromium render shows the branded card and sign-in action. |

| 2026-10-14 03:08 +0600 | Compared `ovhe` with working `ovh`; found the exact `/sillagedash` (without slash) URL returned HTTP 200 with an empty body, while `/sillagedash/` returned the SPA. | Earlier checks tested slash variant only and missed the user’s exact URL. |
| 2026-10-14 03:08 +0600 | Updated Caddy dashboard matcher and reinstalled managed site. | `/sillagedash` now responds 308 to `/sillagedash/`; `/sillagedash/`, `/login`, `/sync` return the SPA; JS asset returns 200. |

## 2026-10-14 dashboard secrets, image host, and sync check

| UTC | Action | Result |
|---|---|---|
| 2026-10-13T21:15Z | Recreated OVHE `sillage-core` and `sillage-cron` so the overlay bind mount sees dashboard writes. Transferred the three allowlisted OVH vendor values through SSH and submitted them via OVHE dashboard `PUT /api/secrets`. | Dashboard readback reports BEAUTYFORT_USER, BEAUTYFORT_SECRET, BTS_JWT_TOKEN set from overlay; values excluded from logs. |
| 2026-10-13T21:15Z | Installed `images.prinscosmetic.eu` proxy to OVHE media service. Saved `IMAGES_DOMAIN`, `LPS_MEDIA_BASE_URL`, and dashboard `image_cdn_base_url`. | Caddy validated/reloaded; dashboard readback is `https://images.prinscosmetic.eu`; a copied JPG returns HTTPS 200. Image root intentionally returns 404 because directory listing is disabled. |
| 2026-10-13T21:15:36Z | Dashboard preflight and manual full sync start (`source=live`). | HTTP 200; started=true; all three secret statuses set. |
| 2026-10-13T21:15:41Z | Stopped the manual run through dashboard `POST /api/sync/stop` after 5 seconds. | HTTP 200; run 1 logged `SyncAbortedError: sync aborted from dashboard`; zero products fetched; abort was expected from the requested stop. `sync_enabled=0`, `full_sync_enabled=0`, orders dry-run remains on and auto-dispatch off. |

## Future scripted replication runs

New run steps are appended here as well as to the ignored local `.deploy/` log. Do not record
credential values.

| UTC | Step | Elapsed | Result |
|---|---|---:|---|
| 2026-10-14 | Caddy cleanup | — | Removed copied Caddy files for unrelated apps and the duplicate installer/template; `deploy-vps.sh` is the single generator and its output remains editable on the VPS. |
| 2026-10-14 | Rebuild docs and media URLs | — | Added this tracked chronology and current clean VPS guide; changed 1,088 old image override URLs to the `images.prinscosmetic.eu` hostname root after confirming all filenames exist on OVHE. |
| 2026-10-14 | Removed unsupported clone path | — | Deleted dead `--clone-from` branches from deploy code; new VPS setup is fresh, with optional media-only copy. |
| 2026-10-14 | Generic VPS inputs and setup cleanup | — | Removed hard-coded VPS aliases from reusable scripts/docs; replication and image-setting scripts now require explicit targets, and code shipping requires `--to`. Historical entries above remain named to preserve the actual run record. |
| 2026-10-14 | Setup failure feedback loop | — | Replication records failed step, elapsed time, and exit code automatically; NEW-VPS-PLAN requires the durable fix and updated script/doc to be committed to the project workflow (commit remains owner-controlled). |

## 2026-10-14 catalogue rebuild and storefront recovery

| UTC | Action | Result |
|---|---|---|
| 2026-10-13T22:20:00Z | OVHE scheduled full catalogue rebuild started (`runId=2`, source=live). | Finished successfully in 409.3s: BeautyFort fetched 9,209, BTS fetched 44,414, 51,291 products created, 51,291 prices written, zero row-level errors. The WordPress finalize request timed out after 120s, so caches could remain stale. |
| 2026-10-13T22:27Z | Investigated MariaDB at ~198% CPU after the rebuild. | The sync containers were idle. Three multi-minute WordPress reads were active: two warehouse-country metadata joins and one WooCommerce product listing. Cancelled those read queries; MariaDB dropped to ~0.01% CPU and the WordPress container became idle. Do not start a second rebuild to address this symptom. |
| 2026-10-13T22:30Z | Compared OVH/OVHE overview hide counts and offer state. | OVHE has 51,291 imported products; its primary offers are almost all active (15,598 out of stock). OVH has 55,444 product rows and 3,461 primary-offer links to vanished feed rows, which are treated as out of stock. Current thresholds and hide-without-image settings match. The count difference is consistent with stale OVH rows/offer links; it does not by itself prove a visibility-rule regression. |
| 2026-10-13T22:33Z | Reproduced the shop on `prinscosmetic.eu`. | Category filters and product cards load after the stalled database reads stop. First-visit country map request fails on the cold post-sync path; `DeliveryGate` treated that API failure as permission to skip the country choice, and the header picker had no list. |
| 2026-10-13T22:34Z | Updated local React storefront `DeliveryGate` and `LocaleSwitcher` to use the bundled delivery-country snapshot when the live map is unavailable. Removed named VPS/domain defaults from the React deployment tool and target-specific live-server details from its deployment guide. | Lint/build completed (existing warnings remain). Deployed React bundle to OVHE after making backup `dist.backup-20261014-043456`. No database or product data was copied. |
| 2026-10-13T22:35Z | Reloaded `/shop` on the deployed storefront. | Required “Where should we deliver?” dialog is visible with searchable countries; category filters are populated behind it. MariaDB remains at ~0.01% CPU, with no multi-second queries. |
| 2026-10-13T22:38Z | Added a managed `wp_postmeta(meta_key(191), post_id)` index to `sillage-warehouses`; the deployment tool applies it even when the plugin was already active, and plugin activation applies it on a new VPS. | Database reports the index present. `EXPLAIN` now uses the composite index for all three metadata joins and estimates one row per key lookup; MariaDB remains below 0.1% CPU. |
| 2026-10-14T22:44Z | Reviewed the catalogue response cache after the CPU incident. | Found cold-cache requests did not take the rebuild lock, so concurrent visitors could all execute the same expensive WooCommerce catalogue query. Added a bounded lock wait: stale cache remains served during refresh; on a truly cold cache, followers wait up to two seconds for the first result before querying. |
| 2026-10-14T22:44Z | Shipped the warehouse plugin through the laptop deployment workflow to OVHE. | Backup `sillage-warehouses-20261014-044435` created; remote `php -l`, plugin activation state, and managed postmeta index check passed. Live routes `/`, `/shop`, `/brands`, `/search`, `/cart/`, `/checkout/`, and `/account` returned HTTP 200. |
| 2026-10-14 | Reproduced the missing home products with Netherlands selected. | `/wp-json/sillage/v1/delivery` returned HTTP 200 with empty `countries`/locations. Product metadata was present for 51,291 imported products; warehouse JSON includes `NL`. Root cause: the delivery-country transient/object-cache held an empty map from before import, and the manual “Clear country cache” action only invalidated catalogue responses, not this map. |
| 2026-10-14 | Fixed country-cache invalidation and cold-load behavior. | Manual cache clear and sync completion now clear both Redis and transient country-map entries. Store API brands are cached; simultaneous cold catalogue misses are coalesced with a retryable response. React retries safe reads, caps taxonomy fetch concurrency at two, runs homepage “Most loved” then “New in” sequentially, and only uses the country snapshot when the live map is still loading or unavailable. HTTPS delivery-country cookies now carry `Secure`. |
| 2026-10-14 | Added a reversible capacity test switch in WordPress → WooCommerce → Warehouses. | **Cold-query coalescing** defaults On — balanced; Off leaves response caching enabled but permits concurrent misses for controlled testing on a stronger VPS. Instructions added to OPERATOR-DASHBOARD.md and CLIENT-GUIDE.md. |
| 2026-10-14 | Refreshed React catalogue cache namespace from v3 to v4 after the empty country-map incident. | Browsers discard the saved zero-count snapshot and fetch the repaired live map/catalogue. |
| 2026-10-14 | Live browser showed Most loved restored, but category rail and New in still absent during cold-cache contention. | Identified home `useCategories()` was loading every category and brand page (up to 20 pages each) just to render three top-level tiles. Replaced it with one `parent=0` category request plus the cached country-count map. |
| 2026-10-14 | Rebuilt and deployed React from the laptop to OVHE. | VPS backup created at `~/sillage/frontend/dist.backup-20261014-045611`; build passed. Browser verified three category tiles and four Most loved products after warm-up. |
| 2026-10-14 | Reduced React homepage/header catalogue fan-out. | Header now fetches only top-level departments; brand pages load only when opened; closed menus no longer request featured products. Shared home-category request is country-scoped. This removes dozens of taxonomy requests and a duplicate popularity request from initial page load. |
| 2026-10-14 | Deployed final laptop-built React bundle to OVHE. | Backup `dist.backup-20261014-050056`; live browser with Netherlands selected shows Parapharmacy, Drugstore, Makeup category tiles and products in both home rows. Catalogue reads now avoid the full brand/category page fan-out on initial render. |
| 2026-10-14 | User reported translated department names, unstable Shop All product tiles, zero brands, and homepage product rows missing after choosing a country in private browsing. | React now uses a 12-entry English Shop All list, brands-only loading on the Brands page, lazy featured-menu requests with bounded retries and a finite empty state, and country-scoped product reads. Laptop build/deploy and live-browser verification follow in the React repository. |

| 2026-10-14 | User reported intermittent missing categories/brands and product rows appearing after several seconds. | Live browser showed `0 brands`; read-only public Store API checks returned HTTP 503 for both brands and top-level categories, then brands returned HTTP 200 with 1,487 total after the cold cache finished warming. This is the source of the intermittent UI failure, not missing catalogue terms. |
| 2026-10-14 | Fixed React recovery for empty taxonomy snapshots and country changes. | Empty brand snapshots are discarded instead of being treated as valid 24-hour cache entries; empty catalogue snapshots are not persisted; the Shop taxonomy hook now reloads when the active delivery-country scope changes. Lint/build passed and the frontend was deployed from the laptop; backup: `dist.backup-20261014-052349`. |
| 2026-10-14 | Fixed cold-cache request coalescing behavior. | Increased the bounded follower wait from 2 to 6 seconds so a visitor waits for the single in-flight WooCommerce catalogue query/cache fill instead of receiving repeated 503s during normal cold starts. Stale cache is still returned immediately when available. Laptop plugin deployment and live cold-cache verification follow. |
| 2026-10-14 | Follow-up isolated the slow brand request. | Public Store API `products/brands?hide_empty=true` still returned 503 after the six-second coalescing window; the same endpoint with `hide_empty=false` returned HTTP 200 in 0.42s. WooCommerce's `hide_empty=true` brand count is the slow cold-query path. |
| 2026-10-14 | Changed the React brand index to fetch fast taxonomy pages and filter out zero-count brands in the browser. | The brand list still excludes empty brands, streams active terms while pages load, and keeps a 24-hour country-scoped cache. Cache namespace bumped to v2 so prior empty entries cannot persist. Frontend laptop build/deploy and live UI verification follow. |
| 2026-10-14 | Live browser check found Shop All still showed “Loading…” because its product request waited for the full category tree and all brand pages. | Changed Shop All to load only top-level departments first and start product requests independently of the brand directory; a brand-specific URL still waits for the selected brand to resolve. Frontend laptop build/deploy follows. |
| 2026-10-14 | Reproduced country-scoped taxonomy errors and corrected the customer flow. | `categories?hide_empty=true` returned 503 after six seconds for NL; the same root terms with `hide_empty=false` returned 200 in 1.2s. React now uses the fast category path and filters with the cached counts. Home categories, Most loved, and New in load before country choice; those global merchandising rows are not refetched after selection. Country selection updates the cookie/state without a full-page reload; shop/product results remain country-scoped. |
| 2026-10-14 | Fixed background page scroll under the country picker. | Body and document scrolling are locked together, body position is fixed while the picker is open, and the original scroll offset is restored on unlock. |
| 2026-10-14 | Live verification caught stale empty-state references after removing country gating from homepage rows. | Replaced the obsolete `hasCountry` checks; rebuild and redeploy, then verify the public homepage for runtime errors and loaded rows. |
| 2026-10-14 | Final laptop-built frontend deployed to OVHE; backup `dist.backup-20261014-053124`. | Live browser verified the homepage has no runtime error, shows the curated department tiles and four products in both merchandising rows; live `/shop` showed departments, brand filters, products and pagination after the first request. The homepage loaders are independent of country state, and selecting a country no longer triggers a full page reload. |
| 2026-10-14 | Wrote the repeatable customer-arrival sequence in the frontend deployment guide. | Documented preload → locked country choice → in-place transition → country-scoped shop/checkout, plus brand/shop loading behavior and manual refresh expectations. |
| 2026-10-14 | Preserved the complete country-visible brand index after measuring the fast fallback. | Live `hide_empty=false` returns 943 nonzero-count terms; the authoritative warmed `hide_empty=true` endpoint returns 1,487. React now streams the fast list while the complete list loads, replaces it on success, and only caches a complete result. A failed cold full-list request no longer blocks the rest of the shop or persists the smaller fallback. |
| 2026-10-14 | Live verification caught brand entries duplicated while fallback and authoritative pages were streamed into one page map; the browser's existing v3 cache retained that merged list. | Kept fallback pages as a quick interim display, stopped streaming authoritative pages into that page map, and now atomically replace fallback data when the complete request resolves. Bumped the brand-index cache to v4 to discard prior merged entries. Laptop lint/build passed; OVHE frontend backups `dist.backup-20261014-053422` and `dist.backup-20261014-053441` were created during the two deployments. Live `/brands` now reports 1,487 brands with no repeated page groups. |
| 2026-10-14 | Live inspection showed legacy `/lps-media/<filename>` image URLs still resolved on the shop hostname, despite the configured image subdomain. | Normalize legacy self-hosted media to `https://images.prinscosmetic.eu/<filename>` at the hostname root, serve those images directly from the dedicated host, and keep them out of the WordPress image-proxy rewrite. Added stable fallback routes for Women, Men, and Gifts when the taxonomy API omits terms. |
| 2026-10-14 | Search overlay category list omitted Gifts and showed inconsistent categories; product tiles started images lazily and several proxy image URLs were broken. | Use the fixed eight English departments (including Men and Gifts) in a three-column layout; request visible search tile images eagerly; preserve original media URLs and fall back to them on image service errors; omit products with no image from popular recommendations. The public catalogue response cache is now one hour for product price/stock and 24 hours for taxonomy, with cold-cache follower waits reduced from six seconds to two. Frontend and plugin deployment/verification recorded below. |
| 2026-10-14 | Follow-up confirmed the screenshot should keep its compact chips, and Greece must retain Women with a zero count. | Changed Popular categories to the existing wrapped chip style with Men and Gifts on the third row. Shop now merges country-specific catalogue counts without filtering out zero-count curated departments; missing terms resolve to zero-result routes. The search drawer reuses the one-hour shared homepage product loader instead of issuing a duplicate query, and New in excludes Most loved IDs. |
| 2026-10-14 | Final OVHE frontend deployed; backup `dist.backup-20261014-055350`. Warehouse plugin backup `sillage-warehouses-20261014-054620`. | Laptop lint/build passed and the deployment script backed up before sync. Remote PHP syntax check passed; warehouse plugin remained active and its metadata cache refresh completed for 28 countries. Live browser showed Most loved and distinct New in products; Search showed all eight chips in three wrapped rows and loaded popular product images. Direct `https://images.prinscosmetic.eu/8435415082686.jpg` returned the image. |
| 2026-10-14T00:02Z | Follow-up found the Women mega-menu could resolve the first category page instead of the actual category because the Woo Store API ignores `slug`; this allowed an unrelated product to appear. Also flattened the Women/Damen source term in the storefront taxonomy. | Public API confirms exact search `Damen` returns term ID 22 and Netherlands-scoped product results under that ID are Women products. Frontend now uses exact `search` matching for term resolution, never issues an unfiltered fallback, keeps department menus flat, uses stable `Search brands`, and bumps the catalog cache to v8. |
| 2026-10-14T00:02Z | Corrected frontend deployed to OVHE; backup `dist.backup-20261014-060221`. | Scripted lint/build and backup/sync passed. Live `/shop/women` now resolves 1,398 products and shows women’s products; the previous v7 browser category cache is discarded. |
| 2026-10-14T00:04Z | Fixed hover-menu recovery and added cross-repo operations handoff; frontend backup `dist.backup-20261014-060450`. | Featured results now persist only when nonempty, keyed by country/category, with a one-hour freshness window. Cold-cache errors retain cached tiles or loading animation and retry every five seconds; no unrelated-product fallback. Lint/build and scripted backup/sync passed. Live Women page shows 1,398 products. Added `docs/STOREFRONT-OPERATIONS.md` and linked it from the Sillage README; the backend cache-guard behavior and targeted plugin deploy sequence are documented there. No backend code change was needed for this retry fix. |
| 2026-10-14T00:06Z | Final hover/search-label build deployed to OVHE; backup `dist.backup-20261014-060610`. | Brand-menu search now shows a stable settled count (example `Search 1,487 brands`) only after the full/fallback index settles; streamed pages do not animate the number. Frontend lint/build and scripted backup/sync passed. The cross-repo handoff guide and frontend deploy guide document cache keys, freshness, retry behavior, code locations, and deployment order. |

| 2026-10-14 | User reported 30-second hover waits and a changing brand prompt. | Frontend now warms Shop All and department featured products after country selection using two concurrent workers, reduces each featured query to eight image-bearing candidates, and retries a transient menu failure every second. Header and Brands page show the neutral `Search brands` prompt while loading, then the exact settled count without animation. Lint/build passed; deployment created final backup `dist.backup-20261014-061310` (earlier iterations were backed up as `dist.backup-20261014-061138` and `dist.backup-20261014-061230`). OVHE verification returned HTTP 200 for `/`, `/shop`, `/brands`, `/search`, `/cart/`, `/checkout/`, and `/account`; Shop first-page images were 24 files / 0.11 MB. |

| 2026-10-14 | User clarified that homepage Most loved/New in products must respect the selected delivery country because availability differs (for example, Poland). | Home product caches are now keyed per country; both rows fetch with `sillage_country`, and changing the dropdown swaps to that country's cached rows or reloads in place without showing the previous country's products. The search drawer bestseller rail follows the same country scope. Deployed to OVHE with backup `dist.backup-20261014-061451`; verification returned HTTP 200 for all configured routes and the Shop image budget passed (24 files / 0.11 MB). |

| 2026-10-14 | User reported homepage Most loved showed “Products are temporarily unavailable” and clarified that the brand count must be real. | Fixed the homepage loader so transient API failures remain retryable rather than becoming a cached-looking empty state; home sections retain skeletons and retry every second until a response succeeds, while true empty results get country-specific copy. Brand search no longer uses a hardcoded 1,500; it shows `Search brands` while loading and the exact count from the settled index. Lint/build, deploy, and live route verification follow. |
