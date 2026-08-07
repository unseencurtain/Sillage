/**
 * Hard gates on live vendor API usage.
 *
 * BeautyFort has a very small daily SOAP budget (~40). Hitting live on every settings save or
 * dashboard "Sync" click would burn the quota and risk a ban. Scheduled catalogue syncs must
 * prefer the on-disk feed cache unless enough time has passed and the daily cap still has room.
 */
import { sil } from "../config/env.ts";
import { query, type RowDataPacket } from "../db/pool.ts";
import { loadSettings, setSetting } from "../db/settings.ts";
import { logger } from "../lib/log.ts";
import type { CacheVendor } from "./feedCache.ts";

const log = logger("live-gate");

export interface LiveGateResult {
  allow: boolean;
  reason: string;
  /** Minutes until the next live fetch is permitted (0 if allowed). */
  retryInMinutes: number;
}

function lastKey(vendor: CacheVendor): string {
  return `last_live_fetch_${vendor}`;
}

function maxPerDay(vendor: CacheVendor, settings: Awaited<ReturnType<typeof loadSettings>>): number {
  if (vendor === "beautyfort") return settings.beautyfortLiveMaxPerDay;
  if (vendor === "bts") return settings.btsLiveMaxPerDay;
  if (vendor === "ocean") return settings.oceanLiveMaxPerDay;
  return 48;
}

export async function checkLiveGate(vendor: CacheVendor): Promise<LiveGateResult> {
  const settings = await loadSettings();
  const minMinutes = settings.liveFeedMinMinutes;

  const [lastRow] = await query<RowDataPacket & { setting_value: string }>(
    `SELECT setting_value FROM ${sil("sil_settings")} WHERE setting_key = ?`,
    [lastKey(vendor)],
  );
  const lastIso = lastRow?.setting_value ?? null;
  if (lastIso) {
    const elapsed = Math.floor((Date.now() - new Date(lastIso).getTime()) / 60_000);
    if (elapsed < minMinutes) {
      return {
        allow: false,
        reason: `${vendor} live fetch blocked: only ${elapsed} min since last download (min ${minMinutes})`,
        retryInMinutes: minMinutes - elapsed,
      };
    }
  }

  const [countRow] = await query<RowDataPacket & { n: number }>(
    `SELECT COUNT(*) AS n FROM ${sil("sil_sync_runs")}
      WHERE source = 'live'
        AND started_at >= CURDATE()
        AND (status IN ('success','partial','running','error') OR status IS NOT NULL)`,
  );
  // Per-vendor daily counts from dedicated counter settings (more accurate than runs).
  const [dayCountRow] = await query<RowDataPacket & { setting_value: string }>(
    `SELECT setting_value FROM ${sil("sil_settings")} WHERE setting_key = ?`,
    [`live_fetch_count_${vendor}_${new Date().toISOString().slice(0, 10)}`],
  );
  const dayCount = Number(dayCountRow?.setting_value ?? 0);
  const max = maxPerDay(vendor, settings);
  if (dayCount >= max) {
    return {
      allow: false,
      reason: `${vendor} live fetch blocked: ${dayCount}/${max} downloads used today`,
      retryInMinutes: 60,
    };
  }

  void countRow;
  return { allow: true, reason: "live allowed", retryInMinutes: 0 };
}

/** Record a successful live download so the gate and daily counter advance. */
export async function recordLiveFetch(vendor: CacheVendor): Promise<void> {
  const now = new Date().toISOString();
  await setSetting(lastKey(vendor), now);
  const dayKey = `live_fetch_count_${vendor}_${now.slice(0, 10)}`;
  const [row] = await query<RowDataPacket & { setting_value: string }>(
    `SELECT setting_value FROM ${sil("sil_settings")} WHERE setting_key = ?`,
    [dayKey],
  );
  const next = String(Number(row?.setting_value ?? 0) + 1);
  await setSetting(dayKey, next);
  log.info(`${vendor}: recorded live fetch (#${next} today)`);
}

/**
 * Resolve what a connector should actually hit.
 * `forceLive` bypasses the gate (CLI escape hatch only — still records the fetch).
 */
export async function resolveLiveOrCache(
  vendor: CacheVendor,
  requested: "live" | "local",
  forceLive = false,
): Promise<{ mode: "live" | "cache" | "local"; gate: LiveGateResult | null }> {
  if (requested === "local") {
    return { mode: "local", gate: null };
  }
  if (forceLive) {
    return { mode: "live", gate: { allow: true, reason: "forceLive", retryInMinutes: 0 } };
  }
  const gate = await checkLiveGate(vendor);
  if (gate.allow) return { mode: "live", gate };
  log.warn(gate.reason);
  return { mode: "cache", gate };
}

/**
 * Separate gate for Ocean's hourly store (price/stock) feed. Must not share the catalog's
 * once-per-day cap, or fast syncs would stall after the first catalog pull.
 */
export async function checkOceanStoreGate(): Promise<LiveGateResult> {
  const settings = await loadSettings();
  const minMinutes = settings.oceanStoreLiveMinMinutes;

  const [lastRow] = await query<RowDataPacket & { setting_value: string }>(
    `SELECT setting_value FROM ${sil("sil_settings")} WHERE setting_key = ?`,
    ["last_live_fetch_ocean_store"],
  );
  const lastIso = lastRow?.setting_value ?? null;
  if (lastIso) {
    const elapsed = Math.floor((Date.now() - new Date(lastIso).getTime()) / 60_000);
    if (elapsed < minMinutes) {
      return {
        allow: false,
        reason: `ocean store live fetch blocked: only ${elapsed} min since last download (min ${minMinutes})`,
        retryInMinutes: minMinutes - elapsed,
      };
    }
  }

  const day = new Date().toISOString().slice(0, 10);
  const [dayCountRow] = await query<RowDataPacket & { setting_value: string }>(
    `SELECT setting_value FROM ${sil("sil_settings")} WHERE setting_key = ?`,
    [`live_fetch_count_ocean_store_${day}`],
  );
  const dayCount = Number(dayCountRow?.setting_value ?? 0);
  const max = settings.oceanStoreLiveMaxPerDay;
  if (dayCount >= max) {
    return {
      allow: false,
      reason: `ocean store live fetch blocked: ${dayCount}/${max} downloads used today`,
      retryInMinutes: 60,
    };
  }

  return { allow: true, reason: "live allowed", retryInMinutes: 0 };
}

export async function recordOceanStoreFetch(): Promise<void> {
  const now = new Date().toISOString();
  await setSetting("last_live_fetch_ocean_store", now);
  const dayKey = `live_fetch_count_ocean_store_${now.slice(0, 10)}`;
  const [row] = await query<RowDataPacket & { setting_value: string }>(
    `SELECT setting_value FROM ${sil("sil_settings")} WHERE setting_key = ?`,
    [dayKey],
  );
  const next = String(Number(row?.setting_value ?? 0) + 1);
  await setSetting(dayKey, next);
  log.info(`ocean_store: recorded live fetch (#${next} today)`);
}

/** Wall-clock half-hour slots (:00–:04 and :30–:34). Cron ticks every 5 min; only these open sync. */
export function inHalfHourSlot(minuteOfHour: number): boolean {
  const m = Math.trunc(minuteOfHour);
  return (m >= 0 && m < 5) || (m >= 30 && m < 35);
}
