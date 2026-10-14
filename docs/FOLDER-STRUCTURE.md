# Sillage project layout

This repository contains application source, deployment scripts, docs, and tracked WordPress
plugins. The React storefront is a separate repository (`unseencurtain/storefront`), checked out
beside Sillage at `../react_store/frontend` for the one-command deployment script.

```text
Sillage/
├── docs/                         Runbooks, operator guide, and deployment chronology
├── production-environment/
│   ├── compose.yaml              Retail Docker Compose stack
│   ├── .env.example              Safe environment template; never store real secrets here
│   ├── scripts/                  Bootstrap, clean deploy, updates, and maintenance
│   ├── sillage-core/             Bun API, dashboard, sync, migrations
│   ├── ecom_sites/config/        Nginx, PHP, Apache, and MariaDB config
│   └── wordpress-image/          Pinned WordPress image build
└── .deploy/                      Local ignored credentials and scratch logs
```

## VPS layout

A fresh retail deployment lives under `~/sillage/`:

```text
~/sillage/
├── .env                         Host-specific settings and secrets
├── compose.yaml                 Compose definition
├── frontend/dist/               React storefront built on the laptop
├── sillage-core/web/dist/       Dashboard built on the laptop
├── ops/caddy/sillage.caddy      Editable Caddy site, linked into /etc/caddy/sites/
└── data/
    ├── wp/                      Bind-mounted WordPress files
    ├── wp-db/                   Bind-mounted MariaDB files
    ├── media/                   Bind-mounted static product photos
    └── sitemaps/                Generated sitemap and robots files
```

The scripts transfer required source/configuration and built frontend assets; they create a fresh
WordPress install and database. They do not copy the old host's runtime folder, database, `.env`, or
login credentials. `--media-from` copies product photos only. Vendor secrets are entered through
Dashboard → Secrets or copied through the explicitly allowlisted migration helper.

For setup order and verification, use [`NEW-VPS-PLAN.md`](NEW-VPS-PLAN.md). For the observed
steps and timing, see [`DEPLOYMENT-CHRONOLOGY.md`](DEPLOYMENT-CHRONOLOGY.md).
