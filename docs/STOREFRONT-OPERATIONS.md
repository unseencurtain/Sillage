# Headless storefront: code map and operations

This guide is the handoff map for the React storefront and the Sillage WordPress/WooCommerce
backend. The detailed chronological run log is in [`DEPLOYMENT-CHRONOLOGY.md`](DEPLOYMENT-CHRONOLOGY.md).
Do not copy a live database to reproduce the application; the runtime and deployment scripts are the
source of truth.

## Repositories and responsibilities

| Area | Repository/path | Responsibility |
|---|---|---|
| Public React storefront | `react_store/frontend/` | Home, shop, search, country picker, product pages, cart and checkout UI |
| WooCommerce integration | `Sillage/plugins/sillage-warehouses/sillage-warehouses.php` | Country availability, category counts, public catalogue response cache, query coalescing and shipping metadata |
| Site/runtime configuration | `Sillage/production-environment/` | Docker Compose, Caddy, WordPress, image service, VPS setup and update scripts |
| Repeatable deployments | `react_store/frontend/tools/sillage-deploy.ts` | Builds on the laptop, makes timestamped backups, syncs selected frontend/plugin artifacts and verifies services |

The public site is a React SPA. WordPress is headless and provides Store API/WP REST, account/admin,
cart and checkout services. Caddy routes the site and the dedicated `images.prinscosmetic.eu`
hostname. Product image files are served from the media mount at the image hostname root.

## Storefront code map

- `src/shared/lib/woo.js`: Store API requests, country cookie, retries, product normalization and image URL rules. Category search uses the Store API `search` parameter; do not use its ignored `slug` parameter to resolve category terms.
- `src/shared/lib/catalog.js`: curated flat department navigation, category/brand indexes, country-keyed product loaders and caches. The live Women department is source term `Damen` (currently ID `22`), which WooCommerce nests under `Duft`; the storefront sets its presentation parent to zero and keeps the selected term ID for product queries.
- `src/features/layout/components/Header.jsx`: hover menus, featured tiles, brand search. A category query must include the resolved category ID and delivery country. Never fall back to an unfiltered product request.
- `src/features/catalog/pages/Shop.jsx`: collection route and country-specific filters/counts. Curated departments are listed flat, including zero-count departments.
- `src/features/search/components/SearchOverlay.jsx`: compact popular-category chips and shared popular products.
- `src/features/catalog/pages/Home.jsx`: home merchandising rows.
- `src/features/layout/components/chrome.js`: menu geometry and responsive styling.
- `DEPLOYMENT.md`: customer flow, cache rules, deployment workflow and troubleshooting notes.

The storefront intentionally exposes a small English department set instead of mirroring the full,
deep, multilingual supplier taxonomy. This is presentation-only: product-category IDs remain intact
for WooCommerce queries. Do not delete or reassign source terms as a way to flatten the UI.

## Customer data flow and freshness

1. On arrival, shared homepage categories and current-country Most loved/New in products begin loading; if no country is known, an initial general result may display under the country dialog.
2. Country choice writes the `sillage_country` cookie and updates React state in place. It does not reload the page.
3. Shop listings, category counts, featured hover products, and homepage Most loved/New in all use that country. Changing country refreshes both homepage rows in place; their one-hour browser cache is keyed by country.
4. Shop product responses and featured hover data are fresh for one hour, matching the configured stock/price sync. Category and brand taxonomy data is cached for 24 hours.
5. The hover cache stores only successful, nonempty featured products, keyed by country and category ID. After country selection, two bounded background workers warm the featured tiles for Shop All and each department before first hover; transient failures keep valid tiles or their loading animation and retry after one second. It must not show an unfiltered department's products or convert a temporary 503 into an empty/unavailable state.
6. A manual refresh may reuse the valid featured cache for up to one hour. A new country or category uses a different key.
7. Brand search shows `Search brands` while its index is loading, then a settled label such as `Search 1,487 brands`. Do not show page-by-page counts or animate a rolling number.

The backend warehouse plugin provides the country-aware category counts and extends product reads
with warehouse scope. Its public Store API response guard keeps product results fresh for one hour,
taxonomy results for 24 hours, serves stale data during refresh, and coalesces cold requests. On a
true cold cache, followers can receive a retryable 503 after the bounded two-second wait. The
frontend must continue retrying those safe reads; do not disable the guard or fan out requests to
every category, because that can recreate the MariaDB CPU spike.

## Images, CORS and security

- Self-hosted product images use `https://images.prinscosmetic.eu/<filename>` at the hostname root. Do not emit `/lps-media/` on the storefront host or add another `/images/` path segment.
- The image host is configured in Caddy and the media service; preserve the editable deployment config rather than hand-editing the VPS.
- Keep WordPress REST and checkout same-origin through Caddy. Do not add wildcard credentialed CORS. Keep API credentials and `.env` values out of the repositories and chronology.
- Product images are public files. Cart tokens, WordPress nonces and account data are not part of the catalogue cache.

## Change and deployment sequence

Run from `react_store/frontend/`, using the existing local SSH alias/config and the intended site URL:

```sh
SILLAGE_SSH_HOST=<target-alias> \
SILLAGE_SSH_CONFIG=<ssh-config-path> \
SILLAGE_SITE=<https-site-url> \
npm run deploy:frontend
```

This runs lint and a production build on the laptop, creates `dist.backup-<timestamp>` on the target,
then syncs the built app. The compiled laptop app is what gets served. Do not edit generated files on
the VPS.

For a managed plugin change, target only the plugin being changed:

```sh
SILLAGE_SSH_HOST=<target-alias> \
SILLAGE_SSH_CONFIG=<ssh-config-path> \
SILLAGE_SITE=<https-site-url> \
SILLAGE_PLUGINS=sillage-warehouses \
npm run deploy:plugins
```

The plugin deployment backs up the live plugin, syncs it, runs remote `php -l`, and verifies its
activation. Use the combined deploy only when both layers changed and their order is intentional.
The target alias, site and SSH config are runtime inputs; never bake a VPS name/IP into reusable
scripts.

After each change:

1. Record the reason, code paths, order, target backup name, and result in `DEPLOYMENT-CHRONOLOGY.md`.
2. Verify the changed customer flow on the deployed site. For department hover issues, check the exact
   category ID returned by `GET /wp-json/wc/store/v1/products/categories?search=Damen` and confirm
   `GET /wp-json/wc/store/v1/products?category=<id>&sillage_country=<country>` returns products
   whose `categories` include that ID.
3. Confirm the menu stays flat, its four tiles belong to the selected category, images load from the
   image hostname, and the selected-country shop route/count is correct.
4. Keep the backup until the owner has reviewed the live change. Do not commit or push without the
   owner's requested review point.

## Current Women category reference

The exact category search `search=Damen` currently returns ID `22`. A Netherlands-scoped popularity
query for category `22` returns Women products, including Jean Paul Gaultier Divine, Coach Love,
DKNY Be Delicious, and Puma Woman. `search` is required because a `slug=damen` request is ignored by
the Store API and may return the first page of unrelated terms. The React cache namespace is
`cosmetic.catalog.v8`; bump it when the persisted catalogue shape or term mapping changes.
