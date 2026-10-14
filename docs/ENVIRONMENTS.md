# VPS environments and repeatable setup

Sillage can be deployed to any supported Ubuntu VPS. The repository does not assign a permanent
role or hostname to a box. Each run supplies an SSH alias, shop domain, image domain, and dashboard
path. DNS must point at the selected VPS before deployment.

## Rules for every host

1. WordPress and MariaDB use bind mounts under the stack directory; do not use named volumes.
2. A fresh VPS gets a new database and WordPress install. Never copy database dumps, WordPress
   files, `.env`, credentials, or the whole application directory from another host.
3. Product photos can be copied separately with `--media-from <photo-source-ssh-alias>`.
4. Fresh installs generate new passwords, leave vendor credentials empty, pause scheduled vendor
   calls, and keep order dispatch in dry-run.
5. Host alias, shop domain, image domain, dashboard path, and account names are changeable inputs.
6. Caddy runs on the host. The managed Sillage site lives at `~/sillage/ops/caddy/sillage.caddy`
   and is linked under `/etc/caddy/sites/`.
7. Retail is this repository. Wholesale is a separate product/repository and must not be mixed into
   this compose stack.

## Clean deployment

```bash
bash production-environment/scripts/replicate-headless-vps.sh \\
  --host <ssh-alias> \\
  --shop shop.example.com \\
  --images images.example.com \\
  --dashboard-path /sillagedash
```

Add `--media-from <photo-source-ssh-alias>` only when product photos should be copied. Run
[`NEW-VPS-PLAN.md`](NEW-VPS-PLAN.md) for the full ordered procedure. See
[`VPS-DEPLOY.md`](VPS-DEPLOY.md) for script responsibilities and flags.

## Existing test deployment

The current test shop uses the React storefront at `https://prinscosmetic.eu`, WordPress Admin at
`/wp-admin/`, the Sillage dashboard at `/sillagedash`, and product images at the root of
`https://images.prinscosmetic.eu/`. Its sync schedules are paused and order dispatch stays in
dry-run. These are current settings, not defaults for future VPS targets.
