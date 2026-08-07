# Sillage — agent entry point

Multi-vendor dropshipping sync between two wholesale APIs and a WooCommerce storefront.

**Read `docs/CONTEXT.md` before touching anything.** It is the canonical fact sheet: container
names, database credentials, WooCommerce schema quirks, and the complete list of tables we write
to. Then read only the one spec under `docs/specs/` that covers your task. Do not go exploring —
everything you need is in those two files.

## Layout

| Path | What it is |
|---|---|
| `production-environment/sillage-core/` | Bun/TypeScript sync engine, HTTP API, React dashboard |
| `production-environment/ecom_sites/data/wp/wp-content/plugins/sillage-bridge/` | Thin WooCommerce plugin |
| `production-environment/ecom_sites/` | Docker stack: WordPress (`ecom`) + MariaDB (`ecom-db`) + static images (`lps-media`) |
| `production-environment/redis/` | Valkey container, separate compose project |
| `.feedscratch/` | Real downloaded vendor feeds, used as offline test fixtures (gitignored) |
| `product-dropshipping/` | Original standalone vendor clients. Reference only — do not edit |
| `docs/` | Context, decisions, data profile, task specs |
| `tools/images/` | Offline image tools (Brasty Playwright scrape, etc.) |

## Hard rules

1. **Never read or write `production-environment/ecom_sites/data/wp/` or `data/wp-db/`** apart from
   the `sillage-bridge` plugin directory. They hold WordPress core and raw MariaDB files.
2. **Never commit secrets.** All credentials live in gitignored `.env` files.
3. **Bun writes products via raw SQL; PHP never does.** The plugin's job list is closed and
   enumerated in `docs/CONTEXT.md`. Adding write logic to PHP is a design violation.
4. **Orders are HPOS.** WooCommerce 11 stores orders in `wp_wc_orders`, not `wp_posts`.
5. **Placing a vendor order spends real money.** There is no sandbox on either API. Respect the
   dry-run flag and the dispatch safety rails.

## Commands

```bash
cd production-environment/sillage-core
bun install
bun run migrate            # apply sillage DB migrations
bun run sync -- --source=local --vendor=all   # offline, uses .feedscratch fixtures
bun run sync -- --source=live --vendor=bts
bun run dev                # API + dashboard on :4000
bun test
```
