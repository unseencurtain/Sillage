# Working on the code

Which box is what, what a role means, and how to rebuild one: [`ENVIRONMENTS.md`](ENVIRONMENTS.md).
That file is the rules. This one is how you actually get work done against a running shop.

Today the test box is `ovhe` (`139.99.61.71`), on `prinscosmetic.eu` / `sillage.prinscosmetic.eu`
/ `images.prinscosmetic.eu` for retail and `wholesale.mirainikki.xyz` /
`sillage-wholesale.mirainikki.xyz` for wholesale. It is disposable — wiped and rebuilt on demand
— and it is deliberately **not** held at parity with production. Do not put anything there you
would mind losing, and do not read it as evidence of what production looks like today.

Its stacks declare `SILLAGE_ROLE=development`, which is a label for the deploy script and nothing
else. Both shops are restored copies carrying production's real vendor credentials against APIs
with no sandbox, so the engine here can spend money exactly like the shop can: a Live dispatch on
the Orders page is a real order wherever you press it. Check the hostname before you click.

Scheduled sync is **off** there. Both wholesalers rate-limit per account and there is one account,
so a test box syncing on a timer takes requests the shop needs. Sync by hand when a test needs it.

## Bridge plugin — nothing to set up

`data/wp/` is a bind mount, so the plugin sources are ordinary files on the box and a save is live
on the next request:

```bash
ssh ovhe
sudo -e ~/sillage/data/wp/wp-content/plugins/sillage-bridge/sillage-bridge.php
# refresh the page
```

Copy the result back into `production-environment/.../sillage-bridge/` in git when it works.

## Engine and dashboard — two speeds

By default a development stack runs the published image, exactly as production does. That is the
point of it: a stack built differently from production tells you about a stack that does not
exist. A TypeScript change then means building a tag and pulling it.

For a tight loop, layer the overlay instead:

```bash
./production-environment/scripts/deploy-vps.sh --host ovhe --role development --overlay --skip-build
```

| You edit | What happens |
|---|---|
| `sillage-core/src/**.ts` | `bun --hot` re-evaluates the module, about a second, port stays bound |
| `sillage-core/web/src/**.tsx` | Vite pushes the change into the open browser tab |
| `sillage-core/migrations/**.sql` | `./scripts/dev.sh migrate` |

```bash
ssh ovhe
cd ~/sillage
./scripts/dev.sh up | logs | test | check | sync | help
```

The overlay is refused on a production stack. Take it off with a plain deploy when you are done —
a box left under it is running code that exists nowhere else, and the image-drift guard is
switched off while it is on.

`dev.sh sync` reads downloaded fixtures from `.feedscratch` rather than the vendor APIs, so a
debugging loop costs the wholesalers nothing and cannot be rate-limited halfway through. That
directory is empty on a freshly rebuilt box; copy fixtures up from a checkout, or use
`dev.sh sync-live <vendor>` when the connector itself is what you are testing.

## Building images

Any box can build, and every deploy rsyncs the engine source onto the box for exactly that reason.
It needs `docker login` as `unseencurtain` once:

```bash
ssh ovhe
cd ~/sillage
bash scripts/build-push-images.sh --core-only --tag <short-sha>
```

Then pin `SILLAGE_CORE_IMAGE=<repo>:<tag>` in the target stack's `.env` and
`docker compose --env-file .env up -d sillage-core sillage-cron`.

`deploy-vps.sh` refuses to deploy an image whose `src/**.ts` does not hash-match the checkout, so a
tag that lags the code is caught before it reaches production rather than after.

## What is not in git

| Path | What it is |
|---|---|
| `<stack>/.env`, `sillage-core/data/secrets.overlay.env` | credentials |
| `<stack>/data/media/` | the shop's own product JPEGs |
| `<stack>/.feedscratch` | downloaded vendor feeds — the offline sync fixtures |
| `~/box-*.tar.gz` | packs of the whole box, made by hand with `~/pack.sh` ([`VPS-MIGRATE.md`](VPS-MIGRATE.md)) |
