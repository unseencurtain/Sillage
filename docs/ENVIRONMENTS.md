# Every box — the rules

Read this before deploying anything. It is short on purpose. If some other doc disagrees with it,
this one wins and the other one is stale.

## The rules

1. **Every box is production.** There is no development tier and never was: neither BeautyFort nor
   BTS offers a test API, and there is one account per vendor. A second box is a second production
   shop on its own hostnames — not a sandbox, not a mirror to keep in step.
2. **A box's settings are its own.** `sil_settings` belongs to the operator, per box. One box may
   be syncing while the other is switched off; that is a decision, not drift. Nothing automated
   changes a setting that is already there — see [`SYNC-RULES.md`](SYNC-RULES.md), which is the
   authority on sync, the cadence and the Rebuild button.
3. **Every box runs identically.** Same compose file, same image tag, same bind mounts, same
   install procedure, same scripts, same behaviour, same live vendor APIs. Dispatch is decided by
   the Orders page Dry-run / Live choice everywhere, and nothing overrules it in either direction.
   The one exception to identical is `--overlay`, below, which is a way of working while you edit
   code on a box, not a kind of box.
4. **Bind mounts only. No Docker named volumes**, ever, for WordPress or MariaDB. Each stack keeps
   all of its state under its own `data/`, so `tar` of the home folder is a real backup. See
   [`VPS-MIGRATE.md`](VPS-MIGRATE.md) for the incident that made this a rule.
5. **One stack per directory, and it must survive alone.** `~/sillage` (retail) and
   `~/sillage-wholesale` (wholesale) share nothing but the box: separate databases, separate
   Valkey, separate Caddy site file, separate `.env`, separate repo. Two on one VPS is a cost
   decision, not a design one — moving either to its own VPS is a pack, a restore and a DNS
   change, with nothing to untangle first.
6. **No hostname has a default.** Not in the deploy script, not in the engine, not in a migration.
   Every default we ever set was correct until the shop moved, and then it silently was not.
7. **Anything done by hand on a box is a bug.** If a rebuild needs a step you remember rather than
   a step a script does, the next rebuild will not have it. Put it in the script, in the same
   change.
8. **Every box is disposable, production included** — but only while a recent copy of it exists,
   and making that copy is a decision, not a timer. `~/pack.sh` on any box writes one file holding
   the whole box; both shops stay up while it runs. **Download it.** A backup living only on the
   machine it backs up is a backup of nothing, which is what an `rm -rf` in `$HOME` proved here on
   2026-09-08. Run it before anything risky, before wiping a box, and before handing one over.
9. **Two boxes share one vendor budget.** Both wholesalers rate-limit per account and there is one
   account each, so two boxes syncing on a schedule draw from the same allowance. Which box has
   its schedule on is the operator's call, per box, and rule 2 applies — do not switch one off to
   tidy the other up.

## Today

| | `ovh` — `51.79.255.226` | `ovhe` — `139.99.61.71` |
|---|---|---|
| Retail | `codeinmoon.xyz`, dashboard `sillage.codeinmoon.xyz`, images `images.codeinmoon.xyz` | `prinscosmetic.eu`, dashboard `sillage.prinscosmetic.eu`, images `images.prinscosmetic.eu` |
| Wholesale | `wholesale.codeinmoon.xyz`, dashboard `sillage-wholesale.codeinmoon.xyz` | `wholesale.mirainikki.xyz`, dashboard `sillage-wholesale.mirainikki.xyz` |
| Settings | the operator's, on this box | the operator's, on this box |

Neither box is a pet. Both are disposable in exactly the same way, and the only thing that makes
that safe is rule 8. What differs between them is the hostnames they answer on, which shop's
customers reach them, and whatever the operator has set on each.

The intended end state is one shop per VPS — retail on its own box, wholesale on its own box —
once the client buys them. Rule 5 is what makes that a move rather than a project.

## Standing a box up, or replacing one

Two ways, and they answer different questions.

**From another box's pack — minutes, with the real catalogue.** Use this to replace a box, or to
stand a second shop up carrying real data:

```bash
ssh ovh 'bash ~/sillage/scripts/pack-box.sh --live'
ssh ovh 'cat ~/box-<stamp>.tar.gz' | ssh ovhe 'cat > ~/box.tar.gz'
ssh ovhe 'sudo tar --numeric-owner -C ~ -xzf ~/box.tar.gz'
ssh ovhe 'cd ~/sillage && bash scripts/adopt-box.sh --shop … --dash … --images … --role development'
ssh ovhe 'cd ~/sillage-wholesale && bash scripts/adopt-box.sh --shop … --dash … --role development'
```

A pack carries the vendor credentials and the shop's settings with it. After adopting, check the
Sync and Orders pages on the new box and set them the way you want *that* box to behave.

**From nothing — a clean shop with an empty catalogue.** Use this to prove the from-scratch path
still works, which is the thing that rots when nobody exercises it:

```bash
ssh ovhe 'sudo bash -s' < production-environment/scripts/bootstrap-host.sh
./production-environment/scripts/deploy-vps.sh --host ovhe --role development \
  --shop … --dash … --images … --fresh
```

WordPress comes up in a couple of minutes; the catalogue does not. Filling it means a live sync,
which is tens of minutes and spends vendor request budget. If you want products quickly, use the
pack.

## Working on the engine

Day to day, a development stack runs the published image, exactly as production does — that is
what makes it worth having. When you want a tight edit loop instead, layer the overlay:

```bash
./production-environment/scripts/deploy-vps.sh --host ovhe --role development --overlay --skip-build
```

That bind-mounts `sillage-core/` and runs `bun --hot` with a Vite dashboard, so TypeScript and
`.tsx` edits are live. It is refused on a production stack. Take it off with a plain deploy when
you are done; a box left under the overlay is running code that exists nowhere else.

Bridge plugin PHP needs none of this: `data/wp/` is a bind mount, so the file on the box is the
file the shop runs.

## Building images

Any box can build. It needs `docker login` as `unseencurtain` once, and the engine source, which
every deploy now rsyncs onto the box whatever its role:

```bash
ssh <box>
cd ~/sillage && bash scripts/build-push-images.sh --core-only --tag <short-sha>
```

Production pulls tags; it does not have to be the box that builds them, and no box is special.
