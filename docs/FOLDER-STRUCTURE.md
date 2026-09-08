# Folder structure

Two trees matter: **this GitHub repo** (code + docs) and the **live VPS** (compose, data,
secrets). They are not the same. The VPS is not a full git clone.

---

## GitHub repository (`unseencurtain/Sillage`)

```
Sillage/
├── AGENTS.md                          Agents: hard rules + read order
├── README.md                          What the repo is + how to run
├── docs/
│   ├── CLIENT-GUIDE.md                Humans: how to use shop + dashboard
│   ├── DOMAIN-MIGRATION.md            Humans: change shop/dash/image hostnames
│   ├── FOLDER-STRUCTURE.md            This file
│   ├── VPS-DEPLOY.md                  Fresh VPS from zero
│   ├── VPS-MIGRATE.md                 New VPS (copy data / restore photos)
│   ├── HANDOFF.md                     Resume after a gap
│   ├── OPERATOR-DASHBOARD.md          Engineers: every UI control
│   ├── CONTEXT.md                     Schema + container facts
│   ├── AGENTS-RUNBOOK.md              Agent loop
│   ├── EAN-IMAGE-SCRAPE.md            Missing photos: fill by EAN only
│   └── …
├── production-environment/
│   ├── compose.yaml                   The only compose file (retail stack)
│   ├── .env.example                   All env keys (copy to .env, never commit)
│   ├── scripts/
│   │   ├── deploy-vps.sh              Empty VPS: core + WordPress + HPOS
│   │   ├── wp-fresh-install.php       First-boot WooCommerce / HPOS / permalinks
│   │   ├── vps-bootstrap.sh           DB grants + wp-config SILLAGE_* defines
│   │   ├── build-push-images.sh       Hub build on the VPS (default core+WP)
│   │   └── bootstrap-host.sh          Docker + Caddy + unzip on a blank Ubuntu
│   ├── sillage-core/                  Bun API, sync, React dashboard
│   │   ├── data/image_overrides.json  EAN → photo URL (in git)
│   │   └── data/found-images-manifest.json
│   ├── ecom_sites/
│   │   ├── config/                    php.ini, Apache hide-version, MariaDB, lps-media nginx
│   │   └── data/wp/wp-content/plugins/sillage-bridge/   only WP path in git
│   ├── python-analysis/               Photo matcher / restore / EAN scrape
│   │   └── ean-image-scrape/          Export missing + EAN-only download
│   └── wordpress-image/
└── tools/images/brasty/               Optional Playwright scrape
```

**Not in git:** `.env`, dashboard password, `secrets.overlay.env`, WordPress/MariaDB files,
`ecom_sites/data/media/**` (the JPEG bytes), Brasty dump.

---

## Live VPS (`ubuntu@139.99.61.71`) — still combined until wholesale cutover

Retail from this repo lives in `~/sillage/`. Wholesale currently still runs on the **same box**
from the old combined compose until it is cut to [sillage-b2b](https://github.com/unseencurtain/sillage-b2b).
A **new retail VPS** must not copy that combined layout: `deploy-vps.sh` brings up ecom / ecom-db /
valkey / lps-media / sillage-core only.

```
/home/ubuntu/
├── sillage/                           Retail app (compose + env + thin binds)
│   ├── .env
│   ├── compose.yaml
│   ├── .feedscratch/
│   ├── scripts/                       vps-bootstrap.sh, wp-fresh-install.php, build-push-images.sh
│   ├── wordpress-image/               Pinned WP 7.1 Dockerfile (copied for Hub builds)
│   ├── sillage-core/
│   │   ├── data/image_overrides.json
│   │   ├── data/secrets.overlay.env
│   │   └── logs/
│   └── ecom_sites/config/
├── ecom_sites/data/
│   ├── wp/                            Retail WordPress
│   ├── wp-db/                         Retail MariaDB (earth + sillage)
│   ├── media/                         Shop CDN photos
│   └── sitemaps/                      robots + wp-sitemap*.xml (Caddy)
└── caddy/Caddyfile                    Symlink → /etc/caddy/Caddyfile
```

## Empty / test VPS (`ubuntu@51.79.255.226`, hostname `ovh`)

Two host folders, two GitHub repos, Docker Hub images only. Do not clone live WordPress
or MariaDB. The only copy from ovhe is the retail JPEG folder.

```
/home/ubuntu/
├── sillage/                           Retail (unseencurtain/Sillage)
│   ├── .env
│   ├── compose.yaml
│   ├── ecom_sites/config/
│   ├── sillage-core/data/             secrets overlay + image_overrides.json
│   └── data/
│       ├── media/                     Hosted bottle JPEGs (from ovhe)
│       ├── wp/
│       ├── wp-db/
│       └── sitemaps/
└── sillage-wholesale/                 Wholesale (unseencurtain/sillage-b2b)
    ├── .env
    ├── compose.yaml
    ├── ecom_sites/config/
    ├── sillage-core/data/
    └── data/                          wp + wp-db + sitemaps — no media/
```

Hub tags on a test box should match the **running** ovhe engines
(`sillage-core`, `sillage-b2b`) and the **running** WordPress image (`sillage-wordpress:d35613d`
until a deliberate WP rebuild). Do not point wholesale at `sillage-core:*`.

---

Docker reads (retail):

| Container | Host path |
|---|---|
| `ecom` | `~/ecom_sites/data/wp` + `~/sillage/ecom_sites/config/php.ini` |
| `ecom-db` | `~/ecom_sites/data/wp-db` (retail only) |
| `lps-media` | `~/ecom_sites/data/media` |
| `sillage-core` / `sillage-cron` | overrides + secrets + logs + `~/sillage/.feedscratch` |

Host Caddy (`/etc/caddy/Caddyfile`) is **not** inside `~/sillage`. On an empty retail VPS it
proxies `:104` (shop), `:4000` (dashboard), `:105` (images). On ovhe until wholesale cutover it
also proxies `:106` / `:4001`. Shop sites must 403 AI training crawlers — snippet
[`ecom_sites/config/caddy-heavybot.snippet`](../production-environment/ecom_sites/config/caddy-heavybot.snippet),
story [`CRAWLER-SHIELD.md`](CRAWLER-SHIELD.md). The images site strips `Server` / `Via`
and `lps-media` 404s are plain text (no nginx version).

---

## What we removed from the VPS (leftovers)

These were **not** used by the running stack after the single-compose move:

| Path | Why it went |
|---|---|
| `~/sillage-core/` | Old split-tree copy (live binds are under `~/sillage/sillage-core/`) |
| `~/redis/` | Legacy compose; Valkey is in `~/sillage/compose.yaml` |
| `~/wordpress-image/` (orphan) | Old leftover; the real Dockerfile is `~/sillage/wordpress-image/` copied for Hub builds |
| `~/Sillage/` | Only existed for `.feedscratch`; cache now lives in `~/sillage/.feedscratch` |
| `~/vps-bootstrap.sh` | Duplicate; real script is `~/sillage/scripts/vps-bootstrap.sh` |
| `~/ecom_sites/compose.yaml*` + `.env.legacy-unused` | Old split compose (do not `compose up` from here) |
| `~/sillage/.env.bak-wrong-domains-*` | Stale env scrap |
| `~/ovhe-backup/{home,images,database,…}` | Extracted copy of the zip — zip kept |
| `~/ecom_sites/config/` | Unused after the move to `~/sillage/ecom_sites/config/` |
| `~/ecom_sites/compose.yaml*` + `wp-state` + `snapshots/` | Old split compose and unused WP snapshots |
| `~/ecom_sites/.env.legacy-unused` | Leftover split-env scrap |

**Never delete:** `~/sillage/.env`, `~/sillage/sillage-core/data/secrets.overlay.env`,
`~/ecom_sites/data/`.
