/**
 * Refresh the offline fixtures in .feedscratch from the live vendor APIs.
 *
 * Read-only against the vendors: catalogue, categories and reference data only. It never touches
 * an order endpoint.
 *
 *   bun run src/cli/fixtures.ts [--vendor=all|beautyfort|bts]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../config/env.ts";
import { formatDuration, logger, setLogLevel } from "../lib/log.ts";
import { BeautyfortClient } from "../vendors/beautyfort/BeautyfortClient.ts";
import { BTSClient } from "../vendors/bts/BtsClient.ts";

setLogLevel(env.logLevel);
const log = logger("fixtures");

const args = new Set(process.argv.slice(2));
const vendorArg = [...args].find((a) => a.startsWith("--vendor="))?.split("=")[1] ?? "all";
const wantBf = vendorArg === "all" || vendorArg === "beautyfort";
const wantBts = vendorArg === "all" || vendorArg === "bts";

await mkdir(env.fixturesDir, { recursive: true });

async function save(name: string, data: unknown): Promise<void> {
  const path = join(env.fixturesDir, name);
  const json = JSON.stringify(data, null, data instanceof Array && data.length > 100 ? 0 : 2);
  await writeFile(path, json, "utf8");
  log.info(`wrote ${name} (${(Buffer.byteLength(json) / 1_048_576).toFixed(2)} MB)`);
}

if (wantBf) {
  const started = Date.now();
  const client = new BeautyfortClient({
    user: env.beautyfort.user,
    secret: env.beautyfort.secret,
    endpoint: env.beautyfort.endpoint,
    testMode: env.beautyfort.testMode,
  });

  log.info("BeautyFort: downloading stock file");
  const products = await client.getStockFile();
  await save("beautyfort_full.json", products);

  log.info("BeautyFort: fetching account information");
  const account = await client.getAccountInformation();
  await save("bf_account.json", account.deliveryOptions);

  log.info(`BeautyFort done in ${formatDuration(Date.now() - started)} — ${products.length} products`);
}

if (wantBts) {
  const started = Date.now();
  const client = new BTSClient({ token: env.bts.token, baseUrl: env.bts.baseUrl, timeout: 180_000 });

  log.info("BTS: feed status");
  await save("bts_feedstatus.json", await client.getFeedStatus(env.bts.language));

  log.info("BTS: categories");
  await save("bts_categories_full.json", await client.getListCategories(env.bts.language));

  log.info("BTS: countries");
  await save("bts_countries.json", await client.getCountries());

  log.info("BTS: full catalogue (paginated)");
  const products = await client.getAllProducts(
    { page_size: 500, language_code: env.bts.language },
    (page, total, fetched) => log.progress(`page ${page}/${total} — ${fetched} products`),
  );
  log.progressEnd();
  await save("bts_products_full.json", products);

  log.info(`BTS done in ${formatDuration(Date.now() - started)} — ${products.length} products`);
}
