# Client feature backlog

Source: client chat (`chat-with-client.md`, Aug 2026). Priorities for work after the
BeautyFort image + theme compatibility slice.

| Priority | Item | Notes |
|---|---|---|
| P0 | Missing product photos (`no_image` / placeholders) | BeautyFort-heavy. Offline Python EAN→URL map → `sillage-core/data/image_overrides.json`. After regenerating overrides, run a fast/rewrite sync so `_external_thumbnail_url` updates on WooCommerce. |
| P0 | Theme compatibility (Astra / Blocksy / Elementor) | Bridge serves vendor CDN URLs via attachment filters so themes/page builders do not need custom templates. |
| P1 | Rename shop sections to **LPS01** (BTS) / **LPS02** (BeautyFort) | Keep separate categories; reduce “supplier” naming in the shop UI. |
| P1 | Vendor **wholesale-perfumes.eu** (Ocean / LovelyXml) | Catalog XML + stock/price XML; good photos; MOQ. Feeds: `/xml/catalog/LovelyXml/en`, `/xml/store/LovelyXml/EUR`. Cart/order REST under `/api/v1/`. |
| P2 | Vendor **wholesale.brasty.com** | Product photos carry a watermark; client may later want LPS logo overlay on all images. |
| P2 | Tiered retail markup | Example discussed: cost ≤ €80 × 1.7, cost > €80 × 1.5. Should live in settings, not hardcoded forever. |
| P2 | Cart minimum / small-order surcharge | Foodpanda-style: allow checkout below threshold with an extra fee, or nudge to add more items. |
| P3 | B2B / higher-MOQ lane | Separate section or mode for larger orders; UX still TBD with client. |

## Image pipeline (operator)

```bash
cd production-environment/python-analysis
python3 beautyfort-enriched/enrich.py --install-core
# Then on the shop: fast sync / rewrite so product meta picks up new URLs
```

Large vendor fixtures under `beautyfort-enriched/products/*.json` are local inputs (not required
in the Bun runtime). The Bun app only needs `sillage-core/data/image_overrides.json`.

## Out of scope until scheduled

New vendor connectors, MOQ pricing, LPS rename — listed above only until a dedicated PR.
