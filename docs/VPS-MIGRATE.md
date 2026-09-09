# Back up a box, or move it to another one

One box holds two stacks, `~/sillage/` (retail) and `~/sillage-wholesale/`. Each keeps
**everything** it needs under its own directory: `compose.yaml`, `.env`, `scripts/`, WordPress in
`data/wp/`, MariaDB in `data/wp-db/`, photos in `data/media/`. Nothing lives in a Docker named
volume. So the backup is the obvious thing — tar the home folder — and it actually restores.

That is the whole design. If you only read one line: **the stack directory is the stack.**

---

## Why not named volumes

WordPress and MariaDB used to sit in named volumes, under `/var/lib/docker`. A `tar` of the home
folder then quietly excluded WordPress core, every installed plugin and theme, `wp-config.php`,
the uploads directory, and the entire database. The archive looked plausible — right directories,
hundreds of megabytes of photos — and you find out what is missing at the worst possible moment,
restoring onto a machine that never had them. It happened here, on 2026-09-08, after an
`rm -rf` on production; the shop came back only because a second box still had the data.

Both boxes are now bind-mount only and `docker volume ls` is empty on each. Keep it that way.

---

## Back up

Run on the box:

```bash
ssh <box>
./pack.sh                                   # the usual one: no downtime, keeps the newest three
```

`~/pack.sh` is a two-line wrapper over the real script, sitting where you land. The longer form,
if you want the other mode:

```bash
bash ~/sillage/scripts/pack-box.sh          # stops both stacks, packs, starts them again
bash ~/sillage/scripts/pack-box.sh --live --keep 3
```

Nothing runs either of them on a schedule. The file is yours to make and yours to download.

You get `~/box-<stamp>.tar.gz` — every stack directory, `/etc/caddy`, and the databases, with
ownership preserved. Download it. Skipped: `.ssh`, earlier packs, and the vendor feed cache,
which re-downloads itself.

The default stops the stacks first, because MariaDB data files copied while the server is writing
to them can restore into a corrupt table. `--live` avoids the downtime and writes consistent SQL
dumps alongside the files, so a hot pack is still restorable.

## Move it to another box

The target needs Docker, Docker Compose and Caddy, and the two networks
(`docker network create ecom_network redis_network`). Then:

```bash
ssh SOURCE 'cat ~/box-<stamp>.tar.gz' | ssh TARGET 'cat > ~/box.tar.gz'
ssh TARGET 'sudo tar --numeric-owner -C ~ -xzf ~/box.tar.gz'
```

The unpacked copy is byte-for-byte the source box, which means every hostname in it still names
the source. `adopt-box.sh` repoints all six places that hold one and restarts the stack:

```bash
cd ~/sillage && bash scripts/adopt-box.sh \
  --shop prinscosmetic.eu --dash sillage.prinscosmetic.eu --images images.prinscosmetic.eu \
  --role development

cd ~/sillage-wholesale && bash scripts/adopt-box.sh \
  --shop wholesale.mirainikki.xyz --dash sillage-wholesale.mirainikki.xyz --role development
```

| Where a hostname hides | What is wrong if you miss it |
|---|---|
| `.env` | The engine and the deploy scripts disagree with the shop |
| `/etc/caddy/sites/<stack>.caddy` | Box does not answer, or has no certificate |
| `wp_options.siteurl` / `.home` | Every link WordPress prints goes to the other box |
| `sil_settings.wp_base_url` | Dashboard links and finalize calls miss |
| `sil_settings.image_cdn_base_url` | Bare filenames in the overrides resolve nowhere |
| `wp_postmeta._external_thumbnail_url` | Pages render with every photo broken |

A restored copy carries the original's vendor credentials against APIs with no sandbox, so it can
place a real order the moment it boots — the Orders page dry-run setting is the gate, on every
box. There is no role or label that makes a copy safe. [`ENVIRONMENTS.md`](ENVIRONMENTS.md) has
the rules; the adopted box's settings are then its own, independent of where it came from.

Wholesale takes no `--images`: it hotlinks catalog `flask_front` URLs and hosts no photos.

## Converting a box that still uses volumes

Once per stack, before packing it:

```bash
cd ~/sillage && bash scripts/to-bind-mounts.sh
```

It stops the stack, copies both volumes into `data/wp/` and `data/wp-db/`, rewrites the two
`.env` paths and starts back up. Idempotent, and it deletes nothing — the old volumes stay until
you remove them yourself, so rolling back is putting the two `.env` lines back.

---

## Rebuild without a source box

Only if every box is gone. Git has the EAN → image map, not the JPEG bytes.

1. [`VPS-DEPLOY.md`](VPS-DEPLOY.md) until WordPress and the dashboard answer.
2. Vendor keys into `~/sillage/.env` or dashboard **Secrets**.
3. Copy `sillage-core/data/image_overrides.json` from the clone onto the box. Values are bare
   filenames, resolved against `image_cdn_base_url` — so photos follow the box they are on.
4. Restore the JPEGs into `~/sillage/data/media/`:

```bash
python3 production-environment/python-analysis/beautyfort-enriched/restore_found_images.py \
  --overrides production-environment/sillage-core/data/image_overrides.json \
  --dest ~/sillage/data/media \
  --from-cdn        # only works while some box still serves the old images host
```

5. Recreate `sillage-core` so the overrides reload, run a live **Rebuild catalogue**, then
   rewrite content so Woo picks the URLs up:

```bash
docker exec sillage-core bun run sync -- --mode=full --source=cache --rewrite-only
```

If the map itself is lost, `fill_missing_shop_images.py` re-matches from a Brasty dump and the
ocean/Shopify CSVs; `brasty_placeholders.py` skips the "no photo" camera graphic. Commit the
merged JSON so the next agent does not start from zero.

---

## After a move, check

- [ ] All five hostnames answer over HTTPS, shop and dashboard both
- [ ] A product page shows a photo, and `https://images.<domain>/<ean>.jpg` is a real one
- [ ] Dashboard login works and the Sync page shows the restored history
- [ ] `docker volume ls` is empty
- [ ] Every stack declares its role: `grep SILLAGE_ROLE ~/*/.env`
- [ ] Do **not** place a live vendor order to "test"
