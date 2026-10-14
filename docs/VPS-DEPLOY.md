# VPS deploy reference

Use [`NEW-VPS-PLAN.md`](NEW-VPS-PLAN.md) for the one ordered, clean-install procedure. This page
is a short reference for the deploy scripts; it is not a second setup recipe. `pack-box.sh` and
`adopt-box.sh` are for disaster recovery of an existing deployment only; never use them to set up
a fresh replacement VPS.

## Script responsibilities

- `replicate-headless-vps.sh` is the normal entry point. It builds the Sillage dashboard locally,
  deploys the backend, installs headless WooCommerce plugins and the account-auth MU plugin, builds
  React on the laptop, and uploads the storefront assets.
- `deploy-vps.sh` prepares the WordPress + Sillage stack, creates fresh WordPress/database state
  when needed, runs migrations, activates the bridge/WooCommerce plugins, and writes the managed
  Caddy site at `~/sillage/ops/caddy/sillage.caddy`.
- `bootstrap-host.sh` is a one-time root step for a genuinely blank Ubuntu host.
- `configure-image-domain.sh` updates the image hostname in `.env` and dashboard Settings.
- `reload-caddy.sh` validates and reloads the managed host Caddy configuration.

## Changeable inputs

```bash
bash production-environment/scripts/replicate-headless-vps.sh \\
  --host SSH_ALIAS \\
  --shop shop.example.com \\
  --images images.example.com \\
  --dashboard-path /sillagedash \\
  --media-from PHOTO_SOURCE_ALIAS
```

`--media-from` is optional and copies product photos only. Never copy another VPS's database,
WordPress bind mount, `.env`, or whole application folder to create a fresh install. The public
image format is `https://images.example.com/<filename>` at the image hostname root.

The lower-level `deploy-vps.sh` flags include `--skip-build`, `--push-images`, `--fresh`,
`--core-only`, `--dns`, and `--overlay`. Use `--fresh` only when intentionally recreating an
existing stack's app state; it is not required for the documented new VPS path. `--overlay` is
for temporary development directly on a VPS and must be removed by a normal deploy afterward.

## Runtime layout

The VPS app is under `~/sillage/`; WordPress, MariaDB, media, and sitemap data are bind-mounted
from `~/sillage/data/`. The main `/etc/caddy/Caddyfile` imports site files. Sillage owns the
editable `~/sillage/ops/caddy/sillage.caddy`, symlinked under `/etc/caddy/sites/`.

See [`FOLDER-STRUCTURE.md`](FOLDER-STRUCTURE.md) for the complete layout,
[`ENVIRONMENTS.md`](ENVIRONMENTS.md) for host roles, and [`SHIP.md`](SHIP.md) for day-two deploys.
