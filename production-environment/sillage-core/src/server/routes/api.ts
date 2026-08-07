/**
 * Authenticated dashboard API. The single source of truth for configuration and ops actions.
 */
import { Hono } from "hono";
import { env, sil, wp } from "../../config/env.ts";
import { execute, query, type RowDataPacket } from "../../db/pool.ts";
import { loadSettings, loadVendors, setSetting } from "../../db/settings.ts";
import { logger } from "../../lib/log.ts";
import {
  loadCompanyBilling,
  parseCompanyBilling,
  parseOrderAddress,
  resolveBillingAddress,
  resolveDeliveryAddress,
  saveCompanyBilling,
} from "../../orders/addresses.ts";
import { destinationAddress, readWooOrder } from "../../orders/ingest.ts";
import { approveVendorOrder, dispatchVendorOrder } from "../../orders/dispatch.ts";
import { maybeCompleteWooOrder } from "../../orders/tracking.ts";
import { clearSyncAbort, requestSyncAbort } from "../../sync/abort.ts";
import { parsePriceTiers } from "../../sync/pricing.ts";
import { markAllPricesDirty, markAllProductsDirty, runSync } from "../../sync/run.ts";
import type { OrderAddress } from "../../orders/types.ts";
import { feedCacheAgeMinutes } from "../../vendors/feedCache.ts";
import { checkLiveGate } from "../../vendors/liveGate.ts";
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
  const source =
    body.source === "local" || body.source === "live" || body.source === "cache"
      ? body.source
      : settings.syncSource;

  // Re-enable scheduling when an operator deliberately starts a run after Stop.
  await clearSyncAbort();
  if (!settings.syncEnabled) await setSetting("sync_enabled", "1");

  // Fire-and-forget so the HTTP request returns immediately; the dashboard polls /sync/runs.
  void runSync({ mode, source }).catch((err) => log.error(`manual ${mode} sync failed`, String(err)));
  return c.json({ ok: true, started: true, mode, source });
});

/** Hard stop: abort the running sync and disable scheduled sync until re-enabled. */
api.post("/sync/stop", async (c) => {
  await requestSyncAbort();
  return c.json({
    ok: true,
    stopped: true,
    detail: "Running sync will abort between batches. sync_enabled is now off — turn it on or press Run to start fresh.",
  });
});

api.get("/sync/live-status", async (c) => {
  const settings = await loadSettings();
  const [bfGate, btsGate, bfAge, btsAge] = await Promise.all([
    checkLiveGate("beautyfort"),
    checkLiveGate("bts"),
    feedCacheAgeMinutes("beautyfort"),
    feedCacheAgeMinutes("bts"),
  ]);
  return c.json({
    liveFeedMinMinutes: settings.liveFeedMinMinutes,
    beautyfort: {
      ...bfGate,
      maxPerDay: settings.beautyfortLiveMaxPerDay,
      cacheAgeMinutes: bfAge,
    },
    bts: {
      ...btsGate,
      maxPerDay: settings.btsLiveMaxPerDay,
      cacheAgeMinutes: btsAge,
    },
  });
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
              COALESCE(NULLIF(v.storefront_label, ''), v.name) AS vendor, o.image_url
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
      storefrontLabel: v.storefrontLabel,
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
  const woo = await readWooOrder(Number(order.wc_order_id));
  const wooAddress = woo ? destinationAddress(woo) : null;
  const deliveryAddress = resolveDeliveryAddress(
    order.delivery_address_json,
    wooAddress,
    String(order.destination_country ?? ""),
  );
  const billingAddress = await resolveBillingAddress(
    order.billing_address_json,
    String(order.vendor),
  );
  const companyBilling = await loadCompanyBilling(String(order.vendor));
  const wpAdminUrl = `${env.wordpress.baseUrl}/wp-admin/admin.php?page=wc-orders&action=edit&id=${order.wc_order_id}`;
  return c.json({
    order,
    // Backward-compatible alias for the editable delivery address.
    address: deliveryAddress,
    wooAddress,
    deliveryAddress,
    billingAddress,
    companyBilling,
    wpAdminUrl,
    items,
    events,
    tracking,
  });
});

api.put("/orders/:id/address", async (c) => {
  const id = Number(c.req.param("id"));
  const [order] = await query<
    RowDataPacket & { status: string; wc_order_id: number; dry_run: number; vendor: string }
  >(
    `SELECT v.id, v.status, v.wc_order_id, v.dry_run, ven.slug AS vendor
       FROM ${sil("sil_vendor_orders")} v
       JOIN ${sil("sil_vendors")} ven ON ven.id = v.vendor_id
      WHERE v.id = ?`,
    [id],
  );
  if (!order) return c.json({ ok: false, error: "not found" }, 404);

  const editable = new Set(["received", "approved", "needs_attention", "submitted"]);
  if (!editable.has(order.status)) {
    return c.json({ ok: false, error: `cannot edit address in status ${order.status}` }, 409);
  }
  if (order.status === "submitted" && Number(order.dry_run) === 0) {
    return c.json({ ok: false, error: "cannot edit address after a live submit" }, 409);
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    address?: OrderAddress;
    delivery?: OrderAddress;
    billing?: OrderAddress & { vat?: string };
    resetDeliveryFromWoo?: boolean;
    useCompanyBilling?: boolean;
  };

  const sets: string[] = [];
  const params: unknown[] = [];

  if (body.resetDeliveryFromWoo) {
    const woo = await readWooOrder(Number(order.wc_order_id));
    if (!woo) return c.json({ ok: false, error: "WooCommerce order not found" }, 404);
    const snap = destinationAddress(woo);
    sets.push("delivery_address_json = ?", "destination_country = ?");
    params.push(JSON.stringify(snap), snap.country.toUpperCase());
  } else {
    const deliveryRaw = body.delivery ?? body.address;
    if (deliveryRaw) {
      const delivery = parseOrderAddress(deliveryRaw);
      if (!delivery) {
        return c.json({ ok: false, error: "delivery.address1 and delivery.country are required" }, 400);
      }
      sets.push("delivery_address_json = ?", "destination_country = ?");
      params.push(JSON.stringify(delivery), delivery.country.toUpperCase());
    }
  }

  if (body.useCompanyBilling) {
    const company = await loadCompanyBilling(order.vendor);
    sets.push("billing_address_json = ?");
    params.push(JSON.stringify(company));
  } else if (body.billing) {
    const billing = parseCompanyBilling(body.billing);
    if (!billing.address1 || !billing.country) {
      return c.json({ ok: false, error: "billing.address1 and billing.country are required" }, 400);
    }
    sets.push("billing_address_json = ?");
    params.push(JSON.stringify(billing));
  }

  if (sets.length === 0) {
    return c.json({ ok: false, error: "nothing to update" }, 400);
  }

  sets.push("updated_at = NOW()");
  params.push(id);
  await execute(`UPDATE ${sil("sil_vendor_orders")} SET ${sets.join(", ")} WHERE id = ?`, params);
  await execute(
    `INSERT INTO ${sil("sil_order_events")} (vendor_order_id, from_status, to_status, message, context)
     VALUES (?, ?, ?, ?, ?)`,
    [
      id,
      order.status,
      order.status,
      body.resetDeliveryFromWoo
        ? "delivery reset from WooCommerce"
        : body.useCompanyBilling
          ? "billing set from saved company profile"
          : "delivery/billing address updated from dashboard",
      JSON.stringify({
        resetDeliveryFromWoo: Boolean(body.resetDeliveryFromWoo),
        useCompanyBilling: Boolean(body.useCompanyBilling),
        hasDelivery: Boolean(body.delivery ?? body.address),
        hasBilling: Boolean(body.billing),
      }),
    ],
  );
  return c.json({ ok: true });
});

const OPERATIONAL_STAGES = [
  "received",
  "approved",
  "submitted",
  "confirmed",
  "dispatched",
  "delivered",
] as const;

api.post("/orders/:id/status", async (c) => {
  const id = Number(c.req.param("id"));
  const [order] = await query<RowDataPacket & { status: string; dry_run: number; wc_order_id: number }>(
    `SELECT id, status, dry_run, wc_order_id FROM ${sil("sil_vendor_orders")} WHERE id = ?`,
    [id],
  );
  if (!order) return c.json({ ok: false, error: "not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { status?: string; confirm?: boolean };
  const next = body.status;
  if (!next || !(OPERATIONAL_STAGES as readonly string[]).includes(next)) {
    return c.json(
      { ok: false, error: `status must be one of: ${OPERATIONAL_STAGES.join(", ")}` },
      400,
    );
  }

  // Same edit window as address: pre-live or dry-run submitted. After live submit require confirm.
  const lockedAfterLive =
    Number(order.dry_run) === 0 &&
    ["submitted", "confirmed", "dispatched", "delivered"].includes(order.status);
  if (lockedAfterLive && !body.confirm) {
    return c.json(
      {
        ok: false,
        error: "confirm required to change status after a live submit",
        needsConfirm: true,
      },
      409,
    );
  }

  const from = order.status;
  await execute(
    `UPDATE ${sil("sil_vendor_orders")}
        SET status = ?,
            approved_at   = IF(? = 'approved'   AND approved_at   IS NULL, NOW(), approved_at),
            submitted_at  = IF(? = 'submitted'  AND submitted_at  IS NULL, NOW(), submitted_at),
            dispatched_at = IF(? = 'dispatched' AND dispatched_at IS NULL, NOW(), dispatched_at),
            delivered_at  = IF(? = 'delivered'  AND delivered_at  IS NULL, NOW(), delivered_at),
            updated_at = NOW()
      WHERE id = ?`,
    [next, next, next, next, next, id],
  );
  await execute(
    `INSERT INTO ${sil("sil_order_events")} (vendor_order_id, from_status, to_status, message, context)
     VALUES (?, ?, ?, ?, ?)`,
    [
      id,
      from,
      next,
      "manual status override",
      JSON.stringify({ confirm: Boolean(body.confirm) }),
    ],
  );

  if (next === "delivered" || from === "delivered") {
    const settings = await loadSettings();
    await maybeCompleteWooOrder(Number(order.wc_order_id), settings.ordersNotifyCustomer);
  }

  return c.json({ ok: true, status: next });
});

api.post("/orders/:id/approve", async (c) => {
  const id = Number(c.req.param("id"));
  return c.json(await approveVendorOrder(id, true));
});

api.post("/orders/:id/dispatch", async (c) => {
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as { live?: boolean };
  // Dashboard buttons are explicit: Dry-run always dry, Live always live — never inherit settings.
  const result = await dispatchVendorOrder(id, {
    force: true,
    dryRun: body.live === true ? false : true,
  });
  return c.json(result);
});

api.get("/settings", async (c) => {
  const s = await loadSettings();
  const [bfBilling, btsBilling] = await Promise.all([
    loadCompanyBilling("beautyfort"),
    loadCompanyBilling("bts"),
  ]);
  return c.json({
    sync_enabled: s.syncEnabled ? "1" : "0",
    fast_sync_minutes: String(s.fastSyncMinutes),
    full_sync_enabled: s.fullSyncEnabled ? "1" : "0",
    full_sync_hour: String(s.fullSyncHour),
    sync_source: s.syncSource,
    global_price_multiplier: String(s.priceMultiplier),
    price_tiers: JSON.stringify(s.priceTiers),
    global_stock_threshold: String(s.stockThreshold),
    hide_products_without_image: s.hideProductsWithoutImage ? "1" : "0",
    orders_dry_run: s.ordersDryRun ? "1" : "0",
    orders_auto_dispatch: s.ordersAutoDispatch ? "1" : "0",
    orders_max_value_eur: String(s.ordersMaxValueEur),
    orders_daily_cap_eur: String(s.ordersDailyCapEur),
    orders_poll_minutes: String(s.ordersPollMinutes),
    orders_notify_customer: s.ordersNotifyCustomer ? "1" : "0",
    description_mode: s.descriptionMode,
    volume_filter_mode: s.volumeFilterMode,
    live_feed_min_minutes: String(s.liveFeedMinMinutes),
    beautyfort_live_max_per_day: String(s.beautyfortLiveMaxPerDay),
    bts_live_max_per_day: String(s.btsLiveMaxPerDay),
    company_billing_beautyfort: JSON.stringify(bfBilling),
    company_billing_bts: JSON.stringify(btsBilling),
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
    "price_tiers",
    "global_stock_threshold",
    "hide_products_without_image",
    "orders_dry_run",
    "orders_auto_dispatch",
    "orders_max_value_eur",
    "orders_daily_cap_eur",
    "orders_poll_minutes",
    "orders_notify_customer",
    "description_mode",
    "volume_filter_mode",
    "live_feed_min_minutes",
    "beautyfort_live_max_per_day",
    "bts_live_max_per_day",
    "company_billing_beautyfort",
    "company_billing_bts",
  ]);
  // Settings that change what we write to WooCommerce. Hashes only see vendor feed data, so a
  // multiplier edit would otherwise look like "nothing changed" forever.
  const priceKeys = new Set([
    "global_price_multiplier",
    "price_tiers",
    "global_stock_threshold",
    "hide_products_without_image",
  ]);
  const contentKeys = new Set(["description_mode", "volume_filter_mode"]);

  let n = 0;
  let touchPrice = false;
  let touchContent = false;
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.has(key) || typeof value !== "string") continue;
    if (key === "company_billing_beautyfort" || key === "company_billing_bts") {
      try {
        const parsed = parseCompanyBilling(JSON.parse(value));
        const slug = key === "company_billing_bts" ? "bts" : "beautyfort";
        await saveCompanyBilling(slug, parsed);
      } catch {
        continue;
      }
      n++;
      continue;
    }
    if (key === "price_tiers") {
      // Persist the canonical sorted/validated form so the dashboard round-trips cleanly.
      const parsed = parsePriceTiers(value);
      await setSetting(key, JSON.stringify(parsed.tiers));
    } else {
      await setSetting(key, value);
    }
    n++;
    if (priceKeys.has(key)) touchPrice = true;
    if (contentKeys.has(key)) touchContent = true;
    // Turning sync back on clears a previous Stop.
    if (key === "sync_enabled" && (value === "1" || value === "true")) {
      await clearSyncAbort();
    }
  }

  let marked = 0;
  if (touchContent) marked = await markAllProductsDirty();
  else if (touchPrice) marked = await markAllPricesDirty();

  if (marked > 0) {
    // Never burn a live vendor download for a settings rewrite — use disk cache / rewrite-only.
    if (touchContent) {
      void runSync({ mode: "full", source: "cache" }).catch((err) =>
        log.error("settings-triggered sync failed", String(err)),
      );
    } else {
      void runSync({ mode: "fast", source: "cache", rewriteOnly: true }).catch((err) =>
        log.error("settings-triggered sync failed", String(err)),
      );
    }
  }

  return c.json({
    ok: true,
    updated: n,
    marked,
    syncStarted: marked > 0,
    syncKind: marked > 0 ? (touchContent ? "full/cache" : "fast/rewrite-only") : null,
  });
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
