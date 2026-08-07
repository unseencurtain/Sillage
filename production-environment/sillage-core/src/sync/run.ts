import { env, sil } from "../config/env.ts";
import { execute, query, type RowDataPacket } from "../db/pool.ts";
import { loadSettings, loadVendors, recordEvent, type Vendor } from "../db/settings.ts";
import { formatDuration, logger } from "../lib/log.ts";
import { createConnector } from "../vendors/registry.ts";
import type { FeedSource, NormalizedProduct } from "../vendors/types.ts";
import {
  applyPriceStockDelta,
  diffOffers,
  markDirtyFromPendingOffers,
  resolveProductIdentities,
  selectPrimaryOffers,
} from "./diff.ts";
import { finalizeWordPress } from "./finalize.ts";
import {
  ATTRIBUTE_TAXONOMIES,
  BRAND_TAXONOMY,
  ensureVendorShopCategories,
  rebuildCategoryLookup,
  recountTerms,
  syncCategories,
  syncFlatTerms,
  type TermRef,
} from "./taxonomy.ts";
import { clearSyncAbort, SyncAbortedError, throwIfSyncAborted } from "./abort.ts";
import { normalizeVolume, vendorStorefrontLabel } from "./volume.ts";
import { buildWriteContext, writePendingProducts, type WriteMode } from "./writer.ts";
import { checkLiveGate, recordLiveFetch } from "../vendors/liveGate.ts";

const log = logger("sync");

export interface SyncOptions {
  mode: WriteMode;
  source: FeedSource;
  /** Vendor slugs to include. Empty means every active vendor. */
  vendors?: string[];
  /** Fetch and diff but make no WooCommerce writes. */
  dryRun?: boolean;
  /** Re-mark products a previous run errored on, so this run retries them. */
  redrive?: boolean;
  /** Re-mark every product, ignoring the applied hashes. */
  rewriteAll?: boolean;
  /**
   * Skip vendor feed fetch entirely — only rewrite already-dirty WooCommerce rows from DB state.
   * Used when a settings change (multiplier, description) must hit the storefront without burning
   * a live API download.
   */
  rewriteOnly?: boolean;
}

/**
 * Force a content rewrite of every product.
 *
 * The writer skips a product whose content hash is unchanged, which is what makes a re-run cheap.
 * But the hash covers only vendor data — it cannot see a change to the description template, the
 * attribute mapping, or the taxonomy a term lives in. After any of those, the stored hashes are
 * stale in a way nothing detects, and this is the only way to pick the change up.
 */
export async function markAllProductsDirty(): Promise<number> {
  const result = await execute(
    `UPDATE ${sil("sil_products")}
        SET needs_content_write = 1, needs_price_write = 1,
            applied_content_hash = NULL, applied_price_hash = NULL, last_error = NULL`,
  );
  return result.affectedRows;
}

/**
 * Force a price rewrite. Price hashes cover vendor cost only — changing the multiplier, FX rate,
 * or stock threshold leaves every applied_price_hash looking "current" until this runs.
 */
export async function markAllPricesDirty(): Promise<number> {
  const result = await execute(
    `UPDATE ${sil("sil_products")}
        SET needs_price_write = 1, applied_price_hash = NULL, last_error = NULL`,
  );
  return result.affectedRows;
}

/**
 * Re-mark products a previous run failed to write.
 *
 * When a batch throws, the writer clears its dirty flags so the run can still terminate and records
 * the error on the row. Nothing would ever pick those rows up again, so the retry has to be
 * explicit — otherwise a transient fault silently strands products forever.
 */
export async function redriveErroredProducts(): Promise<number> {
  const result = await execute(
    `UPDATE ${sil("sil_products")}
        SET needs_content_write = 1, needs_price_write = 1, last_error = NULL
      WHERE last_error IS NOT NULL OR wp_post_id IS NULL`,
  );
  return result.affectedRows;
}

export interface SyncSummary {
  runId: number;
  mode: WriteMode;
  durationMs: number;
  fetched: number;
  created: number;
  updated: number;
  vanished: number;
  postsCreated: number;
  postsUpdated: number;
  pricesUpdated: number;
  termsCreated: number;
  errors: number;
  /** Products hidden because the resolved image was still missing/placeholder. */
  hiddenNoImage: number;
}

async function startRun(mode: WriteMode, source: FeedSource, vendorId: number | null): Promise<number> {
  const result = await execute(
    `INSERT INTO ${sil("sil_sync_runs")} (vendor_id, mode, source, status) VALUES (?, ?, ?, 'running')`,
    [vendorId, mode, source],
  );
  return result.insertId;
}

async function finishRun(runId: number, startedAt: number, summary: Partial<SyncSummary>, error?: unknown): Promise<void> {
  const durationMs = Date.now() - startedAt;
  const status = error ? "error" : (summary.errors ?? 0) > 0 ? "partial" : "success";
  await execute(
    `UPDATE ${sil("sil_sync_runs")}
        SET finished_at = NOW(), duration_ms = ?, status = ?, error_message = ?,
            products_fetched = ?, products_new = ?, products_updated = ?, products_vanished = ?,
            posts_created = ?, posts_updated = ?, prices_updated = ?, terms_created = ?,
            errors = ?, stats = ?
      WHERE id = ?`,
    [
      durationMs,
      status,
      error ? String(error).slice(0, 2000) : null,
      summary.fetched ?? 0,
      summary.created ?? 0,
      summary.updated ?? 0,
      summary.vanished ?? 0,
      summary.postsCreated ?? 0,
      summary.postsUpdated ?? 0,
      summary.pricesUpdated ?? 0,
      summary.termsCreated ?? 0,
      summary.errors ?? 0,
      JSON.stringify(summary),
      runId,
    ],
  );
}

/** Guard against two syncs writing the same rows concurrently. */
async function acquireLock(name: string, timeoutSeconds = 0): Promise<boolean> {
  const rows = await query<RowDataPacket & { locked: number | null }>(`SELECT GET_LOCK(?, ?) AS locked`, [
    `sillage:${name}`,
    timeoutSeconds,
  ]);
  return rows[0]?.locked === 1;
}

async function releaseLock(name: string): Promise<void> {
  await query(`SELECT RELEASE_LOCK(?)`, [`sillage:${name}`]);
}

export async function runSync(options: SyncOptions): Promise<SyncSummary> {
  const startedAt = Date.now();

  if (!(await acquireLock("sync"))) {
    throw new Error("another sync is already running");
  }

  // A previous Stop must not permanently block the next deliberate run.
  await clearSyncAbort();

  const settings = await loadSettings();
  const allVendors = await loadVendors();
  const selected = allVendors.filter(
    (v) => v.active && (!options.vendors?.length || options.vendors.includes(v.slug)),
  );
  if (selected.length === 0) throw new Error("no active vendors selected");

  const runId = await startRun(options.mode, options.source, selected.length === 1 ? selected[0]!.id : null);
  log.info(
    `run ${runId}: ${options.mode} sync from ${options.source}` +
      (options.rewriteOnly ? " (rewrite-only, no vendor fetch)" : "") +
      ` for ${selected.map((v) => v.slug).join(", ")}`,
  );

  const summary: SyncSummary = {
    runId,
    mode: options.mode,
    durationMs: 0,
    fetched: 0,
    created: 0,
    updated: 0,
    vanished: 0,
    postsCreated: 0,
    postsUpdated: 0,
    pricesUpdated: 0,
    termsCreated: 0,
    errors: 0,
    hiddenNoImage: 0,
  };

  try {
    if (options.rewriteAll) {
      const marked = await markAllProductsDirty();
      log.info(`rewrite-all: ${marked} products re-marked for a full content rewrite`);
    } else if (options.redrive) {
      const redriven = await redriveErroredProducts();
      log.info(`redrive: ${redriven} products re-marked for writing`);
    }

    // Settings-driven rewrites: products are already dirty; do not touch vendor APIs.
    if (options.rewriteOnly) {
      await throwIfSyncAborted();
      const ctx = await buildWriteContext(settings, allVendors, new Map(), new Map(), new Map(), new Map());
      if (!options.dryRun) {
        const written = await writePendingProducts(ctx, options.mode, (done, total) => {
          log.progress(`writing ${done}/${total}`);
        });
        log.progressEnd();
        summary.postsCreated = written.postsCreated;
        summary.postsUpdated = written.postsUpdated;
        summary.pricesUpdated = written.pricesUpdated;
        summary.errors += written.errors;
        summary.hiddenNoImage = written.hiddenNoImage;
      }
      summary.durationMs = Date.now() - startedAt;
      await finishRun(runId, startedAt, summary);
      return summary;
    }

    const categoryMaps = new Map<number, Map<string, TermRef>>();
    const brandValues = new Set<string>();
    const attributeValues = new Map<string, Set<string>>();

    for (const vendor of selected) {
      await throwIfSyncAborted();
      const connector = createConnector(vendor.slug);
      // ── Fast path: price and stock only ────────────────────────────────────
      if (options.mode === "fast") {
        const changed = await fastSyncVendor(vendor, connector, options, runId, summary);
        log.info(`${vendor.slug}: ${changed} offers changed`);
        continue;
      }

      // ── Full path ──────────────────────────────────────────────────────────
      const fetchStarted = Date.now();
      await connector.prepare(options.source, (m) => log.progress(`${vendor.slug}: ${m}`));
      const raw = await connector.fetchRaw(options.source, (m) => log.progress(`${vendor.slug}: ${m}`));
      log.progressEnd();

      const products: NormalizedProduct[] = [];
      let skipped = 0;
      for (const record of raw) {
        const normalized = connector.normalize(record);
        if (normalized) products.push(normalized);
        else skipped++;
      }
      log.info(
        `${vendor.slug}: fetched ${raw.length}, normalized ${products.length}` +
          (skipped ? `, skipped ${skipped}` : "") +
          ` in ${formatDuration(Date.now() - fetchStarted)}`,
      );

      const diff = await diffOffers(vendor, products, runId);
      summary.fetched += diff.fetched;
      summary.created += diff.created;
      summary.updated += diff.updated;
      summary.vanished += diff.vanished;

      // Terms are created before the writer runs so every product can resolve its term ids.
      const referenced = new Set<string>();
      for (const p of products) for (const ref of p.categoryRefs) referenced.add(ref);

      const categories = await syncCategories(vendor.id, connector.categories(), referenced);
      categoryMaps.set(vendor.id, categories.map);
      summary.termsCreated += categories.created;

      for (const p of products) {
        if (p.brand) brandValues.add(p.brand);
        for (const [key, value] of Object.entries(p.attributes)) {
          const taxonomy = ATTRIBUTE_TAXONOMIES[key];
          if (!taxonomy) continue;
          let bucket = attributeValues.get(taxonomy);
          if (!bucket) {
            bucket = new Set();
            attributeValues.set(taxonomy, bucket);
          }
          if (key === "volume") {
            const normalized = normalizeVolume(value, settings.volumeFilterMode);
            if (normalized) bucket.add(normalized);
          } else {
            bucket.add(value);
          }
        }
        // Vendor facet is derived from the connector, not the feed attributes.
        const vendorTax = ATTRIBUTE_TAXONOMIES.vendor;
        if (vendorTax) {
          let bucket = attributeValues.get(vendorTax);
          if (!bucket) {
            bucket = new Set();
            attributeValues.set(vendorTax, bucket);
          }
          bucket.add(vendorStorefrontLabel(vendor));
        }
      }
    }

    if (options.mode === "full") {
      const brands = await syncFlatTerms(BRAND_TAXONOMY, brandValues);
      summary.termsCreated += brands.created;

      const attributeMaps = new Map<string, Map<string, TermRef>>();
      for (const [taxonomy, values] of attributeValues) {
        const result = await syncFlatTerms(taxonomy, values);
        attributeMaps.set(taxonomy, result.map);
        summary.termsCreated += result.created;
      }

      const storefrontLabels: Record<string, string> = {};
      for (const v of allVendors) storefrontLabels[v.slug] = vendorStorefrontLabel(v);
      const vendorShop = await ensureVendorShopCategories(allVendors, storefrontLabels);
      summary.termsCreated += vendorShop.created;

      await resolveProductIdentities(settings);
      await markDirtyFromPendingOffers();
      const reassigned = await selectPrimaryOffers(settings);
      if (reassigned > 0) log.info(`${reassigned} products changed their primary offer`);

      if (options.dryRun) {
        log.warn("dry run — no WooCommerce writes performed");
      } else {
        const ctx = await buildWriteContext(
          settings,
          allVendors,
          categoryMaps,
          brands.map,
          attributeMaps,
          vendorShop.bySlug,
        );
        const written = await writePendingProducts(ctx, "full", (done, total) =>
          log.progress(`writing ${done}/${total}`),
        );
        log.progressEnd();
        summary.postsCreated = written.postsCreated;
        summary.postsUpdated = written.postsUpdated;
        summary.pricesUpdated = written.pricesUpdated;
        summary.errors += written.errors;
        summary.hiddenNoImage = written.hiddenNoImage;

        // Once per run, never per batch.
        await recountTerms(["product_cat", BRAND_TAXONOMY, ...Object.values(ATTRIBUTE_TAXONOMIES)]);
        await rebuildCategoryLookup();
        await finalizeWordPress();
      }
    } else if (!options.dryRun) {
      const ctx = await buildWriteContext(settings, allVendors, new Map(), new Map(), new Map());
      const written = await writePendingProducts(ctx, "fast", (done, total) =>
        log.progress(`writing ${done}/${total}`),
      );
      log.progressEnd();
      summary.pricesUpdated = written.pricesUpdated;
      summary.errors += written.errors;
      summary.hiddenNoImage = written.hiddenNoImage;

      // Stock changes move products in and out of the catalogue, so counts shift.
      await recountTerms(["product_cat", BRAND_TAXONOMY]);
      await finalizeWordPress();
    }

    summary.durationMs = Date.now() - startedAt;
    await finishRun(runId, startedAt, summary);

    log.info(
      `run ${runId} finished in ${formatDuration(summary.durationMs)} — ` +
        `${summary.postsCreated} created, ${summary.postsUpdated} updated, ` +
        `${summary.pricesUpdated} repriced, ${summary.vanished} vanished, ` +
        `${summary.hiddenNoImage} hidden (no image), ${summary.errors} errors`,
    );
    return summary;
  } catch (err) {
    summary.durationMs = Date.now() - startedAt;
    const aborted = err instanceof SyncAbortedError || String(err).includes("aborted");
    await finishRun(runId, startedAt, summary, err);
    await recordEvent(
      aborted ? "warn" : "error",
      "sync",
      `run ${runId} ${aborted ? "aborted" : "failed"}: ${String(err)}`,
      undefined,
      runId,
    );
    throw err;
  } finally {
    await releaseLock("sync");
  }
}

/**
 * The 30-minute cadence.
 *
 * BTS exposes a real delta endpoint. BeautyFort does not, so it re-downloads the whole 3.5 MB
 * stock file and diffs locally — still only a few seconds, and far cheaper than a full rewrite.
 */
async function fastSyncVendor(
  vendor: Vendor,
  connector: ReturnType<typeof createConnector>,
  options: SyncOptions,
  runId: number,
  summary: SyncSummary,
): Promise<number> {
  if (connector.fetchPriceStock && options.source === "live") {
    const gate = await checkLiveGate(vendor.slug as "beautyfort" | "bts");
    if (!gate.allow) {
      log.warn(`${vendor.slug}: skipping live delta — ${gate.reason}`);
    } else {
      const since = await lastSuccessfulRun(vendor.id);
      try {
        const updates = await connector.fetchPriceStock(since, (m) => log.progress(`${vendor.slug}: ${m}`));
        log.progressEnd();
        if (updates) {
          await recordLiveFetch(vendor.slug as "beautyfort" | "bts");
          summary.fetched += updates.length;
          const changed = await applyPriceStockDelta(vendor.id, updates);
          summary.updated += changed;
          return changed;
        }
      } catch (err) {
        log.warn(`${vendor.slug}: delta fetch failed, falling back to a full feed diff`, String(err));
      }
    }
  }
  // Fallback and BeautyFort's normal path: pull the full feed and diff by checksum.
  await connector.prepare(options.source, (m) => log.progress(`${vendor.slug}: ${m}`));
  const raw = await connector.fetchRaw(options.source, (m) => log.progress(`${vendor.slug}: ${m}`));
  log.progressEnd();

  const products = raw.map((r) => connector.normalize(r)).filter((p): p is NormalizedProduct => p !== null);
  const diff = await diffOffers(vendor, products, runId);
  summary.fetched += diff.fetched;
  summary.updated += diff.updated;
  summary.created += diff.created;
  summary.vanished += diff.vanished;

  // A fast sync can surface genuinely new products. They are left for the nightly full sync,
  // which is the only path that creates posts and terms.
  await markDirtyFromPendingOffers();
  return diff.updated + diff.vanished;
}

async function lastSuccessfulRun(vendorId: number): Promise<Date> {
  const rows = await query<RowDataPacket & { started_at: string }>(
    `SELECT started_at FROM ${sil("sil_sync_runs")}
      WHERE (vendor_id = ? OR vendor_id IS NULL) AND status IN ('success','partial')
      ORDER BY started_at DESC LIMIT 1`,
    [vendorId],
  );
  const value = rows[0]?.started_at;
  // With no prior run, look back far enough to be useful but inside the endpoint's 30-day cap.
  if (!value) return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  // Overlap by a few minutes so a change landing mid-run is not missed.
  return new Date(new Date(`${value.replace(" ", "T")}Z`).getTime() - 5 * 60 * 1000);
}

export { env };
