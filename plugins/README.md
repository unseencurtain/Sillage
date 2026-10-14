# WordPress plugins (Sillage)

Source for the WordPress plugins that run beside WooCommerce. (An earlier version of this file
named the stale domain `dash.mirainikki.xyz`.)

| Folder | Purpose | Live state |
|---|---|---|
| `headless-core` | API hardening, CORS allowlist, optional redirect | Installed on the `ecom` box (verified 2026-10-14) |
| `headless-woocommerce` | Store API rate limit, admin API block, frontend cart links | Installed on the `ecom` box (verified 2026-10-14) |
| `purelymail-smtp` | Encrypted SMTP for WordPress/WooCommerce mail. **Portable and store-agnostic** — no branding, notices or hostnames | Active on the `ecom` box; **fails closed** — no saved SMTP connection blocks all WordPress email |
| `storefront-legal-notice` | Adds the EU legal-guarantee notice to customer order emails | Active on the `ecom` box. Separate from the SMTP plugin so the SMTP plugin can be reused without it |
| `storefront-ean` | EAN (barcode) lookup only: `/cereve/v1/ean/{ean}` + `/cereve/v1/products/{id}/ean` | **Live** on the `ecom` box. EAN-only by design — catalogue/counts/delivery stay in `sillage-warehouses` |
| `sillage-storefront` | Storefront image proxy: `GET /sillage/v1/img?src=&w=` | Installed on the `ecom` box (verified 2026-10-14) |
| `sillage-warehouses` | Location A/B rules: country scope, shipping per location, order line meta | Live on the `ecom` box (verified 2026-10-14) |

**None of these are dead weight** — `headless-core` and `headless-woocommerce` are also copied and
activated by the `ops/test/` harness. An earlier guess that they were legacy/superseded was wrong.

`sillage-bridge` stays at `production-environment/ecom_sites/data/wp/wp-content/plugins/sillage-bridge`
because Docker mounts that path into the `ecom` container.

Customer-facing text never names a warehouse. Internal vendor slugs stay server-side.
