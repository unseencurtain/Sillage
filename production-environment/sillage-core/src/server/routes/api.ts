/**
 * Authenticated dashboard API. The single source of truth for configuration and ops actions.
 */
import { Hono } from "hono";
import { env, sil, wp } from "../../config/env.ts";
import { applyRuntimeUrls } from "../../config/env.ts";
import { clearSecret, listSecretStatus, loadSecretsOverlay, setSecret } from "../../config/secrets.ts";
import { execute, query, type RowDataPacket } from "../../db/pool.ts";
import { loadSettings, loadVendor, loadVendors, recordEvent, setSetting, updateVendor } from "../../db/settings.ts";
import { logger } from "../../lib/log.ts";
import { resolveTimeZone } from "../../lib/timezone.ts";
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
import { isSyncLockHeld, kickContentRewrite, kickPriceRewrite } from "../../sync/pendingRewrite.ts";
import type { OrderAddress } from "../../orders/types.ts";
import { getRetailLiveCooldown } from "../../vendors/liveGate.ts";
import { parseVendorPatch } from "../../vendors/validateVendorPatch.ts";
import { requireSession, type AuthEnv } from "../auth.ts";

const log = logger("api");

export const api = new Hono<AuthEnv>();
api.use("*", requireSession);

api.get("/overview", async (c) => {
  const settings = await loadSettings();
  // Shop loop ≈ publish AND NOT exclude-from-catalog (same rule as recountTerms).
  // "Published" alone overstates what customers see when hide-without-image / stock
  // threshold attach those visibility terms.
  const [offerRows, productRows, catalogRows, lastSync, orderRows] = await Promise.all([
    query<RowDataPacket & { offers: number }>(`SELECT COUNT(*) AS offers FROM ${sil("sil_offers")} WHERE vanished_at IS NULL`),
    query<RowDataPacket & { products: number }>(`SELECT COUNT(*) AS products FROM ${sil("sil_products")}`),
    query<
      RowDataPacket & {
        published: number;
        catalog_visible: number;
        hidden_from_catalog: number;
        out_of_stock: number;
        hidden_no_image: number;
        hidden_stock: number;
      }
    >(
      `SELECT
         COUNT(*) AS published,
         SUM(CASE WHEN cat.object_id IS NULL THEN 1 ELSE 0 END) AS catalog_visible,
         SUM(CASE WHEN cat.object_id IS NOT NULL THEN 1 ELSE 0 END) AS hidden_from_catalog,
         SUM(CASE WHEN oos.object_id IS NOT NULL THEN 1 ELSE 0 END) AS out_of_stock,
         SUM(CASE
               WHEN cat.object_id IS NOT NULL AND oos.object_id IS NULL THEN 1
               ELSE 0
             END) AS hidden_no_image,
         SUM(CASE
               WHEN cat.object_id IS NOT NULL AND oos.object_id IS NOT NULL THEN 1
               ELSE 0
             END) AS hidden_stock
       FROM ${wp("posts")} p
       LEFT JOIN (
         SELECT tr.object_id
           FROM ${wp("term_relationships")} tr
           JOIN ${wp("term_taxonomy")} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
           JOIN ${wp("terms")} t ON t.term_id = tt.term_id
          WHERE tt.taxonomy = 'product_visibility' AND t.slug = 'exclude-from-catalog'
       ) cat ON cat.object_id = p.ID
       LEFT JOIN (
         SELECT tr.object_id
           FROM ${wp("term_relationships")} tr
           JOIN ${wp("term_taxonomy")} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
           JOIN ${wp("terms")} t ON t.term_id = tt.term_id
          WHERE tt.taxonomy = 'product_visibility' AND t.slug = 'outofstock'
       ) oos ON oos.object_id = p.ID
      WHERE p.post_type = 'product' AND p.post_status = 'publish'`,
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

  const cat = catalogRows[0];
  const published = Number(cat?.published ?? 0);
  const catalogVisible = Number(cat?.catalog_visible ?? 0);
  const hiddenFromCatalog = Number(cat?.hidden_from_catalog ?? 0);

  return c.json({
    offers: Number(offerRows[0]?.offers ?? 0),
    products: Number(productRows[0]?.products ?? 0),
    /** @deprecated Prefer catalogVisible — publish status alone includes catalog-excluded posts. */
    published,
    catalogVisible,
    hiddenFromCatalog,
    outOfStock: Number(cat?.out_of_stock ?? 0),
    /** Catalog-hidden without outofstock term — typically hide_products_without_image. */
    hiddenNoImage: Number(cat?.hidden_no_image ?? 0),
    /** Catalog-hidden with outofstock — stock threshold (and often OOS). */
    hiddenStock: Number(cat?.hidden_stock ?? 0),
    lastSync: lastSync[0] ?? null,
    ordersByStatus,
    syncsLast7Days: syncs.map((s) => ({ day: String(s.day), n: Number(s.n) })),
    settings: {
      dryRun: settings.ordersDryRun,
      autoDispatch: settings.ordersAutoDispatch,
      syncEnabled: settings.syncEnabled,
      hideProductsWithoutImage: settings.hideProductsWithoutImage,
      stockThreshold: settings.stockThreshold,
      scheduleTimezone: settings.scheduleTimezone,
    },
    secrets: (() => {
      loadSecretsOverlay();
      const { secrets } = listSecretStatus();
      const missing = secrets.filter((s) => !s.set).map((s) => s.key);
      return { ready: missing.length === 0, missing };
    })(),
  });
});

api.get("/sync/runs", async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)));
  const offset = (page - 1) * limit;
  const [totalRows, runs] = await Promise.all([
    query<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM ${sil("sil_sync_runs")}`,
    ),
    query<RowDataPacket>(
      `SELECT id, mode, source, status, duration_ms, products_fetched, posts_created, posts_updated,
              prices_updated, products_vanished, errors, started_at, finished_at
         FROM ${sil("sil_sync_runs")} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [limit, offset],
    ),
  ]);
  return c.json({
    runs,
    total: Number(totalRows[0]?.total ?? 0),
    page,
    limit,
  });
});

api.post("/sync/run", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    mode?: string;
    source?: string;
    vendors?: string[];
  };
  const mode = body.mode === "full" ? "full" : "fast";
  const settings = await loadSettings();
  const source =
    body.source === "local" || body.source === "live" || body.source === "cache"
      ? body.source
      : settings.syncSource;
  // Dashboard "Run sync now" may pin BeautyFort + BTS; never accept parked WPF here.
  const vendors = Array.isArray(body.vendors)
    ? body.vendors.filter((v): v is string => v === "beautyfort" || v === "bts")
    : undefined;

  // Re-enable scheduling when an operator deliberately starts a run after Stop.
  await clearSyncAbort();
  if (!settings.syncEnabled) await setSetting("sync_enabled", "1");

  // Honest status: do not claim "started" when the advisory lock is held (nothing was queued).
  if (await isSyncLockHeld()) {
    return c.json({
      ok: true,
      started: false,
      alreadyRunning: true,
      cooldown: false,
      mode,
      source,
      vendors: vendors?.length ? vendors : ["beautyfort", "bts"],
      detail:
        "Sync already running — your new request was not started. Watch the active run; pricing Save queues a rewrite-only follow-up automatically.",
    });
  }

  // Live catalogue syncs must wait out the vendor cooldown — never start a run that would
  // silently reuse a stale on-disk feed.
  if (source === "live") {
    const cooldown = await getRetailLiveCooldown();
    if (!cooldown.allow) {
      return c.json({
        ok: true,
        started: false,
        alreadyRunning: false,
        cooldown: true,
        retryInMinutes: cooldown.retryInMinutes,
        nextAllowedAt: cooldown.nextAllowedAt,
        mode,
        source,
        vendors: vendors?.length ? vendors : ["beautyfort", "bts"],
        detail: `Next sync available in ${cooldown.retryInMinutes} min — ${cooldown.reason}`,
      });
    }
  }

  // Fire-and-forget so the HTTP request returns immediately; the dashboard polls /sync/runs.
  void runSync({
    mode,
    source,
    vendors: vendors?.length ? vendors : undefined,
  }).catch((err) => log.error(`manual ${mode} sync failed`, String(err)));
  return c.json({
    ok: true,
    started: true,
    alreadyRunning: false,
    cooldown: false,
    mode,
    source,
    vendors: vendors?.length ? vendors : ["beautyfort", "bts"],
  });
});

/** Vendor API credentials — status only (never echo values). */
api.get("/secrets", (c) => {
  loadSecretsOverlay();
  const { path, secrets } = listSecretStatus();
  return c.json({
    path,
    hotReload: true,
    note: "Changes apply immediately to this process and at the start of each sync. No container restart required for BF/BTS credentials.",
    secrets,
  });
});

api.put("/secrets", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { key?: string; value?: string };
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const value = typeof body.value === "string" ? body.value : "";
  if (!key) return c.json({ ok: false, error: "key is required" }, 400);
  try {
    const secret = setSecret(key, value);
    await recordEvent("info", "secrets", `Set ${key} via dashboard`, { key, source: secret.source });
    return c.json({ ok: true, secret });
  } catch (err) {
    return c.json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 400);
  }
});

api.delete("/secrets/:key", async (c) => {
  const key = c.req.param("key");
  try {
    const secret = clearSecret(key);
    await recordEvent("info", "secrets", `Cleared ${key} via dashboard`, { key });
    return c.json({ ok: true, secret });
  } catch (err) {
    return c.json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 400);
  }
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
  const cooldown = await getRetailLiveCooldown();
  return c.json({
    cooldownMinutes: cooldown.cooldownMinutes,
    /** @deprecated use cooldownMinutes — same value as live_feed_min_minutes */
    liveFeedMinMinutes: cooldown.cooldownMinutes,
    allow: cooldown.allow,
    retryInMinutes: cooldown.retryInMinutes,
    nextAllowedAt: cooldown.nextAllowedAt,
    reason: cooldown.reason,
    beautyfort: {
      allow: cooldown.beautyfort.allow,
      reason: cooldown.beautyfort.reason,
      retryInMinutes: cooldown.beautyfort.retryInMinutes,
      maxPerDay: cooldown.beautyfort.maxPerDay,
      usedToday: cooldown.beautyfort.usedToday,
      dailyRemaining: Math.max(0, cooldown.beautyfort.maxPerDay - cooldown.beautyfort.usedToday),
    },
    bts: {
      allow: cooldown.bts.allow,
      reason: cooldown.bts.reason,
      retryInMinutes: cooldown.bts.retryInMinutes,
      maxPerDay: cooldown.bts.maxPerDay,
      usedToday: cooldown.bts.usedToday,
      dailyRemaining: Math.max(0, cooldown.bts.maxPerDay - cooldown.bts.usedToday),
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
    globalPriceMultiplier: settings.priceMultiplier,
    globalStockThreshold: settings.stockThreshold,
    vendors: vendors.map((v) => {
      const minOrder = v.orderConfig.min_order_value_eur;
      const minOrderValueEur =
        typeof minOrder === "number" && Number.isFinite(minOrder)
          ? minOrder
          : typeof minOrder === "string" && Number.isFinite(Number(minOrder))
            ? Number(minOrder)
            : null;
      return {
        id: v.id,
        slug: v.slug,
        name: v.name,
        storefrontLabel: v.storefrontLabel,
        skuPrefix: v.skuPrefix,
        currency: v.currency,
        fxRate: v.fxRate,
        vatRate: v.vatRate,
        // Raw nulls so the editor can show "fall back to global" — do not coalesce.
        priceMultiplier: v.priceMultiplier,
        minVisibleStock: v.minVisibleStock,
        minOrderValueEur,
        serviceableCountries: v.serviceableCountries,
        active: v.active,
        liveMaxPerDay: v.liveMaxPerDay,
        storeLiveMaxPerDay: v.storeLiveMaxPerDay,
        storeLiveMinMinutes: v.storeLiveMinMinutes,
        orderConfig: v.orderConfig,
      };
    }),
  });
});

api.put("/vendors/:slug", async (c) => {
  const slug = c.req.param("slug");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    await recordEvent("warn", "vendors", `reject patch for ${slug}: unparseable JSON`);
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  const parsed = parseVendorPatch(body);
  if (!parsed.ok) {
    await recordEvent("warn", "vendors", `reject patch for ${slug}: ${parsed.error}`);
    return c.json({ error: parsed.error }, 400);
  }

  let existing: Awaited<ReturnType<typeof loadVendor>>;
  try {
    existing = await loadVendor(slug);
  } catch {
    return c.json({ error: `Unknown vendor "${slug}"` }, 404);
  }

  const patch = parsed.patch;
  const orderConfig = { ...existing.orderConfig };
  if (patch.minOrderValueEur !== undefined) {
    if (patch.minOrderValueEur === null) {
      delete orderConfig.min_order_value_eur;
    } else {
      orderConfig.min_order_value_eur = patch.minOrderValueEur;
    }
  }

  await updateVendor(slug, {
    storefrontLabel: patch.storefrontLabel,
    priceMultiplier: patch.priceMultiplier,
    minVisibleStock: patch.minVisibleStock,
    fxRate: patch.fxRate,
    vatRate: patch.vatRate,
    active: patch.active,
    serviceableCountries: patch.serviceableCountries,
    liveMaxPerDay: patch.liveMaxPerDay,
    storeLiveMaxPerDay: patch.storeLiveMaxPerDay,
    storeLiveMinMinutes: patch.storeLiveMinMinutes,
    orderConfig: patch.minOrderValueEur !== undefined ? orderConfig : undefined,
  });

  // Multiplier / FX / VAT / stock floor change storefront prices; hashes cover vendor feed only.
  const touchPrice =
    patch.priceMultiplier !== undefined ||
    patch.vatRate !== undefined ||
    patch.fxRate !== undefined ||
    patch.minVisibleStock !== undefined;
  let marked = 0;
  let syncStatus: "started" | "queued" | null = null;
  if (touchPrice) {
    marked = await markAllPricesDirty();
    if (marked > 0) {
      // Same path as Settings pricing Save: rewrite from sil_offers, no live vendor API.
      syncStatus = await kickPriceRewrite();
    }
  }

  await recordEvent("info", "vendors", `updated ${slug}`, {
    fields: Object.keys(patch),
    marked,
    syncStatus,
  });

  return c.json({
    ok: true,
    marked,
    syncStarted: syncStatus === "started",
    syncQueued: syncStatus === "queued",
    syncKind: syncStatus ? "fast/rewrite-only" : null,
    detail:
      syncStatus === "queued"
        ? "Sync already running — new prices will apply when it finishes (rewrite-only follow-up queued)."
        : syncStatus === "started"
          ? "Recalculating prices from stored offers (no live vendor download)."
          : undefined,
  });
});

api.get("/orders", async (c) => {
  const status = c.req.query("status");
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)));
  const offset = (page - 1) * limit;
  const where = status ? "WHERE v.status = ?" : "";
  const filterParams: unknown[] = status ? [status] : [];

  const [totalRows, orders] = await Promise.all([
    query<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total
         FROM ${sil("sil_vendor_orders")} v
         ${where}`,
      filterParams,
    ),
    query<RowDataPacket>(
      `SELECT v.id, v.wc_order_id, v.our_reference, v.status, v.items_cost, v.shipping_cost,
              v.total_cost, v.revenue, v.destination_country, v.dry_run, v.vendor_order_number,
              v.created_at, v.updated_at, ven.slug AS vendor
         FROM ${sil("sil_vendor_orders")} v
         JOIN ${sil("sil_vendors")} ven ON ven.id = v.vendor_id
         ${where}
        ORDER BY v.id DESC LIMIT ? OFFSET ?`,
      [...filterParams, limit, offset],
    ),
  ]);

  return c.json({
    orders,
    total: Number(totalRows[0]?.total ?? 0),
    page,
    limit,
  });
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
    schedule_timezone: s.scheduleTimezone,
    sync_source: s.syncSource,
    global_price_multiplier: String(s.priceMultiplier),
    price_tiers: JSON.stringify(s.priceTiers),
    global_stock_threshold: String(s.stockThreshold),
    hide_products_without_image: s.hideProductsWithoutImage ? "1" : "0",
    image_cdn_base_url: s.imageCdnBaseUrl,
    wp_base_url: s.wpBaseUrl,
    cart_min_enabled: s.cartMinEnabled ? "1" : "0",
    cart_min_subtotal_eur: String(s.cartMinSubtotalEur),
    cart_min_fee_eur: String(s.cartMinFeeEur),
    cart_min_fee_label: s.cartMinFeeLabel,
    cart_min_message: s.cartMinMessage,
    orders_dry_run: s.ordersDryRun ? "1" : "0",
    orders_auto_dispatch: s.ordersAutoDispatch ? "1" : "0",
    orders_max_value_eur: String(s.ordersMaxValueEur),
    orders_daily_cap_eur: String(s.ordersDailyCapEur),
    orders_poll_minutes: String(s.ordersPollMinutes),
    orders_notify_customer: s.ordersNotifyCustomer ? "1" : "0",
    description_mode: s.descriptionMode,
    volume_filter_mode: s.volumeFilterMode,
    live_feed_min_minutes: String(s.liveFeedMinMinutes),
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
    "schedule_timezone",
    "sync_source",
    "global_price_multiplier",
    "price_tiers",
    "global_stock_threshold",
    "hide_products_without_image",
    "image_cdn_base_url",
    "wp_base_url",
    "cart_min_enabled",
    "cart_min_subtotal_eur",
    "cart_min_fee_eur",
    "cart_min_fee_label",
    "cart_min_message",
    "orders_dry_run",
    "orders_auto_dispatch",
    "orders_max_value_eur",
    "orders_daily_cap_eur",
    "orders_poll_minutes",
    "orders_notify_customer",
    "description_mode",
    "volume_filter_mode",
    "live_feed_min_minutes",
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

  // Dashboard Save posts the whole form. Only kick rewrites when a price/content key
  // actually changes — otherwise every Save queues a full/cache rewrite forever.
  const priorRows = await query<RowDataPacket & { setting_key: string; setting_value: string }>(
    `SELECT setting_key, setting_value FROM ${sil("sil_settings")} WHERE setting_key IN (${[...allowed]
      .filter((k) => !k.startsWith("company_billing_"))
      .map(() => "?")
      .join(",")})`,
    [...allowed].filter((k) => !k.startsWith("company_billing_")),
  );
  const prior = new Map(priorRows.map((r) => [r.setting_key, r.setting_value]));

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
    let persist = value;
    if (key === "price_tiers") {
      // Persist the canonical sorted/validated form so the dashboard round-trips cleanly.
      const parsed = parsePriceTiers(value);
      persist = JSON.stringify(parsed.tiers);
    } else if (key === "schedule_timezone") {
      persist = resolveTimeZone(value);
    } else if (key === "full_sync_hour") {
      const h = Math.min(23, Math.max(0, Math.trunc(Number(value)) || 0));
      persist = String(h);
    } else if (key === "live_feed_min_minutes" || key === "fast_sync_minutes") {
      const m = Math.max(1, Math.trunc(Number(value)) || 60);
      persist = String(m);
    }
    const changed = prior.get(key) !== persist;
    if (!changed) continue;
    await setSetting(key, persist);
    n++;
    // One operator "minutes between syncs" keeps schedule cadence and vendor gate in lockstep.
    if (key === "live_feed_min_minutes" && prior.get("fast_sync_minutes") !== persist) {
      await setSetting("fast_sync_minutes", persist);
      n++;
    } else if (key === "fast_sync_minutes" && prior.get("live_feed_min_minutes") !== persist) {
      await setSetting("live_feed_min_minutes", persist);
      n++;
    }
    if (priceKeys.has(key)) touchPrice = true;
    if (contentKeys.has(key)) touchContent = true;
    // Turning sync back on clears a previous Stop.
    if (key === "sync_enabled" && (value === "1" || value === "true")) {
      await clearSyncAbort();
    }
  }

  // Hot-apply public URLs so WooCommerce links / tracking use the new shop host without restart.
  const refreshed = await loadSettings();
  applyRuntimeUrls({ wpBaseUrl: refreshed.wpBaseUrl, imageCdnBaseUrl: refreshed.imageCdnBaseUrl });

  let marked = 0;
  let syncStatus: "started" | "queued" | null = null;
  if (touchContent) {
    marked = await markAllProductsDirty();
    if (marked > 0) syncStatus = await kickContentRewrite();
  } else if (touchPrice) {
    marked = await markAllPricesDirty();
    if (marked > 0) syncStatus = await kickPriceRewrite();
  }

  return c.json({
    ok: true,
    updated: n,
    marked,
    syncStarted: syncStatus === "started",
    syncQueued: syncStatus === "queued",
    syncKind: syncStatus ? (touchContent ? "full/cache" : "fast/rewrite-only") : null,
    detail:
      syncStatus === "queued"
        ? "Sync already running — new prices will apply when it finishes (rewrite-only follow-up queued)."
        : syncStatus === "started"
          ? touchContent
            ? "Rewriting catalogue content from cache…"
            : "Recalculating prices from stored offers (no live vendor download)."
          : undefined,
  });
});

api.get("/logs", async (c) => {
  const level = c.req.query("level");
  const scope = c.req.query("scope");
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50)));
  const offset = (page - 1) * limit;
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

  const [totalRows, events] = await Promise.all([
    query<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM ${sil("sil_events")} ${where}`,
      params,
    ),
    query<RowDataPacket>(
      `SELECT id, level, scope, message, context, run_id, created_at
         FROM ${sil("sil_events")} ${where}
        ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
  ]);

  return c.json({
    events,
    total: Number(totalRows[0]?.total ?? 0),
    page,
    limit,
  });
});
