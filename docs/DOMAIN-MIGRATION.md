# Change the shop or image domain

The shop domain, image hostname, and dashboard path are deployment settings. The dashboard shares
its origin with the React shop at `/sillagedash`. The image hostname serves files from its root:
`https://images.example.com/<filename>`—there is no `/images/` path suffix on that host.

## Change shop or image host

1. Point the new shop and/or image A records at the VPS and wait for DNS to resolve.
2. From the Sillage repo, rebuild and upload the local React app plus Sillage stack config:

   ```bash
   bash production-environment/scripts/replicate-headless-vps.sh \
     --host VPS_ALIAS \
     --shop shop.example.com \
     --images images.example.com \
     --dashboard-path /sillagedash
   ```

   Add `--media-from EXISTING_HOST` only when copying product image files. This does not copy
   WordPress, MariaDB, `.env`, or dashboard credentials.
3. If only the image hostname changed on an already-running stack, update the dashboard and `.env`:

   ```bash
   bash production-environment/scripts/configure-image-domain.sh \
     --host VPS_ALIAS --domain images.example.com
   ```

   Then rerun `deploy-vps.sh` with matching `--shop`, `--dash`, `--images`, and
   `--dashboard-path` values plus `--skip-build` to update the Caddy route without rebuilding
   container images.
4. Check the dashboard Settings image base URL and a real file at
   `https://images.example.com/<filename>`.

The domain stays editable: change the DNS records and pass the new values to the scripts. No
hostname is permanent application identity.
