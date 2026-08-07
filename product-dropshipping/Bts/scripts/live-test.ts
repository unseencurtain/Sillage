/**
 * BTS Wholesaler — Live End-to-End Test
 *
 * Requires BTS_JWT_TOKEN in .env (or environment).
 *
 * What it does:
 *  1. Verifies connectivity — hits every read endpoint
 *  2. Places TWO real test orders using payment_method: "banktransfer"
 *     → Orders appear immediately in your BTS portal
 *     → They stay "Pending Payment" — no wallet balance used
 *     → Ask your account manager (or portal) to cancel them after testing
 *  3. Verifies each order via getOrder
 *  4. Attempts to fetch tracking (will say "not yet" — that is expected)
 *
 * Usage:
 *   bun run scripts/live-test.ts
 *   bun run scripts/live-test.ts --orders   # also places the two test orders
 */

import { BTSClient, BTSRequestError } from "../src/vendors/bts/BTSClient.js";
import config from "../src/vendors/bts/config.js";

// ─── ANSI colours ─────────────────────────────────────────────

const G = (s: string) => `\x1b[32m${s}\x1b[0m`;   // green
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;   // red
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;   // yellow
const B = (s: string) => `\x1b[34m${s}\x1b[0m`;   // blue
const W = (s: string) => `\x1b[1m${s}\x1b[0m`;    // bold
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;  // dim

// ─── Helpers ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(label: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  ${DIM("›")} ${label} … `);
  try {
    await fn();
    console.log(G("✓ pass"));
    passed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(R(`✗ FAIL`) + `\n    ${R(msg)}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n${W(B(`▸ ${title}`))}`);
}

function info(label: string, value: unknown): void {
  const v = typeof value === "object" ? JSON.stringify(value) : String(value);
  console.log(`    ${DIM(label + ":")} ${v}`);
}

// ─── Entry point ──────────────────────────────────────────────

async function main() {
  if (!config.token) {
    console.error(R("\n✗  BTS_JWT_TOKEN is not set.\n"));
    console.error("   1. Copy .env.example to .env");
    console.error("   2. Set BTS_JWT_TOKEN=your_jwt_token");
    console.error("   3. Re-run this script\n");
    process.exit(1);
  }

  const doOrders = process.argv.includes("--orders");
  const client = new BTSClient(config);

  console.log(W("\n━━━  BTS Wholesaler Live API Test  ━━━\n"));
  console.log(`Token   : ${DIM(config.token.slice(0, 12) + "…")}`);
  console.log(`Base URL: ${config.baseUrl}`);
  console.log(`Mode    : ${doOrders ? Y("READ + ORDERS (real orders will be placed!)") : "READ ONLY"}`);

  // ─── 1. Feed Status ─────────────────────────────────────

  section("1. Feed Status");
  let feedStatus: string = "";
  await test("getFeedStatus", async () => {
    const s = await client.getFeedStatus("en-US");
    feedStatus = s.status;
    info("status", s.status);
    info("message", s.message);
    info("cached_file_exists", s.cached_file_exists);
    info("recommended_page_size", s.recommended_page_size);
    if (!["use_pagination", "available", "stale", "not_available"].includes(s.status)) {
      throw new Error(`Unexpected status: ${s.status}`);
    }
  });

  // ─── 2. Categories ──────────────────────────────────────

  section("2. Categories");
  let firstCategoryId: number | undefined;
  await test("getListCategories", async () => {
    const cats = await client.getListCategories("en-US");
    const roots = cats.filter((c) => c.parent_id === 0);
    firstCategoryId = roots[0]?.id;
    info("total_categories", cats.length);
    info("root_categories", roots.length);
    info("first_root", roots[0]);
    if (cats.length === 0) throw new Error("No categories returned");
  });

  // ─── 3. Countries ───────────────────────────────────────

  section("3. Countries");
  await test("getCountries", async () => {
    const countries = await client.getCountries();
    info("total_countries", countries.length);
    info("first_5", countries.slice(0, 5).map((c) => c.country_code).join(", "));
    if (countries.length === 0) throw new Error("No countries returned");
  });

  // ─── 4. Products ─────────────────────────────────────────

  section("4. Products");

  let firstSku = "";
  let secondSku = "";
  let firstProductPrice = 0;

  await test("getListProducts (page 1, size 5)", async () => {
    const res = await client.getListProducts({ page: 1, page_size: 5, language_code: "en-US" });
    const { pagination, products } = res;
    info("total_products", pagination.total_products);
    info("total_pages", pagination.total_pages);
    info("has_next_page", pagination.has_next_page);
    info("first_product", `${products[0]?.ean} — ${products[0]?.name} @ £${products[0]?.price}`);
    if (products.length === 0) throw new Error("No products returned");
    firstSku = products[0]?.ean ?? "";
    secondSku = products[1]?.ean ?? "";
    firstProductPrice = products[0]?.price ?? 0;
  });

  await test("getListProducts with category filter", async () => {
    if (!firstCategoryId) throw new Error("No category ID from previous test");
    const res = await client.getListProducts({
      page: 1, page_size: 5, category_ids: String(firstCategoryId),
    });
    info("category_id", firstCategoryId);
    info("products_in_category", res.pagination.total_products);
  });

  await test("getProducts by SKU", async () => {
    if (!firstSku) throw new Error("No SKU from previous test");
    const products = await client.getProducts([firstSku], "en-US");
    info("returned", products.length);
    info("ean", products[0]?.ean);
    info("name", products[0]?.name);
    info("stock", products[0]?.stock);
    if (products.length === 0) throw new Error("No product returned for SKU");
  });

  await test("getProductStock (real-time)", async () => {
    const skus = [firstSku, secondSku].filter(Boolean);
    const stock = await client.getProductStock(skus);
    info("requested_skus", stock.requested_skus);
    info("found_skus", stock.found_skus);
    info("timestamp", stock.timestamp);
    for (const [sku, data] of Object.entries(stock.products)) {
      info(`  ${sku}`, `${data.availability} — stock: ${data.stock}`);
    }
  });

  await test("getProductChanges (last 1 day)", async () => {
    const since = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const res = await client.getProductChanges({ since, language_code: "en-US", page_size: 5 });
    info("since", since);
    info("changed_products", res.pagination.total_products);
    info("page_1_count", res.products.length);
  });

  await test("getNewProducts (last 7 days)", async () => {
    const res = await client.getNewProducts({ days: 7, language_code: "en-US", page_size: 5 });
    info("new_products", res.pagination.total_products);
    info("since", res.query.since);
  });

  // ─── 5. Shipping ─────────────────────────────────────────

  section("5. Shipping");

  const testAddress = { country_code: "GB", postal_code: "SW1A 1AA" };
  let cheapestShippingId: number | undefined;
  let cheapestShippingCost: number | undefined;
  let cheapestCarrier = "";

  await test("getShippingPrices (GB, SW1A 1AA)", async () => {
    if (!firstSku) throw new Error("No SKU from previous test");
    const options = await client.getShippingPrices(
      testAddress,
      [{ sku: firstSku, quantity: 1 }]
    );
    const sorted = options.sort((a, b) => a.shipping_cost - b.shipping_cost);
    cheapestShippingId = sorted[0]?.id;
    cheapestShippingCost = sorted[0]?.shipping_cost;
    cheapestCarrier = sorted[0]?.company_name ?? "";
    info("options_available", options.length);
    for (const o of sorted) {
      info(`  ${o.company_name}`, `id=${o.id} cost=£${o.shipping_cost} free_over=£${o.free_shipping}`);
    }
    if (options.length === 0) throw new Error("No shipping options returned");
  });

  // ─── 6. Orders ───────────────────────────────────────────

  const placedOrderNumbers: string[] = [];

  if (!doOrders) {
    section("6. Orders");
    console.log(Y("  ⚠  Skipped — run with --orders to place test orders"));
    console.log(Y("     bun run scripts/live-test.ts --orders"));
  } else {
    section("6. Orders (LIVE — using banktransfer, no charges)");

    if (!firstSku || !cheapestShippingId) {
      console.log(R("  ✗  Cannot place orders — missing SKU or shipping ID from earlier tests"));
    } else {
      // Order 1 — single item
      let order1Number = "";
      await test("setCreateOrder — Order 1 (single item)", async () => {
        const order = await client.setCreateOrder({
          payment_method:   "banktransfer",
          products:         [{ sku: firstSku, quantity: 1 }],
          shipping_cost_id: cheapestShippingId!,
          client_name:      "Test Customer One",
          address:          "10 Test Street",
          postal_code:      "SW1A 1AA",
          city:             "London",
          country_code:     "GB",
          telephone:        "+447000000001",
          dropshipping:     1,
        });
        order1Number = order.order_number;
        placedOrderNumbers.push(order1Number);
        info("order_number", order.order_number);
        info("order_status", order.order_status);
        info("order_total", `£${order.order_total}`);
        info("expected_dispatch", order.expected_dispatch_date);
        info("expected_delivery", order.expected_delivery_date);
        console.log(Y(`\n    ⚠  This order is REAL. Ask your BTS account manager to cancel: ${order.order_number}`));
      });

      // Order 2 — two items (if we have a second SKU)
      let order2Number = "";
      await test(`setCreateOrder — Order 2 (${secondSku ? "two items" : "single item"})`, async () => {
        const products = secondSku
          ? [{ sku: firstSku, quantity: 1 }, { sku: secondSku, quantity: 1 }]
          : [{ sku: firstSku, quantity: 2 }];

        // Need fresh shipping price for the new basket
        const opts2 = await client.getShippingPrices(
          { country_code: "ES", postal_code: "28001" },
          products
        );
        const shipping2 = opts2.sort((a, b) => a.shipping_cost - b.shipping_cost)[0];
        if (!shipping2) throw new Error("No shipping options for ES");

        const order = await client.setCreateOrder({
          payment_method:   "banktransfer",
          products,
          shipping_cost_id: shipping2.id,
          client_name:      "Test Customer Two",
          address:          "Calle Gran Via 1",
          postal_code:      "28001",
          city:             "Madrid",
          country_code:     "ES",
          telephone:        "+34600000002",
          dropshipping:     1,
        });
        order2Number = order.order_number;
        placedOrderNumbers.push(order2Number);
        info("order_number", order.order_number);
        info("order_status", order.order_status);
        info("order_total", `£${order.order_total}`);
        info("country", "ES (Spain)");
        info("carrier", shipping2.company_name);
        console.log(Y(`\n    ⚠  This order is REAL. Ask your BTS account manager to cancel: ${order.order_number}`));
      });

      // Verify both orders via getOrder
      if (order1Number) {
        await test(`getOrder — verify Order 1 (${order1Number})`, async () => {
          const detail = await client.getOrder(order1Number);
          info("order_number", detail.order_number);
          info("status", detail.order_status);
          info("client", detail.client_name);
          info("total", `£${detail.order_total}`);
          info("items", detail.products.length);
          if (detail.order_number !== order1Number) throw new Error("Order number mismatch");
        });
      }

      if (order2Number) {
        await test(`getOrder — verify Order 2 (${order2Number})`, async () => {
          const detail = await client.getOrder(order2Number);
          info("order_number", detail.order_number);
          info("status", detail.order_status);
          info("client", detail.client_name);
          info("country", detail.country_code);
        });
      }

      // Try tracking (will not have tracking yet — expected)
      if (placedOrderNumbers.length > 0) {
        await test("getTrackings — new orders (expect not-yet-available)", async () => {
          try {
            const trackings = await client.getTrackings(placedOrderNumbers);
            info("trackings_returned", trackings.length);
            for (const t of trackings) {
              info(`  ${t.order_number}`, t.tracking || "(no tracking yet)");
            }
          } catch (e) {
            // "order_not_found" is expected for brand-new orders
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("404") || msg.toLowerCase().includes("not_found")) {
              info("result", Y("Tracking not yet assigned (expected for new orders)"));
            } else {
              throw e;
            }
          }
        });
      }
    }
  }

  // ─── Summary ─────────────────────────────────────────────

  console.log(`\n${"─".repeat(50)}`);
  console.log(W("Results"));
  console.log(`  ${G("✓")} Passed : ${W(String(passed))}`);
  if (failed > 0) console.log(`  ${R("✗")} Failed : ${W(String(failed))}`);
  if (placedOrderNumbers.length > 0) {
    console.log(`\n${Y("⚠  Orders placed (banktransfer — CANCEL via your BTS account manager):")}`);
    placedOrderNumbers.forEach((n) => console.log(`   ${B(n)}`));
    console.log(DIM("   Your BTS portal: https://www.btswholesaler.com"));
  }
  console.log();

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(R("\nFatal: " + (e instanceof Error ? e.message : String(e))));
  process.exit(1);
});
