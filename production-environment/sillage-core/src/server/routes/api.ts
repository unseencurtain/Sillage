/**
 * Authenticated dashboard API. The single source of truth for configuration and ops actions.
 */
import { Hono } from "hono";
import { env, sil, wp } from "../../config/env.ts";
import { applyRuntimeUrls } from "../../config/env.ts";
import { clearSecret, listSecretStatus, loadSecretsOverlay, setSecret } from "../../config/secrets.ts";
import { execute, query, type RowDataPacket } from "../../db/pool.ts";
import { loadSettings, loadVendor, loadVendors, recordEvent, setSetting, updateVendor } from "../../db/settings.ts";
import {
  deleteArchived,
  deleteMessage,
  deleteMessages,
  listMessages,
  setMessageStatus,
  type MessageKind,
  type MessageStatus,
} from "../../messages/store.ts";
import { listCachedQuotes, loadShippingRules, SHIPPING_SETTING_KEYS, refreshAllQuotes } from "../../shipping/quotes.ts";
import { logger } from "../../lib/log.ts";
import { resolveTimeZone } from "../../lib/timezone.ts";
import { displayedShopImage, isUnusableImage, shopVisibility } from "../../sync/imageRules.ts";
import { loadImageOverrides, normalizeEan, resolveImageUrl } from "../../sync/images.ts";
import {
  loadCompanyBilling,
  parseCompanyBilling,
  parseOrderAddress,
  resolveBillingAddress,
  resolveDeliveryAddress,
  saveCompanyBilling,
} from "../../orders/addresses.ts";
import { destinationAddress, readWooOrder, ignoreOrderIngest } from "../../orders/ingest.ts";
import { approveVendorOrder, dispatchVendorOrder } from "../../orders/dispatch.ts";
import { maybeCompleteWooOrder } from "../../orders/tracking.ts";
import { clearSyncAbort, requestSyncAbort } from "../../sync/abort.ts";
import { parsePriceTiers } from "../../sync/pricing.ts";
import { markAllPricesDirty, markAllProductsDirty, runSync } from "../../sync/run.ts";
import {
  isCatalogueRebuildPending,
  isSyncLockHeld,
  kickContentRewrite,
  kickPriceRewrite,
  queueCatalogueRebuild,
} from "../../sync/pendingRewrite.ts";
import type { OrderAddress } from "../../orders/types.ts";
import { getStorefrontLiveCooldown } from "../../vendors/liveGate.ts";
import { parseVendorPatch } from "../../vendors/validateVendorPatch.ts";
import { isParkedVendor, storefrontVendorSlugs } from "../../vendors/registry.ts";
import { requireSession, verifyPassword, type AuthEnv } from "../auth.ts";
import { IDENTITY_KEYS, loadIdentity, pushIdentity, saveIdentity, validateIdentity, type IdentityField } from "../../identity/identity.ts";

const log = logger("api");

/** Shortest cadence an operator may set. See docs/SYNC-RULES.md. */
const MIN_SYNC_MINUTES = 30;

function parseRunStats(raw: unknown): {
  fetchedByVendor?: Record<string, number>;
  skippedVendors?: string[];
  btsDelta?: boolean;
} {
  if (!raw) return {};
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object") return {};
    const obj = parsed as {
      fetchedByVendor?: Record<string, number>;
      skippedVendors?: string[];
      btsDelta?: boolean;
    };
    return {
      fetchedByVendor: obj.fetchedByVendor,
      skippedVendors: obj.skippedVendors,
      btsDelta: obj.btsDelta,
    };
  } catch {
    return {};
  }
}

function decorateSyncRun(row: RowDataPacket) {
  const extra = parseRunStats(row.stats);
  const { stats: _stats, ...rest } = row;
  void _stats;
  return {
    ...rest,
    fetched_by_vendor: extra.fetchedByVendor ?? null,
    skipped_vendors: extra.skippedVendors ?? [],
    bts_delta: extra.btsDelta === true,
  };
}

function offerEans(row: RowDataPacket): string[] {
  const collected: string[] = [];
  const raw = row.eans;
  if (Array.isArray(raw)) {
    for (const v of raw) if (typeof v === "string" && v) collected.push(v);
  } else if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const v of parsed) if (typeof v === "string" && v) collected.push(v);
      }
    } catch {
      /* ignore malformed JSON */
    }
  }
  if (typeof row.primary_ean === "string" && row.primary_ean) collected.push(row.primary_ean);
  return collected;
}

async function loadUsableImagesForEans(eans: string[]): Promise<Map<string, string>> {
  const unique = [
    ...new Set(
      eans.flatMap((raw) => {
        const trimmed = raw.trim();
        const norm = normalizeEan(trimmed);
        return [trimmed, norm].filter((v): v is string => Boolean(v));
      }),
    ),
  ];
  const map = new Map<string, string>();
  if (unique.length === 0) return map;
  const rows = await query<RowDataPacket & { primary_ean: string | null; image_url: string | null }>(
    `SELECT primary_ean, image_url FROM ${sil("sil_offers")}
      WHERE vanished_at IS NULL
        AND primary_ean IN (${unique.map(() => "?").join(",")})
        AND image_url IS NOT NULL AND image_url != ''`,
    unique,
  );
  for (const row of rows) {
    const ean = normalizeEan(row.primary_ean);
    if (!ean || isUnusableImage(row.image_url) || map.has(ean)) continue;
    map.set(ean, row.image_url!);
  }
  return map;
}

async function hasSuccessfulCatalogue(): Promise<boolean> {
  const rows = await query<RowDataPacket & { n: number }>(
    `SELECT COUNT(*) AS n FROM ${sil("sil_sync_runs")}
      WHERE mode = 'full' AND status IN ('success','partial')`,
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * Catalogue counts: the heavy aggregate behind the Overview tiles.
 *
 * "Published / Visible / Hidden" are read from `wp_posts` joined to `sil_products`, the
 * `_external_thumbnail_url` meta and two `product_visibility` term scans — tens of thousands of rows
 * per call. They only move when a sync writes, so recomputing them on a dashboard timer (the page
 * used to poll every 15s, per open tab) spent a small VPS's CPU on numbers that had not changed.
 * Precompute once and reuse.
 *
 * The cache key is the newest finished sync run, read fresh on each request (one indexed row). That
 * keeps the cache correct even though the sync runs in its own process, so a cold cache or a newly
 * finished run recomputes once while every other request — however many tabs, however often — is a
 * plain lookup.
 */
interface CatalogueCounts {
  offers: number;
  products: number;
  published: number;
  catalogVisible: number;
  hiddenFromCatalog: number;
  outOfStock: number;
  hiddenNoImage: number;
  hiddenStock: number;
  hiddenOperator: number;
}

let catalogueCountsCache: { key: number; data: CatalogueCounts } | null = null;
let catalogueCountsInFlight: { key: number; promise: Promise<CatalogueCounts> } | null = null;

/** The newest run that finished, success or not. `0` before any run has completed. */
async function newestFinishedRunId(): Promise<number> {
  const rows = await query<RowDataPacket & { id: number }>(
    `SELECT id FROM ${sil("sil_sync_runs")}
      WHERE status IN ('success','partial','error')
      ORDER BY id DESC LIMIT 1`,
  );
  return Number(rows[0]?.id ?? 0);
}

async function computeCatalogueCounts(): Promise<CatalogueCounts> {
  // The hide reasons are counted from `_external_thumbnail_url` — the photo the shop actually
  // prints — and not from sil_offers.image_url. Two reasons, and the first is why these numbers
  // were wrong for so long.
  //
  // A vendor's raw image_url being non-empty does not mean the product has a photo. `isUnusableImage`
  // also rejects non-http junk, placeholder paths and BeautyFort's tiny /pic/ thumbs, and the writer
  // resolves through overrides and other vendors' offers before deciding. Testing `image_url = ''`
  // in SQL re-implemented that rule and got it wrong: it reported 675 products hidden for a missing
  // photo when the real figure was 12,003, and left 9,129 of 25,372 hidden products attributed to no
  // reason at all, so the two hide reasons visibly failed to add up to the total.
  //
  // The thumbnail meta cannot drift like that, because the writer has already applied the rule when
  // it set the value: the meta holds a usable URL or is empty, nothing else. Measured on 51,201 live
  // products, zero rows hold a placeholder, a /pic/ thumb or a non-http value. So `TRIM() = ''` here
  // is not an approximation of the rule, it is the writer's own verdict read back — and it agrees
  // exactly with the `hiddenNoImage` figure the sync run reports.
  const [offerRows, productRows, catalogRows] = await Promise.all([
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
        hidden_operator: number;
      }
    >(
      `SELECT
         COUNT(*) AS published,
         SUM(CASE WHEN cat.object_id IS NULL THEN 1 ELSE 0 END) AS catalog_visible,
         SUM(CASE WHEN cat.object_id IS NOT NULL THEN 1 ELSE 0 END) AS hidden_from_catalog,
         SUM(CASE WHEN oos.object_id IS NOT NULL THEN 1 ELSE 0 END) AS out_of_stock,
         SUM(CASE
               WHEN cat.object_id IS NOT NULL
                AND IFNULL(sp.operator_hidden, 0) = 1 THEN 1
               ELSE 0
             END) AS hidden_operator,
         SUM(CASE
               WHEN cat.object_id IS NOT NULL
                AND IFNULL(sp.operator_hidden, 0) = 0
                AND (thumb.meta_value IS NULL OR TRIM(thumb.meta_value) = '') THEN 1
               ELSE 0
             END) AS hidden_no_image,
         SUM(CASE
               WHEN cat.object_id IS NOT NULL
                AND IFNULL(sp.operator_hidden, 0) = 0
                AND thumb.meta_value IS NOT NULL AND TRIM(thumb.meta_value) != ''
                AND oos.object_id IS NOT NULL THEN 1
               ELSE 0
             END) AS hidden_stock
       FROM ${wp("posts")} p
       LEFT JOIN ${sil("sil_products")} sp ON sp.wp_post_id = p.ID
       LEFT JOIN ${wp("postmeta")} thumb
              ON thumb.post_id = p.ID AND thumb.meta_key = '_external_thumbnail_url'
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
  ]);

  const cat = catalogRows[0];
  return {
    offers: Number(offerRows[0]?.offers ?? 0),
    products: Number(productRows[0]?.products ?? 0),
    published: Number(cat?.published ?? 0),
    catalogVisible: Number(cat?.catalog_visible ?? 0),
    hiddenFromCatalog: Number(cat?.hidden_from_catalog ?? 0),
    outOfStock: Number(cat?.out_of_stock ?? 0),
    hiddenNoImage: Number(cat?.hidden_no_image ?? 0),
    hiddenStock: Number(cat?.hidden_stock ?? 0),
    hiddenOperator: Number(cat?.hidden_operator ?? 0),
  };
}

/**
 * Cached catalogue counts, recomputed only when a sync has finished since the last read. `runId` is
 * the sync run the numbers reflect: the dashboard echoes it back so it can tell, without guessing,
 * when a newer run has landed and its value is due to move.
 */
async function loadCatalogueCounts(): Promise<{ runId: number; counts: CatalogueCounts }> {
  const key = await newestFinishedRunId();
  const cached = catalogueCountsCache;
  if (cached && cached.key === key) return { runId: key, counts: cached.data };
  if (catalogueCountsInFlight && catalogueCountsInFlight.key === key) {
    return { runId: key, counts: await catalogueCountsInFlight.promise };
  }
  const promise = computeCatalogueCounts()
    .then((data) => {
      catalogueCountsCache = { key, data };
      return data;
    })
    .finally(() => {
      if (catalogueCountsInFlight?.key === key) catalogueCountsInFlight = null;
    });
  catalogueCountsInFlight = { key, promise };
  return { runId: key, counts: await promise };
}

export const api = new Hono<AuthEnv>();
api.use("*", requireSession);

api.get("/overview", async (c) => {
  const settings = await loadSettings();
  // Shop loop ≈ publish AND NOT exclude-from-catalog (same rule as recountTerms). "Published" alone
  // overstates what customers see when hide-without-image / the stock threshold attach those terms.
  // The catalogue counts themselves are precomputed — see loadCatalogueCounts — so this endpoint is a
  // couple of point reads however often the dashboard asks.
  const [snapshot, lastSync, orderRows] = await Promise.all([
    loadCatalogueCounts(),
    query<RowDataPacket>(
      `SELECT id, mode, source, status, duration_ms, products_fetched, posts_created, posts_updated,
              prices_updated, products_vanished, errors, started_at, finished_at, stats
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

  const { counts, runId: countsRunId } = snapshot;

  return c.json({
    offers: counts.offers,
    products: counts.products,
    /** @deprecated Prefer catalogVisible — publish status alone includes catalog-excluded posts. */
    published: counts.published,
    catalogVisible: counts.catalogVisible,
    hiddenFromCatalog: counts.hiddenFromCatalog,
    outOfStock: counts.outOfStock,
    /** Exclusive hide reason (writer order): no/weak image, including those also OOS. */
    hiddenNoImage: counts.hiddenNoImage,
    /** Exclusive hide reason: usable image, out of stock / below threshold. */
    hiddenStock: counts.hiddenStock,
    /** Exclusive hide reason: operator Keep hidden. */
    hiddenOperator: counts.hiddenOperator,
    /** The finished sync run the counts above were computed from. */
    countsRunId,
    lastSync: lastSync[0] ? decorateSyncRun(lastSync[0]) : null,
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
      // Optional entries (the forms' SMTP password, the Turnstile secret) are not part of "ready":
      // the shop syncs, prices and sells without either, so they must never block a sync.
      const missing = secrets.filter((s) => !s.set && !s.optional).map((s) => s.key);
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
              prices_updated, products_vanished, errors, started_at, finished_at, stats
         FROM ${sil("sil_sync_runs")} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [limit, offset],
    ),
  ]);
  return c.json({
    runs: runs.map(decorateSyncRun),
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
  const allowed = new Set(storefrontVendorSlugs());
  const vendors = Array.isArray(body.vendors)
    ? body.vendors.filter((v): v is string => allowed.has(v))
    : undefined;
  const vendorList = vendors?.length ? vendors : storefrontVendorSlugs();
  const vendorNames = "BeautyFort + BTS";

  await clearSyncAbort();

  if (await isSyncLockHeld()) {
    return c.json({
      ok: true,
      started: false,
      alreadyRunning: true,
      queued: false,
      cooldown: false,
      mode,
      source,
      vendors: vendorList,
      detail:
        "Sync already running — your new request was not started. Watch the active run; pricing Save queues a rewrite-only follow-up automatically.",
    });
  }

  const catalogueReady = await hasSuccessfulCatalogue();
  const pendingRebuild = await isCatalogueRebuildPending();

  // One press is all a rebuild takes. Once it is queued the next vendor call rebuilds instead of
  // syncing prices, so a second press has nothing to add and must not read as "it did not work".
  if (mode === "full" && pendingRebuild) {
    return c.json({
      ok: true,
      started: false,
      alreadyRunning: false,
      queued: true,
      cooldown: false,
      pendingRebuild: true,
      mode,
      source,
      vendors: vendorList,
      detail: settings.syncEnabled
        ? `Rebuild is already queued. The next vendor call (every ${settings.fastSyncMinutes} min) rebuilds ${vendorNames} instead of syncing prices.`
        : "Rebuild is already queued. Turn Sync enabled on and the next vendor call rebuilds instead of syncing prices.",
    });
  }

  // Scheduled cadence owns price/stock. A one-off Update is only for when Sync enabled is off.
  if (mode === "fast" && settings.syncEnabled) {
    return c.json({
      ok: true,
      started: false,
      alreadyRunning: false,
      queued: false,
      cooldown: false,
      scheduleOwnsSync: true,
      mode,
      source,
      vendors: vendorList,
      detail:
        "Automatic price & stock sync is on. The next scheduled call will run it. Turn Sync enabled off for a one-off update.",
    });
  }

  // Rebuild while the schedule is on (and a catalogue already exists) waits for the next call.
  if (mode === "full" && settings.syncEnabled && catalogueReady) {
    if (!pendingRebuild) await queueCatalogueRebuild();
    return c.json({
      ok: true,
      started: false,
      alreadyRunning: false,
      queued: true,
      cooldown: false,
      pendingRebuild: true,
      mode,
      source,
      vendors: vendorList,
      detail: pendingRebuild
        ? `Catalogue rebuild is already queued. The next scheduled sync (every ${settings.fastSyncMinutes} min) will rebuild instead of prices-only.`
        : `Catalogue rebuild queued. The next scheduled sync (every ${settings.fastSyncMinutes} min) will rebuild ${vendorNames} instead of a prices-only call.`,
    });
  }

  // The call interval holds even for a button press: a feed downloaded minutes ago is the feed a
  // second download would return, so the press costs a vendor call and buys nothing. Every vendor
  // or none, too — fetching one wholesaler would write half a catalogue and split the two clocks.
  if (source === "live") {
    const cooldown = await getStorefrontLiveCooldown();
    if (!cooldown.allow) {
      // A rebuild press is remembered rather than refused: the next call rebuilds instead of
      // syncing prices. That is the whole contract — press once, it happens on the next call.
      if (mode === "full") {
        await queueCatalogueRebuild();
        return c.json({
          ok: true,
          started: false,
          alreadyRunning: false,
          queued: true,
          cooldown: true,
          pendingRebuild: true,
          retryInMinutes: cooldown.retryInMinutes,
          nextAllowedAt: cooldown.nextAllowedAt,
          mode,
          source,
          vendors: vendorList,
          detail: settings.syncEnabled
            ? `Rebuild queued. The next vendor call, in about ${cooldown.retryInMinutes} min, rebuilds ${vendorNames} instead of syncing prices.`
            : `Rebuild queued. Turn Sync enabled on and the next vendor call — the feeds are ${cooldown.retryInMinutes} min from their interval — rebuilds instead of syncing prices.`,
        });
      }
      return c.json({
        ok: true,
        started: false,
        alreadyRunning: false,
        queued: false,
        cooldown: true,
        retryInMinutes: cooldown.retryInMinutes,
        nextAllowedAt: cooldown.nextAllowedAt,
        mode,
        source,
        vendors: vendorList,
        detail: `Next vendor call in ${cooldown.retryInMinutes} min — ${cooldown.reason}`,
      });
    }
  }

  void runSync({
    mode,
    source,
    vendors: vendorList,
  }).catch((err) => log.error(`manual ${mode} sync failed`, String(err)));
  return c.json({
    ok: true,
    started: true,
    alreadyRunning: false,
    queued: false,
    cooldown: false,
    mode,
    source,
    vendors: vendorList,
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
  const [cooldown, settings, pendingRebuild, catalogueReady] = await Promise.all([
    getStorefrontLiveCooldown(),
    loadSettings(),
    isCatalogueRebuildPending(),
    hasSuccessfulCatalogue(),
  ]);
  return c.json({
    profile: env.sillageProfile,
    vendors: storefrontVendorSlugs(),
    cooldownMinutes: cooldown.cooldownMinutes,
    /** @deprecated use cooldownMinutes — same value as live_feed_min_minutes */
    liveFeedMinMinutes: cooldown.cooldownMinutes,
    allow: cooldown.allow,
    retryInMinutes: cooldown.retryInMinutes,
    nextAllowedAt: cooldown.nextAllowedAt,
    reason: cooldown.reason,
    syncEnabled: settings.syncEnabled,
    pendingRebuild,
    catalogueReady,
    scheduleOwnsFastSync: settings.syncEnabled,
    dailyCapEnabled: false,
    beautyfort: {
      allow: cooldown.beautyfort.allow,
      reason: cooldown.beautyfort.reason,
      retryInMinutes: cooldown.beautyfort.retryInMinutes,
      maxPerDay: cooldown.beautyfort.maxPerDay,
      usedToday: cooldown.beautyfort.usedToday,
      dailyRemaining: null,
    },
    bts: {
      allow: cooldown.bts.allow,
      reason: cooldown.bts.reason,
      retryInMinutes: cooldown.bts.retryInMinutes,
      maxPerDay: cooldown.bts.maxPerDay,
      usedToday: cooldown.bts.usedToday,
      dailyRemaining: null,
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

  const [totalRows, items, settings] = await Promise.all([
    query<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total
         FROM ${sil("sil_products")} p
         JOIN ${sil("sil_offers")} o ON o.id = p.primary_offer_id
         ${where}`,
      params,
    ),
    query<RowDataPacket>(
      `SELECT p.id, p.sku, p.wp_post_id, p.slug, o.name, o.stock, o.vendor_price, o.primary_ean,
              o.eans, COALESCE(NULLIF(v.storefront_label, ''), v.name) AS vendor, o.image_url,
              v.min_visible_stock, thumb.meta_value AS wp_thumb_url, p.operator_hidden
         FROM ${sil("sil_products")} p
         JOIN ${sil("sil_offers")} o ON o.id = p.primary_offer_id
         JOIN ${sil("sil_vendors")} v ON v.id = o.vendor_id
         LEFT JOIN ${wp("postmeta")} thumb
           ON thumb.post_id = p.wp_post_id AND thumb.meta_key = '_external_thumbnail_url'
         ${where}
        ORDER BY p.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
    loadSettings(),
  ]);

  const offerImages = await loadUsableImagesForEans(items.map((row) => offerEans(row)).flat());
  const overrides = loadImageOverrides(process.cwd(), settings.imageCdnBaseUrl);

  const decorated = items.map((row) => {
    const threshold =
      row.min_visible_stock === null || row.min_visible_stock === undefined
        ? settings.stockThreshold
        : Number(row.min_visible_stock);
    const {
      min_visible_stock: _min,
      eans: _eans,
      wp_thumb_url: wooThumb,
      operator_hidden: opHidden,
      ...rest
    } = row;
    void _min;
    void _eans;
    const resolved = resolveImageUrl(
      offerEans(row),
      (row.image_url as string | null) ?? null,
      overrides,
      offerImages,
    );
    const photo = displayedShopImage((wooThumb as string | null) ?? null, resolved);
    const operatorHidden = Number(opHidden) === 1;
    const slug = typeof row.slug === "string" ? row.slug : "";
    return {
      ...rest,
      operator_hidden: operatorHidden,
      photo_url: photo,
      shop_url: slug ? `${env.wordpress.baseUrl}/product/${slug}/` : null,
      shop_visibility: shopVisibility({
        stock: Number(row.stock),
        imageUrl: photo,
        hideWithoutImage: settings.hideProductsWithoutImage,
        stockThreshold: threshold,
        operatorHidden,
      }),
    };
  });

  return c.json({ items: decorated, total: Number(totalRows[0]?.total ?? 0), page, limit });
});

api.put("/products/:id/visibility", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ hidden?: boolean }>();
  if (!Number.isFinite(id) || id <= 0 || typeof body.hidden !== "boolean") {
    return c.json({ error: "hidden must be true or false" }, 400);
  }

  const rows = await query<RowDataPacket & { id: number; sku: string | null; wp_post_id: number | null }>(
    `SELECT id, sku, wp_post_id FROM ${sil("sil_products")} WHERE id = ? LIMIT 1`,
    [id],
  );
  const row = rows[0];
  if (!row) return c.json({ error: "product not found" }, 404);

  await execute(
    `UPDATE ${sil("sil_products")}
        SET operator_hidden = ?, needs_price_write = 1
      WHERE id = ?`,
    [body.hidden ? 1 : 0, id],
  );

  // Hide immediately so a bad photo is off the catalogue before the rewrite lands.
  if (body.hidden && row.wp_post_id) {
    await execute(
      `INSERT IGNORE INTO ${wp("term_relationships")} (object_id, term_taxonomy_id, term_order)
       SELECT ?, tt.term_taxonomy_id, 0
         FROM ${wp("term_taxonomy")} tt
         JOIN ${wp("terms")} t ON t.term_id = tt.term_id
        WHERE tt.taxonomy = 'product_visibility'
          AND t.slug IN ('exclude-from-catalog', 'exclude-from-search')`,
      [row.wp_post_id],
    );
  }

  const syncStatus = await kickPriceRewrite();
  await recordEvent(
    "info",
    "products",
    body.hidden
      ? `Keep hidden: ${row.sku ?? id}`
      : `Follow shop rules: ${row.sku ?? id}`,
    { productId: id, sku: row.sku, hidden: body.hidden },
  );

  return c.json({
    ok: true,
    operator_hidden: body.hidden,
    syncStarted: syncStatus === "started",
    syncQueued: syncStatus === "queued",
  });
});

api.get("/vendors", async (c) => {
  const vendors = await loadVendors();
  const settings = await loadSettings();
  const lastFetchRows = await query<RowDataPacket & { setting_key: string; setting_value: string }>(
    `SELECT setting_key, setting_value FROM ${sil("sil_settings")}
      WHERE setting_key IN (
        'last_live_fetch_beautyfort',
        'last_live_fetch_bts'
      )`,
  );
  const lastLiveFetch: Record<string, string | null> = {
    beautyfort: null,
    bts: null,
  };
  for (const row of lastFetchRows) {
    if (row.setting_key === "last_live_fetch_beautyfort") lastLiveFetch.beautyfort = row.setting_value;
    if (row.setting_key === "last_live_fetch_bts") lastLiveFetch.bts = row.setting_value;
  }
  return c.json({
    profile: env.sillageProfile,
    parkedVendors: [],
    globalPriceMultiplier: settings.priceMultiplier,
    globalStockThreshold: settings.stockThreshold,
    callIntervalMinutes: settings.liveFeedMinMinutes,
    lastLiveFetch,
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
        parked: isParkedVendor(v.slug),
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
  if (isParkedVendor(slug) && patch.active === true) {
    await recordEvent("warn", "vendors", `reject activate for parked vendor ${slug}`);
    return c.json(
      { error: `${slug} is parked on this storefront and cannot be activated` },
      400,
    );
  }
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

// A row is "done" once it is really at the vendor or closed. A dry-run submit is a rehearsal, not a
// placement, so it stays in "to do" until it is submitted live.
const DONE_STATUSES = ["submitted", "confirmed", "dispatched", "delivered", "cancelled"] as const;
/** Statuses that mean a row is really at a vendor and must never be bulk-closed. */
const PLACED_STATUSES = ["submitted", "confirmed", "dispatched", "delivered"] as const;

// Compile-time constants, never input, so they are inlined instead of bound.
const doneSql = (alias: string) =>
  `(${alias}.status IN (${DONE_STATUSES.map((s) => `'${s}'`).join(", ")})` +
  ` AND NOT (${alias}.dry_run = 1 AND ${alias}.status = 'submitted'))`;
const placedSql = (alias: string) =>
  `(${alias}.dry_run = 0 AND ${alias}.status IN (${PLACED_STATUSES.map((s) => `'${s}'`).join(", ")}))`;

/** Rows a single bulk call may touch. The UI re-runs it for the rest. */
const BULK_ORDER_LIMIT = 500;

api.get("/orders", async (c) => {
  const filter = c.req.query("filter");
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)));
  const offset = (page - 1) * limit;

  // The list shows one row per WooCommerce order; the vendor split lives under it (and in the
  // panel tabs). An order is "to do" while any of its vendor rows is to do, "done" only once every
  // one of them is placed or closed.
  const orderDone = `MIN(${doneSql("v")})`;
  const having =
    filter === "todo" ? `HAVING ${orderDone} = 0` : filter === "done" ? `HAVING ${orderDone} = 1` : "";

  const [totalRows, orders, countRows] = await Promise.all([
    query<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total
         FROM (SELECT 1 FROM ${sil("sil_vendor_orders")} v GROUP BY v.wc_order_id ${having}) o`,
    ),
    query<RowDataPacket & { wc_order_id: number }>(
      `SELECT v.wc_order_id,
              SUM(v.items_cost)         AS items_cost,
              SUM(v.shipping_cost)      AS shipping_cost,
              SUM(v.total_cost)         AS total_cost,
              SUM(v.revenue)            AS revenue,
              MAX(v.destination_country) AS destination_country,
              MAX(v.dry_run)            AS any_dry_run,
              MIN(v.created_at)         AS created_at,
              MAX(v.updated_at)         AS updated_at,
              ${orderDone}              AS order_done
         FROM ${sil("sil_vendor_orders")} v
        GROUP BY v.wc_order_id
        ${having}
        ORDER BY v.wc_order_id DESC
        LIMIT ? OFFSET ?`,
      [limit, offset],
    ),
    // Whole-table counts at order level, so the filter row can say how much is waiting.
    query<RowDataPacket & { total: number; done: number | null }>(
      `SELECT COUNT(*) AS total, SUM(order_done) AS done
         FROM (SELECT ${orderDone} AS order_done FROM ${sil("sil_vendor_orders")} v GROUP BY v.wc_order_id) o`,
    ),
  ]);

  const wcOrderIds = orders.map((o) => Number(o.wc_order_id));
  const vendorRows = wcOrderIds.length
    ? await query<RowDataPacket>(
        `SELECT v.id, v.wc_order_id, v.our_reference, v.status, v.items_cost, v.shipping_cost,
                v.total_cost, v.revenue, v.destination_country, v.dry_run, v.vendor_order_number,
                v.created_at, v.updated_at, ven.slug AS vendor, ven.sku_prefix AS vendor_prefix,
                ${doneSql("v")} AS done
           FROM ${sil("sil_vendor_orders")} v
           JOIN ${sil("sil_vendors")} ven ON ven.id = v.vendor_id
          WHERE v.wc_order_id IN (${wcOrderIds.map(() => "?").join(", ")})
          ORDER BY v.wc_order_id DESC, v.id ASC`,
        wcOrderIds,
      )
    : [];

  const byOrder = new Map<number, RowDataPacket[]>();
  for (const row of vendorRows) {
    const list = byOrder.get(Number(row.wc_order_id)) ?? [];
    list.push(row);
    byOrder.set(Number(row.wc_order_id), list);
  }

  const all = Number(countRows[0]?.total ?? 0);
  const done = Number(countRows[0]?.done ?? 0);

  return c.json({
    orders: orders.map((o) => ({
      wc_order_id: Number(o.wc_order_id),
      items_cost: o.items_cost,
      shipping_cost: o.shipping_cost,
      total_cost: o.total_cost,
      revenue: o.revenue,
      destination_country: o.destination_country,
      any_dry_run: o.any_dry_run,
      order_done: o.order_done,
      created_at: o.created_at,
      updated_at: o.updated_at,
      vendors: byOrder.get(Number(o.wc_order_id)) ?? [],
    })),
    total: Number(totalRows[0]?.total ?? 0),
    page,
    limit,
    counts: { all, done, todo: all - done },
  });
});

/**
 * Bulk-close or delete dispatch rows from the Orders list.
 *
 * `done` is a close, not a spend: the row becomes `cancelled`, which is terminal for the tracking
 * poller, and it can be reopened from the stage buttons. `delete` is irreversible and therefore
 * needs the operator's own password (not just the session cookie).
 *
 * Either explicit `wc_order_ids` (whole orders, from the list) or `ids` (single vendor rows), or a
 * `filter` of todo/done/all, so clearing a list of test orders costs one request instead of one per
 * row. A row that is really at a vendor — live submitted or later — is never touched.
 */
api.post("/orders/bulk", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    action?: string;
    ids?: unknown;
    wc_order_ids?: unknown;
    filter?: string;
    password?: string;
  };
  const action = body.action;
  if (action !== "done" && action !== "delete") {
    return c.json({ ok: false, error: "action must be 'done' or 'delete'" }, 400);
  }

  // Selection is either whole WooCommerce orders (`wc_order_ids`, from the list), single vendor
  // rows (`ids`), or a filter. Both id lists are expanded to the vendor rows that belong to them.
  const numList = (v: unknown) =>
    Array.isArray(v) ? v.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0) : [];
  const wcOrderIds = numList(body.wc_order_ids);
  const ids = numList(body.ids);
  const filter = body.filter;
  const hasFilter = filter === "todo" || filter === "done" || filter === "all";
  if (wcOrderIds.length === 0 && ids.length === 0 && !hasFilter) {
    return c.json({ ok: false, error: "pass wc_order_ids[], ids[] or a filter of todo, done or all" }, 400);
  }

  if (action === "delete" && !verifyPassword(c.get("user"), body.password ?? "")) {
    return c.json({ ok: false, error: "wrong password" }, 403);
  }

  const selection =
    wcOrderIds.length > 0
      ? `v.wc_order_id IN (${wcOrderIds.map(() => "?").join(", ")})`
      : ids.length > 0
        ? `v.id IN (${ids.map(() => "?").join(", ")})`
        : filter === "todo"
          ? `NOT ${doneSql("v")}`
          : filter === "done"
            ? doneSql("v")
            : "1 = 1";
  const selectionParams = wcOrderIds.length > 0 ? wcOrderIds : ids;
  const where = `${selection} AND NOT ${placedSql("v")}`;

  const rows = await query<RowDataPacket & { id: number; status: string; wc_order_id: number }>(
    `SELECT v.id, v.status, v.wc_order_id
       FROM ${sil("sil_vendor_orders")} v
      WHERE ${where}
      ORDER BY v.id ASC
      LIMIT ?`,
    [...selectionParams, BULK_ORDER_LIMIT],
  );

  const touchedOrders = new Set<number>();
  for (const row of rows) {
    if (action === "done") {
      await execute(
        `UPDATE ${sil("sil_vendor_orders")} SET status = 'cancelled', updated_at = NOW() WHERE id = ?`,
        [row.id],
      );
      await execute(
        `INSERT INTO ${sil("sil_order_events")} (vendor_order_id, from_status, to_status, message, context)
         VALUES (?, ?, 'cancelled', ?, ?)`,
        [
          row.id,
          row.status,
          "closed in bulk — nothing was sent to a vendor",
          JSON.stringify({ bulk: true }),
        ],
      );
    } else {
      await execute(`DELETE FROM ${sil("sil_vendor_order_items")} WHERE vendor_order_id = ?`, [row.id]);
      await execute(`DELETE FROM ${sil("sil_vendor_order_tracking")} WHERE vendor_order_id = ?`, [row.id]);
      await execute(`DELETE FROM ${sil("sil_order_events")} WHERE vendor_order_id = ?`, [row.id]);
      await execute(`DELETE FROM ${sil("sil_vendor_orders")} WHERE id = ?`, [row.id]);
      touchedOrders.add(Number(row.wc_order_id));
    }
  }

  // Only once an order has no dispatch row left does deleting it mean "never import this again" —
  // that is what stops the poller bringing a live WooCommerce order back.
  let ignored = 0;
  if (action === "delete") {
    for (const wcOrderId of touchedOrders) {
      const [left] = await query<RowDataPacket & { n: number }>(
        `SELECT COUNT(*) AS n FROM ${sil("sil_vendor_orders")} WHERE wc_order_id = ?`,
        [wcOrderId],
      );
      if (Number(left?.n ?? 0) > 0) continue;
      await ignoreOrderIngest(wcOrderId, `order #${wcOrderId} deleted in the dashboard`);
      ignored += 1;
    }
  }

  // Anything matching the selection, so the answer can say what was skipped and what is left.
  const [matchedRow] = await query<RowDataPacket & { n: number }>(
    `SELECT COUNT(*) AS n FROM ${sil("sil_vendor_orders")} v WHERE ${selection}`,
    selectionParams,
  );
  const [remaining] = await query<RowDataPacket & { n: number }>(
    `SELECT COUNT(*) AS n FROM ${sil("sil_vendor_orders")} v WHERE ${where}`,
    selectionParams,
  );

  const touchedCount = new Set(rows.map((r) => Number(r.wc_order_id))).size;

  await recordEvent("info", "orders", `${action === "done" ? "closed" : "deleted"} ${rows.length} order row(s)`, {
    action,
    wc_order_ids: wcOrderIds.length ? wcOrderIds : null,
    ids: ids.length ? ids : null,
    filter: hasFilter ? filter : null,
    ignored,
  });

  return c.json({
    ok: true,
    action,
    changed: rows.length,
    orders: touchedCount,
    skipped: Math.max(0, Number(matchedRow?.n ?? 0) - rows.length),
    ignored,
    remaining: Number(remaining?.n ?? 0),
  });
});

api.get("/orders/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const [order] = await query<RowDataPacket>(
    `SELECT v.*, ven.slug AS vendor, ven.sku_prefix AS vendor_prefix
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
  // Sibling rows of the same WooCommerce order — the vendor tabs in the panel. Ordered so the
  // currently-open row and its siblings read left-to-right in the order they were ingested.
  const siblings = await query<RowDataPacket>(
    `SELECT v.id, ven.slug AS vendor, ven.sku_prefix AS vendor_prefix, v.status, ${doneSql("v")} AS done
       FROM ${sil("sil_vendor_orders")} v
       JOIN ${sil("sil_vendors")} ven ON ven.id = v.vendor_id
      WHERE v.wc_order_id = ? AND v.id <> ?
      ORDER BY v.id ASC`,
    [order.wc_order_id, id],
  );
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
    siblings,
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

/** Shipping: vendor cost cache per country plus the operator rules. Read only. */
api.get("/shipping", async (c) => {
  const [rules, quotes, vendors] = await Promise.all([loadShippingRules(), listCachedQuotes(), loadVendors()]);
  return c.json({
    rules,
    vendors: vendors
      .filter((v) => v.active)
      .map((v) => ({ slug: v.slug, name: v.name, countries: v.serviceableCountries.length })),
    quotes,
  });
});

/** Refresh the vendor quote cache now, instead of waiting for the next due tick. */
api.post("/shipping/refresh", async (c) => {
  const results = await refreshAllQuotes();
  return c.json({ ok: true, results });
});

api.get("/settings", async (c) => {
  const s = await loadSettings();
  const [bfBilling, btsBilling] = await Promise.all([
    loadCompanyBilling("beautyfort"),
    loadCompanyBilling("bts"),
  ]);
  return c.json({
    sillage_profile: env.sillageProfile,
    parked_vendors: "",
    orders_sandbox_locked: "0",
    sync_enabled: s.syncEnabled ? "1" : "0",
    fast_sync_minutes: String(s.fastSyncMinutes),
    full_sync_enabled: s.fullSyncEnabled ? "1" : "0",
    full_sync_hour: String(s.fullSyncHour),
    schedule_timezone: s.scheduleTimezone,
    sync_source: s.syncSource,
    storefront_pages_enabled: s.storefrontPagesEnabled ? "1" : "0",
    storefront_pages_delay_minutes: String(s.storefrontPagesDelayMinutes),
    storefront_pages_max_age_hours: String(s.storefrontPagesMaxAgeHours),
    storefront_pages_batch_size: String(s.storefrontPagesBatchSize),
    storefront_pages_batch_pause_seconds: String(s.storefrontPagesBatchPauseSeconds),
    storefront_pages_include_offers: s.storefrontPagesIncludeOffers ? "1" : "0",
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
    contact_recipients: s.contactRecipients,
    contact_turnstile_site_key: s.contactTurnstileSiteKey,
    mail_username: s.mailUsername,
    mail_password: s.mailPassword,
    description_mode: s.descriptionMode,
    volume_filter_mode: s.volumeFilterMode,
    live_feed_min_minutes: String(s.liveFeedMinMinutes),
    ...(await shippingSettingsForDashboard()),
    pending_catalogue_rebuild: (await isCatalogueRebuildPending()) ? "1" : "0",
    ...identityForDashboard(await loadIdentity()),
    company_billing_beautyfort: JSON.stringify(bfBilling),
    company_billing_bts: JSON.stringify(btsBilling),
  });
});

/** Identity fields as the dashboard form names them (identity_<field>, the sil_settings keys). */
function identityForDashboard(identity: Record<IdentityField, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of Object.keys(IDENTITY_KEYS) as IdentityField[]) {
    out[IDENTITY_KEYS[field]] = identity[field];
  }
  return out;
}

async function shippingSettingsForDashboard(): Promise<Record<string, string>> {
  const r = await loadShippingRules();
  return {
    shipping_markup_percent: String(r.markupPercent),
    shipping_markup_fixed_eur: String(r.markupFixedEur),
    shipping_free_over_eur: String(r.freeOverEur),
    shipping_display_mode: r.displayMode,
    shipping_quote_refresh_hours: String(r.refreshHours),
  };
}

api.put("/settings", async (c) => {
  const body = await c.req.json<Record<string, string>>();

  // Identity is validated first so a bad address refuses the whole save instead of half of it.
  const identityPatch: Partial<Record<IdentityField, string>> = {};
  for (const field of Object.keys(IDENTITY_KEYS) as IdentityField[]) {
    const key = IDENTITY_KEYS[field];
    if (typeof body[key] === "string") identityPatch[field] = body[key];
  }
  const identityProblems = validateIdentity(identityPatch);
  if (identityProblems.length > 0) {
    return c.json(
      { ok: false, error: identityProblems.map((p) => `${p.field}: ${p.message}`).join("; ") },
      400,
    );
  }
  const allowed = new Set([
    ...SHIPPING_SETTING_KEYS,
    "sync_enabled",
    "fast_sync_minutes",
    "full_sync_enabled",
    "full_sync_hour",
    "schedule_timezone",
    "sync_source",
    "storefront_pages_enabled",
    "storefront_pages_delay_minutes",
    "storefront_pages_max_age_hours",
    "storefront_pages_batch_size",
    "storefront_pages_batch_pause_seconds",
    "storefront_pages_include_offers",
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
    "contact_recipients",
    "contact_turnstile_site_key",
    "mail_username",
    "mail_password",
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
    } else if (key === "storefront_pages_delay_minutes") {
      // 0 means "the moment the rebuild finishes". A day is the ceiling: any longer and the pages
      // trail the catalogue past the max-age floor below, which would make this value meaningless.
      const m = Math.trunc(Number(value));
      persist = String(Number.isFinite(m) ? Math.min(720, Math.max(0, m)) : 10);
    } else if (key === "storefront_pages_max_age_hours") {
      // A floor, never zero: "refresh whenever it is older than nothing" is a run every tick.
      const h = Math.trunc(Number(value));
      persist = String(Number.isFinite(h) && h > 0 ? Math.min(168, h) : 30);
    } else if (key === "storefront_pages_batch_size") {
      const n = Math.trunc(Number(value));
      persist = String(Number.isFinite(n) ? Math.min(100_000, Math.max(0, n)) : 2000);
    } else if (key === "storefront_pages_batch_pause_seconds") {
      const s = Math.trunc(Number(value));
      persist = String(Number.isFinite(s) ? Math.min(300, Math.max(0, s)) : 5);
    } else if (key === "live_feed_min_minutes" || key === "fast_sync_minutes") {
      // 30 minutes is the floor: anything above is the operator's call, nothing below is. Both
      // wholesalers are one account each, and a cadence under half an hour spends their rate limit
      // on feeds that have barely changed.
      const m = Math.max(MIN_SYNC_MINUTES, Math.trunc(Number(value)) || 60);
      persist = String(m);
    }
    if (key.startsWith("shipping_")) {
      const n = Number(value);
      if (key === "shipping_display_mode") {
        if (value !== "total" && value !== "per_location") continue;
        persist = value;
      } else if (!Number.isFinite(n)) {
        continue;
      } else if (key === "shipping_markup_percent") {
        persist = String(Math.min(100, Math.max(0, n)));
      } else if (key === "shipping_quote_refresh_hours") {
        persist = String(Math.max(1, Math.trunc(n)));
      } else {
        persist = String(Math.max(0, n));
      }
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

  // Identity is saved, then written into WordPress. A failed push does not undo the save; it is
  // reported so the operator knows WordPress still has the old values.
  let identityPush: { ok: boolean; error?: string; changed?: Record<string, { from: string; to: string }> } | null = null;
  if (Object.keys(identityPatch).length > 0) {
    await saveIdentity(identityPatch);
    try {
      const pushed = await pushIdentity(await loadIdentity());
      identityPush = { ok: pushed.ok, error: pushed.error, changed: pushed.changed };
    } catch (err) {
      identityPush = { ok: false, error: err instanceof Error ? err.message : String(err) };
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
    identityPush,
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

/* ------------------------------------------------------------------ *
 * Storefront messages (Contact / Right of Withdrawal)
 * ------------------------------------------------------------------ */

const MESSAGE_KINDS: MessageKind[] = ["contact", "withdrawal"];
const MESSAGE_STATUSES: MessageStatus[] = ["new", "read", "archived"];

api.get("/messages", async (c) => {
  const kind = (c.req.query("kind") ?? "contact") as MessageKind;
  if (!MESSAGE_KINDS.includes(kind)) {
    return c.json({ ok: false, error: "unknown kind" }, 400);
  }

  const rawStatus = c.req.query("status") ?? "all";
  if (rawStatus !== "all" && !MESSAGE_STATUSES.includes(rawStatus as MessageStatus)) {
    return c.json({ ok: false, error: "unknown status" }, 400);
  }

  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 25)));

  const result = await listMessages({
    kind,
    status: rawStatus as MessageStatus | "all",
    page,
    limit,
  });
  return c.json(result);
});

/** Move a message between new / read / archived. The kind says which table, always. */
api.put("/messages/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) return c.json({ ok: false, error: "bad id" }, 400);

  const kind = (c.req.query("kind") ?? "") as MessageKind;
  if (!MESSAGE_KINDS.includes(kind)) return c.json({ ok: false, error: "unknown kind" }, 400);

  const body = await c.req.json<{ status?: string }>().catch(() => ({}) as { status?: string });
  const status = body.status as MessageStatus | undefined;
  if (!status || !MESSAGE_STATUSES.includes(status)) {
    return c.json({ ok: false, error: "unknown status" }, 400);
  }

  const changed = await setMessageStatus(kind, id, status);
  if (!changed) return c.json({ ok: false, error: "not found" }, 404);
  return c.json({ ok: true, status });
});

api.delete("/messages/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) return c.json({ ok: false, error: "bad id" }, 400);

  const kind = (c.req.query("kind") ?? "") as MessageKind;
  if (!MESSAGE_KINDS.includes(kind)) return c.json({ ok: false, error: "unknown kind" }, 400);

  const removed = await deleteMessage(kind, id);
  if (!removed) return c.json({ ok: false, error: "not found" }, 404);
  await recordEvent("info", "messages", `${kind} message #${id} deleted by the operator`);
  return c.json({ ok: true });
});

/**
 * Delete a selection in one go. Ids arrive in the body rather than the path — a dozen of them would
 * not fit a URL — and the kind still names the single table they may come from, so a body can never
 * reach across both.
 */
api.post("/messages/bulk-delete", async (c) => {
  const kind = (c.req.query("kind") ?? "") as MessageKind;
  if (!MESSAGE_KINDS.includes(kind)) return c.json({ ok: false, error: "unknown kind" }, 400);

  const body = await c.req
    .json<{ ids?: unknown }>()
    .catch(() => ({}) as { ids?: unknown });
  const ids = Array.isArray(body.ids) ? body.ids.map(Number) : [];
  if (ids.length === 0) return c.json({ ok: false, error: "no ids" }, 400);

  const removed = await deleteMessages(kind, ids);
  await recordEvent("info", "messages", `${removed} ${kind} message(s) deleted by the operator`);
  return c.json({ ok: true, removed });
});

/** Empty one tab's archive: everything already archived, in one move. */
api.post("/messages/empty-archive", async (c) => {
  const kind = (c.req.query("kind") ?? "") as MessageKind;
  if (!MESSAGE_KINDS.includes(kind)) return c.json({ ok: false, error: "unknown kind" }, 400);

  const removed = await deleteArchived(kind);
  await recordEvent("info", "messages", `${kind} archive emptied by the operator (${removed} message(s))`);
  return c.json({ ok: true, removed });
});
