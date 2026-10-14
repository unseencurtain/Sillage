# WordPress plugins (Sillage)

Source for the WordPress plugins that run beside WooCommerce. (An earlier version of this file
named the stale domain `dash.mirainikki.xyz`.)

| Folder | Purpose | Live state |
|---|---|---|
| `headless-core` | API hardening, CORS allowlist, optional redirect | Installed on the `ecom` box (verified 2026-10-14) |
| `headless-woocommerce` | Store API rate limit, admin API block, frontend cart links | Installed on the `ecom` box (verified 2026-10-14) |
| `purelymail-smtp` | Encrypted SMTP for WordPress/WooCommerce mail | Installed on the `ecom` box (verified 2026-10-14); needs credentials |
| `storefront-ean` | EAN lookup and catalogue endpoints for the storefront | Source retained; the retail box currently runs `sillage-storefront` instead — confirm before removing |
| `sillage-storefront` | Storefront catalogue/EAN endpoints | Installed on the `ecom` box (verified 2026-10-14) |
| `sillage-warehouses` | Location A/B rules: country scope, shipping per location, order line meta | Live on the `ecom` box (verified 2026-10-14) |

**None of these are dead weight** — `headless-core` and `headless-woocommerce` are also copied and
activated by the `ops/test/` harness. An earlier guess that they were legacy/superseded was wrong.

`sillage-bridge` stays at `production-environment/ecom_sites/data/wp/wp-content/plugins/sillage-bridge`
because Docker mounts that path into the `ecom` container.

Customer-facing text never names a warehouse. Internal vendor slugs stay server-side.
