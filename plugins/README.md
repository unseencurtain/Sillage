# WordPress plugins (Sillage)

Source for the WordPress plugins that run beside WooCommerce on `dash.mirainikki.xyz`.

| Folder | Purpose | Live state |
|---|---|---|
| `headless-core` | API hardening, CORS allowlist, optional redirect | Not installed |
| `headless-woocommerce` | Store API rate limit, admin API block, frontend cart links | Not installed |
| `purelymail-smtp` | Encrypted SMTP for WordPress/WooCommerce mail | Not installed (needs credentials) |
| `storefront-ean` | EAN lookup and catalogue endpoints for the storefront | Live as `storefront-ean-api` |
| `sillage-warehouses` | Location A/B rules: country scope, shipping per location, order line meta | Not installed |

`sillage-bridge` stays at `production-environment/ecom_sites/data/wp/wp-content/plugins/sillage-bridge`
because Docker mounts that path into the `ecom` container.

Customer-facing text never names a warehouse. Internal vendor slugs stay server-side.
