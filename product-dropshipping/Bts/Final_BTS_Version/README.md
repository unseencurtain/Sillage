# Final_BTS_Version

Self-contained BTS Wholesaler API client for Bun / Node 18+. Includes:

- `BTSClient.ts`
- `types.ts`
- `orderStatus.ts`
- `config.ts`
- `.env.example`
- `BTSClient_Integration_Guide.md`

## Configuration

The client does **not** load `.env` for you. Read your environment variables in your app
and pass the token into the constructor, or use `config.ts` which reads `process.env.BTS_JWT_TOKEN`.

## Usage

```ts
import { BTSClient } from "./Final_BTS_Version/BTSClient";
import config from "./Final_BTS_Version/config";

const client = new BTSClient(config);

const { products } = await client.getListProducts({ page: 1, page_size: 200 });
const stock = await client.getProductStock(["SKU1", "SKU2"]);

const order = await client.setCreateOrder({
  // See types.ts for the full CreateOrderParams shape
  billing_address: {
    name: "John Doe",
    address1: "Main St 1",
    city: "Berlin",
    postal_code: "10115",
    country: "DE",
    phone: "+49 111 2222",
    email: "john@example.com",
  },
  shipping_address: {
    name: "John Doe",
    address1: "Main St 1",
    city: "Berlin",
    postal_code: "10115",
    country: "DE",
    phone: "+49 111 2222",
    email: "john@example.com",
  },
  products: [{ sku: "SKU1", quantity: 1 }],
});

const details = await client.getOrder(order.order_number);
const tracking = await client.getTrackings([order.order_number]);
```

## Available methods

- `getListProducts`, `getAllProducts`, `getProducts`
- `getFeedStatus`, `getProductChanges`, `getAllProductChanges`
- `getProductStock`, `getNewProducts`
- `getListCategories`
- `getShippingPrices`, `getCountries`
- `setCreateOrder`, `getOrder`, `getTrackings`
