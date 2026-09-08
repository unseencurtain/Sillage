# The development box

`ovhe` (`139.99.61.71`) is the development shop. It used to be the live one; production moved to
`ovh` and this box was rebuilt for development, on the hostnames it already answers on.

| | Development (`ovhe`) | Production (`ovh`) |
|---|---|---|
| Shop | `https://prinscosmetic.eu` | `https://codeinmoon.xyz` |
| Dashboard | `https://sillage.prinscosmetic.eu` | `https://sillage.codeinmoon.xyz` |
| Images | `https://images.prinscosmetic.eu` | `https://images.codeinmoon.xyz` |
| Stack directory | `~/sillage-dev` | `~/sillage` |
| Engine code | bind-mounted from the checkout, hot-reloads | baked into the Hub image |
| Dashboard | Vite dev server with HMR | prebuilt bundle served by the API |
| Sync scheduler | off unless asked for | every 60 minutes |
| Vendor orders | **impossible** | dry-run by default, Live available |

The two shops are visually identical and hold the same vendor credentials, so the dashboard prints
an amber **Development box** banner in the sidebar on `ovhe` and nowhere else. If you are unsure
which one you are looking at, look there before you press anything.

## Vendor orders cannot leave this box

Neither BeautyFort nor BTS has a sandbox. A "Live" dispatch spends real money and ships real stock
to whatever address the order carried, so a dev box able to dispatch is a loaded gun pointed at a
real bank account.

The dev stack runs with `SILLAGE_DEV_BOX=1`, and `resolveDispatchDryRun` in
`sillage-core/src/storefront/profile.ts` turns every dispatch into a rehearsal when it is set. It is
a property of the machine, read from the environment at boot — not a setting, so it cannot be
clicked off from the Orders page, and pressing Live there is simply refused.

Catalogue syncs are read-only against the vendor APIs and are safe. They do consume request budget,
which is why the scheduler is off by default (see `dev.sh cron on`) and why the default sync reads
downloaded fixtures instead.

## The edit loop

Everything is bind-mounted from the git checkout at `~/sillage-dev`, so there is no build step, no
`docker cp`, and no image push in the loop.

| You edit | What happens |
|---|---|
| `sillage-core/src/**.ts` | `bun --hot` re-evaluates the module, about a second, port stays bound |
| `sillage-core/web/src/**.tsx` | Vite pushes the change into the open browser tab |
| `ecom_sites/data/wp/wp-content/plugins/sillage-bridge/**.php` | live on the next request; just refresh |
| `sillage-core/migrations/**.sql` | `./scripts/dev.sh migrate` |

```bash
ssh ovhe
cd ~/sillage-dev
./scripts/dev.sh up          # bring it up
./scripts/dev.sh logs        # follow engine + dashboard
./scripts/dev.sh test        # engine test suite, in the container
./scripts/dev.sh check       # typecheck
./scripts/dev.sh sync        # offline sync from .feedscratch fixtures
./scripts/dev.sh help        # everything else
```

`dev.sh sync` is offline on purpose. `~/sillage-dev/.feedscratch` holds real downloaded BeautyFort
and BTS feeds, so a normal debugging loop costs the wholesalers nothing and cannot be rate-limited
halfway through. `dev.sh sync-live <vendor>` does hit the real API when you need to test the
connector itself.

## Deploying to it

From a laptop or agent checkout:

```bash
./production-environment/scripts/deploy-vps.sh --host ovhe --dev --skip-build
```

`--dev` changes four things and nothing else:

1. the stack lives in `~/sillage-dev`, with its own `.env`, its own Docker volumes
   (`sillage_dev_wp_html`, `sillage_dev_wp_db`) and its own Caddy site file
   (`/etc/caddy/sites/sillage-dev.caddy`);
2. `compose.dev.yaml` is layered on top of `compose.yaml`;
3. the whole of `sillage-core/` is rsynced, because the containers run the checkout rather than
   an image;
4. `SILLAGE_DEV_BOX=1` goes into the generated `.env`.

Domains default to the three `prinscosmetic.eu` hostnames under `--dev`. A production deploy has no
default at all and stops unless told — those names were the live shop's once, and leaving them as
the global fallback meant a production deploy could quietly target the wrong hostname.

## Building the Hub images

This box is the only one with a Docker Hub login, so production images are still built here — now
from the same checkout you develop in, rather than a separate copy that drifts:

```bash
ssh ovhe
cd ~/sillage-dev
bash scripts/build-push-images.sh --core-only --tag <short-sha>
```

`deploy-vps.sh` refuses to deploy an image whose `src/**.ts` does not hash-match the checkout, so a
tag that lags the code is caught before it reaches production rather than after.

## What lives on this box and is not in git

Leave these alone; they are the reason the box has a 38 GB disk.

| Path | What it is |
|---|---|
| `~/sillage-dev/.feedscratch` | real downloaded vendor feeds — the offline sync fixtures |
| `~/photo-inventory/` | photo coverage lists and indexes |
| `~/dev-assets/ean-image-scrape/` | unreviewed EAN image scrape. **Not** the shop's photos, and roughly 2,000 files are under 8 KB. Inspect before applying any of it |
| `~/sillage-dev/data/media/` | the shop's own product JPEGs, served as `images.prinscosmetic.eu` |

## Resetting the dev shop

The database is a Docker volume, so it survives `dev.sh down`. To start the catalogue over:

```bash
cd ~/sillage-dev
docker compose -f compose.yaml -f compose.dev.yaml --env-file .env down -v   # drops the volumes too
./scripts/dev.sh up
```

Then reinstall WordPress the same way a new shop is set up — `deploy-vps.sh --host ovhe --dev`
handles it, and `--finish` runs the readiness check afterwards. `docs/REBUILD-FROM-SCRATCH.md` is
the long version; nothing there is production-specific except the hostnames.
