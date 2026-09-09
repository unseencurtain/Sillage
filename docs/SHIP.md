# Shipping a change

One command, about ninety seconds, from an edited file to a running shop.

```bash
./production-environment/scripts/ship.sh                    # → ovhe (default)
./production-environment/scripts/ship.sh --to ovhe --to ovh # → several boxes
./production-environment/scripts/ship.sh --status           # what is each box running?
./production-environment/scripts/ship.sh --rollback 82bd81e # back to a known tag
```

Wholesale is the same command in
[unseencurtain/sillage-b2b](https://github.com/unseencurtain/sillage-b2b); it defaults to that
box's `~/sillage-wholesale` and the `sillage-b2b` image.

## What one run does

1. **Refuses a dirty tree.** The image tag is the commit, always. `--dirty` overrides and tags
   `<sha>-dirty` so a hand-shipped build is obvious in `--status` afterwards.
2. **Runs the gates locally** — typecheck, `bun test`, dashboard build. A failure stops the run
   before anything leaves the laptop.
3. **Builds and pushes**, but only if that tag is not already on Hub. Re-shipping an unchanged
   commit skips straight to the deploy. Building happens on the builder box (`ovhe` by default,
   `--builder <host>`), which is where the Hub credentials live.
4. **Deploys to each target**: pins `SILLAGE_CORE_IMAGE` in that box's `.env`, pulls, restarts the
   engine and the scheduler, waits for `/health`.
5. **Verifies.** If `/health` does not answer, the old `.env` is restored and the previous image
   is brought back up rather than leaving a shop on a broken build. Then it diffs every
   operator-owned `sil_settings` row from before the deploy against after, and fails the run if
   one moved. Finally it checks that the image's revision label is the commit being shipped, so a
   stale tag cannot slip through.

Service names are read from compose, not assumed, so the same script works on retail, on
wholesale, and on a box that does not exist yet.

## What it deliberately does not do

- **It does not touch settings.** Sync enabled, the cadence, dry-run and the rest belong to that
  box's operator — see [`SYNC-RULES.md`](SYNC-RULES.md). The snapshot diff exists to prove it.
- **It does not build a box.** WordPress, Caddy, MariaDB grants, media and the first boot of an
  empty VPS are [`deploy-vps.sh`](VPS-DEPLOY.md)'s job. That runs once per box. This runs every
  time a line of code changes.
- **It does not touch WordPress.** A change to the bridge plugin or the WordPress image still goes
  through `deploy-vps.sh`.

## Housekeeping

Every build prunes the builder's cache down to 2 GB, and every deploy leaves the box holding the
running engine image and the one before it — enough to roll back without a pull. `--prune` runs
both by hand and prints the disk left.

## Image size

The engine image is ~170 MB. It was 401 MB until the Dockerfile was split in three: the dashboard
toolchain (vite, react, tailwind, typescript — about 185 MB of devDependencies) now builds in a
throwaway stage that exports only `web/dist`, the runtime stage installs the four packages the
engine actually imports, and supercronic is fetched in its own stage so curl and its certificate
chain never reach the shipped layer.

The WordPress image is still ~1.1 GB and that is almost entirely `wordpress:7.1-php8.3-apache`
upstream. An fpm-alpine base would cut roughly half, but it changes how the shop is served, so it
is a deliberate piece of work rather than a tweak — not something to slip into a code deploy.

## When it fails

| Message | Meaning |
|---|---|
| `uncommitted changes` | Commit first, or `--dirty` if you know why. |
| `typecheck failed` / test output | The gates did their job. Nothing was deployed. |
| `no ~/<dir> on this box` | That box has never been built. Run `deploy-vps.sh` for it once. |
| `engine did not answer /health` | Already rolled back to the previous image. Read the engine log. |
| `operator settings changed` | A migration or a deploy step wrote `sil_settings`. That is a bug — the diff is printed. |
| `image revision label says …` | The tag on Hub was built from other source. `--rebuild` to replace it. |
