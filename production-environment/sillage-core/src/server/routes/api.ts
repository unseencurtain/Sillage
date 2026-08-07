/**
 * Authenticated dashboard API. The single source of truth for configuration and ops actions.
 */
import { Hono } from "hono";
import { sil, wp } from "../../config/env.ts";
import { query, type RowDataPacket } from "../../db/pool.ts";
import { loadSettings, loadVendors, setSetting } from "../../db/settings.ts";
import { logger } from "../../lib/log.ts";
import { approveVendorOrder, dispatchVendorOrder } from "../../orders/dispatch.ts";
import { runSync } from "../../sync/run.ts";
import { requireSession, type AuthEnv } from "../auth.ts";

const log = logger("api");

export const api = new Hono<AuthEnv>();
api.use("*", requireSession);

api.get("/overview", async (c) => {
  const settings = await loadSettings();
  const [offerRows, productRows, publishedRows, lastSync, orderRows] = await Promise.all([
    query<RowDataPacket & { offers: number }>(`SELECT COUNT(*) AS offers FROM ${sil("sil_offers")} WHERE vanished_at IS NULL`),
    query<RowDataPacket & { products: number }>(`SELECT COUNT(*) AS products FROM ${sil("sil_products")}`),
    query<RowDataPacket & { published: number }>(
      `SELECT COUNT(*) AS published FROM ${wp("posts")} WHERE post_type='product' AND post_status='publish'`,
    ),
    query<RowDataPacket>(
      `SELECT id, mode, source, status, duration_ms, products_fetched, posts_created, posts_updated,
              prices_updated, products_vanished, errors, started_at, finished_at
         FROM ${sil("sil_sync_runs")} ORDER BY id DESC LIMIT 1`,
    ),
    query<RowDataPacket & { status: string; n: number }>(
      `SELECT status, COUNT(*) AS n FROM ${sil("sil_vendor_orders")} GROUP BY status`,
    ),
  ]);

  const syncs = await query<RowDataPacket & { day: string; n: number }>(
    `SELECT DATE(started_at) AS day, COUNT(*) AS n
       FROM ${sil("sil_sync_runs")}
      WHERE started_at >= CURDATE() - INTERVAL 7 DAY
      GROUP BY DATE(started_at) ORDER BY day`,
  );

  const ordersByStatus: Record<string, number> = {};
  for (const r of orderRows) ordersByStatus[r.status] = Number(r.n);

  return c.json({
    offers: Number(offerRows[0]?.offers ?? 0),
    products: Number(productRows[0]?.products ?? 0),
    published: Number(publishedRows[0]?.published ?? 0),
    lastSync: lastSync[0] ?? null,
    ordersByStatus,
    syncsLast7Days: syncs.map((s) => ({ day: String(s.day), n: Number(s.n) })),
    settings: {
      dryRun: settings.ordersDryRun,
      autoDispatch: settings.ordersAutoDispatch,
      syncEnabled: settings.syncEnabled,
    },
  });
});

api.get("/sync/runs", async (c) => {
  const limit = Math.min(100, Number(c.req.query("limit") ?? 50));
  const runs = await query<RowDataPacket>(
    `SELECT id, mode, source, status, duration_ms, products_fetched, posts_created, posts_updated,
            prices_updated, products_vanished, errors, started_at, finished_at
       FROM ${sil("sil_sync_runs")} ORDER BY id DESC LIMIT ?`,
    [limit],
  );
  return c.json({ runs });
});

api.post("/sync/run", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { mode?: string; source?: string };
  const mode = body.mode === "full" ? "full" : "fast";
  const settings = await loadSettings();
  const source = body.source === "local" || body.source === "live" ? body.source : settings.syncSource;

  // Fire-and-forget so the HTTP request returns immediately; the dashboard polls /sync/runs.
  void runSync({ mode, source }).catch((err) => log.error(`manual ${mode} sync failed`, String(err)));
  return c.json({ ok: true, started: true, mode, source });
});

api.get("/products", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)));
  const offset = (page - 1) * limit;

  const where = q
    ? `WHERE p.sku LIKE ? OR o.name LIKE ? OR o.primary_ean LIKE ?`
    : "";
  const params: unknown[] = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];

  const [totalRows, items] = await Promise.all([
    query<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total
         FROM ${sil("sil_products")} p
         JOIN ${sil("sil_offers")} o ON o.id = p.primary_offer_id
         ${where}`,
      params,
    ),
    query<RowDataPacket>(
      `SELECT p.id, p.sku, p.wp_post_id, p.slug, o.name, o.stock, o.vendor_price, o.primary_ean,
              v.slug AS vendor, o.image_url
         FROM ${sil("sil_products")} p
         JOIN ${sil("sil_offers")} o ON o.id = p.primary_offer_id
         JOIN ${sil("sil_vendors")} v ON v.id = o.vendor_id
         ${where}
        ORDER BY p.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
  ]);

  return c.json({ items, total: Number(totalRows[0]?.total ?? 0), page, limit });
});

api.get("/vendors", async (c) => {
  const vendors = await loadVendors();
  const settings = await loadSettings();
  return c.json({
    vendors: vendors.map((v) => ({
      id: v.id,
      slug: v.slug,
      name: v.name,
      skuPrefix: v.skuPrefix,
      currency: v.currency,
      fxRate: v.fxRate,
      priceMultiplier: v.priceMultiplier ?? settings.priceMultiplier,
      minVisibleStock: v.minVisibleStock ?? settings.stockThreshold,
      serviceableCountries: v.serviceableCountries,
      active: v.active,
      orderConfig: v.orderConfig,
    })),
  });
});

api.get("/orders", async (c) => {
  const status = c.req.query("status");
  const limit = Math.min(100, Number(c.req.query("limit") ?? 50));
  const orders = await query<RowDataPacket>(
    `SELECT v.id, v.wc_order_id, v.our_reference, v.status, v.items_cost, v.shipping_cost,
            v.total_cost, v.revenue, v.destination_country, v.dry_run, v.vendor_order_number,
            v.created_at, v.updated_at, ven.slug AS vendor
       FROM ${sil("sil_vendor_orders")} v
       JOIN ${sil("sil_vendors")} ven ON ven.id = v.vendor_id
      ${status ? "WHERE v.status = ?" : ""}
      ORDER BY v.id DESC LIMIT ?`,
    status ? [status, limit] : [limit],
  );
  return c.json({ orders });
});

api.get("/orders/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const [order] = await query<RowDataPacket>(
    `SELECT v.*, ven.slug AS vendor
       FROM ${sil("sil_vendor_orders")} v
       JOIN ${sil("sil_vendors")} ven ON ven.id = v.vendor_id
      WHERE v.id = ?`,
    [id],
  );
  if (!order) return c.json({ ok: false, error: "not found" }, 404);
  const [items, events, tracking] = await Promise.all([
    query<RowDataPacket>(`SELECT * FROM ${sil("sil_vendor_order_items")} WHERE vendor_order_id = ?`, [id]),
    query<RowDataPacket>(
      `SELECT * FROM ${sil("sil_order_events")} WHERE vendor_order_id = ? ORDER BY id DESC LIMIT 50`,
      [id],
    ),
    query<RowDataPacket>(`SELECT * FROM ${sil("sil_vendor_order_tracking")} WHERE vendor_order_id = ?`, [id]),
  ]);
  return c.json({ order, items, events, tracking });
});

api.post("/orders/:id/approve", async (c) => {
  const id = Number(c.req.param("id"));
  return c.json(await approveVendorOrder(id, true));
});

api.post("/orders/:id/dispatch", async (c) => {
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as { live?: boolean };
  const result = await dispatchVendorOrder(id, {
    force: true,
    dryRun: body.live ? false : undefined,
  });
  return c.json(result);
});

api.get("/settings", async (c) => {
  const s = await loadSettings();
  return c.json({
    sync_enabled: s.syncEnabled ? "1" : "0",
    fast_sync_minutes: String(s.fastSyncMinutes),
    full_sync_enabled: s.fullSyncEnabled ? "1" : "0",
    full_sync_hour: String(s.fullSyncHour),
    sync_source: s.syncSource,
    global_price_multiplier: String(s.priceMultiplier),
    global_stock_threshold: String(s.stockThreshold),
    orders_dry_run: s.ordersDryRun ? "1" : "0",
    orders_auto_dispatch: s.ordersAutoDispatch ? "1" : "0",
    orders_max_value_eur: String(s.ordersMaxValueEur),
    orders_daily_cap_eur: String(s.ordersDailyCapEur),
    orders_poll_minutes: String(s.ordersPollMinutes),
    orders_notify_customer: s.ordersNotifyCustomer ? "1" : "0",
    description_mode: s.descriptionMode,
  });
});

api.put("/settings", async (c) => {
  const body = await c.req.json<Record<string, string>>();
  const allowed = new Set([
    "sync_enabled",
    "fast_sync_minutes",
    "full_sync_enabled",
    "full_sync_hour",
    "sync_source",
    "global_price_multiplier",
    "global_stock_threshold",
    "orders_dry_run",
    "orders_auto_dispatch",
    "orders_max_value_eur",
    "orders_daily_cap_eur",
    "orders_poll_minutes",
    "orders_notify_customer",
    "description_mode",
  ]);
  let n = 0;
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.has(key) || typeof value !== "string") continue;
    await setSetting(key, value);
    n++;
  }
  return c.json({ ok: true, updated: n });
});

api.get("/logs", async (c) => {
  const level = c.req.query("level");
  const scope = c.req.query("scope");
  const limit = Math.min(200, Number(c.req.query("limit") ?? 100));
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (level) {
    clauses.push("level = ?");
    params.push(level);
  }
  if (scope) {
    clauses.push("scope = ?");
    params.push(scope);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const events = await query<RowDataPacket>(
    `SELECT id, level, scope, message, context, run_id, created_at
       FROM ${sil("sil_events")} ${where}
      ORDER BY id DESC LIMIT ?`,
    [...params, limit],
  );
  return c.json({ events });
});
