# BTSClient Integration Guide

This guide is for developers who want to use the `BTSClient` class in any app (Express, Next.js, NestJS, workers, scripts, etc.).

---

## 1. What this class gives you

`BTSClient` is a typed wrapper over BTS Wholesaler API endpoints:

- Catalog (`getListProducts`, `getAllProducts`, `getProducts`)
- Delta updates (`getProductChanges`, `getAllProductChanges`)
- Stock (`getProductStock`)
- Categories / countries / shipping
- Order creation + tracking

It also normalizes several real-world API response differences and throws `BTSRequestError` with status/details.

---

## 2. Minimum requirements

- Runtime: Bun or Node.js 18+ (native `fetch`)
- A valid BTS JWT token from BTS account portal

If you're copying files out of this repo, copy both:

1. `src/vendors/bts/BTSClient.ts`
2. `src/vendors/bts/types.ts`

Also copy `src/utils/orderStatus.ts` (used by `BTSClient` for normalized English order statuses).

---

## 3. Basic usage

```ts
import { BTSClient } from "./src/vendors/bts/BTSClient";

const client = new BTSClient({
  token: process.env.BTS_JWT_TOKEN!,
  // optional:
  baseUrl: "https://api.btswholesaler.com/v1/api",
  timeout: 180_000,
  maxRetries: 3,
});
```

---

## 4. Product/catalog integration pattern

### Full import (first time)

```ts
const allProducts = await client.getAllProducts({ page_size: 500, language_code: "en-US" });
// Save to your DB
```

### Incremental updates (regular job)

```ts
const changes = await client.getAllProductChanges("2026-05-01", "en-US");
// Apply changed stock/price (or fetch full details for changed SKUs)
```

### Real-time stock check before checkout

```ts
const stock = await client.getProductStock(["8411061123456", "3614272049529"]);
```

---

## 5. Order integration pattern (recommended flow)

> BTS has no sandbox. Test with `payment_method: "banktransfer"` to keep orders in pending payment.

```ts
// 1) Calculate shipping
const shippingOptions = await client.getShippingPrices(
  { country_code: "ES", postal_code: "28001" },
  [{ sku: "8411061123456", quantity: 1 }],
);

if (!shippingOptions.length) {
  throw new Error("No shipping options for this address.");
}

const cheapest = shippingOptions.sort((a, b) => a.shipping_cost - b.shipping_cost)[0]!;

// 2) Create order
const created = await client.setCreateOrder({
  payment_method: "banktransfer",
  products: [{ sku: "8411061123456", quantity: 1 }],
  shipping_cost_id: cheapest.id,
  client_name: "Jane Doe",
  address: "15 High Street",
  postal_code: "28001",
  city: "Madrid",
  country_code: "ES",
  telephone: "+34600123456",
  dropshipping: 1,
});

// 3) Store created.order_number in your DB
// 4) Poll tracking/status later
const order = await client.getOrder(created.order_number);
const tracking = await client.getTrackings([created.order_number]);
```

---

## 6. Language behavior

Where BTS supports `language_code`, this client defaults to English (`en-US`) unless you pass another language.

Order status values are normalized to English for common non-English variants.

---

## 7. Error handling

```ts
import { BTSRequestError } from "./src/vendors/bts/BTSClient";

try {
  await client.getProducts(["8411061123456"]);
} catch (e) {
  if (e instanceof BTSRequestError) {
    console.error("Message:", e.message);
    console.error("HTTP status:", e.statusCode);
    console.error("Details:", e.details);
  }
  throw e;
}
```

---

## 8. API limits and guardrails in class

- `getProducts`: max **25** SKUs/request
- `getProductStock`: max **100** SKUs/request
- `getTrackings`: requires at least one order number
- `getShippingPrices`: requires at least one cart line
- Automatic retry on HTTP `429` with exponential backoff

---

## 9. Production checklist

1. Persist your own `last_sync_at` and run delta sync on a schedule.
2. Re-check stock just before creating an order.
3. Always call `getShippingPrices` with the exact final country/postal + cart.
4. Use returned `shipping_cost_id` immediately for `setCreateOrder`.
5. Persist `order_number` and poll `getOrder` / `getTrackings`.
6. Log `BTSRequestError.statusCode` and `details` for debugging.

---

## 10. Related files in this repo

- `src/vendors/bts/BTSClient.ts` — main class
- `src/vendors/bts/types.ts` — typings
- `src/utils/orderStatus.ts` — status normalization
- `scripts/sync.ts` — full + delta sync pipeline
- `src/server/routes/cart.ts` — checkout integration example
