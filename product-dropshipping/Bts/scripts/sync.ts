/**
 * BTS Catalog Sync Script
 *
 * Usage:
 *   bun run scripts/sync.ts           # full sync
 *   bun run scripts/sync.ts --delta   # only changes since last sync
 *
 * Requires BTS_JWT_TOKEN in environment or .env file.
 */

import { BTSClient } from "../src/vendors/bts/BTSClient.js";
import config from "../src/vendors/bts/config.js";
import type { ProductRow, CategoryRow } from "../src/db/database.js";
import {
  getDb,
  closeDb,
  upsertProducts,
  upsertCategories,
  updateProductStock,
  logSync,
  getLastSync,
} from "../src/db/database.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ─── Helpers ─────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function bold(s: string) {
  return `\x1b[1m${s}\x1b[0m`;
}

function green(s: string) {
  return `\x1b[32m${s}\x1b[0m`;
}

function yellow(s: string) {
  return `\x1b[33m${s}\x1b[0m`;
}

function red(s: string) {
  return `\x1b[31m${s}\x1b[0m`;
}

function bar(done: number, total: number, width = 30): string {
  const pct = total > 0 ? Math.round((done / total) * width) : 0;
  return `[${"█".repeat(pct)}${" ".repeat(width - pct)}] ${done}/${total}`;
}

const dataDir = join(process.cwd(), "data");
const productJsonPath = join(dataDir, "products_BTS.json");

type ProductJsonFile = {
  generated_at: string;
  mode: "full" | "delta";
  count: number;
  products: ProductRow[];
};

async function writeProductJson(
  rows: ProductRow[],
  mode: "full" | "delta",
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const payload: ProductJsonFile = {
    generated_at: new Date().toISOString(),
    mode,
    count: rows.length,
    products: rows,
  };
  await writeFile(productJsonPath, JSON.stringify(payload, null, 2), "utf8");
}

async function readProductJsonRows(): Promise<ProductRow[]> {
  try {
    const raw = await readFile(productJsonPath, "utf8");
    const parsed = JSON.parse(raw) as ProductJsonFile | ProductRow[];
    if (Array.isArray(parsed)) return parsed as ProductRow[];
    if (Array.isArray(parsed.products)) return parsed.products;
    return [];
  } catch {
    return [];
  }
}

// ─── Full sync ────────────────────────────────────────────────

async function fullSync(client: BTSClient): Promise<{ products: number; categories: number }> {
  log(bold("Starting FULL sync..."));

  // 1. Check feed status
  try {
    const status = await client.getFeedStatus("en-US");
    log(`Feed status: ${status.status} — ${status.message}`);
  } catch {
    log(yellow("Could not fetch feed status — continuing anyway"));
  }

  // 2. Sync categories
  log("Fetching categories...");
  const cats = await client.getListCategories("en-US");
  const catRows: CategoryRow[] = cats.map((c) => ({
    id: c.id,
    name: c.name,
    parent_id: c.parent_id,
  }));
  upsertCategories(catRows);
  log(green(`✓ Saved ${catRows.length} categories`));

  // 3. Sync products with progress bar
  log("Fetching full product catalog (this may take several minutes)...");

  let totalFetched = 0;
  const BATCH_SIZE = 500;
  const allRows: ProductRow[] = [];

  let page = 1;
  let totalPages = 1;

  while (true) {
    const res = await client.getListProducts({
      page,
      page_size: BATCH_SIZE,
      language_code: "en-US",
    });

    totalPages = res.pagination.total_pages;

    const productRows: ProductRow[] = res.products.map((p) => ({
      id: p.id,
      ean: p.ean,
      categories: p.categories ?? "",
      manufacturer: p.manufacturer ?? "",
      name: p.name ?? "",
      description: p.description ?? "",
      recommended_price: p.recommended_price ?? 0,
      price: p.price ?? 0,
      stock: p.stock ?? 0,
      image: p.image ?? "",
      delivery: p.delivery ?? 0,
      gender: p.gender ?? "",
      flammable: p.flammable ? 1 : 0,
      restricted_countries: JSON.stringify(p.restricted_countries ?? []),
      leadtime_to_ship: p.leadtime_to_ship ?? "",
    }));

    allRows.push(...productRows);
    totalFetched += productRows.length;

    process.stdout.write(
      `\r  ${bar(page, totalPages)} ${totalFetched} products fetched`,
    );

    if (!res.pagination.has_next_page) break;
    page++;
  }

  process.stdout.write("\n");
  log(green(`✓ Fetched ${totalFetched} products across ${totalPages} pages`));
  log("Writing data/products_BTS.json...");
  await writeProductJson(allRows, "full");
  log(green(`✓ Wrote ${allRows.length} products to data/products_BTS.json`));
  log("Importing products from data/products_BTS.json into SQLite...");
  const rowsFromJson = await readProductJsonRows();
  getDb().run("DELETE FROM products");
  upsertProducts(rowsFromJson);
  log(green(`✓ Imported ${rowsFromJson.length} products into SQLite`));

  return { products: rowsFromJson.length, categories: catRows.length };
}

// ─── Delta sync ───────────────────────────────────────────────

async function deltaSync(client: BTSClient, since: string): Promise<{ products: number; categories: number }> {
  log(bold(`Starting DELTA sync since ${since}...`));

  const changes = await client.getAllProductChanges(since, "en-US");

  if (changes.length === 0) {
    log(green("✓ No changes since last sync"));
    return { products: 0, categories: 0 };
  }

  log(`Found ${changes.length} changed products — updating stock/price only...`);

  const jsonRows = await readProductJsonRows();
  if (jsonRows.length === 0) {
    log(yellow("data/products_BTS.json is missing or empty — running full sync instead"));
    return fullSync(client);
  }

  const byEan = new Map(jsonRows.map((p) => [p.ean, p]));
  const missingSkus: string[] = [];

  for (const change of changes) {
    const row = byEan.get(change.product_sku);
    if (!row) {
      missingSkus.push(change.product_sku);
      continue;
    }
    row.stock = change.product_stock ?? row.stock;
    row.price = change.product_price ?? row.price;
    row.recommended_price = change.recommended_price ?? row.recommended_price;
    row.synced_at = new Date().toISOString();
  }

  if (missingSkus.length > 0) {
    log(
      yellow(
        `${missingSkus.length} changed SKUs were not in products_BTS.json — fetching full records for those`,
      ),
    );
    for (let i = 0; i < missingSkus.length; i += 25) {
      const skus = missingSkus.slice(i, i + 25);
      const products = await client.getProducts(skus, "en-US");
      for (const p of products) {
        byEan.set(p.ean, {
          id: p.id,
          ean: p.ean,
          categories: p.categories ?? "",
          manufacturer: p.manufacturer ?? "",
          name: p.name ?? "",
          description: p.description ?? "",
          recommended_price: p.recommended_price ?? 0,
          price: p.price ?? 0,
          stock: p.stock ?? 0,
          image: p.image ?? "",
          delivery: p.delivery ?? 0,
          gender: p.gender ?? "",
          flammable: p.flammable ? 1 : 0,
          restricted_countries: JSON.stringify(p.restricted_countries ?? []),
          leadtime_to_ship: p.leadtime_to_ship ?? "",
          synced_at: new Date().toISOString(),
        });
      }
    }
  }

  const mergedRows = Array.from(byEan.values());
  log("Writing updated data/products_BTS.json...");
  await writeProductJson(mergedRows, "delta");
  log(green(`✓ Wrote ${mergedRows.length} products to data/products_BTS.json`));

  const rowsFromJson = await readProductJsonRows();
  const byEanFromJson = new Map(rowsFromJson.map((p) => [p.ean, p]));

  let updated = 0;
  for (const change of changes) {
    const row = byEanFromJson.get(change.product_sku);
    if (!row) continue;
    updateProductStock(row.ean, row.stock, row.price);
    updated++;
    process.stdout.write(`\r  Updated ${updated}/${changes.length} products in SQLite`);
  }
  process.stdout.write("\n");

  if (missingSkus.length > 0) {
    const missingRows = rowsFromJson.filter((p) => missingSkus.includes(p.ean));
    if (missingRows.length > 0) {
      upsertProducts(missingRows);
      log(green(`✓ Added ${missingRows.length} newly discovered products to SQLite`));
    }
  }

  log(green(`✓ Delta sync complete — ${updated} products updated (stock/price)`));
  return { products: updated, categories: 0 };
}

// ─── Entry point ──────────────────────────────────────────────

async function main() {
  if (!config.token) {
    console.error(red("✗ BTS_JWT_TOKEN is not set. Copy .env.example to .env and add your token."));
    process.exit(1);
  }

  const isDelta = process.argv.includes("--delta");
  const client = new BTSClient(config);

  // Ensure DB is initialised
  getDb();

  const startedAt = new Date().toISOString();
  let result = { products: 0, categories: 0 };
  let error = "";

  try {
    if (isDelta) {
      const lastSync = getLastSync();
      if (!lastSync) {
        log(yellow("No previous sync found — falling back to full sync"));
        result = await fullSync(client);
      } else {
        // Use 1 hour before last sync to avoid missing any edge-case changes
        const since = new Date(new Date(lastSync.completed_at).getTime() - 3_600_000)
          .toISOString()
          .slice(0, 10);
        result = await deltaSync(client, since);
      }
    } else {
      result = await fullSync(client);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log(red(`✗ Sync failed: ${msg}`));
    error = msg;
  }

  logSync({
    type: isDelta ? "delta" : "full",
    products_synced: result.products,
    categories_synced: result.categories,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    error,
  });

  closeDb();

  if (error) process.exit(1);

  log(bold(green(`\n✓ Sync complete — ${result.products} products, ${result.categories} categories`)));
}

main();
