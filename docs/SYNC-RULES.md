# Sync — the operator's rules

These are the shop owner's rules, not suggestions. They apply to every box and to both shops
(retail here, wholesale in [unseencurtain/sillage-b2b](https://github.com/unseencurtain/sillage-b2b)).
If code, another doc, or an agent disagrees with this file, this file is right and the other thing
is a bug. Read it before touching `sync/schedule.ts`, `vendors/liveGate.ts`, the Sync page, or
anything named `*_minutes`.

## 1. The settings belong to the operator. Never change one.

Nobody — no script, no deploy, no agent, no migration — writes `sil_settings` to "fix" or "tidy"
what an operator set. Not `sync_enabled`, not the cadence, not `full_sync_enabled`, not dry-run,
not the stock threshold. **Each box is set independently**: one may be syncing while the other is
switched off, and that is a deliberate choice, not drift to reconcile. If a setting looks wrong,
say so and leave it alone.

The only writes allowed to that table are the ones the operator triggers themselves through the
dashboard, plus the engine's own bookkeeping rows (`last_live_fetch_*`, `live_fetch_count_*`,
`pending_*`, `sync_abort`).

A deploy may seed a **missing** row so a fresh install has a value. It may never overwrite a
present one.

## 2. Rebuild is one press, and it lands on the next call

- Shop empty, or schedule off and the feeds are out of their interval → **Rebuild runs now.**
- Anything else → **Rebuild is queued.** The next vendor call becomes a catalogue rebuild instead
  of a prices-and-stock sync. It does not add an extra download, and it does not shorten the wait.
- Once queued, **the button is dead** until that call has run. Pressing it again cannot make the
  rebuild happen sooner, so the dashboard must not accept the press and pretend otherwise.
- Press it, then leave it. That is the whole workflow.

## 3. The call interval holds, including for buttons

`live_feed_min_minutes` is the shortest gap between two downloads of the same vendor feed. A press
does not override it: a feed pulled twenty minutes ago returns the same data twenty minutes later,
so a second download spends a vendor call for nothing.

**30 minutes is the floor.** Anything above 30 is the operator's call — 60, 120, whatever. Below
30 is refused: one account per wholesaler, and they rate-limit.

The Settings page shows one field for this. It writes two rows (`live_feed_min_minutes` for the
gap, `fast_sync_minutes` for the tick), and they must always hold the same number. They shipped
with different defaults once, so the dashboard displayed 60 while the scheduler ticked at 30 and
logged every second tick as blocked. Migration `022_one_sync_cadence.sql` fixed the existing rows;
keep the defaults equal.

## 4. Both vendors start together, or nobody starts

A run takes BeautyFort and BTS or neither. Starting on "whichever vendor is ready" is what made
them leapfrog: a run fetched the eligible one, reset only that clock, and left the other's alone.
With a 60-minute interval they settled half an hour apart and every run reported one of them
skipped — each refreshed hourly, never together, so no single run saw the whole catalogue.

Waiting for both costs at most one tick and re-converges the clocks on the first joint run. The
Sync page's "BF wait 44m · BTS wait 45m" is the two clocks; the run happens when the later one
opens.

## 5. Off means off, on means on, immediately

`sync_enabled` is read at every tick. Turning it off stops the schedule without stopping the
container; a run already in flight is stopped by Stop, which also switches the schedule off and
latches `sync_abort` until the next deliberate start. Turning it back on from the dashboard clears
that latch. Nothing else may set it.

## 6. Ordering is separate, and dry-run is the only gate

No box is a sandbox: every stack talks to the live wholesalers on live credentials, because
neither vendor offers a test API — they never have. Dispatch therefore follows the Orders page
Dry-run / Live choice on every box, and nothing else overrules it. There is no "development mode"
that makes an order safe, and the dashboard must never claim there is.
