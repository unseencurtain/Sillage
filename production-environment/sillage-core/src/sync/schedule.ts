/**
 * Decide what the cron tick should do.
 *
 * Cron fires on a fixed short interval and this decides whether anything is due. The alternative —
 * encoding the cadence in the crontab — would mean a container rebuild to change it, and the
 * dashboard is meant to be the single source of truth for configuration.
 *
 * Every time comparison is evaluated by the database rather than in JavaScript. The scheduler, the
 * API and the operator's browser can all disagree about the clock and the time zone; `sil_sync_runs`
 * timestamps are written by the database, so the database is the only clock that cannot be wrong
 * about its own rows.
 */
import { applyRuntimeUrls, sil } from "../config/env.ts";
import { query, type RowDataPacket } from "../db/pool.ts";
import { loadSettings, recordEvent, type GlobalSettings } from "../db/settings.ts";
import { logger } from "../lib/log.ts";
import { todayAtHourUtc, toMysqlUtc } from "../lib/timezone.ts";
import { recoverStuckSubmits, dispatchDueOrders } from "../orders/dispatch.ts";
import { sweepDispatchableOrders } from "../orders/ingest.ts";
import { pollDueOrders } from "../orders/tracking.ts";
import { getRetailLiveCooldown, inHalfHourSlot } from "../vendors/liveGate.ts";
import { runSync, type SyncSummary } from "./run.ts";

const log = logger("schedule");

export interface ScheduleDecision {
  action: "full" | "fast" | "skip";
  reason: string;
}

/** What the database knows about recent runs. Split out so the decision itself stays pure. */
export interface ScheduleTiming {
  /** Minutes since the last successful run of either mode, or null when there has never been one. */
  minutesSinceAny: number | null;
  /** Runs of the full sync started since today's scheduled hour, in any state. */
  fullRunsSinceWindow: number;
  /** Whether today's full-sync hour has already passed. */
  windowOpen: boolean;
}

interface TimingRow extends RowDataPacket {
  minutes_since_any: number | null;
  full_runs_since_window: number;
  window_open: number;
}

/**
 * Ask the database what is due.
 *
 * `minutes_since_any` counts from the last run of *either* mode, because a full sync also refreshes
 * every price and stock level — running a fast sync two minutes later would be wasted work.
 *
 * Full-sync window start is “today at fullSyncHour:00” in `scheduleTimezone`, converted to UTC
 * in JS (MariaDB stays UTC; no CONVERT_TZ dependency).
 */
async function loadTiming(fullSyncHour: number, scheduleTimezone: string): Promise<ScheduleTiming> {
  const hour = normaliseHour(fullSyncHour);
  const windowStartSql = toMysqlUtc(todayAtHourUtc(scheduleTimezone, hour));
  const rows = await query<TimingRow>(
    `SELECT
       (SELECT TIMESTAMPDIFF(MINUTE, MAX(started_at), NOW())
          FROM ${sil("sil_sync_runs")}
         WHERE status IN ('success','partial')) AS minutes_since_any,
       (SELECT COUNT(*)
          FROM ${sil("sil_sync_runs")}
         WHERE mode = 'full'
           AND started_at >= ?) AS full_runs_since_window,
       (NOW() >= ?) AS window_open`,
    [windowStartSql, windowStartSql],
  );
  const row = rows[0]!;
  return {
    minutesSinceAny: row.minutes_since_any === null ? null : Number(row.minutes_since_any),
    fullRunsSinceWindow: Number(row.full_runs_since_window),
    windowOpen: Number(row.window_open) === 1,
  };
}

/** Clamp an operator-supplied hour into a real hour of the day. */
export function normaliseHour(hour: number): number {
  return Math.min(23, Math.max(0, Math.trunc(hour) || 0));
}

/** The scheduling rules, with every input supplied. Pure, so it can be tested exhaustively. */
export function decide(settings: GlobalSettings, timing: ScheduleTiming): ScheduleDecision {
  if (!settings.syncEnabled) {
    return { action: "skip", reason: "sync_enabled is off" };
  }

  const hour = normaliseHour(settings.fullSyncHour);

  // Counted over all statuses, not just successful ones, so a failing full sync is attempted once
  // per day rather than retried on every tick for the rest of the day. A failure is surfaced on the
  // dashboard for an operator to retry deliberately.
  if (settings.fullSyncEnabled && timing.windowOpen && timing.fullRunsSinceWindow === 0) {
    return { action: "full", reason: `nightly full sync for ${String(hour).padStart(2, "0")}:00 is due` };
  }

  const since = timing.minutesSinceAny;
  if (since === null) {
    return { action: "full", reason: "no successful run on record, seeding the catalogue" };
  }
  if (since >= settings.fastSyncMinutes) {
    return { action: "fast", reason: `${since} min since the last run, cadence is ${settings.fastSyncMinutes} min` };
  }

  return {
    action: "skip",
    reason: `${since} min since the last run, next fast sync at ${settings.fastSyncMinutes} min`,
  };
}

export async function decideSchedule(settings: GlobalSettings): Promise<ScheduleDecision> {
  if (!settings.syncEnabled) {
    return { action: "skip", reason: "sync_enabled is off" };
  }

  // Catalogue syncs only open on the :00 and :30 walls (cron ticks every 5 minutes).
  // Combined with live_feed_min_minutes (default 60) this caps live downloads to ~1/hour.
  const [clock] = await query<RowDataPacket & { m: number }>(`SELECT MINUTE(NOW()) AS m`);
  if (!inHalfHourSlot(Number(clock?.m ?? 99))) {
    return {
      action: "skip",
      reason: `outside :00/:30 sync window (minute=${clock?.m})`,
    };
  }

  return decide(
    settings,
    await loadTiming(normaliseHour(settings.fullSyncHour), settings.scheduleTimezone),
  );
}

/** One cron tick. Returns the summary when a sync ran, or null when nothing was due. */
export async function runScheduledSync(override?: "full" | "fast"): Promise<SyncSummary | null> {
  const settings = await loadSettings();
  applyRuntimeUrls({ wpBaseUrl: settings.wpBaseUrl, imageCdnBaseUrl: settings.imageCdnBaseUrl });
  const decision = override ? { action: override, reason: "forced from the command line" } : await decideSchedule(settings);

  // Order housekeeping runs every tick, independent of whether a catalogue sync is due.
  try {
    const recovered = await recoverStuckSubmits();
    if (recovered > 0) log.warn(`recovered ${recovered} stuck submitting order(s)`);
    await sweepDispatchableOrders(20);
    await dispatchDueOrders(10);
    const polled = await pollDueOrders(50);
    if (polled > 0) log.info(`polled ${polled} vendor order(s) for tracking`);
  } catch (err) {
    log.error("order housekeeping failed", String(err));
    await recordEvent("error", "schedule", `order housekeeping failed: ${String(err)}`);
  }

  log.info(`tick: ${decision.action} — ${decision.reason}`);
  if (decision.action === "skip") return null;

  if (settings.syncSource === "live") {
    const cooldown = await getRetailLiveCooldown();
    if (!cooldown.allow) {
      log.info(
        `tick: skip live ${decision.action} — cooldown ${cooldown.retryInMinutes}m (${cooldown.reason})`,
      );
      return null;
    }
  }

  try {
    return await runSync({ mode: decision.action, source: settings.syncSource });
  } catch (err) {
    // Overlap is expected, not exceptional: a full sync can outlast the tick interval, and the
    // advisory lock in runSync is what keeps the two from writing the same rows.
    if (String(err).includes("another sync is already running")) {
      log.info("a sync is already running, leaving it alone");
      return null;
    }
    await recordEvent("error", "schedule", `scheduled ${decision.action} sync failed: ${String(err)}`);
    throw err;
  }
}
