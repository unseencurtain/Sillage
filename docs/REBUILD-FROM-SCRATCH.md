# Rebuilding both shops on a wiped VPS

Read this before touching a blank box. It exists because the first rebuild of `ovh` took hours
instead of one script run, and every hour of that traced back to something the live box had by
hand that no script created, or to an assumption nobody had checked.

`ovhe` and `ovh` are the **same machine spec**: 2 vCPU, 3.7 GB RAM, 38 GB disk. When a rebuild
behaves worse than the live box, the difference is never the hardware. It is state on `ovhe`
that exists only because a human typed it once.

---

## 1. Standing requirements — do not ask for these again

These are settled. Treat them as given on every rebuild.

| Thing | Value |
|---|---|
| Retail shop | `codeinmoon.xyz` |
| Retail media | `images.codeinmoon.xyz` |
| Retail dashboard | `sillage.codeinmoon.xyz` |
| Wholesale shop | `wholesale.codeinmoon.xyz` |
| Wholesale dashboard | `sillage-wholesale.codeinmoon.xyz` |
| Retail WordPress admin | `cherry` |
| Retail dashboard operator | `europa` |
| Wholesale WordPress admin | `orange` |
| Wholesale dashboard operator | `wildwest` |
| Test VPS | `ovh` — `51.79.255.226` |
| Live VPS (photo source) | `ovhe` — `139.99.61.71` |

And the rules behind them:

1. **Never `admin`.** Not for WordPress, not for the dashboard. Both deploy scripts refuse it.
   Pass the names above with `--wp-user` / `--dash-user`.
2. **Two repos, two stacks, two host folders.** Retail is this repo in `~/sillage`. Wholesale is
   [unseencurtain/sillage-b2b](https://github.com/unseencurtain/sillage-b2b) in
   `~/sillage-wholesale`. Never cross them.
3. **Never clone live WordPress or MariaDB.** Fresh installs only, via `wp-fresh-install.php`.
4. **Photos come from `ovhe`, not from vendors.** Retail product images are scraped JPEGs
   (~390 MB, ~4200 files) that exist on no vendor feed. Copy them with
   `--media-from ovhe`. Wholesale has no media directory — its images are remote
   `flask_front` URLs from the wholesale-perfumes catalogue.
5. **The catalogue stays empty until the operator presses Rebuild catalogue.** WordPress gets
   set up first — pages, menus, theme, shipping, payment. Both schedulers decline every tick
   until one import has succeeded. Do not "helpfully" start a sync.
6. **Images are pulled from Hub, built on the VPS.** Never `docker build` in an agent VM or on
   a laptop; `docker login` lives on the VPS.
7. **Wholesale dispatch stays sandboxed.** `orders_dry_run=1`, `orders_auto_dispatch=0`.
8. **Finish by verifying with curl and reporting a table** of every hostname with its DNS answer
   and HTTPS status. "It should work" is not a result.

---

## 2. The rebuild, in stages

Two hand-offs are deliberate. Everything a script can do is scripted; the theme and the first
import are the owner's, because the paid Blocksy companion is uploaded by hand and the shop
should look right before 51,000 products land in it.

### Stage 0 — host (automated)

```bash
ssh root@NEW_IP 'bash -s' < production-environment/scripts/bootstrap-host.sh
```

Docker, Compose, Caddy, ufw, the `ubuntu` user, and 4 GB of swap.

### Stage 1 — DNS (owner, then verified here)

Five A records → the new IP, entered as **labels**: `@`, `images`, `sillage`, `wholesale`,
`sillage-wholesale`. See §4 — pasting full hostnames is the trap that cost the first rebuild.
The deploy refuses to start until all of them resolve to the box, so this cannot be skipped.

### Stage 2 — retail stack (automated)

```bash
./production-environment/scripts/deploy-vps.sh \
  --host ovh \
  --shop codeinmoon.xyz \
  --dash sillage.codeinmoon.xyz \
  --images images.codeinmoon.xyz \
  --wp-user cherry --dash-user europa \
  --media-from ovhe
```

Ends with: WordPress installed (WooCommerce, HPOS, permalinks, EUR, coming-soon off, Blocksy
theme, shop page as front page), the ~4,200 product photos in place and served over
`images.…`, the bridge plugin active, the sitemap cron installed, **and an empty catalogue**.

### Stage 3 — theme and WordPress setup (owner) — work stops here

Hand over `~/creds-retail.txt` and wait. The owner uploads `blocksy-companion-pro.zip` in
Plugins → Add New → Upload, activates it, and sets up the theme, homepage, menus and shipping.
`FS_METHOD` is pinned to `direct` so the upload never asks for FTP credentials, and the
installer activates whichever companion directory it finds, so nothing here needs a redeploy.

### Stage 4 — wholesale stack (automated)

```bash
cd ../sillage-b2b
./production-environment/scripts/deploy-vps.sh \
  --host ovh \
  --shop wholesale.codeinmoon.xyz \
  --dash sillage-wholesale.codeinmoon.xyz \
  --wp-user orange --dash-user wildwest
```

No photos: wholesale images are remote vendor URLs. Same end state, empty catalogue.

### Stage 5 — wholesale theme setup (owner) — work stops here

### Stage 6 — first import (owner presses the button, verified here)

The owner presses **Rebuild catalogue** on each dashboard. On an empty shop that starts
immediately; with a catalogue already present and the schedule on, it queues and the next tick
runs it. Then the checks in §3.

Measured on the 2 vCPU box: retail 51,203 products in about two minutes, wholesale 19,073 in
about two and a half.

---

## 3. Postflight — what "done" means

```bash
for h in codeinmoon.xyz images.codeinmoon.xyz sillage.codeinmoon.xyz \
         wholesale.codeinmoon.xyz sillage-wholesale.codeinmoon.xyz; do
  printf '%-34s dns=%-16s https=%s\n' "$h" \
    "$(dig +short "$h" A | head -1)" \
    "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 25 "https://$h/")"
done
```

- Four sites return 200; the media host returns 200 for a known file (`/` is 404, there is no
  index).
- Both dashboards accept their operator login.
- `swapon --show` lists `/swapfile`.
- `crontab -l` lists `write-sitemaps.py`.
- Both WordPress containers report the version pinned in `wordpress-image/Dockerfile`.
- Both catalogues are empty and both cron ticks log *no sync has ever succeeded*.

---

## 4. What may be bind-mounted, and what may not

A bind mount is an interface between the host and a container. Anything mounted that way can be
moved, replaced or edited behind the container's back, and that is exactly how this project lost
an afternoon. So the rule is: **a host path only where a host process genuinely takes part.**

| Path | Where it lives | Why |
|---|---|---|
| Product photos | host `data/media` | The scrapers write them and they are copied between boxes. |
| Sitemaps / robots | host `data/sitemaps` | The host's Caddy serves these files directly. |
| `php.ini`, `mariadb.cnf`, nginx and Caddy configs | host, read-only | Config the operator edits and a container only reads. |
| Engine logs, vendor feed cache, secrets overlay | host | Read while debugging; feeds double as offline fixtures. |
| **WordPress (`/var/www/html`)** | **Docker volume** | Core belongs to the image. A host copy is how a datadir drifted to a newer WordPress than the image it booted from. Plugins and themes the operator uploads persist in the volume. |
| **MariaDB (`/var/lib/mysql`)** | **Docker volume** | Raw InnoDB files. Hard rule 1 already forbids touching them, so they should not be reachable. |

Development is the exception, and it is a one-line exception: set `WP_DATA` and `WP_DB_DATA` to
host paths and both go back to being bind mounts for editing.

Because WordPress is a volume, the deploy no longer writes into a host `wp-content`. Plugins and
themes are unpacked into a staging directory and copied in with `docker cp`; `wp-config.php` is
patched by `scripts/wp-config-patch.php` running inside the container; `--clone-from` is gone,
since cloning a live datadir was both forbidden and the source of the drift.

## 5. What went wrong the first time, and what now prevents it

Each of these cost real time on `ovh`. The fix is in code, not in memory.

### Deployed a stale WordPress image

Both shops came up on WordPress 7.0.2 from a repo that pins 7.1. The tag `d35613d` was chosen
because the live box runs it — but a tag on a running box says nothing about that box's files.
`ovhe`'s datadir had been upgraded in place afterwards, so the image reads 7.0.2 while the shop
it serves reads 7.1.

*Lesson:* verify image **contents**, never a tag's reputation.
*Guard:* both deploy scripts read `/usr/src/wordpress/wp-includes/version.php` out of the image
and refuse to continue on a mismatch.

### Let the engine import 51,000 products nobody asked for

The scheduler read an empty `sil_sync_runs` as "seed the catalogue" and started five minutes
after boot, into a WordPress that had no pages or shipping set up.

*Lesson:* before starting a stack, know what its cron does on the **first** tick, not the steady
state.
*Guard:* both schedulers skip until one run has succeeded. Seeding is the dashboard's
**Rebuild catalogue** and nothing else.

### No swap, so the kernel killed Apache mid-import

The wholesale full sync peaks near 2 GB of Bun heap. On 3.7 GB shared with two MariaDB instances
and two WordPress containers, the OOM killer fired every five minutes and the storefront timed
out. `ovhe` never had this problem because someone had given it 2 GB of swap by hand, years
before, and no script recorded that.

*Lesson:* when a rebuild misbehaves and the original does not, diff the **host**, not the app —
swap, cron, sysctl, mounts.
*Guard:* `bootstrap-host.sh` and both deploy scripts create 4 GB of swap with
`vm.swappiness=10`.

### Caddy served sitemaps from a directory nothing wrote

`deploy-vps.sh` created `data/sitemaps` and pointed Caddy at it for `robots.txt` and
`wp-sitemap*.xml`, but only `ovhe`'s hand-added crontab entry ever filled it.

Worse, the script's own defaults were the live box's: it wrote to `~/ecom_sites/data/sitemaps`
(the fresh layout is `~/sillage/data/sitemaps`) and advertised `prinscosmetic.eu` in
`robots.txt`. Both are silent — Caddy just keeps serving an empty directory, and Google is
pointed at another shop.

*Lesson:* a default that encodes one host is a landmine on the second host. Pass the values.
*Guard:* the retail deploy installs the cron with `SITEMAP_HOST_DIR` and `WP_BASE_URL` set
explicitly and runs it once; `write-sitemaps.py` now detects the layout instead of assuming it.

### Homepage redirected to a random product

`wp-fresh-install.php` never set a front page. With `show_on_front` left on posts, WordPress
guessed a permalink for `/` and 301'd the homepage to whichever product owned that post ID.

*Guard:* the installer sets the WooCommerce shop page as the front page.

### Blocksy's companion was never activated

The installer activated `blocksy-companion/…` while the image ships
`blocksy-companion-pro/…`, so it silently did nothing.

*Guard:* the installer activates whichever directory exists.

### Chased DNS symptoms instead of checking DNS

Four hostnames were entered into a DNS panel whose host field appends the zone, producing
`sillage.codeinmoon.xyz.codeinmoon.xyz`. The doubled name resolved, the real one returned
NXDOMAIN, Let's Encrypt refused to issue, and the browser reported a bare connection failure —
which reads like a broken server, not a missing record. This was diagnosed only after
certificates failed.

*Lesson:* resolve every hostname **before** deploying, and compare the answer to the target IP.
*Guard:* both deploy scripts do exactly that and print the record to add, label-only, then stop.

### Invented hostnames to work around it

The doubled names were briefly served so the dashboards were reachable. That was confusing and
not asked for.

*Lesson:* fix the cause or report the blocker. Do not add hostnames nobody chose.

### The operator could queue the first import but nothing would run it

Gating the scheduler against unattended seeding was right, but **Rebuild catalogue** parks a flag
for the next scheduled call, and the gate declined every call until a sync had succeeded. On a
shop with products and the schedule on, the two deadlocked: the button reported "queued" forever.

*Lesson:* a gate and a queue must agree about who is allowed to break the tie.
*Guard:* an operator-queued rebuild now outranks the never-synced gate, with a test for it. An
unattended tick still refuses to seed.

### Every sitemap URL 404'd while the shop looked fine

The writer built a temp directory and renamed it over the target. The target is a bind mount, and
unlinking a mount point fails with EBUSY, so the write failed on every sync — logged as a warning
next to a successful import, which is easy to read past. The host script had the same swap and was
worse: replacing the directory orphaned the mount inside every running container.

*Lesson:* atomic-directory-swap is wrong for any path a container mounts. Swap files instead.
*Guard:* both writers move files into the directory, pages before the index, pruning pages a
smaller catalogue no longer references.

### The wholesale bridge pointed at a database that did not exist

`wp-config.php` on the wholesale shop defined `SILLAGE_DB` as `sillage` — the retail name — while
that server only has `sillage_wpf`. An early install wrote the default and the patcher only ever
*inserted* constants, never corrected one that was already present, so it never converged.

*Lesson:* a config patcher that cannot fix a wrong value is a patcher that hides drift.
*Guard:* `wp-config-patch.php` refreshes each constant it owns and is idempotent.

### Brought the wholesale stack up by hand, so the box drifted from the script

The wholesale shop on `ovh` was assembled with ad-hoc commands and `/tmp` scripts rather than by
running the b2b repo's own `deploy-vps.sh`. It works, but it landed in `~/wholesale-sillage`
while the script deploys to `~/sillage-wholesale`, and none of those steps are reproducible.

*Lesson:* if a bring-up needs a step the script does not have, add it to the script and run the
script. A shell history is not a deployment.
*Canonical path:* `~/sillage-wholesale`, which is what the next rebuild will produce. The
currently running box is the odd one out.

### Stale object cache hid the fix

After correcting `page_on_front`, the shop kept redirecting: the Redis object cache still held
the old option. Flushing Valkey is part of changing any WordPress option by SQL.

*Guard:* flush `valkey` / `wholesale-valkey` after direct option writes.
