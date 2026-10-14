# Sillage handoff

Read this first when resuming work. This file describes the current retail deployment; historical incidents and subsystem details live in the linked runbooks.

## Current deployment — 2026-10-14

| Item | Current value |
|---|---|
| Retail VPS | Current test deployment; use its configured SSH alias from the operator's SSH config |
| React storefront | `https://prinscosmetic.eu` |
| WordPress Admin | `https://prinscosmetic.eu/wp-admin/` |
| Sillage dashboard | `https://prinscosmetic.eu/sillagedash` |
| Product photos | `https://images.prinscosmetic.eu/`; 4,228 JPEGs were copied from a separate photo source |
| Access | Storefront open for testing; WP Admin and dashboard use their normal logins |
| Local credentials | `.deploy/vps-dashboard-<ssh-alias>.txt` (ignored, mode 600); never print the contents |
| Compose and env | `~/sillage/compose.yaml` and `~/sillage/.env` on the selected host |
| WordPress bind mount | `~/sillage/data/wp` |
| MariaDB bind mount | `~/sillage/data/wp-db` |
| Media bind mount | `~/sillage/data/media` |
| Fresh database | No database or WordPress files were copied from another host; React built locally and uploaded |
| Base plugins | WooCommerce, Redis Cache, Sillage Bridge, headless-core and headless-woocommerce active; Blocksy removed |
| Safety defaults | `sync_enabled=0`, `full_sync_enabled=0`, `orders_dry_run=1`, `orders_auto_dispatch=0`; vendor keys entered through dashboard Secrets |
| Images | Built on the selected target and kept local; registry push is optional with `--push-images` |

The hostname and dashboard path are runtime choices. Change them with deploy flags or the stack `.env`; do not add a permanent retired-domain rule to identity code.

## Routine work

- Engine or dashboard changes: follow [`SHIP.md`](SHIP.md) and [`ENVIRONMENTS.md`](ENVIRONMENTS.md).
- Fresh setup or identity/path change: follow [`NEW-VPS-PLAN.md`](NEW-VPS-PLAN.md) and [`VPS-DEPLOY.md`](VPS-DEPLOY.md).
- WordPress image/core update: use `scripts/bump-wordpress.sh <version> ...`; bind-mounted core is synchronized by `update-wordpress-core.sh`.
- Docker Engine/Compose update: use `scripts/update-docker-host.sh <ssh-alias>`. Docker runs as a host service, not inside WordPress.
- Back up before risky changes with `scripts/pack-box.sh`; download the archive off-host.
- When using an existing photo source, copy only `~/sillage/data/media`; never copy its WordPress tree or database.

## Deploy command

```bash
SSH_ALIAS="your-configured-alias"
SHOP_DOMAIN="prinscosmetic.eu"
IMAGE_DOMAIN="images.prinscosmetic.eu"
bash production-environment/scripts/replicate-headless-vps.sh \\
  --host "$SSH_ALIAS" \\
  --shop "$SHOP_DOMAIN" \\
  --images "$IMAGE_DOMAIN" \\
  --dashboard-path /sillagedash
```

The deploy checks DNS, builds images on the target, creates fresh bind-mounted WordPress/MariaDB state, activates base plugins, writes Caddy config, and stores generated logins in the ignored credentials file. It does not clone a database. For a truly blank host, run `bootstrap-host.sh` first.

Wholesale is maintained in the separate `sillage-b2b` repository. Do not deploy wholesale from this retail checkout. See [`CLIENT-GUIDE.md`](CLIENT-GUIDE.md), [`OPERATOR-DASHBOARD.md`](OPERATOR-DASHBOARD.md), and [`REBUILD-FROM-SCRATCH.md`](REBUILD-FROM-SCRATCH.md) for details.
