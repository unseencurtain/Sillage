# B2B wholesale — parked for its own site

Operator decision: **decouple B2B onto its own website.** This folder is the parking lot for
wholesale-perfumes / SoleLuna work that must not live in the main LPS retail mental model.

## What this storefront is *not*

The main Sillage + cosmetic shop (`cosmetic.slilverbelt.xyz` / this repo’s WordPress site) sells
**BeautyFort + BTS only**. Wholesale-perfumes products must not appear on `/shop`, search, or a
`/b2b-wholesale/` page on that site.

## What’s here

| Path | Purpose |
|---|---|
| `docs/wholesale-perfumes-api.md` | Sanitized cart/order API notes (no secrets) |
| `sillage-vendor/README.md` | Pointers to the connector still living in sillage-core |
| This README | Scaffold for a future separate WP / compose project |

## Connector status in main sillage-core

Implementation remains in git under:

- `production-environment/sillage-core/src/vendors/wholesale-perfumes/`
- `production-environment/sillage-core/src/orders/adapters/wholesale-perfumes.ts`

On the **main** storefront it is:

1. Forced **`active = 0`** in `sil_vendors` (migration `016_park_wholesale_perfumes_b2b.sql`)
2. **Excluded from `--vendor=all`** via `PARKED_B2B_VENDOR_SLUGS` in `src/vendors/registry.ts`
3. Opt-in only with an explicit `--vendor=wholesale-perfumes` (for a future B2B site / offline tests)

Do not re-enable it on the retail shop without an explicit product decision.

## Next project (out of scope here)

Stand up a separate WordPress + Sillage stack that:

- Syncs only `wholesale-perfumes`
- Owns its own domain and catalogue
- Reuses the parked API doc and connector code (copy or shared package — decide then)

Until that exists, treat this folder as documentation + scaffolding only.
