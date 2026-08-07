# Sillage

Multi-vendor dropshipping sync: **BeautyFort** + **BTS Wholesaler** → **WooCommerce**.

Bun/TypeScript sync engine, thin WordPress plugin, React ops dashboard. Designed so a fresh Ubuntu VPS can be brought up with two scripts and no live-site cloning.

## What you get

| Surface | Purpose |
|---|---|
| WooCommerce storefront | Customer shop (HPOS orders, EUR, vendor categories, tracking page) |
| Sillage dashboard | Sync controls, orders, settings, dry-run / live dispatch |
| sillage-core | Catalogue sync, pricing, images, order ingest + vendor dispatch |
| sillage-bridge | Thin WP plugin (REST + shortcodes only — **no product SQL writes**) |

## Repository layout

| Path | What it is |
|---|---|
| `production-environment/sillage-core/` | Sync engine, HTTP API, React dashboard |
| `production-environment/ecom_sites/` | Compose: WordPress (`ecom`) + MariaDB (`ecom-db`) + sillage |
| `…/plugins/sillage-bridge/` | Only WordPress path that is versioned |
| `production-environment/wordpress-image/` | Dockerfile: `wordpress:latest` + PHP Redis → `lime/wordpress:latest` |
| `production-environment/redis/` | Valkey object cache |
| `production-environment/scripts/` | One-click host bootstrap + VPS deploy |
| `docs/` | Start with [`docs/CONTEXT.md`](docs/CONTEXT.md) |
| `docs/CLIENT-FEATURE-WALKTHROUGH.md` | Client-facing feature tour |

## Safety (read before live sync / dispatch)

- Vendor order APIs have **no sandbox**. Defaults: `orders_dry_run=1`, `orders_auto_dispatch=0`.
- Live catalogue fetches are **rate-gated** (min interval + per-day caps) with on-disk feed cache.
- **Never commit** `.env`, `.deploy/`, or `*.pem`.
- WordPress core / MariaDB data under `ecom_sites/data/` are gitignored (plugin excepted).
- Bun writes products via SQL; PHP must not grow write paths.

## One-click VPS deploy (presentation path)

**Full step-by-step (provider → bootstrap → DNS → deploy → verify):** see [`docs/VPS-DEPLOY.md`](docs/VPS-DEPLOY.md).

Needs: Ubuntu 22.04+ (or 24/26), SSH key access, Docker Hub reachability, a domain on Porkbun (optional `--dns`).

### 1. Fresh host (as `root`, once)

```bash
ssh root@YOUR_VPS 'bash -s' < production-environment/scripts/bootstrap-host.sh
```

Installs Docker Engine + Compose plugin, Caddy, ufw (22/80/443), creates `ubuntu` with docker+sudo, creates `ecom_network` / `redis_network`.

Point SSH at the new user (example):

```sshconfig
Host my-sillage
  HostName YOUR_VPS_IP
  User ubuntu
  IdentityFile ~/.ssh/your-key.pem
  IdentitiesOnly yes
```

### 2. Local secrets (laptop)

```bash
cp production-environment/sillage-core/.env.example production-environment/sillage-core/.env
# Fill BeautyFort + BTS credentials. Dashboard password is generated on deploy.
```

Optional DNS automation:

```bash
mkdir -p .deploy
cat > .deploy/porkbun.env <<'EOF'
PORKBUN_API_KEY=pk1_...
PORKBUN_SECRET_KEY=sk1_...
EOF
chmod 600 .deploy/porkbun.env
```

### 3. Deploy

```bash
./production-environment/scripts/deploy-vps.sh \
  --host my-sillage \
  --shop shop.example.com \
  --dash ops.example.com \
  --dns \
  --ip YOUR_VPS_IP
```

What that does:

1. Builds **`lime/wordpress:latest` on the VPS** from `wordpress-image/` (not copied from another server)
2. Starts Valkey, MariaDB, WordPress, sillage-core, sillage-cron
3. Configures Caddy (`fmt` + `validate` + `reload`) with Let’s Encrypt
4. Fresh WordPress install + WooCommerce / redis-cache / Blocksy from wordpress.org + sillage-bridge
5. Applies canonical DB grants from `ecom_sites/config/sillage-grants.sql`
6. Runs migrations; writes dashboard + WP admin passwords to **`.deploy/vps-dashboard-<host>.txt`** (mode `600`, gitignored)

Re-run the same command to update code/plugin/image. It will not wipe an existing DB unless you intentionally clear `~/ecom_sites/data`.

### 4. After deploy checklist

- [ ] `https://shop…` and `https://ops…` return 200
- [ ] Dashboard login works (password file above)
- [ ] Overview loads (if it fails with SQL denied → grants missing; re-apply `sillage-grants.sql`)
- [ ] `.feedscratch` is **writable** (feed cache); compose must **not** mount it `:ro`
- [ ] Settings: keep **Dry-run** on until you are ready to spend real money
- [ ] Flush local DNS if a brand-new subdomain shows `ERR_NAME_NOT_RESOLVED` (`resolvectl flush-caches`)

## Local development

```bash
docker network create ecom_network
docker network create redis_network

cp production-environment/sillage-core/.env.example production-environment/sillage-core/.env
cp production-environment/ecom_sites/.env.example production-environment/ecom_sites/.env

# Build the Redis-enabled WordPress image once
docker build -t lime/wordpress:latest production-environment/wordpress-image

cd production-environment/redis && docker compose up -d
cd ../ecom_sites && docker compose up -d --build

cd ../sillage-core
bun install
bun run migrate
bun run sync -- --source=local --vendor=all   # needs .feedscratch fixtures
# bun run dev   # API + dashboard on :4000
bun test
```

| Service | URL |
|---|---|
| Dashboard | http://127.0.0.1:4000 |
| Storefront | http://localhost (or host-mapped WP port) |

## Security model (short)

| Area | Practice |
|---|---|
| Secrets | `.env` mode `600`; never in git; deploy writes to `.deploy/` only |
| Network | Caddy terminates TLS; sillage-core bound to `127.0.0.1:4000`; MariaDB `127.0.0.1:3307` |
| Firewall | ufw allows 22/80/443 only on bootstrapped hosts |
| DB | `sillage` user: ALL on `sillage.*`; narrow DML/SELECT on listed `earth.wp_*` tables only (see `sillage-grants.sql`) |
| Orders | Dry-run default; live dispatch is explicit and spends real money |
| Feeds | Live vendor downloads capped; disk cache under `.feedscratch/cache` |

## Agents / contributors

Read [`AGENTS.md`](AGENTS.md) then [`docs/CONTEXT.md`](docs/CONTEXT.md) before changing anything. Do not edit WordPress core or raw MariaDB files outside the bridge plugin.

## License / ownership

Private project — see repository settings on GitHub.
