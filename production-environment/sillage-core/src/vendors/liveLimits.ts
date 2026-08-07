/**
 * Resolve live-feed download caps from the vendor row, with legacy sil_settings keys as fallback.
 * Pure — no database imports.
 */

export const DEFAULT_LIVE_MAX_PER_DAY: Record<string, number> = {
  beautyfort: 20,
  bts: 48,
  ocean: 1,
};

export const DEFAULT_OCEAN_STORE_MAX_PER_DAY = 24;
export const DEFAULT_OCEAN_STORE_MIN_MINUTES = 60;

export interface LiveLimitVendorFields {
  liveMaxPerDay: number | null;
  storeLiveMaxPerDay?: number | null;
  storeLiveMinMinutes?: number | null;
}

function asNonNegInt(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

/**
 * Catalogue live-download daily cap.
 * Prefer sil_vendors.live_max_per_day; else legacy `{slug}_live_max_per_day`; else built-in default.
 */
export function resolveLiveMaxPerDay(
  vendorSlug: string,
  vendor: Pick<LiveLimitVendorFields, "liveMaxPerDay"> | null | undefined,
  legacySetting: number | null | undefined,
): number {
  const fromRow = asNonNegInt(vendor?.liveMaxPerDay ?? null);
  if (fromRow !== null) return fromRow;

  const fromLegacy = asNonNegInt(legacySetting ?? null);
  if (fromLegacy !== null) return fromLegacy;

  return DEFAULT_LIVE_MAX_PER_DAY[vendorSlug] ?? 48;
}

/**
 * Ocean store (price/stock) feed limits — separate from the catalog once-per-day cap.
 */
export function resolveOceanStoreLimits(
  vendor: Pick<LiveLimitVendorFields, "storeLiveMaxPerDay" | "storeLiveMinMinutes"> | null | undefined,
  legacyMaxPerDay: number | null | undefined,
  legacyMinMinutes: number | null | undefined,
): { maxPerDay: number; minMinutes: number } {
  const max =
    asNonNegInt(vendor?.storeLiveMaxPerDay ?? null) ??
    asNonNegInt(legacyMaxPerDay ?? null) ??
    DEFAULT_OCEAN_STORE_MAX_PER_DAY;
  const min =
    asNonNegInt(vendor?.storeLiveMinMinutes ?? null) ??
    asNonNegInt(legacyMinMinutes ?? null) ??
    DEFAULT_OCEAN_STORE_MIN_MINUTES;
  return { maxPerDay: max, minMinutes: min };
}

/** Legacy setting key for a vendor's catalogue daily cap. */
export function legacyLiveMaxSettingKey(vendorSlug: string): string {
  return `${vendorSlug}_live_max_per_day`;
}
