/**
 * BTS Wholesaler SDK tests
 *
 * Unit tests run without a token.
 * Integration tests run only when BTS_JWT_TOKEN is set.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { BTSClient, BTSRequestError } from "../src/vendors/bts/BTSClient.js";
import { Database } from "bun:sqlite";
import {
  getDb,
  closeDb,
  upsertProducts,
  upsertCategories,
  getProductByEan,
  searchProducts,
  getManufacturers,
  getCategories,
  addToCart,
  getCart,
  getCartTotal,
  updateCartQty,
  removeFromCart,
  clearCart,
  saveOrder,
  getOrderByNumber,
  getOrders,
} from "../src/db/database.js";
import type { ProductRow, CategoryRow } from "../src/db/database.js";

const HAVE_TOKEN = !!process.env.BTS_JWT_TOKEN;

// ─── Unit Tests: BTSClient ─────────────────────────────────────

describe("BTSClient — constructor", () => {
  it("throws if no token provided", () => {
    expect(() => new BTSClient({ token: "" })).toThrow(BTSRequestError);
  });

  it("accepts a valid token", () => {
    const c = new BTSClient({ token: "test-token" });
    expect(c).toBeInstanceOf(BTSClient);
  });

  it("uses default baseUrl", () => {
    const c = new BTSClient({ token: "tok" });
    // Can't inspect private field directly — just ensure no throw
    expect(c).toBeDefined();
  });

  it("accepts custom baseUrl", () => {
    const c = new BTSClient({
      token: "tok",
      baseUrl: "https://custom.api.test",
    });
    expect(c).toBeDefined();
  });

  it("throws BTSRequestError with name 'BTSRequestError'", () => {
    try {
      new BTSClient({ token: "" });
    } catch (e) {
      expect(e).toBeInstanceOf(BTSRequestError);
      expect((e as BTSRequestError).name).toBe("BTSRequestError");
    }
  });
});

describe("BTSRequestError", () => {
  it("carries statusCode and details", () => {
    const err = new BTSRequestError("test", 401, { raw: "body" });
    expect(err.message).toBe("test");
    expect(err.statusCode).toBe(401);
    expect(err.details).toEqual({ raw: "body" });
  });
});

describe("BTSClient — input validation", () => {
  const client = new BTSClient({ token: "dummy" });

  it("getProducts rejects > 25 SKUs", async () => {
    const skus = Array.from({ length: 26 }, (_, i) => `SKU${i}`);
    await expect(client.getProducts(skus)).rejects.toThrow("25");
  });

  it("getProducts returns [] for empty array", async () => {
    const result = await client.getProducts([]);
    expect(result).toEqual([]);
  });

  it("getProductStock rejects > 100 SKUs", async () => {
    const skus = Array.from({ length: 101 }, (_, i) => `SKU${i}`);
    await expect(client.getProductStock(skus)).rejects.toThrow("100");
  });

  it("getProductStock rejects empty array", async () => {
    await expect(client.getProductStock([])).rejects.toThrow();
  });

  it("getTrackings rejects empty array", async () => {
    await expect(client.getTrackings([])).rejects.toThrow();
  });

  it("getShippingPrices rejects empty products", async () => {
    await expect(
      client.getShippingPrices(
        { country_code: "GB", postal_code: "SW1A 1AA" },
        [],
      ),
    ).rejects.toThrow();
  });
});

// ─── Unit Tests: Database layer ───────────────────────────────

describe("Database — products", () => {
  // Use an in-memory DB for tests
  beforeEach(() => {
    closeDb();
    // Override DB path to in-memory for isolation
    process.env._TEST_DB = ":memory:";
  });

  const sampleProduct: ProductRow = {
    id: 1001,
    ean: "TEST_EAN_001",
    categories: "100/200",
    manufacturer: "TestBrand",
    name: "Test Perfume 50ml",
    description: "A lovely test fragrance",
    recommended_price: 99.99,
    price: 49.99,
    stock: 10,
    image: "https://example.com/img.jpg",
    delivery: 24,
    gender: "unisex",
    flammable: 1,
    restricted_countries: "[]",
    leadtime_to_ship: "24h",
  };

  it("upserts and retrieves a product by EAN", () => {
    upsertProducts([sampleProduct]);
    const found = getProductByEan("TEST_EAN_001");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("Test Perfume 50ml");
    expect(found!.price).toBe(49.99);
  });

  it("upsert is idempotent", () => {
    upsertProducts([sampleProduct]);
    upsertProducts([{ ...sampleProduct, price: 39.99 }]);
    const found = getProductByEan("TEST_EAN_001");
    expect(found!.price).toBe(39.99);
  });

  it("getProductByEan returns null for unknown EAN", () => {
    const found = getProductByEan("NONEXISTENT");
    expect(found).toBeNull();
  });

  it("searchProducts returns paginated results", () => {
    const products = Array.from({ length: 30 }, (_, i) => ({
      ...sampleProduct,
      id: 2000 + i,
      ean: `BULK_${i}`,
      name: `Product ${i}`,
      manufacturer: i % 2 === 0 ? "BrandA" : "BrandB",
      stock: i % 3 === 0 ? 0 : 5,
    }));
    upsertProducts(products);

    const { products: page1, total } = searchProducts({
      page: 1,
      pageSize: 10,
    });
    expect(total).toBeGreaterThanOrEqual(30);
    expect(page1.length).toBe(10);
  });

  it("searchProducts filters by manufacturer", () => {
    upsertProducts([
      { ...sampleProduct, id: 3001, ean: "BRAND_A_1", manufacturer: "ADIDAS" },
      { ...sampleProduct, id: 3002, ean: "BRAND_B_1", manufacturer: "CHANEL" },
    ]);
    const { products } = searchProducts({ manufacturer: "ADIDAS" });
    expect(products.every((p) => p.manufacturer === "ADIDAS")).toBe(true);
  });

  it("searchProducts filters in-stock only", () => {
    upsertProducts([
      { ...sampleProduct, id: 4001, ean: "INSTOCK_1", stock: 5 },
      { ...sampleProduct, id: 4002, ean: "OUTSTOCK_1", stock: 0 },
    ]);
    const { products } = searchProducts({ inStockOnly: true });
    expect(products.every((p) => p.stock > 0)).toBe(true);
  });

  it("getManufacturers returns distinct sorted list", () => {
    upsertProducts([
      { ...sampleProduct, id: 5001, ean: "M1", manufacturer: "ZEBRA" },
      { ...sampleProduct, id: 5002, ean: "M2", manufacturer: "APPLE" },
      { ...sampleProduct, id: 5003, ean: "M3", manufacturer: "APPLE" }, // duplicate
    ]);
    const brands = getManufacturers();
    expect(brands.includes("APPLE")).toBe(true);
    expect(brands.includes("ZEBRA")).toBe(true);
    // No duplicates
    expect(brands.filter((b) => b === "APPLE").length).toBe(1);
    // Sorted
    const appleIdx = brands.indexOf("APPLE");
    const zebraIdx = brands.indexOf("ZEBRA");
    expect(appleIdx).toBeLessThan(zebraIdx);
  });
});

describe("Database — categories", () => {
  const cats: CategoryRow[] = [
    { id: 1, name: "Perfumes", parent_id: 0 },
    { id: 2, name: "Cosmetics", parent_id: 0 },
    { id: 10, name: "Paco Rabanne", parent_id: 1 },
  ];

  it("upserts and retrieves categories", () => {
    upsertCategories(cats);
    const all = getCategories();
    expect(all.length).toBeGreaterThanOrEqual(3);
  });

  it("root categories have parent_id 0", () => {
    upsertCategories(cats);
    const roots = getCategories().filter((c) => c.parent_id === 0);
    expect(roots.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Database — cart", () => {
  const SID = "test-session-123";

  beforeEach(() => {
    clearCart(SID);
  });

  it("adds item to cart", () => {
    addToCart(SID, {
      product_sku: "SKU1",
      quantity: 2,
      price: 10,
      name: "Test",
      image: "",
    });
    const cart = getCart(SID);
    expect(cart.length).toBe(1);
    expect(cart[0]!.quantity).toBe(2);
  });

  it("increments quantity on duplicate add", () => {
    addToCart(SID, {
      product_sku: "SKU1",
      quantity: 1,
      price: 10,
      name: "Test",
      image: "",
    });
    addToCart(SID, {
      product_sku: "SKU1",
      quantity: 3,
      price: 10,
      name: "Test",
      image: "",
    });
    const cart = getCart(SID);
    expect(cart[0]!.quantity).toBe(4); // 1 + 3
  });

  it("updates quantity", () => {
    addToCart(SID, {
      product_sku: "SKU2",
      quantity: 1,
      price: 5,
      name: "Item",
      image: "",
    });
    updateCartQty(SID, "SKU2", 5);
    expect(getCart(SID)[0]!.quantity).toBe(5);
  });

  it("removes item when qty set to 0", () => {
    addToCart(SID, {
      product_sku: "SKU3",
      quantity: 2,
      price: 5,
      name: "Item",
      image: "",
    });
    updateCartQty(SID, "SKU3", 0);
    expect(getCart(SID).length).toBe(0);
  });

  it("removes a specific item", () => {
    addToCart(SID, {
      product_sku: "SKU4",
      quantity: 1,
      price: 5,
      name: "A",
      image: "",
    });
    addToCart(SID, {
      product_sku: "SKU5",
      quantity: 1,
      price: 5,
      name: "B",
      image: "",
    });
    removeFromCart(SID, "SKU4");
    const cart = getCart(SID);
    expect(cart.length).toBe(1);
    expect(cart[0]!.product_sku).toBe("SKU5");
  });

  it("calculates cart total", () => {
    addToCart(SID, {
      product_sku: "T1",
      quantity: 2,
      price: 10,
      name: "A",
      image: "",
    });
    addToCart(SID, {
      product_sku: "T2",
      quantity: 3,
      price: 5,
      name: "B",
      image: "",
    });
    expect(getCartTotal(SID)).toBe(35); // 2*10 + 3*5
  });

  it("clears cart", () => {
    addToCart(SID, {
      product_sku: "C1",
      quantity: 1,
      price: 1,
      name: "X",
      image: "",
    });
    clearCart(SID);
    expect(getCart(SID).length).toBe(0);
    expect(getCartTotal(SID)).toBe(0);
  });
});

describe("Database — orders", () => {
  it("saves and retrieves an order", () => {
    const orderNumber = `TEST-${Date.now()}`;
    saveOrder(
      {
        order_number: orderNumber,
        order_total: 89.5,
        order_status: "Paid",
        payment_method: "wallet",
        client_name: "Jane Doe",
        address: "10 Test St",
        postal_code: "W1A 1AA",
        city: "London",
        state_code: "",
        country_code: "GB",
        telephone: "+441234567890",
        shipping_company: "DPD",
        shipping_cost: 7.5,
        tracking: "",
        expected_dispatch_date: "2025-06-01",
        expected_delivery_date: "2025-06-03",
        dropshipping: 1,
      },
      [
        {
          order_number: orderNumber,
          product_sku: "SKU999",
          product_name: "Test Item",
          quantity: 1,
          unit_price: 89.5,
        },
      ],
    );

    const found = getOrderByNumber(orderNumber);
    expect(found).not.toBeNull();
    expect(found!.client_name).toBe("Jane Doe");
    expect(found!.order_total).toBe(89.5);
    expect(found!.items.length).toBe(1);
    expect(found!.items[0]!.product_sku).toBe("SKU999");
  });

  it("getOrders returns paginated results", () => {
    const { orders, total } = getOrders(1, 100);
    expect(Array.isArray(orders)).toBe(true);
    expect(total).toBeGreaterThanOrEqual(0);
  });
});

// ─── Integration Tests (require live token) ───────────────────

describe.skipIf(!HAVE_TOKEN)("BTSClient — live API", () => {
  // Lazy init — only instantiated when the token is actually present
  const client = HAVE_TOKEN
    ? new BTSClient({ token: process.env.BTS_JWT_TOKEN! })
    : (null as unknown as BTSClient);

  it("getFeedStatus returns a valid status", async () => {
    const status = await client.getFeedStatus("en-US");
    expect(["use_pagination", "available", "stale", "not_available"]).toContain(
      status.status,
    );
    expect(typeof status.message).toBe("string");
  }, 30_000);

  it("getListProducts returns paginated products", async () => {
    const res = await client.getListProducts({ page: 1, page_size: 50 });
    expect(res.pagination).toBeDefined();
    expect(res.pagination.total_products).toBeGreaterThan(0);
    expect(res.products.length).toBeGreaterThan(0);
    expect(typeof res.products[0]!.ean).toBe("string");
    expect(typeof res.products[0]!.price).toBe("number");
  }, 30_000);

  it("getListCategories returns array", async () => {
    const cats = await client.getListCategories("en-US");
    expect(Array.isArray(cats)).toBe(true);
    expect(cats.length).toBeGreaterThan(0);
    expect(typeof cats[0]!.id).toBe("number");
    expect(typeof cats[0]!.name).toBe("string");
  }, 30_000);

  it("getCountries returns valid list", async () => {
    const countries = await client.getCountries();
    expect(Array.isArray(countries)).toBe(true);
    expect(countries.length).toBeGreaterThan(0);
    expect(typeof countries[0]!.country_code).toBe("string");
  }, 30_000);

  it("getProducts fetches details for first SKU", async () => {
    // Get one SKU from the catalog
    const { products } = await client.getListProducts({
      page: 1,
      page_size: 5,
    });
    const sku = products[0]!.ean;
    const details = await client.getProducts([sku], "en-US");
    expect(details.length).toBeGreaterThan(0);
    expect(details[0]!.ean).toBe(sku);
  }, 30_000);

  it("getProductStock checks real-time availability", async () => {
    const { products } = await client.getListProducts({
      page: 1,
      page_size: 3,
    });
    const skus = products.map((p) => p.ean);
    const stock = await client.getProductStock(skus);
    expect(stock.requested_skus).toBe(skus.length);
    expect(typeof stock.timestamp).toBe("string");
  }, 30_000);
});
