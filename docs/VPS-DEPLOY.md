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

Stack: Caddy (TLS) → WordPress `:104` + `lps-media` `:105` + sillage-core `:4000`, MariaDB, Valkey, sillage-cron. Host bind-mount `ecom_sites/data/media/` into `lps-media`. Preferred image URLs use the images host (document root); shop `/lps-media/*` remains a fallback.

---

## Prerequisites (laptop)

1. Git clone of this repo with vendor credentials ready:

   ```bash
   cp production-environment/sillage-core/.env.example production-environment/sillage-core/.env
   # Edit: BEAUTYFORT_USER, BEAUTYFORT_SECRET, BTS_JWT_TOKEN, endpoints if needed
   ```

2. SSH key that can log in as **root** on the new VPS (providers usually give you this at create time).

3. Two DNS names (A records) pointing at the VPS IP — either create them yourself, or use Porkbun API (below).

4. Optional — Porkbun API for `--dns`:

   ```bash
   mkdir -p .deploy
   cat > .deploy/porkbun.env <<'EOF'
   PORKBUN_API_KEY=pk1_...
   PORKBUN_SECRET_KEY=sk1_...
   EOF
   chmod 600 .deploy/porkbun.env
   ```

   In Porkbun, enable **API access** for that domain.

---

## Step 0 — Create the VPS

At Hetzner / OVH / etc.:

- Ubuntu 24.04+ (or 26.04)
- ≥ 4 GB RAM, ≥ 40 GB disk
- Attach your SSH public key
- Note the **public IPv4**

Firewall on the provider side: allow **22, 80, 443** (or leave open; the bootstrap script enables ufw the same way).

---

## Step 1 — Bootstrap the host (as root, once)

From the repo root on your laptop:

```bash
ssh root@YOUR_VPS_IP 'bash -s' < production-environment/scripts/bootstrap-host.sh
```

This installs and configures:

- Docker Engine + Compose plugin  
- Caddy  
- ufw (22 / 80 / 443) + fail2ban  
- user `ubuntu` (sudo NOPASSWD + docker group), copies root’s `authorized_keys`  
- docker networks `ecom_network` and `redis_network`

Add an SSH config alias for the deploy user:

```sshconfig
Host my-sillage
    HostName YOUR_VPS_IP
    User ubuntu
    IdentityFile ~/.ssh/your-key.pem
    IdentitiesOnly yes
```

Check:

```bash
ssh my-sillage 'docker --version && caddy version && groups'
```

You should see `docker` in `groups`.

---

## Step 2 — DNS

Point both hostnames at `YOUR_VPS_IP` (TTL 600 is fine):

| Name | Type | Value |
|---|---|---|
| `shop.example.com` (or a subdomain) | A | VPS IP |
| `ops.example.com` | A | VPS IP |
| `images.example.com` (optional CDN) | A | VPS IP |

If using Porkbun + `.deploy/porkbun.env`, the next step’s `--dns` flag creates/updates these A records for you.

After creating records, if your laptop still shows `ERR_NAME_NOT_RESOLVED`:

```bash
resolvectl flush-caches   # Linux systemd-resolved
```

Public resolvers (1.1.1.1 / 8.8.8.8) often see new names before your ISP cache does.

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

Omit `--dns` if you already created the A records manually. Omit `--images` only if you will keep
serving product files solely under `https://shop…/lps-media/`.

### What the script does

1. Rsyncs `sillage-core`, `sillage-bridge`, redis compose, wordpress-image, grants SQL  
2. **Builds `lime/wordpress:latest` on the VPS** (`wordpress:latest` + PHP Redis) — does not copy an image from another server  
3. Writes remote `.env` files (DB passwords + dashboard password); mode `600`  
4. Writes Caddyfile, runs `caddy fmt` / `validate` / `reload`  
5. Starts Valkey → MariaDB → WordPress → sillage-core → sillage-cron  
6. Fresh WordPress install (empty catalogue)  
7. Installs WooCommerce, redis-cache, Blocksy from wordpress.org + activates sillage-bridge  
8. Applies `ecom_sites/config/sillage-grants.sql`  
9. Runs DB migrations  
10. Saves logins to **`.deploy/vps-dashboard-my-sillage.txt`** on the laptop (gitignored)

Expect ~5–15 minutes the first time (image pulls + builds).

---

## Step 4 — Verify

```bash
# Passwords
cat .deploy/vps-dashboard-my-sillage.txt

# From laptop (after DNS works)
curl -sS -o /dev/null -w "%{http_code}\n" https://shop.example.com/
curl -sS -o /dev/null -w "%{http_code}\n" https://ops.example.com/
# After media files exist on the host bind mount:
curl -sS -o /dev/null -w "%{http_code}\n" https://images.example.com/<known-file>.jpg
```

On the VPS:

```bash
ssh my-sillage '
  docker ps
  curl -sS http://127.0.0.1:4000/health
  docker exec sillage-core sh -c "mkdir -p /app/.feedscratch/cache && echo cache_ok"
'
```

Checklist:

- [ ] Shop and dashboard return **200** over HTTPS  
- [ ] Dashboard login works (`admin` + password from the file)  
- [ ] Overview page loads (not “Failed to load overview”)  
- [ ] Settings → **Orders dry-run** is **on** for demos  
- [ ] Sync → live cards may say “Using cache / blocked” until the first successful live download  

---

## Step 5 — First catalogue sync (optional)

1. Open `https://ops.example.com` → Sync  
2. Keep rate limits in mind (`live_feed_min_minutes`, daily caps in Settings)  
3. Click **Run full sync** once to seed the feed cache (hits vendor APIs — respect caps)  
4. Later runs use cache when live downloads are gated  

**Stop all sync** aborts a running job and turns **Sync enabled** off. Turn Sync enabled back on (or press Run) to resume.

---

## Updating an existing VPS

Same command again (no need to re-bootstrap):

```bash
./production-environment/scripts/deploy-vps.sh \
  --host my-sillage \
  --shop shop.example.com \
  --dash ops.example.com \
  --ip YOUR_VPS_IP
```

This refreshes code/plugin/image. It does **not** wipe MariaDB / WordPress data unless you delete `~/ecom_sites/data` yourself.

---

## Security notes

| Item | Expectation |
|---|---|
| Secrets | Only in remote `~/sillage-core/.env`, `~/ecom_sites/.env`, and laptop `.deploy/` — never commit |
| Ports | Caddy :80/:443 public; sillage-core `127.0.0.1:4000`; MariaDB `127.0.0.1:3307` |
| Firewall | ufw allows 22/80/443 only after bootstrap |
| DB user `sillage` | Narrow grants on `earth.wp_*` — see `sillage-grants.sql` |
| Money | Vendor order APIs have no sandbox; keep dry-run on until intentional |

---

## Common failures

| Symptom | Fix |
|---|---|
| `ERR_NAME_NOT_RESOLVED` | DNS not propagated / local cache — flush caches; confirm A records |
| Dashboard “Failed to load overview” / SQL denied | Re-apply grants SQL as root against `ecom-db` |
| Sync `EROFS` / read-only `.feedscratch` | Mount must be RW (deploy script does this; no `:ro`) |
| `lime/wordpress` pull denied | Always **build** on the VPS via deploy (private tag) |
| Stop sync “internal error” | Fixed on current `main` (`error_message` column); redeploy sillage-core if an old image |
| Let’s Encrypt fail | DNS must already point at this VPS; ports 80/443 open |

---

## Scripts reference

| Script | Role |
|---|---|
| `production-environment/scripts/bootstrap-host.sh` | Fresh OS → Docker + Caddy + ubuntu user |
| `production-environment/scripts/deploy-vps.sh` | App deploy / update |
| `production-environment/scripts/porkbun-dns.sh` | A-record upsert (used by `--dns`) |
| `production-environment/scripts/vps-bootstrap.sh` | Remote DB user + wp-config Sillage constants |
| `production-environment/wordpress-image/Dockerfile` | `wordpress:latest` + Redis PHP extension |

Canonical product facts: [`CONTEXT.md`](CONTEXT.md). High-level pointer: [`../README.md`](../README.md).
