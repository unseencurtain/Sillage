# wholesale-perfumes connector (parked)

The live TypeScript implementation is still in the main repo so history and tests stay intact:

| Piece | Path in main tree |
|---|---|
| Connector | `production-environment/sillage-core/src/vendors/wholesale-perfumes/` |
| Order adapter | `production-environment/sillage-core/src/orders/adapters/wholesale-perfumes.ts` |
| Client + XML parsers | `…/WholesalePerfumesClient.ts` |
| Unit tests | `production-environment/sillage-core/tests/wholesalePerfumes.test.ts` |
| Fixtures | `production-environment/sillage-core/tests/fixtures/wholesale_perfumes_*.xml` |
| Seed migration | `migrations/013_wholesale_perfumes_vendor.sql` |
| Park-on-main migration | `migrations/016_park_wholesale_perfumes_b2b.sql` |

Registry: registered in `createConnectors()` / order adapters, but listed in
`PARKED_B2B_VENDOR_SLUGS` so `--vendor=all` on the retail stack never selects it.

API notes: [`../docs/wholesale-perfumes-api.md`](../docs/wholesale-perfumes-api.md).

When the separate B2B site is started, either move these packages here or publish them as a shared
module — do not re-wire them into the cosmetic retail storefront.
