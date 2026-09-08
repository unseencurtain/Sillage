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

Everything a script can do is scripted. Three things are deliberately the owner's, in this
order: **activation**, **customisation**, **the first import**. The paid Blocksy companion is
uploaded by hand, and the shop should look right before 51,000 products land in it.

So the deploy installs plugin and theme *files* and leaves every one of them **inactive**
(`wp-fresh-install.php` only activates when `WP_ACTIVATE_PLUGINS=1`, which the deploy does not
set). The owner activates what they want, customises, and then `--finish` re-checks the settings
the engine and orders depend on before anything is imported.

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

Ends with: WordPress installed and reachable, the shop options written (HPOS, permalinks, EUR,
coming-soon off), WooCommerce / redis-cache / sillage-bridge / Blocksy **present but inactive**,
the ~4,200 product photos in place and served over `images.…`, the sitemap cron installed,
**and an empty catalogue**.

### Stage 3 — activation and WordPress setup (owner) — work stops here

Hand over both logins from `.deploy/vps-dashboard-<host>.txt` — the WordPress pair
(`wp_admin_user` / `wp_admin_password`) and the dashboard pair — and wait. That file is written by
the deploy and is the only copy outside the server's `.env`. The owner uploads
`blocksy-companion-pro.zip` in
Plugins → Add New → Upload, activates the plugins and the theme, and sets up the homepage, menus
and shipping. `FS_METHOD` is pinned to `direct` so the upload never asks for FTP credentials.

Activating WooCommerce is what creates its tables and pages, so it has to happen before any
import — that is what stage 3.5 confirms.

### Stage 3.5 — readiness check (automated, after the owner is done)

```bash
./production-environment/scripts/deploy-vps.sh \
  --host ovh --shop codeinmoon.xyz --dash sillage.codeinmoon.xyz --finish
```

Three things happen, and **the order matters**:

1. `wp-readiness.php` prints one line per prerequisite and repairs the *options* — HPOS,
   permalinks, EUR, coming-soon off, and a real page on `/`. It also verifies the four HPOS order
   tables **exist**, rather than trusting the option that claims they do, and asks
   `WC_Install::create_tables()` for them when they do not. Plugin and theme activation is
   reported and never changed, so a half-customised shop is not overridden.
2. `apply-grants.sh --strict` re-applies the engine's database grants and verifies every one
   against `mysql.tables_priv` / `mysql.db`. This is not belt-and-braces: MariaDB **refuses a
   table-level `GRANT` on a table that does not exist** (ERROR 1146) and stops reading the file
   there, so a deploy that ships WooCommerce inactive can only grant the WordPress core tables.
   The nine `wp_wc_*` / `wp_woocommerce_*` grants can only be applied after activation — which is
   why readiness runs first: it is what creates the four order tables these grants need.
3. `wp-finalize.sh` invalidates WooCommerce's caches. If the catalogue was imported while Sillage
   Bridge was inactive, the products are committed but invisible — object caching holds
   WordPress's post counts with no expiry — and this is the stage right after activation, so it
   is where that gets cleared. Costs ~15s and needs no re-import.

Readiness and grants exit non-zero while anything required is still wrong, so the import is never
started on a shop that cannot hold it.

### Stage 4 — wholesale stack (automated)

```bash
cd ../sillage-b2b
./production-environment/scripts/deploy-vps.sh \
  --host ovh \
  --shop wholesale.codeinmoon.xyz \
  --dash sillage-wholesale.codeinmoon.xyz \
  --wp-user orange --dash-user wildwest
```

No photos: wholesale images are remote vendor URLs. Same end state, plugins inactive, empty
catalogue.

### Stage 5 — wholesale activation and setup (owner) — work stops here

Then the same readiness check from the b2b repo:

```bash
./production-environment/scripts/deploy-vps.sh \
  --host ovh --shop wholesale.codeinmoon.xyz --dash sillage-wholesale.codeinmoon.xyz --finish
```

It must report `sillage db  sillage_wpf`. Reading `sillage` there means the bridge is pointed at
the retail database — see §5.

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

- `--finish` reports `ready` for both shops, retail on database `sillage` and wholesale on
  `sillage_wpf`.
- Four sites return 200; the media host returns 200 for a known file (`/` is 404, there is no
  index).
- Both dashboards accept their operator login.
- `swapon --show` lists `/swapfile`.
- `crontab -l` lists **two** `write-sitemaps.py` lines, one per stack, each pointing at its own
  `scripts/` directory — and that file is actually present in both. A single line means the
  bare-filename guard bug is back; a missing file means the rsync was dropped again.
- `/wp-sitemap.xml` and `/robots.txt` return 200 on both shops, and each `robots.txt` advertises
  **its own** hostname. Check after the first import: the pages only exist once there are
  products.
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

*Guard:* the installer points `/` at the WooCommerce shop archive as a placeholder, and
`wp-readiness.php` requires `/` to resolve to a *published page*. The particular page is the
owner's: the live shop uses a hand-built "Home" page, not the shop archive, so the check accepts
any page and only fails on "latest posts" or a front page that points at a product.

### Blocksy's companion was never activated

The installer activated `blocksy-companion/…` while the image ships `blocksy-companion-pro/…`,
so it silently did nothing — and the failure was invisible because a `WP_Error` was printed
among a hundred other lines.

*Guard:* activation is now the owner's step, and `wp-readiness.php` reports the active theme and
each plugin's state as its own line, so "inactive" cannot hide. When `WP_ACTIVATE_PLUGINS=1` is
used for an unattended install, the installer activates whichever companion directory exists.

### Neither stack could own the Caddyfile

Both deploys wrote the whole of `/etc/caddy/Caddyfile`, with a check that skipped the rewrite when
the box already served someone else's hostname. On one box that means the second stack deployed is
never served: wholesale finished, printed "Deploy finished", and had no TLS for either of its
hostnames. The previous box only worked because the two configs had been merged by hand.

*Lesson:* when two components each need part of a shared file, neither can own it. *Guard:* each
stack writes exactly one `/etc/caddy/sites/<stack>.caddy`, the main Caddyfile only holds
`import /etc/caddy/sites/*.caddy`, and a monolithic Caddyfile is migrated to `sites/legacy.caddy`
once with the deploying stack's own blocks stripped, since Caddy rejects duplicate site addresses.
`--keep-caddy` and `--replace-caddy` are gone; there is nothing left to choose between.

Wholesale's block also still pointed `robots.txt` and `/wp-sitemap*` at
`/home/ubuntu/ecom_sites/data/sitemaps`, a path from before the host folders were renamed, so Caddy
would have served an empty directory. It uses `$DATA_DIR` now.

### A guard that asked the daemon instead of the file

The wholesale deploy refused to run: "This VPS already runs wholesale-ecom from ~/sillage (combined
live stack)." It was looking at its own containers, started by its own previous run twenty minutes
earlier. The intended check — is this box running the *combined* stack, where retail's compose file
also defines the wholesale containers — is a question about the compose file.

*Lesson:* a guard against a name collision has to ask what *claims* the name, not what currently
holds it, or the script stops being re-runnable. *Guard:* it greps retail's compose file for
`container_name: wholesale-`.

### The install gate asked the wrong question

The block deciding whether to install WordPress ran `wp_has_config || NEED_FRESH=1` — true only
when `wp-config.php` is missing. The loop immediately above it *waits up to three minutes for the
image entrypoint to create that exact file*. So on the first real rebuild the gate was already
false, and the whole install was skipped in silence: no WooCommerce, no Blocksy, no admin user,
and a shop serving the five-minute install screen. The deploy reported success for everything it
had not done.

*Lesson:* a gate that tests a file another step is waiting for is not a gate. Ask the question you
actually mean — is WordPress installed — of the thing that holds the answer. *Guard:*
`wp_installed()` counts the `wp_options` table in `information_schema`.

### The cron install died on a box with no crontab

`( crontab -l 2>/dev/null; echo "$SITEMAP_CRON" ) | crontab -` looks defensive. It is not: on a
machine that has never had a crontab, `crontab -l` exits non-zero, `set -e` kills the subshell
before the `echo`, `pipefail` propagates it, and the deploy aborts having installed an *empty*
crontab. The error was invisible because it went to `/dev/null`. Every earlier deploy passed
because the box already had a crontab from a previous run.

*Guard:* `{ crontab -l 2>/dev/null || true; echo "$SITEMAP_CRON"; } | crontab -`.

### A second deploy erased the WordPress password from the creds file

The first run writes `.deploy/vps-dashboard-<host>.txt` with both logins. The update branch — taken
on every subsequent run — rewrote the same file with only the dashboard pair, so the wp-admin
password existed nowhere but the server's `.env`.

*Lesson:* code that rewrites a file wholesale has to re-read everything in it. *Guard:* the update
branch reads the WordPress login back from the remote `.env` alongside the dashboard one.

Wholesale had it worse: it never wrote `WP_ADMIN_USER` / `WP_ADMIN_PASS` into the remote `.env` at
all, so when the second deploy rewrote the creds file the wholesale wp-admin password existed in no
file on either machine and had to be reset. Both scripts now persist it in `.env` and read it back.

### Hub images that predate the fix they are supposed to carry

`sillage-core:latest` and `sillage-b2b:latest` were both built *before* the scheduler fix that
lets an operator-queued rebuild start on a shop that has never synced. Deploying from them would
have reproduced the original complaint exactly — pressing **Rebuild catalogue** and nothing
happening — with the repo, the docs and the retrospective all claiming it was fixed.

*Lesson:* "the fix is committed" and "the fix is in the image the VPS boots" are different
statements. The WordPress version guard existed for precisely this reason and covered only
WordPress. *Guard for now:* both engine images are rebuilt from the checkout and pinned in `.env`
by commit SHA, never `:latest`, and the image is grepped for the fix before deploying.

### Grants that cannot be applied before WooCommerce exists

Found while making activation manual, before it could bite. Retail's grants are deliberately
narrow — table-level, no DDL, nothing on `wp_users` — and MariaDB refuses a table-level `GRANT`
for a table that does not exist, then stops reading the file. With WooCommerce inactive at deploy
time, the `wp_wc_*` grants cannot be applied, and the import would have connected fine and then
died on its first write to a lookup table. Wholesale is unaffected: its grants are
database-level, which apply before the tables exist.

*Guard:* `apply-grants.sh` applies with `--force`, then verifies each grant against
`mysql.tables_priv` and `mysql.db` and labels it `ok`, `pending` (table not created yet) or
`MISSING`. The deploy runs it in report mode; `--finish` runs it `--strict` after activation.

### A fallback that could not work

The wholesale deploy looked for `sillage-grants-wholesale.sql` and quietly fell back to retail's
`sillage-grants.sql` when it was absent. That fallback can never work: retail's grants name the
`earth` database, which does not exist on `wholesale-db`. It would have applied nothing and said
nothing.

*Lesson:* a fallback that cannot work is worse than no fallback, because it turns a missing file
into a mystery about the engine. *Guard:* a missing wholesale grants file is now a hard error.
(The file itself was committed all along — a truncated directory listing during this review
suggested otherwise, which is its own reminder to check before concluding.)

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

### A successful import of 51,201 products that showed an empty shop

The owner rebuilt the retail catalogue before activating Sillage Bridge. The run reported
`51201 created`, the database held all 51,201 products published with `wp_wc_product_meta_lookup`
fully populated — and both the storefront and the WooCommerce Products screen showed nothing.

Raw SQL writes are invisible to WooCommerce's caches, so the engine calls the bridge's
`/finalize` at the end of a run to invalidate them. With the plugin off, the route does not
exist, and the call 404'd. `finalize` treated that as a warning on the stated grounds that
"the caches expire on their own" — true of transients, false of the object cache. With Valkey in
front of WordPress, `wp_count_posts` is cached with **no expiry**, so the shop reports zero
products for as long as it stays up. One WARN, mid-log, between two lines that looked like
success. The cure was a 15-second cache flush, not the 40-minute re-import it looked like.

This is a trap the staged design creates: we ship plugins inactive *on purpose* so the shop can
be styled while empty, which makes "imported before the bridge was on" a state we invite.

*Guards:* `finalize` logs at error level and spells out the fix, with 404 called out separately
because it has exactly one cause. `scripts/wp-finalize.sh` performs the flush, and
`deploy --finish` runs it — that stage is by definition right after activation.

### HPOS was enabled everywhere and existed nowhere

Both shops reported `woocommerce_custom_orders_table_enabled = yes` with **no order tables at
all**. The deploy writes that option before WooCommerce has ever been activated, and writing it
creates nothing: WooCommerce builds those tables from its own installer. Hard rule 4 puts orders
in `wp_wc_orders`, and neither box had one. Nothing would have surfaced this until the first
real order had nowhere to land — on wholesale, with a €300 minimum behind it.

On retail it did surface, indirectly and confusingly: `apply-grants.sh --strict` failed on four
`wp_wc_order*` tables. That was the symptom, and the ordering inside `--finish` made it a wall —
grants ran *before* readiness, but readiness is what creates those tables.

*Guards:* readiness checks the four tables physically rather than trusting the option, and calls
`WC_Install::create_tables()` under `WP_READINESS_FIX=1`. `--finish` runs readiness first.

### Two independent bugs, each hiding the other, and zero sitemaps

`/wp-sitemap.xml` served 403 on both shops. There are two routes to a sitemap and both were
broken, so neither could act as the other's fallback:

1. **The engine.** It staged files in `<dir>.tmp-<pid>`, a *sibling* of the sitemap directory.
   That directory is a bind mount, so the sibling lands on the container's overlay filesystem
   and every rename out of it crossed a device boundary: `EXDEV`. The per-file rename was itself
   a fix for an earlier `EBUSY` on unlinking the mount point — the staging location was never
   revisited. Staging in a dotted *child* puts both ends on one filesystem.
2. **The host cron.** The deploy installed a cron calling `scripts/write-sitemaps.py` and ran it
   once itself, but never rsynced the file. The log was three lines of `No such file or
   directory`.

Two more faults surfaced while fixing it, both specific to one box hosting both shops. The cron
guard grepped the bare filename, so whichever stack deployed first was the only one to get a
cron. And wholesale's `write-sitemaps.py` was an unmodified retail copy — `earth`, `ecom-db`,
`~/sillage/.env` — which would have published retail's catalogue as wholesale's sitemap.

*Guards:* staging inside the mount, with a sweep for `.tmp-*` left by a killed run; the script is
rsynced before anything schedules it; the cron guard matches this stack's own script path;
database, container and stack directory come from the environment; and `WP_BASE_URL` lost its
default rather than gaining a better one — it was another shop's domain, and wrong is worse than
absent when the value ends up in `robots.txt`.

### Wholesale wrote outside its own stack

`DATA_DIR` and `SITEMAP_HOST_DIR` were hardcoded to `/home/ubuntu/ecom_sites/data`, from when
wholesale shared the retail box's directory. With retail in `~/sillage` and wholesale in
`~/sillage-wholesale`, that is a third directory belonging to neither — and the deploy created
it, mounted it, and pointed Caddy at it.

*Guard:* both keys derive from the stack directory, and are corrected on update so an existing
box moves with a deploy instead of needing a hand.

### The dashboard re-derived a rule instead of reading the answer

Retail's Overview said 675 products were hidden for a missing photo. The real figure was 12,003.
Of 25,372 hidden products, 9,129 belonged to no reason at all, and the page showed that shortfall
without comment because nothing added the reasons up.

The hide-reason query tested `sil_offers.image_url = ''`. But an image_url is not a photo. The
writer runs `isUnusableImage` over it — rejecting placeholders, non-http values and BeautyFort's
tiny `/pic/` thumbs — and resolves through overrides and other vendors' offers before deciding.
Re-stating that rule as one SQL predicate could only ever be an approximation, and this one was
off by a factor of eighteen. The owner spotted it from the outside: the shop looked short of
photos in a way the dashboard did not admit to.

The fix is not a better predicate. `_external_thumbnail_url` is the writer's verdict already
recorded — a usable URL or empty, nothing else — so the dashboard reads it instead of recomputing
it. Verified across 51,201 live products: no placeholder, `/pic/` thumb or non-http value survives
in that meta. `scripts/export-missing-images.py` selects on the same column, which is why its row
count and the `hiddenNoImage` a sync reports are the same number rather than two estimates.

*Guard:* the tile now prints `N unattributed — please report this` whenever the reasons fall short
of the total. That line is the whole point of the fix. A wrong count is invisible; a count that
fails to add up is not, and this bug survived a full rebuild only because nothing on the page
contradicted it.

While chasing it, the drop in BeautyFort's product count that prompted the question turned out to
be real and not ours: the vendor's feed shrank. New-shop image coverage is marginally better than
the old box's. Worth stating, because "the dashboard was lying" and "we are losing products" were
the same report and only one of them was true.
