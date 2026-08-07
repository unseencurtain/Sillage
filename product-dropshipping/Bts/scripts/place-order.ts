/**
 * Place a single test order and print the raw response
 * bun run scripts/place-order.ts
 */
import { BTSClient } from "../src/vendors/bts/BTSClient.js";
import config from "../src/vendors/bts/config.js";

const client = new BTSClient(config);

// Step 1 — pick a product
console.log("Fetching product...");
const { products } = await client.getListProducts({ page: 1, page_size: 2, language_code: "en-US" });
const product = products[0]!;
console.log(`Product : ${product.ean} — ${product.name}`);
console.log(`Price   : €${product.price}  Stock: ${product.stock}`);

// Step 2 — get shipping
console.log("\nFetching shipping options (GB)...");
const shippingOptions = await client.getShippingPrices(
  { country_code: "GB", postal_code: "EC1A 1BB" },
  [{ sku: product.ean, quantity: 1 }]
);
const shipping = shippingOptions.sort((a, b) => a.shipping_cost - b.shipping_cost)[0]!;
console.log(`Carrier : ${shipping.company_name}  Cost: €${shipping.shipping_cost}  ID: ${shipping.id}`);

// Step 3 — place order
console.log("\nPlacing order...");
const raw = await client.setCreateOrder({
  payment_method:   "banktransfer",
  products:         [{ sku: product.ean, quantity: 1 }],
  shipping_cost_id: shipping.id,
  client_name:      "Live Test Order",
  address:          "42 Baker Street",
  postal_code:      "EC1A 1BB",
  city:             "London",
  country_code:     "GB",
  telephone:        "+447911123456",
  dropshipping:     1,
});

console.log("\n=== RAW setCreateOrder response ===");
console.log(JSON.stringify(raw, null, 2));
