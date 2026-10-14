# New retail VPS: repeatable setup

This is the current runbook for a clean Sillage retail install. It creates a fresh WordPress
installation and database. It never copies a WordPress folder, database, `.env`, or secrets from
another VPS. Product photos are the only runtime data the media option copies.
The public image URL is `https://images.example.com/<filename>` at the image hostname root; never
append `/images/` to that hostname. The dashboard shares the shop origin at `/sillagedash`.

## Source repositories

The deploy uses two laptop checkouts:

- Sillage: `unseencurtain/Sillage` (this repository)
- React storefront: `unseencurtain/storefront`, checked out beside Sillage at
  `../react_store/frontend`

Do not upload a whole local project folder to the server. The script transfers the build context,
configuration, and generated frontend assets it needs. Runtime data is created on the new host.

## Ordered setup

1. **Create the VPS and DNS.** Use a supported Ubuntu host with a public IPv4 address and SSH
   access. Point the shop and image host A records at that address. The dashboard shares the shop
   hostname at `/sillagedash`.
2. **Bootstrap a blank host once as root.** Add an SSH config alias for the `ubuntu` account after
   bootstrap. Keep the host alias, shop name, image name, and dashboard path as changeable inputs.

   ```bash
   ssh root@NEW_VPS_IP 'bash -s' < production-environment/scripts/bootstrap-host.sh
   ```

3. **From the Sillage repo root, run the replication script.** `--media-from` is optional; it
   copies photos only. Leave it out when no photo source is available.

   ```bash
   bash production-environment/scripts/replicate-headless-vps.sh \
     --host NEW_VPS_ALIAS \
     --shop shop.example.com \
     --images images.example.com \
     --dashboard-path /sillagedash \
     --media-from EXISTING_PHOTO_HOST
   ```

   The script builds the Sillage dashboard locally with the configured path, runs the Sillage
   stack deploy, installs the headless WooCommerce plugins and account-session MU plugin, builds
   the React app on the laptop, uploads its `dist`, and writes/reloads the editable Caddy site at
   `~/sillage/ops/caddy/sillage.caddy`, linked from `/etc/caddy/sites/sillage.caddy`.
   The deploy creates new database and WordPress state, new admin/dashboard logins, and keeps
   sync schedules paused and order dispatch in dry-run.
4. **Set the image base URL.** The replication deploy routes `--images` to the media service.
   Save the same URL to dashboard Settings and `.env`:

   ```bash
   bash production-environment/scripts/configure-image-domain.sh \
     --host NEW_VPS_ALIAS --domain images.example.com
   ```

5. **Enter vendor credentials in Sillage Dashboard → Secrets.** This is the normal path for a
   new VPS. `copy-vendor-secrets.sh` is an explicit migration helper for the three allowlisted
   BeautyFort/BTS credentials; it must never be used to copy an `.env` or runtime folder.
6. **Verify, then start the first sync manually.** Check the React shop, `/wp-admin/`,
   `/sillagedash`, one real image URL, and dashboard Secrets status. Confirm both schedules are
   off and order dispatch is dry-run. Start a full catalogue sync from the dashboard when the
   owner is ready; monitor its run and logs. Do not enable a recurring schedule until the first
   import succeeds and the catalogue is checked.

## What gets copied

| Source | New VPS |
|---|---|
| Sillage application and configuration from this repo | Selected deployment files and source/build context |
| React source | Built locally; only generated frontend assets are uploaded |
| Optional media source | Product image files only |
| WordPress, MariaDB, old `.env`, dashboard logins | **Never copied**; created fresh |
| Vendor API credentials | Entered through dashboard Secrets; optional allowlisted migration helper |

## Change settings later

- Shop domain, image domain, dashboard path, and SSH alias are script arguments; update DNS first.
- The editable Caddy site is `~/sillage/ops/caddy/sillage.caddy`, linked from
  `/etc/caddy/sites/sillage.caddy`. Validate and reload it with
  `~/sillage/scripts/reload-caddy.sh`.
- Change the image base URL with `configure-image-domain.sh`. To change its public DNS/Caddy
  route too, rerun `deploy-vps.sh` with the matching `--images` value and `--skip-build`.
- Update the WordPress container version with `scripts/bump-wordpress.sh`; update host Docker
  Engine/Compose with `scripts/update-docker-host.sh`.
- Stripe is deferred until the customer and catalogue flows work.

## Rebuild timing and chronology

The previous test-host work measured an incremental deploy, not a fully blank VPS rebuild. The
five-to-ten-minute clean-host target is **not yet verified**. Each clean VPS run must use this
sequence without manual trial-and-error and record each elapsed step in
[`DEPLOYMENT-CHRONOLOGY.md`](DEPLOYMENT-CHRONOLOGY.md). Historical failures and corrections are
kept in the archive linked from [`REBUILD-FROM-SCRATCH.md`](REBUILD-FROM-SCRATCH.md).

When a run fails or needs a manual workaround, record the exact step, elapsed time, error code or
symptom, cause, and the durable fix. Put repeatable fixes in `production-environment/scripts/` and
update this plan in the same change. Do not leave a one-off repair only on a VPS. The replication
script appends step results and failure exit codes to the chronology automatically; keep sensitive
output and secret values out of that log.
