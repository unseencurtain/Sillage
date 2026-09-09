# Images: a CDN of its own, and a copy that outlives every VPS

Status: **plan**. The two prerequisites are already done and live (see "Already done"); everything
under "The work" is proposed and not built yet.

## Why this needs a plan at all

Product photos are the only thing in this system that cannot be regenerated. Products, prices,
stock, categories and the whole WooCommerce database can be rebuilt from the wholesalers in about
forty minutes by pressing Rebuild catalogue. The curated images cannot: they are the result of
scraping, matching and hand-checking, and the wholesalers will not give them back.

So the images plus the EAN→image mapping are the backup that matters. Everything else is a cache.

Today they are also the most entangled thing in the system, because a hostname for them is written
in four places:

| Where | What it holds | Count today |
|---|---|---|
| `~/sillage/data/media/` on the shop VPS | the JPEG files | 4,228 files, 388 MB |
| `sillage-core/data/image_overrides.json` (in git) | EAN → image | 10,919 entries, 4,564 self-hosted |
| `wp_postmeta._external_thumbnail_url` | the URL WooCommerce prints | 3,221 rows on our own CDN |
| `sil_settings.image_cdn_base_url` | the origin relative overrides resolve against | 1 row |

Move the files and change only some of those, and the shop keeps working — pointed at a machine you
think you have decommissioned. That is not hypothetical. It happened twice today:

- The storefront on `codeinmoon.xyz` was serving 3,221 photos from `images.prinscosmetic.eu`, the
  box it had replaced, because the committed overrides file had that origin baked into 4,564
  entries. Nothing was broken, so nothing reported it.
- After that was repointed, a scheduled sync put 593 of them **back**, because the engine on the
  box was still reading the old absolute overrides file. Those 593 products had visibly broken
  images for as long as the old box stayed down.

Both are the same mistake: the origin is data, stored in several places, with nothing checking that
they agree.

## Already done

These two are live in production and are what the rest of the plan builds on.

1. **Self-hosted overrides carry no origin.** `image_overrides.json` stores `9424115.jpg`, not
   `https://images.somewhere/9424115.jpg`, and `absolutizeImageUrl` prefixes the deployment's own
   `image_cdn_base_url` at load. External CDNs (Shopify, BTS, Ocean) keep their scheme and are used
   as written. One committed file is now correct on every box, including the dev one.
2. **Production is repointed and independent.** All 3,221 rows and the setting now name
   `images.codeinmoon.xyz`, and the engine resolves the 4,564 self-hosted overrides against it.

## The work

### 1. The image bundle — one portable unit

A single zip that is the whole of what cannot be regenerated, and contains **no hostname anywhere**:

```
image-bundle-2026-09-08.zip
├── media/                    every JPEG, flat, EAN-named
├── image_overrides.json      relative form, exactly as committed
├── manifest.json             per-file sha256, counts, bytes, created_at, source host, git sha
├── restore-cdn.sh            rebuilds a CDN box from this zip alone
└── RESTORE.md                the same thing for a human, no repo required
```

The zip is self-sufficient on purpose. If both VPSes are gone and the GitHub repo is gone, this file
plus a blank Ubuntu box is enough to have the images serving again. That is the requirement, so the
restore script travels inside the zip rather than living only in the repo.

JPEGs do not compress, so expect roughly the size of `media/` — store the media entries rather than
deflating them, and the build takes about a minute instead of ten.

`scripts/make-image-bundle.sh`, run on the shop VPS:

```bash
~/sillage/scripts/make-image-bundle.sh              # → ~/image-bundle-<date>.zip + ~/image-bundle-latest.zip
```

It verifies as it goes: every override that is relative must have a matching file in `media/`, and
every file's sha256 goes in the manifest. A bundle that cannot restore itself should fail to build
rather than sit on disk looking like a backup.

Weekly cron on production writes it, and the same script runs after any bulk image import. The user
downloads `~/image-bundle-latest.zip` from `ovh`.

### 2. The CDN on its own VPS

Deliberately the dumbest box in the fleet: no Docker, no PHP, no database. Caddy serving a
directory, which is also what gives it TLS.

```
/srv/images/            the JPEGs
/etc/caddy/Caddyfile    one site block
~/image-bundle-latest.zip   a second copy of the backup, so it exists on two machines
```

```caddy
cdn.example.com {
	root * /srv/images
	file_server
	# Filenames are EAN-based and the content never changes under a name, so this is safe
	# and it takes the load off the box almost entirely.
	header Cache-Control "public, max-age=31536000, immutable"
	header -Server
}
```

Why separate at all: the shop VPS is the one that runs out of memory under a crawler or a big
import, and images are the part that must never go down with it. It also means the shop stack loses
the `lps-media` container, the `DATA_DIR/media` mount and the `images.*` Caddy block entirely —
the shop stops being an image host, which is what made it entangled in the first place.

`restore-cdn.sh` (inside the bundle) does the whole box: install Caddy, unzip to `/srv/images`,
verify every sha256 against the manifest, write the Caddyfile, reload. It takes a hostname as its
only argument.

### 3. Repointing as one operation that verifies itself

`scripts/repoint-image-cdn.sh --to https://cdn.example.com`, run on the shop VPS. The whole point is
that it refuses to half-succeed:

1. **Preflight** — sample 20 filenames from the overrides, fetch them from the new origin, require
   200 and `image/*`. Stop here if the new CDN is not actually serving.
2. Update `sil_settings.image_cdn_base_url`.
3. Rewrite `wp_postmeta._external_thumbnail_url` from any known-ours origin to the new one.
4. **Postflight** — assert zero rows reference any old origin, then re-sample and fetch.
5. `wp-finalize.sh`, because postmeta changes are invisible behind the object cache.
6. Print before/after host counts.

Idempotent, so running it twice is a no-op and an interrupted run is fixed by running it again.

### 4. The guard that would have caught both incidents

A check that fails loudly instead of a shop that looks fine:

> Every product thumbnail must be on this deployment's `image_cdn_base_url`, or on the documented
> list of external vendor CDNs (`images.btswholesaler.com`, `cdn.shopify.com`,
> `www.oceanfragrances.com`). Anything else is an orphan.

It runs in `deploy-vps.sh --finish` and from cron, and reports like
`orphan image hosts: images.prinscosmetic.eu (593)`. Both of today's incidents were exactly this
condition, and both were invisible for the same reason — a URL that resolves is indistinguishable
from a correct one until the machine behind it goes away.

The dashboard should show the same thing: the Overview already prints "N unattributed" when its
hide reasons do not add up, and an orphan-host count belongs next to it.

### 5. Deploying to production, by a person or an agent

The sequence has an ordering constraint that is not obvious and that bit us today: **the engine must
understand relative overrides before the relative overrides file reaches it.** Ship the file to an
old engine and it rejects all 4,564 as unusable, and 4,564 products lose their photo on the next
sync.

```bash
# 1. CDN box first — nothing else is safe until images are actually being served
scp image-bundle-latest.zip newcdn:~/ && ssh newcdn 'unzip -q image-bundle-latest.zip && bash restore-cdn.sh cdn.example.com'
curl -sI https://cdn.example.com/9424115.jpg | head -1     # expect 200

# 2. Engine that can resolve relative overrides
ssh <build-host> 'cd ~/sillage-dev && bash scripts/build-push-images.sh --core-only --tag <sha>'

# 3. Engine and overrides file together, never separately
./production-environment/scripts/deploy-vps.sh --host ovh --skip-build

# 4. Repoint, which verifies before and after
ssh ovh '~/sillage/scripts/repoint-image-cdn.sh --to https://cdn.example.com'

# 5. Confirm no orphans
ssh ovh '~/sillage/scripts/check-image-hosts.sh'
```

Steps 1, 4 and 5 each assert their own success, so an agent cannot report "done" on a shop whose
images are broken — which is the failure mode this whole plan exists to prevent.

### 6. Disaster recovery, from the zip alone

Both VPSes gone, repo gone, laptop holds only `image-bundle-latest.zip`:

1. Any blank Ubuntu box, `unzip image-bundle-latest.zip`, read `RESTORE.md`.
2. `bash restore-cdn.sh <hostname>` → images serving, verified against the manifest.
3. Point DNS at it.
4. Rebuild the shop from the repo as usual (`docs/REBUILD-FROM-SCRATCH.md`), set
   `image_cdn_base_url` to that hostname, drop `image_overrides.json` into
   `sillage-core/data/`, press Rebuild catalogue.

The catalogue comes back from the wholesalers; the photos come back from the zip. Nothing else was
irreplaceable.

## Order of work

1. `make-image-bundle.sh` and the manifest format — this is the backup, and it is worth having
   before anything is moved.
2. `check-image-hosts.sh` and wire it into `deploy-vps.sh --finish` — cheap, and it turns the whole
   class of failure from silent into loud.
3. `restore-cdn.sh` plus `RESTORE.md`, shipped inside the bundle, and test it on a throwaway box.
4. `repoint-image-cdn.sh`.
5. Provision the CDN VPS, repoint, then remove `lps-media` and the media mount from the shop stack.

Steps 1 and 2 are worth doing on their own even if the separate CDN box never happens.
