/**
 * Vendor shipping quote cache.
 *
 * For every (vendor, country) pair the vendor serves, ask the vendor adapter what it costs to ship
 * there and keep the cheapest option in sil_shipping_quotes. The WordPress bridge reads that table
 * at checkout, so checkout never waits on a vendor.
 *
 *   BTS (location A)        quotes per country with one representative postcode and one in-stock
 *                           EAN. Carrier and price vary by postcode; the cache keeps one per country.
 *   BeautyFort (location B) publishes a flat price per country in its account info, so no postcode
 *                           or product is needed.
 *
 * A failed country keeps its last good price and is marked status='error'. A country with no
 * option is marked status='none'. The bridge only charges rows with status='ok'.
 */
import { createOrderAdapter } from "../orders/adapters/index.ts";
import type { OrderItem } from "../orders/adapter.ts";
import { logger } from "../lib/log.ts";
import { execute, query, queryOne, type RowDataPacket } from "../db/pool.ts";
import { sil } from "../config/env.ts";
import { loadVendors, type Vendor } from "../db/settings.ts";

const log = logger("shipping-quotes");

/**
 * One representative postcode per country. BTS prices depend on postcode, so the cache is only as
 * accurate as this table. Capital-city codes are used. Keep in step with served countries.
 */
export const QUOTE_POSTCODE: Record<string, string> = {
  AT: "1010", BE: "1000", BG: "1000", CH: "8001", CZ: "11000", DE: "10115", DK: "1050",
  EE: "10111", ES: "28001", FI: "00100", FR: "75001", GB: "SW1A 1AA", GR: "10563", HR: "10000",
  HU: "1051", IE: "D02 X285", IT: "00184", LT: "01101", LU: "2010", LV: "LV-1050", MC: "98000",
  NL: "1011 AB", PL: "00-001", PT: "1000-001", RO: "010011", SE: "111 20", SI: "1000", SK: "81101",
};

export interface QuoteRefreshResult {
  vendor: string;
  ok: number;
  none: number;
  error: number;
}

export interface SampleItem {
  ean: string;
  vendorProductId: string;
}

/** Last refresh time across all rows, or null when the cache is empty. */
export async function lastQuoteRefresh(): Promise<Date | null> {
  const row = await queryOne<RowDataPacket & { last: Date | null }>(
    `SELECT MAX(quoted_at) AS last FROM ${sil("sil_shipping_quotes")}`,
  );
  return row?.last ? new Date(row.last) : null;
}

/** Hours between refreshes, from sil_settings. Falls back to 6 when unset or invalid. */
export async function refreshIntervalHours(): Promise<number> {
  const row = await queryOne<RowDataPacket & { setting_value: string }>(
    `SELECT setting_value FROM ${sil("sil_settings")} WHERE setting_key = 'shipping_quote_refresh_hours'`,
  );
  const h = Number(row?.setting_value);
  return Number.isFinite(h) && h >= 1 ? h : 6;
}

/** Whether a refresh is due now. A cache that has never been filled is always due. */
export async function refreshDue(now: Date = new Date()): Promise<boolean> {
  const last = await lastQuoteRefresh();
  if (!last) return true;
  const hours = await refreshIntervalHours();
  return now.getTime() - last.getTime() >= hours * 3_600_000;
}

/** One in-stock BTS offer with an EAN, used as the sample product for BTS quotes. */
async function btsSampleItem(vendorId: number): Promise<SampleItem | null> {
  const row = await queryOne<RowDataPacket & { primary_ean: string; vendor_product_id: string }>(
    `SELECT primary_ean, vendor_product_id FROM ${sil("sil_offers")}
      WHERE vendor_id = ? AND stock > 0 AND primary_ean IS NOT NULL AND primary_ean <> ''
      ORDER BY id LIMIT 1`,
    [vendorId],
  );
  return row ? { ean: row.primary_ean, vendorProductId: row.vendor_product_id } : null;
}

async function upsertQuote(
  vendorSlug: string,
  country: string,
  cost: number,
  status: "ok" | "none" | "error",
  carrier: string | null,
  deliveryDays: number | null,
): Promise<void> {
  // On error keep the last good cost and carrier. Only status and time change.
  if (status === "error") {
    await execute(
      `UPDATE ${sil("sil_shipping_quotes")} SET status = 'error', quoted_at = NOW()
        WHERE vendor_slug = ? AND country = ?`,
      [vendorSlug, country],
    );
    const exists = await queryOne<RowDataPacket & { n: number }>(
      `SELECT COUNT(*) AS n FROM ${sil("sil_shipping_quotes")} WHERE vendor_slug = ? AND country = ?`,
      [vendorSlug, country],
    );
    if (!exists || exists.n === 0) {
      await execute(
        `INSERT INTO ${sil("sil_shipping_quotes")} (vendor_slug, country, cost_eur, status)
         VALUES (?, ?, 0, 'error')`,
        [vendorSlug, country],
      );
    }
    return;
  }
  await execute(
    `INSERT INTO ${sil("sil_shipping_quotes")} (vendor_slug, country, cost_eur, carrier, delivery_days, status, quoted_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE cost_eur = VALUES(cost_eur), carrier = VALUES(carrier),
       delivery_days = VALUES(delivery_days), status = VALUES(status), quoted_at = NOW()`,
    [vendorSlug, country, cost, carrier, deliveryDays, status],
  );
}

/** Refresh the cache for one vendor. Per-country failures are recorded, not thrown. */
export async function refreshVendorQuotes(vendor: Vendor): Promise<QuoteRefreshResult> {
  const adapter = createOrderAdapter(vendor.slug);
  const result: QuoteRefreshResult = { vendor: vendor.slug, ok: 0, none: 0, error: 0 };
  const isBts = vendor.slug === "bts";

  let sample: SampleItem | null = null;
  if (isBts) {
    sample = await btsSampleItem(vendor.id);
    if (!sample) {
      log.warn("bts: no in-stock EAN offer to quote with; skipping refresh");
      return result;
    }
  }

  for (const country of vendor.serviceableCountries) {
    const code = country.toUpperCase();
    const postcode = QUOTE_POSTCODE[code] ?? "";
    if (isBts && !postcode) {
      log.warn(`bts: no quote postcode for ${code}; skipping`);
      continue;
    }
    try {
      const items: OrderItem[] = sample
        ? [{
            sku: sample.ean,
            vendorProductId: sample.vendorProductId,
            ean: sample.ean,
            name: "quote sample",
            quantity: 1,
            unitCost: 0,
          }]
        : [];
      const options = await adapter.quoteShipping(
        {
          country: code,
          address: {
            firstName: "", lastName: "", company: "", address1: "", address2: "", city: "",
            state: "", postcode, country: code, email: "", phone: "",
          },
        },
        items,
      );
      const valid = options.filter((o) => Number.isFinite(o.cost) && o.cost >= 0);
      if (valid.length === 0) {
        await upsertQuote(vendor.slug, code, 0, "none", null, null);
        result.none++;
        continue;
      }
      const cheapest = valid.reduce((a, b) => (b.cost < a.cost ? b : a));
      await upsertQuote(vendor.slug, code, cheapest.cost, "ok", cheapest.company ?? null, cheapest.deliveryDays ?? null);
      result.ok++;
    } catch (err) {
      log.warn(`${vendor.slug} ${code}: quote failed`, String(err));
      await upsertQuote(vendor.slug, code, 0, "error", null, null);
      result.error++;
    }
  }
  return result;
}

/** Refresh every active vendor that serves at least one country. */
export async function refreshAllQuotes(): Promise<QuoteRefreshResult[]> {
  const vendors = (await loadVendors()).filter((v) => v.active && v.serviceableCountries.length > 0);
  const out: QuoteRefreshResult[] = [];
  for (const vendor of vendors) out.push(await refreshVendorQuotes(vendor));
  return out;
}


export const SHIPPING_SETTING_KEYS = [
  "shipping_markup_percent",
  "shipping_markup_fixed_eur",
  "shipping_free_over_eur",
  "shipping_display_mode",
  "shipping_quote_refresh_hours",
] as const;

export interface ShippingRules {
  markupPercent: number;
  markupFixedEur: number;
  freeOverEur: number;
  displayMode: "total" | "per_location";
  refreshHours: number;
}

/** Operator rules, read fresh from sil_settings. Invalid stored values fall back to the safe default. */
export async function loadShippingRules(): Promise<ShippingRules> {
  const rows = await query<RowDataPacket & { setting_key: string; setting_value: string }>(
    `SELECT setting_key, setting_value FROM ${sil("sil_settings")}
      WHERE setting_key IN (${SHIPPING_SETTING_KEYS.map(() => "?").join(",")})`,
    [...SHIPPING_SETTING_KEYS],
  );
  const v = new Map(rows.map((r) => [r.setting_key, r.setting_value]));
  const num = (k: string, fallback: number, min: number): number => {
    const n = Number(v.get(k));
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  const mode = v.get("shipping_display_mode");
  return {
    markupPercent: num("shipping_markup_percent", 0, 0),
    markupFixedEur: num("shipping_markup_fixed_eur", 0, 0),
    freeOverEur: num("shipping_free_over_eur", 0, 0),
    displayMode: mode === "per_location" ? "per_location" : "total",
    refreshHours: num("shipping_quote_refresh_hours", 6, 1),
  };
}

export interface CachedQuote {
  vendorSlug: string;
  country: string;
  costEur: number;
  carrier: string | null;
  deliveryDays: number | null;
  status: string;
  quotedAt: string;
}

/** All cached quotes, for the dashboard. */
export async function listCachedQuotes(): Promise<CachedQuote[]> {
  const rows = await query<RowDataPacket & {
    vendor_slug: string; country: string; cost_eur: string; carrier: string | null;
    delivery_days: number | null; status: string; quoted_at: Date;
  }>(
    `SELECT vendor_slug, country, cost_eur, carrier, delivery_days, status, quoted_at
       FROM ${sil("sil_shipping_quotes")} ORDER BY vendor_slug, country`,
  );
  return rows.map((r) => ({
    vendorSlug: r.vendor_slug,
    country: r.country,
    costEur: Number(r.cost_eur),
    carrier: r.carrier,
    deliveryDays: r.delivery_days,
    status: r.status,
    quotedAt: new Date(r.quoted_at).toISOString(),
  }));
}
