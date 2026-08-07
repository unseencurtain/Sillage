/**
 * Production downloader orchestrator.
 *
 * Reads the Brasty CSV → searches by EAN → verifies the row → hovers →
 * extracts the largest image URL via the pluggable strategy → downloads bytes.
 *
 * Concurrency = pool of browser contexts (default 1). Resume via JSONL manifest.
 * Uses list-row-hover-large strategy (w700 after hover; never w60 thumbs).
 */
import { existsSync, mkdirSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  loadConfig,
  redactSecrets,
  type AppConfig,
} from "./config.js";
import { readProductsCsv } from "./csv.js";
import { allocateOutputPath, downloadImage, DownloadError } from "./downloader.js";
import { hoverProductImage } from "./hover.js";
import { getExtractionStrategy } from "./imageExtractor.js";
import { LoginError } from "./login.js";
import { Logger } from "./logger.js";
import { Manifest } from "./manifest.js";
import { attachNetworkCapture } from "./networkCapture.js";
import { searchByEan } from "./search.js";
import { ensureSession, SessionExpiredError } from "./session.js";
import type { CsvProduct, LogCategory, ManifestStatus } from "./types.js";

function politenessWait(ms: number): Promise<void> {
  // Configurable delay between products — not a DOM wait substitute.
  return new Promise((r) => setTimeout(r, ms));
}

async function processProduct(
  page: Page,
  product: CsvProduct,
  cfg: AppConfig,
  log: Logger,
  manifest: Manifest,
  claimed: Set<string>,
): Promise<void> {
  const { ean, name } = product;
  if (manifest.isDone(ean)) {
    const prev = manifest.get(ean);
    log.category("already_exists", `resume skip ${ean}`, {
      path: prev?.outputPath,
      name,
    });
    return;
  }

  // Also skip if a file already exists on disk for this EAN (first slot).
  const primary = `${cfg.outputDir}/${ean}.jpg`.replace(/\\/g, "/");
  if (existsSync(primary) && !manifest.isDone(ean)) {
    manifest.append({
      ean,
      status: "already_exists",
      outputPath: primary,
    });
    claimed.add(primary);
    log.category("already_exists", `file present ${ean}`, { path: primary });
    return;
  }

  const network = attachNetworkCapture(page);
  try {
    network.clear();
    const search = await searchByEan(page, ean);
    if (!search.ok) {
      const cat: LogCategory =
        search.reason === "page_structure"
          ? "unexpected_page_structure"
          : "search_failed";
      const status: ManifestStatus = cat;
      log.category(cat, `${ean}: ${search.detail}`, { name, reason: search.reason });
      manifest.append({ ean, status, error: search.detail });
      return;
    }

    // Hard verify — required by spec.
    if (search.matchedEan !== ean) {
      log.category(
        "search_failed",
        `${ean}: EAN mismatch after search (${search.matchedEan})`,
        { name },
      );
      manifest.append({
        ean,
        status: "search_failed",
        error: `mismatch ${search.matchedEan}`,
      });
      return;
    }

    const hover = await hoverProductImage(page, search.rowLocator, network);
    if (!hover.ok) {
      log.category("hover_failed", `${ean}: ${hover.detail}`, { name });
      manifest.append({ ean, status: "hover_failed", error: hover.detail });
      return;
    }

    const strategy = getExtractionStrategy();
    let imageUrl: string | null;
    try {
      imageUrl = await strategy.extract({
        page,
        row: search.rowLocator,
        ean,
        network,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/pending investigation/i.test(msg)) {
        log.category("unexpected_page_structure", `${ean}: ${msg}`, {
          name,
          strategy: strategy.name,
        });
        manifest.append({
          ean,
          status: "unexpected_page_structure",
          error: msg,
        });
        return;
      }
      log.category("missing_image", `${ean}: extract failed: ${msg}`, { name });
      manifest.append({ ean, status: "missing_image", error: msg });
      return;
    }

    if (!imageUrl) {
      log.category("missing_image", `${ean}: no image URL`, { name });
      manifest.append({ ean, status: "missing_image", error: "no url" });
      return;
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
        return;
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
      return;
    }

    claimed.add(dest.replace(/\\/g, "/"));
    manifest.append({
      ean,
      status: "downloaded",
      outputPath: dest,
      imageUrl,
    });
    log.category("downloaded", `${ean} → ${dest}`, { name, url: imageUrl });
  } finally {
    network.dispose();
  }
}

async function workerLoop(
  id: number,
  browser: Browser,
  queue: CsvProduct[],
  cfg: AppConfig,
  log: Logger,
  manifest: Manifest,
  claimed: Set<string>,
): Promise<void> {
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  const closeSession = async (): Promise<void> => {
    const p = page;
    const c = context;
    page = null;
    context = null;
    if (p) await p.close().catch(() => undefined);
    if (c) await c.close().catch(() => undefined);
  };

  try {
    while (true) {
      const product = queue.shift();
      if (!product) break;
      try {
        if (!page || !context) {
          context = await ensureSession(browser, cfg, log);
          page = await context.newPage();
          await page.goto(cfg.brastyBaseUrl, { waitUntil: "domcontentloaded" });
        }
        await processProduct(page, product, cfg, log, manifest, claimed);
      } catch (err) {
        if (err instanceof LoginError) {
          throw err;
        }
        if (err instanceof SessionExpiredError) {
          // Mid-run expiry: drop context and let ensureSession re-login next iteration.
          log.warn(`${err.message} Refreshing session for worker ${id}…`);
          await closeSession();
          queue.unshift(product);
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        log.category("unexpected_page_structure", `${product.ean}: ${msg}`, {
          worker: id,
        });
        manifest.append({
          ean: product.ean,
          status: "unexpected_page_structure",
          error: msg,
        });
        await closeSession();
      }
      if (cfg.politenessDelayMs > 0 && queue.length > 0) {
        await politenessWait(cfg.politenessDelayMs);
      }
    }
  } finally {
    await closeSession();
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = new Logger(cfg.logPath);
  mkdirSync(cfg.outputDir, { recursive: true });

  const products = await readProductsCsv(cfg.brastyCsvPath);
  log.info(`Loaded ${products.length} products from ${cfg.brastyCsvPath}`);
  log.info(
    `Strategy: ${getExtractionStrategy().name} | concurrency=${cfg.concurrency} | politeness=${cfg.politenessDelayMs}ms`,
  );

  if (getExtractionStrategy().name === "pending-investigation") {
    log.warn(
      "Extraction strategy is still pending. Run npm run investigate, then register a concrete strategy in imageExtractor.ts.",
    );
  }

  const manifest = new Manifest(cfg.manifestPath);
  const claimed = manifest.claimedPaths();
  // Also claim files already on disk.
  for (const p of products) {
    const primary = `${cfg.outputDir}/${p.ean}.jpg`.replace(/\\/g, "/");
    if (existsSync(primary)) claimed.add(primary);
  }

  const queue = products.filter((p) => !manifest.isDone(p.ean));
  log.info(
    `Queue ${queue.length} (skipping ${products.length - queue.length} already done)`,
  );

  const browser = await chromium.launch({
    headless: cfg.headless,
    args: ["--disable-dev-shm-usage"],
  });
  try {
    // Validate / refresh session once before the pool starts.
    const probe = await ensureSession(browser, cfg, log);
    await probe.close();

    const workers: Promise<void>[] = [];
    for (let i = 0; i < cfg.concurrency; i++) {
      workers.push(workerLoop(i, browser, queue, cfg, log, manifest, claimed));
    }
    await Promise.all(workers);
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
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(msg);
  process.exitCode = 1;
});
