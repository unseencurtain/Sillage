# Which box is what — the rules

Read this before deploying anything. It is short on purpose. If some other doc disagrees with it,
this one wins and the other one is stale.

## The rules

1. **A role is a label, not a machine and not a mode.** Every stack declares
   `SILLAGE_ROLE=production` or `SILLAGE_ROLE=development` in its own `.env`. Nothing infers it
   from a hostname. It exists so `deploy-vps.sh` can tell that `~/sillage` on a box is the live
   shop and refuse to push the other role over it; the engine never reads it.
2. **No stack is a sandbox.** Neither BeautyFort nor BTS has one, and there is a single account per
   vendor, so a development stack talks to the same live APIs on the same credentials as the shop.
   Dispatch is decided by the Orders page Dry-run / Live choice, everywhere, and that setting is
   the only thing between a rehearsal and a real purchase. The dashboard prints no banner claiming
   otherwise, because there is nothing true it could say.
3. **Every stack runs identically.** Same compose file, same image tag, same bind mounts, same
   install procedure, same scripts, same behaviour. A development stack that is built or behaves
   differently from production is not testing production. The one exception is `--overlay`, below,
   which is a way of working and is refused on production.
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
9. **A development stack does not spend production's vendor budget.** Both wholesalers rate-limit
   per account and there is one account, so a test box syncing on a schedule takes requests the
   shop needs. Leave `sync_enabled` off there and sync by hand when a test needs it.

## Today

| | `ovh` — `51.79.255.226` | `ovhe` — `139.99.61.71` |
|---|---|---|
| Role | production | development |
| Status | the real shops; all work lands here | wiped and rebuilt on demand |
| Retail | `codeinmoon.xyz`, dashboard `sillage.codeinmoon.xyz`, images `images.codeinmoon.xyz` | whatever it is rebuilt onto |
| Wholesale | `wholesale.codeinmoon.xyz`, dashboard `sillage-wholesale.codeinmoon.xyz` | as above |

`ovhe` is not a mirror and is not held at parity — it exists to be destroyed and brought back.
Neither is `ovh` a pet: it is disposable in exactly the same way, and the only thing that makes
that safe is rule 8. The difference between the two boxes is which one customers reach.

The intended end state is one shop per VPS — retail on its own box, wholesale on its own box —
once the client buys them. Rule 5 is what makes that a move rather than a project.

## Changing a role

On the box, in the stack directory:

```bash
bash scripts/set-role.sh                     # what is this stack?
bash scripts/set-role.sh development
bash scripts/set-role.sh production
```

It rewrites one `.env` line and nothing restarts, because nothing in the running stack behaves
differently. Relabelling a box does not make it safe to press Live on it, and never did.

`deploy-vps.sh --role <role>` refuses to deploy a role that a box does not already hold unless you
add `--switch-role`. Changing what a box is for should be a sentence you typed, not a side effect
of a deploy.

## Rebuilding the test box

Two ways, and they answer different questions.

**From a production pack — minutes, with the real catalogue.** Use this when you want to test
against real data or reproduce something production is doing:

```bash
ssh ovh 'bash ~/sillage/scripts/pack-box.sh --live'
ssh ovh 'cat ~/box-<stamp>.tar.gz' | ssh ovhe 'cat > ~/box.tar.gz'
ssh ovhe 'sudo tar --numeric-owner -C ~ -xzf ~/box.tar.gz'
ssh ovhe 'cd ~/sillage && bash scripts/adopt-box.sh --shop … --dash … --images … --role development'
ssh ovhe 'cd ~/sillage-wholesale && bash scripts/adopt-box.sh --shop … --dash … --role development'
```

The pack carries production's vendor credentials — as does every stack — so leave the Orders page
on dry-run and `sync_enabled` off there unless a test needs otherwise.

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
