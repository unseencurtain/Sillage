# Sillage

Multi-vendor dropshipping sync between BeautyFort, BTS Wholesaler, and a WooCommerce storefront.

Bun/TypeScript sync engine + thin WordPress plugin + React ops dashboard.

## Layout

| Path | What it is |
|---|---|
| `production-environment/sillage-core/` | Sync engine, HTTP API, React dashboard |
| `production-environment/ecom_sites/` | Docker Compose: WordPress (`ecom`) + MariaDB (`ecom-db`) + sillage |
| `production-environment/ecom_sites/data/wp/wp-content/plugins/sillage-bridge/` | Thin WooCommerce plugin (only WP path that is versioned) |
| `production-environment/redis/` | Valkey object cache |
| `docs/` | Context, decisions, specs — start with `docs/CONTEXT.md` |
| `product-dropshipping/` | Original standalone vendor clients (reference only) |

## Quick start (dev)

```bash
# Networks (once)
docker network create ecom_network
docker network create redis_network

# Copy env templates and fill credentials
cp production-environment/sillage-core/.env.example production-environment/sillage-core/.env
cp production-environment/ecom_sites/.env.example production-environment/ecom_sites/.env

cd production-environment/redis && docker compose up -d
cd ../ecom_sites && docker compose up -d --build

cd ../sillage-core
bun install
bun run migrate
bun run sync -- --source=local --vendor=all   # needs fixtures in .feedscratch/
# or
bun run sync -- --source=live --vendor=all
```

Dashboard: http://127.0.0.1:4000  
Storefront: http://localhost

## Safety

- Vendor order APIs have **no sandbox**. `orders_dry_run=1` and `orders_auto_dispatch=0` by default.
- Never commit `.env` files.
- WordPress core and MariaDB data under `ecom_sites/data/` are gitignored (plugin excepted).

## VPS notes (4 GB)

On a 4 GB host, lower MariaDB `innodb_buffer_pool_size` from `2G` to about `1G` in
`production-environment/ecom_sites/config/mariadb.cnf` before bringing the stack up.

```bash
git clone git@github.com:unseencurtain/Sillage.git
cd Sillage
# create .env files, adjust buffer pool, then compose up as above
```

## Docs

Read `AGENTS.md` and `docs/CONTEXT.md` before changing anything.
