/**
 * Full-catalog Brasty image crawl.
 *
 * Paginates the B2B product list (IN STOCK first), and for each `.c-product`
 * row: read EAN → hover → extract w700 URL → download → manifest.
 * Resume-safe via JSONL manifest + page checkpoint. Prefer laptop runs;
 * keep CONCURRENCY=1 and a hard politeness delay.
 */
import { existsSync, mkdirSync, statfsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  buildCatalogListUrl,
  collectVisibleRows,
  loadCatalogPage,
  loadCheckpoint,
  saveCheckpoint,
  type CatalogCheckpoint,
  type StockFilter,
} from "./catalog.js";
import {
  loadConfig,
  redactSecrets,
  type AppConfig,
} from "./config.js";
import { allocateOutputPath, downloadImage, DownloadError } from "./downloader.js";
import { hoverProductImage } from "./hover.js";
import { getExtractionStrategy } from "./imageExtractor.js";
import { LoginError } from "./login.js";
import { Logger } from "./logger.js";
import { Manifest } from "./manifest.js";
import { attachNetworkCapture } from "./networkCapture.js";
import { ensureSession, SessionExpiredError } from "./session.js";
import type { LogCategory, ManifestStatus } from "./types.js";

const MIN_FREE_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB

function politenessWait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseStockFilters(raw: string): StockFilter[] {
  const v = raw.trim().toLowerCase();
  if (!v || v === "in_stock" || v === "instock") return ["in_stock"];
  if (v === "out_of_stock" || v === "outofstock") return ["out_of_stock"];
  if (v === "all") return ["in_stock", "out_of_stock"];
  throw new Error(
    `Invalid CATALOG_STOCK_FILTER="${raw}". Use in_stock | out_of_stock | all`,
  );
}

function assertDiskSpace(dir: string, log: Logger): void {
  try {
    const st = statfsSync(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    const freeGb = (free / (1024 ** 3)).toFixed(1);
    log.info(`Free disk at ${dir}: ${freeGb} GiB`);
    if (free < MIN_FREE_BYTES) {
      throw new Error(
        `Aborting: only ${freeGb} GiB free (need ≥ ~8 GiB for ~14k JPGs). Free space and retry.`,
      );
    }
  } catch (err) {
    if (err instanceof Error && /Aborting:/.test(err.message)) throw err;
    log.warn(
      `Could not statfs ${dir}: ${err instanceof Error ? err.message : String(err)}. Continuing cautiously.`,
    );
  }
}

async function processListRow(
  page: Page,
  ean: string,
  name: string,
  row: import("playwright").Locator,
  cfg: AppConfig,
  log: Logger,
  manifest: Manifest,
  claimed: Set<string>,
): Promise<"downloaded" | "skipped" | "failed"> {
  if (manifest.isDone(ean)) {
    log.category("already_exists", `resume skip ${ean}`, { name });
    return "skipped";
  }

  const primary = `${cfg.outputDir}/${ean}.jpg`.replace(/\\/g, "/");
  if (existsSync(primary)) {
    manifest.append({ ean, status: "already_exists", outputPath: primary });
    claimed.add(primary);
    log.category("already_exists", `file present ${ean}`, { path: primary });
    return "skipped";
  }

  // Clear sticky hover preview from the previous row before capturing.
  await page.mouse.move(0, 0).catch(() => undefined);

  const thumbSrc = await row
    .locator(".c-product__img img, picture img, img")
    .first()
    .getAttribute("src")
    .catch(() => null);
  const dataImage = await row
    .locator("picture[data-image]")
    .first()
    .getAttribute("data-image")
    .catch(() => null);
  if (
    (thumbSrc && /no-image/i.test(thumbSrc)) ||
    (dataImage && /\/images\/w\d+\/\.webp/i.test(dataImage))
  ) {
    log.category("missing_image", `${ean}: no-image placeholder on list row`, {
      name,
      thumbSrc,
      dataImage,
    });
    manifest.append({
      ean,
      status: "missing_image",
      error: "no-image placeholder",
    });
    return "failed";
  }

  const network = attachNetworkCapture(page);
  try {
    network.clear();
    const hover = await hoverProductImage(page, row, network);
    if (!hover.ok) {
      log.category("hover_failed", `${ean}: ${hover.detail}`, { name });
      manifest.append({ ean, status: "hover_failed", error: hover.detail });
      return "failed";
    }

    const strategy = getExtractionStrategy();
    let imageUrl: string | null;
    try {
      imageUrl = await strategy.extract({ page, row, ean, network });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.category("missing_image", `${ean}: extract failed: ${msg}`, { name });
      manifest.append({ ean, status: "missing_image", error: msg });
      return "failed";
    }

    if (!imageUrl) {
      log.category("missing_image", `${ean}: no image URL`, { name });
      manifest.append({ ean, status: "missing_image", error: "no url" });
      return "failed";
    }

    // Absolute URL for same-origin relative paths.
    try {
      imageUrl = new URL(imageUrl, page.url()).href;
    } catch {
      /* keep as-is */
    }

    const dest = allocateOutputPath(cfg.outputDir, ean, claimed);
    try {
      await downloadImage({
        url: imageUrl,
        destPath: dest,
        retryCount: cfg.retryCount,
        retryBackoffMs: cfg.retryBackoffMs,
        log,
      });
    } catch (err) {
      if (err instanceof DownloadError && err.kind === "network_timeout") {
        log.category("network_timeout", `${ean}: ${err.message}`, {
          name,
          url: imageUrl,
        });
        manifest.append({
          ean,
          status: "network_timeout",
          imageUrl,
          error: err.message,
        });
        return "failed";
      }
      const msg = err instanceof Error ? err.message : String(err);
      log.category("missing_image", `${ean}: download failed: ${msg}`, {
        name,
        url: imageUrl,
      });
      manifest.append({
        ean,
        status: "missing_image",
        imageUrl,
        error: msg,
      });
      return "failed";
    }

    claimed.add(dest.replace(/\\/g, "/"));
    manifest.append({
      ean,
      status: "downloaded",
      outputPath: dest,
      imageUrl,
    });
    log.category("downloaded", `${ean} → ${dest}`, { name, url: imageUrl });
    return "downloaded";
  } finally {
    network.dispose();
  }
}

interface RunStats {
  attempted: number;
  downloaded: number;
  skipped: number;
  failed: number;
}

async function crawlFilter(
  browser: Browser,
  cfg: AppConfig,
  log: Logger,
  manifest: Manifest,
  claimed: Set<string>,
  stockFilter: StockFilter,
  startPage: number,
  startRowIndex: number,
  maxPagesCap: number | null,
): Promise<RunStats> {
  const stats: RunStats = {
    attempted: 0,
    downloaded: 0,
    skipped: 0,
    failed: 0,
  };

  let context: BrowserContext | null = null;
  let page: Page | null = null;

  const open = async (): Promise<Page> => {
    if (page && context) return page;
    context = await ensureSession(browser, cfg, log);
    page = await context.newPage();
    return page;
  };

  const close = async (): Promise<void> => {
    const p = page;
    const c = context;
    page = null;
    context = null;
    if (p) await p.close().catch(() => undefined);
    if (c) await c.close().catch(() => undefined);
  };

  const runStartedAt =
    loadCheckpoint(cfg.catalogCheckpointPath)?.startedAt ??
    new Date().toISOString();
  let listedCount: number | undefined;

  try {
    let pageNum = startPage;
    let rowStart = startRowIndex;
    let maxPage = pageNum;

    while (true) {
      let p = await open();
      const loaded = await loadCatalogPage(
        p,
        cfg.brastyBaseUrl,
        stockFilter,
        pageNum,
      );
      listedCount = loaded.listedCount ?? listedCount;
      maxPage =
        maxPagesCap !== null
          ? Math.min(loaded.maxPage, maxPagesCap)
          : loaded.maxPage;
      if (pageNum > maxPage) break;

      log.info(
        `Catalog ${stockFilter}: page ${pageNum}/${maxPage} (${loaded.rowCount} rows)` +
          (listedCount !== undefined ? `, listed≈${listedCount}` : ""),
      );

      let rows = await collectVisibleRows(p);
      for (let i = rowStart; i < rows.length; i++) {
        // Re-bind after possible session refresh / context rebuild.
        const livePage = await open();
        if (rows[i] === undefined || livePage !== p) {
          await loadCatalogPage(livePage, cfg.brastyBaseUrl, stockFilter, pageNum);
          rows = await collectVisibleRows(livePage);
          p = livePage;
        }
        const meta = rows[i];
        if (!meta) break;

        stats.attempted += 1;
        try {
          const outcome = await processListRow(
            livePage,
            meta.ean,
            meta.name,
            meta.row,
            cfg,
            log,
            manifest,
            claimed,
          );
          if (outcome === "downloaded") stats.downloaded += 1;
          else if (outcome === "skipped") stats.skipped += 1;
          else stats.failed += 1;
        } catch (err) {
          if (err instanceof LoginError) throw err;
          if (err instanceof SessionExpiredError) {
            log.warn(`${err.message} Refreshing session…`);
            await close();
            const p2 = await open();
            await loadCatalogPage(p2, cfg.brastyBaseUrl, stockFilter, pageNum);
            rows = await collectVisibleRows(p2);
            p = p2;
            const again = rows.find((r) => r.ean === meta.ean);
            if (!again) {
              const cat: LogCategory = "unexpected_page_structure";
              const status: ManifestStatus = cat;
              log.category(cat, `${meta.ean}: row lost after re-login`, {
                page: pageNum,
              });
              manifest.append({
                ean: meta.ean,
                status,
                error: "row lost after re-login",
              });
              stats.failed += 1;
            } else {
              const outcome = await processListRow(
                p2,
                again.ean,
                again.name,
                again.row,
                cfg,
                log,
                manifest,
                claimed,
              );
              if (outcome === "downloaded") stats.downloaded += 1;
              else if (outcome === "skipped") stats.skipped += 1;
              else stats.failed += 1;
            }
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            log.category("unexpected_page_structure", `${meta.ean}: ${msg}`, {
              page: pageNum,
            });
            manifest.append({
              ean: meta.ean,
              status: "unexpected_page_structure",
              error: msg,
            });
            stats.failed += 1;
            await close();
          }
        }

        saveCheckpoint(cfg.catalogCheckpointPath, {
          stockFilter,
          page: pageNum,
          maxPage,
          rowIndex: i + 1,
          startedAt: runStartedAt,
          updatedAt: new Date().toISOString(),
          listedCount,
        });

        if (stats.attempted % 25 === 0) {
          log.info(
            `Progress ${stockFilter}: page ${pageNum}/${maxPage} row ${i + 1}/${rows.length} | ` +
              `attempted=${stats.attempted} downloaded=${stats.downloaded} skipped=${stats.skipped} failed=${stats.failed}`,
          );
        }

        if (cfg.politenessDelayMs > 0) {
          await politenessWait(cfg.politenessDelayMs);
        }
      }

      rowStart = 0;
      pageNum += 1;
      if (pageNum > maxPage) break;
    }

    saveCheckpoint(cfg.catalogCheckpointPath, {
      stockFilter,
      page: maxPage + 1,
      maxPage,
      rowIndex: 0,
      startedAt: runStartedAt,
      updatedAt: new Date().toISOString(),
      listedCount,
    });
  } finally {
    await close();
  }

  return stats;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = new Logger(cfg.logPath);
  mkdirSync(cfg.outputDir, { recursive: true });
  assertDiskSpace(cfg.outputDir, log);

  const filters = parseStockFilters(cfg.catalogStockFilter);
  const maxPagesCap =
    cfg.catalogMaxPages > 0 ? cfg.catalogMaxPages : null;

  log.info(
    `Full-catalog crawl | filters=${filters.join("→")} | strategy=${getExtractionStrategy().name} | ` +
      `politeness=${cfg.politenessDelayMs}ms | checkpoint=${cfg.catalogCheckpointPath}`,
  );
  log.info(`List URL example: ${buildCatalogListUrl(cfg.brastyBaseUrl, filters[0]!, 1)}`);

  const manifest = new Manifest(cfg.manifestPath);
  const claimed = manifest.claimedPaths();
  // Claim any files already on disk (even if not in manifest).
  // Cheap scan: only primary EAN.jpg names we might create later are claimed at download time.

  const browser = await chromium.launch({
    headless: cfg.headless,
    args: ["--disable-dev-shm-usage"],
  });

  const totals: RunStats = {
    attempted: 0,
    downloaded: 0,
    skipped: 0,
    failed: 0,
  };

  try {
    const probe = await ensureSession(browser, cfg, log);
    await probe.close();

    for (const stockFilter of filters) {
      const existing = loadCheckpoint(cfg.catalogCheckpointPath);
      let startPage = cfg.catalogStartPage;
      let startRow = 0;
      if (
        existing &&
        existing.stockFilter === stockFilter &&
        cfg.catalogStartPage <= 1
      ) {
        startPage = Math.max(1, existing.page);
        startRow = Math.max(0, existing.rowIndex);
        // Completed filter parks at page = maxPage+1
        if (existing.maxPage > 0 && existing.page > existing.maxPage) {
          log.info(`Checkpoint says ${stockFilter} already complete — skipping`);
          continue;
        }
        log.info(
          `Resuming ${stockFilter} from checkpoint page=${startPage} rowIndex=${startRow}`,
        );
      } else if (cfg.catalogStartPage > 1) {
        log.info(`Starting ${stockFilter} at CATALOG_START_PAGE=${startPage}`);
      }

      const stats = await crawlFilter(
        browser,
        cfg,
        log,
        manifest,
        claimed,
        stockFilter,
        startPage,
        startRow,
        maxPagesCap,
      );
      totals.attempted += stats.attempted;
      totals.downloaded += stats.downloaded;
      totals.skipped += stats.skipped;
      totals.failed += stats.failed;
      log.info(
        `Finished filter ${stockFilter}: attempted=${stats.attempted} downloaded=${stats.downloaded} skipped=${stats.skipped} failed=${stats.failed}`,
      );
    }
  } catch (err) {
    if (err instanceof LoginError) {
      log.error(`[${err.kind}] ${redactSecrets(err.message, cfg.brastyPassword)}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    await browser.close();
  }

  log.printSummary();
  log.info(
    `Catalog totals: attempted=${totals.attempted} downloaded=${totals.downloaded} skipped=${totals.skipped} failed=${totals.failed}`,
  );
  log.info(
    "Next: npm run watermark && npm run build-overrides  (set LPS_MEDIA_BASE_URL=https://images.slilverbelt.xyz)",
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(msg);
  process.exitCode = 1;
});
