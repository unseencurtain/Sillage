# Client feature backlog

Source: client chat (`chat-with-client.md`, Aug 2026) + vendor feed handoff (Aug 2026).

| Priority | Item | Notes |
|---|---|---|
| P0 | Missing product photos (`no_image` / placeholders) | **Done (stage 3):** cross-vendor EAN fill on full+fast sync; `hide_products_without_image` (default on) excludes unresolved placeholders. Overrides still via `image_overrides.json` / Ocean enricher. |
| P0 | Theme compatibility (Astra / Blocksy / Elementor) | Bridge attachment filters (see `sillage-bridge`). |
| P1 | Rename shop sections to **LPS01** (BTS) / **LPS02** (BeautyFort) | **Done (stage 3):** `sil_vendors.storefront_label`; root `product_cat` renamed in place. SKU prefix / slug formula unchanged. |
| P1 | Vendor **wholesale-perfumes.eu** (full catalogue + orders) | **Done (connector):** slug `ocean`, sku `OC`, LPS03, migration 013 (inactive). Confirm MOQ / countries / VAT / cart `code` before enable. See [`docs/vendors/ocean-brasty-notes.md`](vendors/ocean-brasty-notes.md). |
| P1 | Brasty **Playwright image scrape** | Image source only (EAN → `image_overrides.json`). Tool: `tools/brasty-images/`. See operator `beastly-image.md`. |
| P2 | ~~Vendor **wholesale.brasty.com** (full catalogue + orders)~~ | **Dropped.** Brasty is photos-only; no catalogue/order connector. |
| P2 | ~~Brasty shipping rules (26 kg/box, pallet >120 kg)~~ | **Dropped.** Kept as reference in [`ocean-brasty-notes.md`](vendors/ocean-brasty-notes.md); not wired. |
| P2 | Tiered retail markup | **Done (stage 3):** `sil_settings.price_tiers` JSON; dashboard editor; empty `[]` keeps single multiplier. |
| P2 | Cart minimum / small-order surcharge | **Done (stage 3):** Foodpanda-style fee under global / per-vendor minimum; dashboard knobs default off; bridge adds fee + “add X more” notice. |
| P3 | B2B / higher-MOQ lane | Separate section or mode; UX TBD. |

## Image pipeline (operator)

```bash
cd production-environment/python-analysis
cp .env.example .env   # set OCEAN_USER + OCEAN_TOKEN (API token from their portal)
python3 beautyfort-enriched/enrich.py --fetch-ocean --install-core
# Then on the shop: fast sync / rewrite so product meta picks up new URLs
```

## Out of scope until scheduled

Brasty catalogue/order connectors and shipping rules are dropped (image source only).
Brasty Playwright bulk download remains P1 above. Ocean is implemented but seeded
inactive pending operator confirmation of MOQ, countries, VAT, and cart `code`.
