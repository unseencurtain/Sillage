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

## 2. The rebuild, in order

```bash
# 0. once, as root on the blank box — Docker, Caddy, ufw, ubuntu user, 4 GB swap
ssh root@NEW_IP 'bash -s' < production-environment/scripts/bootstrap-host.sh

# 1. DNS first. Five A records → the new IP. Enter the LABEL, never the FQDN (see §4).
#    @  images  sillage  wholesale  sillage-wholesale

# 2. retail, with the photos
./production-environment/scripts/deploy-vps.sh \
  --host ovh \
  --shop codeinmoon.xyz \
  --dash sillage.codeinmoon.xyz \
  --images images.codeinmoon.xyz \
  --wp-user cherry --dash-user europa \
  --media-from ovhe

# 3. wholesale, from the other repo
cd ../sillage-b2b
./production-environment/scripts/deploy-vps.sh \
  --host ovh \
  --shop wholesale.codeinmoon.xyz \
  --dash sillage-wholesale.codeinmoon.xyz \
  --wp-user orange --dash-user wildwest
```

Both scripts stop before building anything if a hostname does not already resolve to the box,
and both refuse a Hub tag whose bundled WordPress does not match the Dockerfile pin.

Then hand over the credentials from `~/creds-retail.txt` and `~/creds-wholesale.txt`, and leave
the catalogue empty.

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

## 4. What went wrong the first time, and what now prevents it

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
