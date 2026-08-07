import { sil } from "../config/env.ts";
import { execute, query, type RowDataPacket } from "./pool.ts";

interface SettingRow extends RowDataPacket {
  setting_key: string;
  setting_value: string;
}

export interface VendorRow extends RowDataPacket {
  id: number;
  slug: string;
  name: string;
  sku_prefix: string;
  currency: string;
  fx_rate: string;
  price_multiplier: string | null;
  min_visible_stock: number | null;
  serviceable_countries: string | string[];
  order_config: string | Record<string, unknown> | null;
  active: number;
}

export interface Vendor {
  id: number;
  slug: string;
  name: string;
  skuPrefix: string;
  currency: string;
  fxRate: number;
  priceMultiplier: number | null;
  minVisibleStock: number | null;
  serviceableCountries: string[];
  orderConfig: Record<string, unknown>;
  active: boolean;
}

export interface GlobalSettings {
  priceMultiplier: number;
  stockThreshold: number;
  maxRrpRatio: number;
  dedupeByEan: boolean;
  primaryOfferStrategy: "cheapest" | "most_stock";
  descriptionMode: "none" | "template";
  /** exact = every ml term; ranges = buckets; off = hide volume facet. */
  volumeFilterMode: "exact" | "ranges" | "off";
  writeBatchSize: number;
  maxStatementBytes: number;
  syncEnabled: boolean;
  fastSyncMinutes: number;
  fullSyncEnabled: boolean;
  /** Hour of day, 0-23, in the database server's time zone. */
  fullSyncHour: number;
  syncSource: "live" | "local";
  ordersDryRun: boolean;
  ordersAutoDispatch: boolean;
  ordersMaxValueEur: number;
  ordersDailyCapEur: number;
  ordersPollMinutes: number;
  ordersNotifyCustomer: boolean;
}

/** MariaDB returns JSON columns as either a string or a parsed value depending on driver mode. */
function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export async function loadSettings(): Promise<GlobalSettings> {
  const rows = await query<SettingRow>(`SELECT setting_key, setting_value FROM ${sil("sil_settings")}`);
  const map = new Map(rows.map((r) => [r.setting_key, r.setting_value]));

  const num = (key: string, fallback: number): number => {
    const v = map.get(key);
    if (v === undefined) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const flag = (key: string, fallback: boolean): boolean => {
    const v = map.get(key);
    return v === undefined ? fallback : v === "1" || v === "true";
  };

  return {
    priceMultiplier: num("global_price_multiplier", 1),
    stockThreshold: num("global_stock_threshold", 0),
    maxRrpRatio: num("max_rrp_ratio", 10),
    dedupeByEan: flag("dedupe_by_ean", true),
    primaryOfferStrategy: (map.get("primary_offer_strategy") as GlobalSettings["primaryOfferStrategy"]) ?? "cheapest",
    descriptionMode: (map.get("description_mode") as GlobalSettings["descriptionMode"]) ?? "none",
    volumeFilterMode: (map.get("volume_filter_mode") as GlobalSettings["volumeFilterMode"]) ?? "ranges",
    writeBatchSize: num("write_batch_size", 500),
    maxStatementBytes: num("max_statement_bytes", 4_194_304),
    syncEnabled: flag("sync_enabled", true),
    fastSyncMinutes: num("fast_sync_minutes", 30),
    fullSyncEnabled: flag("full_sync_enabled", true),
    fullSyncHour: num("full_sync_hour", 3),
    syncSource: (map.get("sync_source") as GlobalSettings["syncSource"]) ?? "live",
    ordersDryRun: flag("orders_dry_run", true),
    ordersAutoDispatch: flag("orders_auto_dispatch", false),
    ordersMaxValueEur: num("orders_max_value_eur", 500),
    ordersDailyCapEur: num("orders_daily_cap_eur", 2000),
    ordersPollMinutes: num("orders_poll_minutes", 15),
    ordersNotifyCustomer: flag("orders_notify_customer", true),
  };
}

export async function setSetting(key: string, value: string): Promise<void> {
  await execute(
    `INSERT INTO ${sil("sil_settings")} (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [key, value],
  );
}

function toVendor(row: VendorRow): Vendor {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    skuPrefix: row.sku_prefix,
    currency: row.currency,
    fxRate: Number(row.fx_rate),
    priceMultiplier: row.price_multiplier === null ? null : Number(row.price_multiplier),
    minVisibleStock: row.min_visible_stock,
    serviceableCountries: parseJson<string[]>(row.serviceable_countries, []),
    orderConfig: parseJson<Record<string, unknown>>(row.order_config, {}),
    active: row.active === 1,
  };
}

export async function loadVendors(): Promise<Vendor[]> {
  const rows = await query<VendorRow>(`SELECT * FROM ${sil("sil_vendors")} ORDER BY id`);
  return rows.map(toVendor);
}

export async function loadVendor(slug: string): Promise<Vendor> {
  const rows = await query<VendorRow>(`SELECT * FROM ${sil("sil_vendors")} WHERE slug = ?`, [slug]);
  const row = rows[0];
  if (!row) throw new Error(`Vendor "${slug}" is not registered in sil_vendors`);
  return toVendor(row);
}

export async function updateVendor(
  slug: string,
  patch: Partial<Pick<Vendor, "priceMultiplier" | "minVisibleStock" | "active" | "fxRate">> & {
    serviceableCountries?: string[];
    orderConfig?: Record<string, unknown>;
  },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.priceMultiplier !== undefined) {
    sets.push("price_multiplier = ?");
    params.push(patch.priceMultiplier);
  }
  if (patch.minVisibleStock !== undefined) {
    sets.push("min_visible_stock = ?");
    params.push(patch.minVisibleStock);
  }
  if (patch.active !== undefined) {
    sets.push("active = ?");
    params.push(patch.active ? 1 : 0);
  }
  if (patch.fxRate !== undefined) {
    sets.push("fx_rate = ?");
    params.push(patch.fxRate);
  }
  if (patch.serviceableCountries !== undefined) {
    sets.push("serviceable_countries = ?");
    params.push(JSON.stringify(patch.serviceableCountries));
  }
  if (patch.orderConfig !== undefined) {
    sets.push("order_config = ?");
    params.push(JSON.stringify(patch.orderConfig));
  }
  if (sets.length === 0) return;

  params.push(slug);
  await execute(`UPDATE ${sil("sil_vendors")} SET ${sets.join(", ")} WHERE slug = ?`, params);
}

export async function recordEvent(
  level: "debug" | "info" | "warn" | "error",
  scope: string,
  message: string,
  context?: unknown,
  runId?: number,
): Promise<void> {
  await execute(
    `INSERT INTO ${sil("sil_events")} (level, scope, message, context, run_id) VALUES (?, ?, ?, ?, ?)`,
    [level, scope, message.slice(0, 1000), context === undefined ? null : JSON.stringify(context), runId ?? null],
  );
}
