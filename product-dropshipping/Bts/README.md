# BTS Dropship Router

Multi-vendor dropshipping toolkit for [BTS Wholesaler](https://www.btswholesaler.com).

- **`BTSClient`** — typed TypeScript SDK for the BTS Wholesaler REST API
- **SQLite** — local catalog cache via `bun:sqlite`
- **Sync scripts** — full & delta catalog sync
- **Express storefront** — browse, cart, checkout, order tracking

---

## Quick start

```sh
cp .env.example .env
# Edit .env — add your BTS_JWT_TOKEN
bun install
bun run sync          # pull catalog into SQLite (~15 000 products)
bun run dev           # start storefront at http://localhost:3000
```

Catalog sync now writes `data/products_BTS.json` first, then imports/updates SQLite from that file.

---

## BTSClient SDK

Detailed standalone integration doc: **[`BTSClient_Integration_Guide.md`](./BTSClient_Integration_Guide.md)**.

### Installation / import

```ts
import { BTSClient } from "./src/vendors/bts/BTSClient";
```

### Configuration

```ts
const client = new BTSClient({
  token:      "your-jwt-token",   // from BTSWholesaler account → API section
  baseUrl:    "https://api.btswholesaler.com/v1/api", // optional
  timeout:    180_000,            // ms, default 120 000
  maxRetries: 3,                  // retries on 429, default 3
});
```

Get your JWT from **btswholesaler.com → My Account → API → Create Account Service**.

---

### Products

#### List catalog (paginated)

```ts
const page = await client.getListProducts({
  page:               1,
  page_size:          200,       // 50–500
  language_code:      "en-US",
  category_ids:       "12,45",   // optional server-side filter
  manufacturer_names: "CHANEL",  // optional server-side filter
});

console.log(page.pagination.total_products);
console.log(page.products[0].ean, page.products[0].price);
```

#### Fetch entire catalog (auto-paginates)

```ts
const all = await client.getAllProducts(
  { language_code: "en-US", page_size: 500 },
  (page, total, fetched) => console.log(`${page}/${total} — ${fetched} products`)
);
```

#### Get specific products by SKU/EAN (max 25)

```ts
const products = await client.getProducts(["8411061123456", "3614272049529"]);
```

#### Feed status

```ts
const status = await client.getFeedStatus("en-US");
// status.status: "use_pagination" | "available" | "stale" | "not_available"
```

#### Delta sync — changed products since a date

```ts
// Single page
const changes = await client.getProductChanges({ since: "2025-05-01" });

// Auto-paginated
const all = await client.getAllProductChanges("2025-05-01", "en-US");
// Returns ProductChange[] — lighter than full Product
```

#### Real-time stock check (max 100 SKUs)

```ts
const stock = await client.getProductStock(["8411061123456", "3614272049529"]);
// stock.products["8411061123456"].availability → "in_stock" | "out_of_stock" | "not_found"
// stock.products["8411061123456"].stock → 42
```

#### New arrivals

```ts
const newArrivals = await client.getNewProducts({ days: 7, language_code: "en-US" });
```

---

### Categories

```ts
const categories = await client.getListCategories("en-US");
// [{ id: 14498, name: "Perfumes", parent_id: 0 }, ...]
// parent_id: 0 → root category
// Products use "14498/15008" slash-separated paths
```

---

### Shipping

#### Get available shipping options

```ts
const options = await client.getShippingPrices(
  { country_code: "GB", postal_code: "SW1A 1AA" },
  [{ sku: "8411061123456", quantity: 2 }]
);
// options[0].id → use as shipping_cost_id when creating an order
// options[0].shipping_cost → 7.50
// options[0].free_shipping → 150.00 (threshold for free shipping)
```

#### List shippable countries

```ts
const countries = await client.getCountries();
// [{ country_code: "GB", country_name: "United Kingdom" }, ...]
```

---

### Orders

> ⚠️ **There is no sandbox.** Use `payment_method: "banktransfer"` for testing — orders stay in *Pending Payment* and can be cancelled by your account manager.

#### Create order

```ts
// Step 1: get shipping options (above)
const options = await client.getShippingPrices(...);
const shipping = options.sort((a, b) => a.shipping_cost - b.shipping_cost)[0];

// Step 2: place order
const order = await client.setCreateOrder({
  payment_method:   "banktransfer",  // or "wallet" | "btscredit"
  products:         [{ sku: "8411061123456", quantity: 1 }],
  shipping_cost_id: shipping.id,     // from getShippingPrices
  client_name:      "Jane Doe",
  address:          "10 Downing Street",
  postal_code:      "SW1A 2AA",
  city:             "London",
  country_code:     "GB",            // must match getShippingPrices country
  telephone:        "+441234567890",
  dropshipping:     1,
  // state_code: "NY"               // required for US & CA orders
});

console.log(order.order_number);    // "743799256961"
console.log(order.order_status);    // "Pending Payment"
```

#### Get order details

```ts
const detail = await client.getOrder("743799256961");
// detail.order_status, detail.tracking, detail.products[]
```

#### Get tracking (poll every 2–4 hours)

```ts
const trackings = await client.getTrackings(["743799256961", "743799256962"]);
// [{ order_number: "743799256961", tracking: "GLS-9876543210" }]
```

---

### Error handling

All errors throw `BTSRequestError`:

```ts
import { BTSRequestError } from "./src/vendors/bts/BTSClient";

try {
  await client.setCreateOrder({ ... });
} catch (e) {
  if (e instanceof BTSRequestError) {
    console.error(e.message);       // human-readable
    console.error(e.statusCode);    // HTTP status (400, 401, 429, …)
    console.error(e.details);       // raw response body
  }
}
```

Common order error codes: `no_stock`, `no_enough_money`, `shipping_cost_code_error`, `product_error`.

---

## Sync scripts

```sh
bun run sync          # full sync — fetches all products + categories
bun run sync:delta    # delta sync — only products changed since last sync
```

Delta sync falls back to full sync when there is no previous sync log.

### How date-based sync works

`bun run sync:delta` reads the last successful sync time from the `sync_log` table (`getLastSync().completed_at`).  
It then subtracts 1 hour as a safety buffer and sends that date to BTS `getProductChanges` via the `since` parameter.

So the flow is:
1. First run (`sync`): fetch full catalog, write `data/products_BTS.json`, then import into SQLite.
2. Next runs (`sync:delta`): update `data/products_BTS.json` from BTS changes, then apply DB updates from JSON.
3. Delta applies stock/price updates for existing products; missing SKUs are fetched and inserted.
4. Product/category endpoints are requested in English (`en-US`) wherever BTS supports a language option.

---

## Storefront

```sh
bun run dev           # hot-reload dev server
bun run start         # production
```

| Route | Description |
|---|---|
| `/` | Home — stats + featured products |
| `/products` | Browse with search, brand & category filters |
| `/products/:ean` | Product detail + add to cart |
| `/cart` | Cart — update quantities, remove items |
| `/cart/checkout` | Checkout form — auto-selects cheapest shipping |
| `/orders` | Order history |
| `/orders/:number` | Order detail with tracking |
| `/orders/:number/refresh` | Refresh tracking from BTS API |
| `/orders/refresh-all` | Bulk tracking refresh for pending orders |

---

## Testing

```sh
bun test                         # unit tests (no token needed) — 30 tests
BTS_JWT_TOKEN=your_token bun test  # + 6 live API integration tests
```

---

## Project structure

```
src/
  vendors/
    bts/
      BTSClient.ts   ← main SDK class
      types.ts       ← all TypeScript interfaces
      config.ts      ← reads BTS_JWT_TOKEN from env
    beautyfort/
      config.ts      ← SOAP/XML vendor config
  db/
    database.ts      ← bun:sqlite layer (products, orders, cart)
  server/
    app.ts           ← Express entry point
    views.ts         ← HTML template helpers
    routes/
      products.ts
      cart.ts        ← cart + checkout
      orders.ts      ← orders + tracking
scripts/
  sync.ts            ← catalog sync (full + delta)
tests/
  bts.test.ts
data/
  bts.sqlite         ← auto-created on first run
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `BTS_JWT_TOKEN` | Yes | JWT from BTSWholesaler account portal |
| `BTS_LANGUAGE` | No | Default language (default `en-US`) |
| `PORT` | No | HTTP port (default `3000`) |

Copy `.env.example` to `.env` and fill in your token.

---

## API reference summary

| Method | Endpoint | Description |
|---|---|---|
| `getListProducts` | GET `/getListProducts` | Paginated catalog |
| `getAllProducts` | — | Auto-paginate full catalog |
| `getProducts` | GET `/getProducts` | By SKU, max 25 |
| `getFeedStatus` | GET `/getFeedStatus` | Feed health check |
| `getProductChanges` | GET `/getProductChanges` | Delta sync, max 30 days |
| `getAllProductChanges` | — | Auto-paginate delta |
| `getProductStock` | GET `/getProductStock` | Real-time stock, max 100 SKUs |
| `getNewProducts` | GET `/getNewProducts` | New arrivals, 1–30 days |
| `getListCategories` | GET `/getListCategories` | Category tree |
| `getShippingPrices` | GET `/getShippingPrices` | Shipping options |
| `getCountries` | GET `/getCountries` | Shippable countries |
| `setCreateOrder` | POST `/setCreateOrder` | Place order |
| `getOrder` | GET `/getOrder` | Order details |
| `getTrackings` | GET `/getTrackings` | Bulk tracking |
