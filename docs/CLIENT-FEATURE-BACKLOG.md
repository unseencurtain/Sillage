# Client feature backlog

Source: client chat (`chat-with-client.md`, Aug 2026) + vendor feed handoff (Aug 2026).

| Priority | Item | Notes |
|---|---|---|
| P0 | Missing product photos (`no_image` / placeholders) | BeautyFort-heavy. Python EAN→URL → `sillage-core/data/image_overrides.json`. **Ocean XML photos wired** (`enrich.py --fetch-ocean --install-core`). Then fast/rewrite sync. |
| P0 | Theme compatibility (Astra / Blocksy / Elementor) | Bridge attachment filters (see `sillage-bridge`). |
| P1 | Rename shop sections to **LPS01** (BTS) / **LPS02** (BeautyFort) | Keep separate categories; less “supplier” naming. |
| P1 | Vendor **wholesale-perfumes.eu** (full catalogue + orders) | Feeds documented in [`docs/vendors/ocean-brasty-notes.md`](vendors/ocean-brasty-notes.md). Images already used offline. |
| P1 | Brasty **Playwright image scrape** | CSV has no images; see operator `beastly-image.md`. |
| P2 | Vendor **wholesale.brasty.com** (full catalogue + orders) | Watermarked photos; MOQ; shipping 26 kg/box. |
| P2 | Tiered retail markup | e.g. cost ≤ €80 × 1.7, > €80 × 1.5 — settings-driven. |
| P2 | Cart minimum / small-order surcharge | Foodpanda-style fee under threshold. |
| P3 | B2B / higher-MOQ lane | Separate section or mode; UX TBD. |

## Image pipeline (operator)

```bash
cd production-environment/python-analysis
cp .env.example .env   # set OCEAN_USER + OCEAN_TOKEN (API token from their portal)
python3 beautyfort-enriched/enrich.py --fetch-ocean --install-core
# Then on the shop: fast sync / rewrite so product meta picks up new URLs
```

## Out of scope until scheduled

Full Ocean/Brasty Bun connectors, MOQ pricing, LPS rename, Brasty Playwright — listed above.
