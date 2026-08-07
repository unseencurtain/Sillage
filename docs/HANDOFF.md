# HANDOFF — pick up after a month

Canonical resume doc for operators and agents. Read this first, then [`CONTEXT.md`](CONTEXT.md) for
schema facts and [`OPERATOR-DASHBOARD.md`](OPERATOR-DASHBOARD.md) for UI controls.

---

## Where things are

| Item | Location |
|---|---|
| **Live VPS** | SSH `ovhe` — `ubuntu@139.99.61.71`, hostname `ovh-experi`. App dir `~/sillage/`; data `~/ecom_sites/data/`. |
| **Unused VPS** | SSH `ovh` — `51.79.255.226`. Empty; do not deploy here unless deliberately repurposed. |
| **Public URLs** | Shop `https://cosmetic.slilverbelt.xyz` · Dashboard `https://sillage.slilverbelt.xyz` · Images `https://images.slilverbelt.xyz` |
| **Single env** | Laptop `production-environment/.env` → VPS `~/sillage/.env` (same shape; gitignored) |
| **Compose** | `production-environment/compose.yaml` only |
| **Hub images** | `unseencurtain/sillage-core:<tag>`, `unseencurtain/sillage-wordpress:<tag>` |
| **Tag baseline** | `pre-scratch-20260808` — restore marker before catalogue wipe + B2B split ([`SCRATCH-RESET.md`](SCRATCH-RESET.md)) |
| **B2B (later)** | [unseencurtain/sillage-b2b](https://github.com/unseencurtain/sillage-b2b) · local pointer `b2b-wholesale/` |
| **Operator UI guide** | [`OPERATOR-DASHBOARD.md`](OPERATOR-DASHBOARD.md) |
| **Deploy recipe** | [`VPS-DEPLOY.md`](VPS-DEPLOY.md) |

---

## Product decisions (do not reverse casually)

- **Retail shop = BeautyFort + BTS only.** wholesale-perfumes (WPF/B2B) is parked — inactive,
  excluded from `--vendor=all`, no `/b2b-wholesale` on this WordPress install.
- **No LPS\*** as `product_cat` or visible product attributes. Internal `_sillage_vendor` postmeta
  only; storefront labels LPS01/LPS02 live in `sil_vendors.storefront_label`.
- **B2B is a separate project** — own compose / own repo when ready; not bolted onto this shop.
- **`orders_dry_run` stays `1`** unless you intentionally dispatch live vendor orders (no sandbox).
- **Images:** host volume `~/ecom_sites/data/media` → `lps-media`; public CDN
  `images.slilverbelt.xyz`. Brasty Playwright crawl may still run on the laptop
  (`tools/images/brasty/`).
- **Theme target: Kadence.** Bridge must stay theme-agnostic; Blocksy-specific shims are legacy,
  not the long-term model. Lots of shop UI belongs in **sillage-bridge**, not the theme.

---

## Next work (priority)

1. **Polish retail UI for Kadence** — replace Blocksy-specific assumptions; guarded theme shims only.
2. **More shop UI through sillage-bridge** — filters, catalog helpers, cart/checkout polish.
3. **B2B separately** — new stack in [sillage-b2b](https://github.com/unseencurtain/sillage-b2b);
   own compose; do not expand this retail repo for WPF.

Polish **this retail shop (BF+BTS) first.** B2B later on its own infrastructure.

---

## Commands cheat sheet

### Deploy / update (from laptop)

```bash
./production-environment/scripts/deploy-vps.sh \
  --host ovhe \
  --shop cosmetic.slilverbelt.xyz \
  --dash sillage.slilverbelt.xyz \
  --images images.slilverbelt.xyz \
  --skip-build   # omit to build+push Hub images first
```

Day-2 pull on VPS: `ssh ovhe 'cd ~/sillage && docker compose --env-file .env pull && docker compose --env-file .env up -d'`

Full recipe: [`VPS-DEPLOY.md`](VPS-DEPLOY.md). Dashboard login file: `.deploy/vps-dashboard-ovhe.txt`.

### Sync (operator)

Dashboard **Overview** or **Sync** → **Run sync now** (`POST /api/sync/run`, BF+BTS fast sync).
CLI offline: `cd production-environment/sillage-core && bun run sync -- --source=local --vendor=all`.

### Secrets overlay (vendor API keys)

| Where | Path |
|---|---|
| VPS | `~/sillage/sillage-core/data/secrets.overlay.env` |
| Laptop | `production-environment/sillage-core/data/secrets.overlay.env` |
| Container | `/app/data/secrets.overlay.env` (`SILLAGE_SECRETS_FILE`) |

Set/clear via dashboard **Secrets** (overlay wins over compose `.env`). `touch` the file before
first `compose up` so Docker bind-mounts a file, not a directory.

### Migrate

```bash
# VPS
ssh ovhe 'docker exec sillage-core bun run migrate'

# Local dev
cd production-environment/sillage-core && bun run migrate
```

### Local dev stack

```bash
cd production-environment/sillage-core && bun install && bun run dev   # :4000
cd production-environment && docker compose --env-file .env up -d
```

See [`AGENTS.md`](../AGENTS.md) for hard rules (no PHP product writes, HPOS, dry-run safety).
