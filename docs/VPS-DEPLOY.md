# Fresh VPS deploy — Sillage

End-to-end recipe for a **brand-new Ubuntu VPS** (nothing installed).  
Target: ~4 GB RAM, public IPv4, SSH key access. Tested on Ubuntu 24.04 / 26.04.

You run everything from your **laptop** in a clone of this repo. The VPS never needs you to paste secrets into chat logs.

---

## What you will have

| Piece | Example |
|---|---|
| Shop (WooCommerce) | `https://shop.example.com` |
| Dashboard (Sillage) | `https://ops.example.com` |
| Product images CDN | `https://images.example.com/<file>` (optional `--images`) |
| Passwords file (laptop only) | `.deploy/vps-dashboard-<ssh-host>.txt` |

**One compose + one env** on the VPS:

| Path | Role |
|---|---|
| `~/sillage/compose.yaml` | Entire stack (ecom, ecom-db, valkey, lps-media, sillage-core, sillage-cron) |
| `~/sillage/.env` | All secrets + image tags + domains |
| `~/ecom_sites/data/{wp,wp-db,media}` | Host volumes (WP, MariaDB, product images) |
| Host Caddy (`/etc/caddy/Caddyfile`) | TLS edge → `:104` / `:105` / `:4000` |

Images are pulled from Docker Hub (`unseencurtain/sillage-core:<sha>`, `unseencurtain/sillage-wordpress:<sha>`). Minimal rsync covers compose, config, plugin, and `image_overrides.json` only — **not** a full source-tree sync. After the first deploy, day-2 updates are Hub pull + that thin rsync.

---

## Prerequisites (laptop)

1. Git clone with vendor credentials:

   ```bash
   cp production-environment/.env.example production-environment/.env
   # Edit vendor keys + dashboard password placeholders
   ```

2. SSH key that can log in as **root** on the new VPS (bootstrap), then as **ubuntu** (deploy).

3. Docker Hub login on the laptop (`docker login`) so `build-push-images.sh` can push.

4. Two or three DNS names (A records) pointing at the VPS IP — or Porkbun API via `.deploy/porkbun.env` and `--dns`.

---

## Step 0 — Create the VPS

At Hetzner / OVH / etc.: Ubuntu 24.04+, ≥ 4 GB RAM, ≥ 40 GB disk, SSH key attached.  
Firewall: allow **22, 80, 443**.

---

## Step 1 — Bootstrap the host (as root, once)

```bash
ssh root@YOUR_VPS_IP 'bash -s' < production-environment/scripts/bootstrap-host.sh
```

Installs Docker + Compose plugin, Caddy, ufw, fail2ban, `ubuntu` user, and networks `ecom_network` / `redis_network`.

```sshconfig
Host my-sillage
    HostName YOUR_VPS_IP
    User ubuntu
    IdentityFile ~/.ssh/your-key.pem
    IdentitiesOnly yes
```

---

## Step 2 — DNS

| Name | Type | Value |
|---|---|---|
| `shop.example.com` | A | VPS IP |
| `ops.example.com` | A | VPS IP |
| `images.example.com` (optional CDN) | A | VPS IP |

---

## Step 3 — One-shot deploy

```bash
./production-environment/scripts/deploy-vps.sh \
  --host my-sillage \
  --shop shop.example.com \
  --dash ops.example.com \
  --images images.example.com \
  --dns \
  --ip YOUR_VPS_IP
```

### What the script does

1. Builds and pushes `sillage-core` + `sillage-wordpress` to Docker Hub (`:<git-sha>` and `:latest`)
2. Rsyncs `compose.yaml`, `ecom_sites/config/`, `sillage-bridge` plugin, `image_overrides.json`
3. Writes `~/sillage/.env` once (preserves secrets on later runs)
4. Writes host Caddyfile, `caddy validate` / `reload`
5. `docker compose pull && up -d` for the whole stack
6. Fresh WordPress install only when `wp-config.php` is missing (or `--fresh`)
7. Grants + `bun run migrate`
8. Saves dashboard login to **`.deploy/vps-dashboard-<host>.txt`**

Expect ~5–15 minutes the first time (image builds + pulls).

### Day-2 update (3–5 commands)

```bash
# from laptop / repo root
./production-environment/scripts/build-push-images.sh
./production-environment/scripts/deploy-vps.sh \
  --host my-sillage \
  --shop shop.example.com \
  --dash ops.example.com \
  --images images.example.com \
  --skip-build   # if you already pushed
```

Or on the VPS after images are on Hub and compose/env are current:

```bash
ssh my-sillage 'cd ~/sillage && docker compose --env-file .env pull && docker compose --env-file .env up -d && docker exec sillage-core bun run migrate'
```

---

## Step 4 — Verify

```bash
cat .deploy/vps-dashboard-my-sillage.txt

curl -sS -o /dev/null -w "%{http_code}\n" https://shop.example.com/
curl -sS -o /dev/null -w "%{http_code}\n" https://ops.example.com/
curl -sS -o /dev/null -w "%{http_code}\n" https://images.example.com/<known-file>.jpg
```

```bash
ssh my-sillage '
  docker ps
  curl -sS http://127.0.0.1:4000/health
  docker inspect sillage-core --format "{{.Config.Image}}"
'
```

Checklist:

- [ ] Shop and dashboard return **200** over HTTPS  
- [ ] Dashboard login works  
- [ ] Overview page loads  
- [ ] Settings → **Orders dry-run** is **on** for demos  
- [ ] `images.*` CDN serves files from `~/ecom_sites/data/media`  

---

## Local development (same compose)

```bash
docker network create ecom_network
docker network create redis_network

cp production-environment/.env.example production-environment/.env
# fill MYSQL_* / SILLAGE_* / vendor keys

# optional: build local tags instead of pulling Hub
docker build -t unseencurtain/sillage-wordpress:latest production-environment/wordpress-image
docker build -t unseencurtain/sillage-core:latest production-environment/sillage-core

cd production-environment
docker compose --env-file .env --profile local up -d
docker exec sillage-core bun run migrate
```

`shop-gateway` (profile `local`) serves `http://localhost` and `/lps-media/*`. VPS uses host Caddy instead — do not enable the local profile there.

---

## Security notes

| Item | Expectation |
|---|---|
| Secrets | Only in `~/sillage/.env` and laptop `.deploy/` — never commit |
| Ports | Caddy :80/:443 public; app ports on `127.0.0.1` only |
| Money | Vendor order APIs have no sandbox; keep dry-run on until intentional |
| Images | Prefer Hub pulls; never commit Docker Hub tokens |

---

## Common failures

| Symptom | Fix |
|---|---|
| `ERR_NAME_NOT_RESOLVED` | DNS / local cache |
| Dashboard SQL denied | Re-run deploy (grants) or apply `ecom_sites/config/sillage-grants.sql` |
| Image pull denied | `docker login` on laptop; confirm `SILLAGE_CORE_IMAGE` / `WORDPRESS_IMAGE` in `.env` |
| Let’s Encrypt fail | DNS must point here; 80/443 open |
| Old split stack still running | Deploy stops `~/redis` + `~/ecom_sites` compose projects before starting `~/sillage` |

---

## Scripts reference

| Script | Role |
|---|---|
| `scripts/bootstrap-host.sh` | Fresh OS → Docker + Caddy + ubuntu user |
| `scripts/build-push-images.sh` | Build/push Hub images |
| `scripts/deploy-vps.sh` | App deploy / update |
| `scripts/porkbun-dns.sh` | A-record upsert (`--dns`) |
| `scripts/vps-bootstrap.sh` | Remote DB user + wp-config Sillage constants |
| `wordpress-image/Dockerfile` | WordPress + Redis PHP extension |

Canonical product facts: [`CONTEXT.md`](CONTEXT.md).

---

## Production (`ovh`) cutover — commands only

Do **not** run these until staging (`ovhe`) is green and the operator explicitly
asks to cut over. Exact laptop commands (adjust domains/IP):

```bash
# 1) Ensure laptop production-environment/.env has all vendor + Hub keys
cp -n production-environment/.env.example production-environment/.env

# 2) Build/push tip images
./production-environment/scripts/build-push-images.sh

# 3) Deploy to production host (example alias `ovh`)
./production-environment/scripts/deploy-vps.sh \
  --host ovh \
  --shop shop.YOUR_DOMAIN \
  --dash ops.YOUR_DOMAIN \
  --images images.YOUR_DOMAIN \
  --skip-build \
  --ip YOUR_PROD_IP

# 4) Verify
ssh ovh 'cd ~/sillage && docker compose --env-file .env ps && curl -sS http://127.0.0.1:4000/health'
```

Single env on prod must be `~/sillage/.env`. Keep Settings → Orders dry-run **on**
until intentional live dispatch. `wholesale-perfumes` stays inactive until toggled
in the dashboard (migration seeds `active=0`).
