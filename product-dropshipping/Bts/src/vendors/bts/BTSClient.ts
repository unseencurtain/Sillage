/**
 * BTSClient — BTS Wholesaler API SDK for Bun / Node.js
 *
 * All API calls return typed responses. Errors throw `BTSRequestError`.
 * Uses the native Fetch API (available in Bun and Node 18+).
 *
 * @example
 * ```ts
 * import { BTSClient } from "./BTSClient";
 * const client = new BTSClient({ token: process.env.BTS_JWT_TOKEN! });
 * const { products } = await client.getListProducts({ page: 1, page_size: 200 });
 * ```
 */

import type {
  BTSConfig,
  Product,
  ProductListResponse,
  GetListProductsParams,
  FeedStatus,
  ProductChangesResponse,
  GetProductChangesParams,
  StockResponse,
  NewProductsResponse,
  GetNewProductsParams,
  Category,
  ShippingAddress,
  OrderProduct,
  ShippingOption,
  Country,
  CreateOrderParams,
  CreateOrderResponse,
  OrderDetails,
  TrackingInfo,
} from "./types.js";
import { normalizeOrderStatus } from "../../server/utils/orderStatus.js";

// ─── Error class ──────────────────────────────────────────────

export class BTSRequestError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "BTSRequestError";
  }
}

// ─── Response normalizers ────────────────────────────────────
// The real API returns prices as "30.10€" strings and stock as "31" strings.
// These helpers coerce everything to the typed numbers declared in types.ts.

function parsePrice(v: unknown): number {
  if (typeof v === "number") return v;
  // Strip any currency symbol (€, £, $) then parse
  return parseFloat(String(v ?? "0").replace(/[^0-9.]/g, "")) || 0;
}

function parseStock(v: unknown): number {
  if (typeof v === "number") return v;
  return parseInt(String(v ?? "0"), 10) || 0;
}

function normaliseProduct(raw: Record<string, unknown>): Product {
  return {
    id: Number(raw["id"] ?? 0),
    ean: String(raw["ean"] ?? ""),
    categories: String(raw["categories"] ?? ""),
    manufacturer: String(raw["manufacturer"] ?? ""),
    name: String(raw["name"] ?? ""),
    description: String(raw["description"] ?? ""),
    recommended_price: parsePrice(raw["recommended_price"]),
    price: parsePrice(raw["price"]),
    stock: parseStock(raw["stock"]),
    image: String(raw["image"] ?? ""),
    delivery: Number(raw["delivery"] ?? raw["leadtime_to_ship"] ?? 0),
    gender: String(raw["gender"] ?? ""),
    flammable: Boolean(raw["flammable"]),
    restricted_countries: Array.isArray(raw["restricted_countries"])
      ? (raw["restricted_countries"] as string[])
      : [],
    leadtime_to_ship: String(raw["leadtime_to_ship"] ?? ""),
  };
}

// ─── BTSClient ────────────────────────────────────────────────

export class BTSClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;

  constructor(config: BTSConfig) {
    if (!config.token) {
      throw new BTSRequestError(
        "BTS JWT token is required. Set BTS_JWT_TOKEN in your environment.",
      );
    }
    this.token = config.token;
    this.baseUrl = (
      config.baseUrl ?? "https://api.btswholesaler.com/v1/api"
    ).replace(/\/$/, "");
    this.timeout = config.timeout ?? 120_000;
    this.maxRetries = config.maxRetries ?? 3;
  }

  // ============================================================
  // Private helpers
  // ============================================================

  private get authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
  }

  /**
   * Build a URL with flat key=value query parameters.
   * Arrays like product_sku[0], product_sku[1] must be appended manually.
   */
  private buildUrl(
    endpoint: string,
    params?: Record<string, string | number | undefined>,
  ): string {
    const url = new URL(`${this.baseUrl}/${endpoint.replace(/^\//, "")}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== "") {
          url.searchParams.set(k, String(v));
        }
      }
    }
    return url.toString();
  }

  private async executeRequest<T>(
    url: string,
    init: RequestInit,
    attempt = 0,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    // Rate-limit retry with exponential backoff
    if (res.status === 429 && attempt < this.maxRetries) {
      const retryAfter = parseInt(res.headers.get("Retry-After") ?? "5", 10);
      const delay = retryAfter * 1000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delay));
      return this.executeRequest<T>(url, init, attempt + 1);
    }

    if (!res.ok) {
      let body = "";
      try {
        body = await res.text();
      } catch {}
      throw new BTSRequestError(
        `BTS API ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
        res.status,
        body,
      );
    }

    return res.json() as Promise<T>;
  }

  private async get<T>(
    endpoint: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const url = this.buildUrl(endpoint, params);
    return this.executeRequest<T>(url, {
      method: "GET",
      headers: this.authHeaders,
    });
  }

  private async post<T>(endpoint: string, body: URLSearchParams): Promise<T> {
    const url = `${this.baseUrl}/${endpoint.replace(/^\//, "")}`;
    return this.executeRequest<T>(url, {
      method: "POST",
      headers: {
        ...this.authHeaders,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  }

  // ============================================================
  // Product Methods
  // ============================================================

  /**
   * Get a single page of the product catalog.
   * @see https://api.btswholesaler.com/v1/api/getListProducts
   */
  async getListProducts(
    params: GetListProductsParams = {},
  ): Promise<ProductListResponse> {
    const raw = await this.get<Record<string, unknown>>("getListProducts", {
      page: params.page,
      page_size: params.page_size,
      language_code: params.language_code ?? "en-US",
      category_ids: params.category_ids,
      manufacturer_names: params.manufacturer_names,
    });
    const rawProducts = (raw["products"] ?? []) as Record<string, unknown>[];
    return {
      pagination: raw["pagination"] as ProductListResponse["pagination"],
      products: rawProducts.map(normaliseProduct),
    };
  }

  /**
   * Fetch the **entire** product catalog by auto-paginating all pages.
   * Reports progress via optional callback.
   *
   * @example
   * ```ts
   * const products = await client.getAllProducts(
   *   { language_code: "en-US", page_size: 500 },
   *   (page, total) => console.log(`Page ${page}/${total}`)
   * );
   * ```
   */
  async getAllProducts(
    params: Omit<GetListProductsParams, "page"> = {},
    onProgress?: (page: number, totalPages: number, fetched: number) => void,
  ): Promise<Product[]> {
    const all: Product[] = [];
    let page = 1;

    while (true) {
      const res = await this.getListProducts({
        ...params,
        page,
        page_size: params.page_size ?? 500,
      });
      all.push(...res.products);
      onProgress?.(page, res.pagination.total_pages, all.length);

      if (!res.pagination.has_next_page) break;
      page++;
    }

    return all;
  }

  /**
   * Get detailed data for up to **25** specific products by SKU / EAN.
   */
  async getProducts(skus: string[], languageCode?: string): Promise<Product[]> {
    if (skus.length === 0) return [];
    if (skus.length > 25)
      throw new BTSRequestError("getProducts: maximum 25 SKUs per request");

    const url = new URL(`${this.baseUrl}/getProducts`);
    skus.forEach((sku, i) => url.searchParams.append(`product_sku[${i}]`, sku));
    url.searchParams.set("language_code", languageCode ?? "en-US");

    const raw = await this.executeRequest<unknown>(url.toString(), {
      method: "GET",
      headers: this.authHeaders,
    });

    // API may return an array or an object keyed by index
    const arr: Record<string, unknown>[] = Array.isArray(raw)
      ? (raw as Record<string, unknown>[])
      : (Object.values(raw as Record<string, unknown>) as Record<
          string,
          unknown
        >[]);
    return arr.map(normaliseProduct);
  }

  /**
   * Check feed status before starting a full sync.
   */
  async getFeedStatus(languageCode?: string): Promise<FeedStatus> {
    return this.get<FeedStatus>("getFeedStatus", {
      language_code: languageCode ?? "en-US",
    });
  }

  /**
   * Get products changed since a specific date — ideal for delta/incremental sync.
   * Max 30 days back.
   */
  async getProductChanges(
    params: GetProductChangesParams,
  ): Promise<ProductChangesResponse> {
    return this.get<ProductChangesResponse>("getProductChanges", {
      since: params.since,
      language_code: params.language_code ?? "en-US",
      page: params.page,
      page_size: params.page_size,
    });
  }

  /**
   * Auto-paginates `getProductChanges` and returns all changed products.
   */
  async getAllProductChanges(
    since: string,
    languageCode?: string,
  ): Promise<ProductChangesResponse["products"]> {
    const all: ProductChangesResponse["products"] = [];
    let page = 1;

    while (true) {
      const res = await this.getProductChanges({
        since,
        language_code: languageCode ?? "en-US",
        page,
        page_size: 500,
      });
      all.push(...res.products);
      if (!res.pagination.has_next_page) break;
      page++;
    }

    return all;
  }

  /**
   * Real-time stock and price check for up to **100** SKUs.
   * Lightweight — use for cart validation and pre-order checks.
   */
  async getProductStock(skus: string[]): Promise<StockResponse> {
    if (skus.length === 0)
      throw new BTSRequestError("getProductStock: at least one SKU required");
    if (skus.length > 100)
      throw new BTSRequestError(
        "getProductStock: maximum 100 SKUs per request",
      );

    const url = new URL(`${this.baseUrl}/getProductStock`);
    skus.forEach((sku, i) => url.searchParams.append(`product_sku[${i}]`, sku));

    return this.executeRequest<StockResponse>(url.toString(), {
      method: "GET",
      headers: this.authHeaders,
    });
  }

  /**
   * Get recently added products (new arrivals).
   */
  async getNewProducts(
    params: GetNewProductsParams = {},
  ): Promise<NewProductsResponse> {
    return this.get<NewProductsResponse>("getNewProducts", {
      days: params.days,
      language_code: params.language_code ?? "en-US",
      page: params.page,
      page_size: params.page_size,
    });
  }

  // ============================================================
  // Category & Shipping Methods
  // ============================================================

  /**
   * Get the full category tree.
   * Products reference categories as a `/`-separated path of IDs e.g. `"14498/15008"`.
   *
   * Real API returns a keyed object: { "14497": { id: "14497", name: "Men", parent_id: null }, … }
   */
  async getListCategories(languageCode?: string): Promise<Category[]> {
    const raw = await this.get<unknown>("getListCategories", {
      language_code: languageCode ?? "en-US",
    });

    // Direct array (documented format)
    if (Array.isArray(raw)) {
      return (raw as Record<string, unknown>[]).map((c) => ({
        id: Number(c["id"]),
        name: String(c["name"] ?? ""),
        parent_id: c["parent_id"] == null ? 0 : Number(c["parent_id"]),
      }));
    }

    // Real API: keyed object { "14497": { id, name, parent_id }, … }
    if (raw && typeof raw === "object") {
      return Object.values(raw as Record<string, Record<string, unknown>>).map(
        (c) => ({
          id: Number(c["id"]),
          name: String(c["name"] ?? ""),
          parent_id: c["parent_id"] == null ? 0 : Number(c["parent_id"]),
        }),
      );
    }

    return [];
  }

  /**
   * Calculate available shipping methods and costs for an address + cart.
   *
   * @example
   * ```ts
   * const options = await client.getShippingPrices(
   *   { country_code: "GB", postal_code: "SW1A 1AA" },
   *   [{ sku: "8411061123456", quantity: 1 }]
   * );
   * // Pick options[0].id as shipping_cost_id when creating the order
   * ```
   */
  async getShippingPrices(
    address: ShippingAddress,
    products: OrderProduct[],
  ): Promise<ShippingOption[]> {
    if (products.length === 0)
      throw new BTSRequestError(
        "getShippingPrices: at least one product required",
      );

    const url = new URL(`${this.baseUrl}/getShippingPrices`);
    url.searchParams.set("address[country_code]", address.country_code);
    url.searchParams.set("address[postal_code]", address.postal_code);
    products.forEach((p, i) => {
      url.searchParams.set(`products[${i}][sku]`, p.sku);
      url.searchParams.set(`products[${i}][quantity]`, String(p.quantity));
    });

    const raw = await this.executeRequest<unknown>(url.toString(), {
      method: "GET",
      headers: this.authHeaders,
    });

    if (Array.isArray(raw)) {
      return (raw as Record<string, unknown>[]).map((r) => ({
        id: Number(r["id"] ?? 0),
        delivery_time: Number(r["delivery_time"] ?? 0),
        company_name: String(r["company_name"] ?? ""),
        shipping_cost: Number(r["shipping_cost"] ?? 0),
        free_shipping: Number(r["free_shipping"] ?? 0),
      }));
    }

    if (raw && typeof raw === "object") {
      return Object.values(raw as Record<string, Record<string, unknown>>).map(
        (r) => ({
          id: Number(r["id"] ?? 0),
          delivery_time: Number(r["delivery_time"] ?? 0),
          company_name: String(r["company_name"] ?? ""),
          shipping_cost: Number(r["shipping_cost"] ?? 0),
          free_shipping: Number(r["free_shipping"] ?? 0),
        }),
      );
    }

    return [];
  }

  /**
   * List all countries BTS Wholesaler can ship to.
   *
   * Real API returns: { "AT": "Austria", "BE": "Belgium", … }
   */
  async getCountries(): Promise<Country[]> {
    const raw = await this.get<unknown>("getCountries");

    // Documented format: array of { country_code, country_name }
    if (Array.isArray(raw)) {
      return raw as Country[];
    }

    // Real API: { "AT": "Austria", … }
    if (raw && typeof raw === "object") {
      return Object.entries(raw as Record<string, string>).map(
        ([code, name]) => ({
          country_code: code,
          country_name: name,
        }),
      );
    }

    return [];
  }

  // ============================================================
  // Order Methods
  // ============================================================

  /**
   * Create a new dropship order.
   *
   * ⚠️  There is **no sandbox mode** — every call creates a real order.
   * Use `payment_method: "banktransfer"` during testing; it stays in
   * "Pending Payment" and can be cancelled by your account manager.
   *
   * Workflow:
   * 1. `getShippingPrices` → choose a `shipping_cost_id`
   * 2. `setCreateOrder` → store the `order_number`
   * 3. `getOrder` / `getTrackings` to poll status
   *
   * Real API returns just the bare order number string e.g. `"690005604133"`.
   * This method returns immediately after creation for lower checkout latency.
   * Call `getOrder(order_number)` if you need full details right away.
   */
  async setCreateOrder(order: CreateOrderParams): Promise<CreateOrderResponse> {
    const body = new URLSearchParams();
    body.set("payment_method", order.payment_method);
    body.set("shipping_cost_id", String(order.shipping_cost_id));
    body.set("client_name", order.client_name);
    body.set("address", order.address);
    body.set("postal_code", order.postal_code);
    body.set("city", order.city);
    body.set("country_code", order.country_code);
    body.set("telephone", order.telephone);
    body.set("dropshipping", String(order.dropshipping ?? 1));
    if (order.state_code) body.set("state_code", order.state_code);

    order.products.forEach((p, i) => {
      body.set(`products[${i}][sku]`, p.sku);
      body.set(`products[${i}][quantity]`, String(p.quantity));
    });

    // Real API returns the order number as a bare string, not a JSON object
    const raw = await this.post<unknown>("setCreateOrder", body);

    let orderNumber: string;
    let responseObject: Record<string, unknown> | null = null;
    if (typeof raw === "string") {
      orderNumber = raw.trim();
    } else if (raw && typeof raw === "object") {
      const r = raw as Record<string, unknown>;
      responseObject = r;
      orderNumber = String(r["order_number"] ?? r["id"] ?? r["order"] ?? "");
    } else {
      throw new BTSRequestError(
        `setCreateOrder: unexpected response: ${JSON.stringify(raw)}`,
      );
    }

    if (!orderNumber) {
      throw new BTSRequestError(
        `setCreateOrder: could not extract order number from response: ${JSON.stringify(raw)}`,
      );
    }

    return {
      order_number: orderNumber,
      order_total: String(responseObject?.["order_total"] ?? "0"),
      order_status: normalizeOrderStatus(
        String(responseObject?.["order_status"] ?? "Pending Payment"),
      ),
      expected_dispatch_date: String(
        responseObject?.["expected_dispatch_date"] ?? "",
      ),
      expected_dispatch_date_2: String(
        responseObject?.["expected_dispatch_date_2"] ?? "",
      ),
      expected_delivery_date: String(
        responseObject?.["expected_delivery_date"] ?? "",
      ),
      expected_delivery_date_2: String(
        responseObject?.["expected_delivery_date_2"] ?? "",
      ),
    };
  }

  /**
   * Get full order details including status, tracking, and line items.
   *
   * Real API products format: { sku, quantity (string), price (string) }
   * We normalise to the documented OrderItem shape.
   */
  async getOrder(orderNumber: string): Promise<OrderDetails> {
    const raw = await this.get<Record<string, unknown>>("getOrder", {
      order_number: orderNumber,
    });

    // Normalise product line items
    const rawProducts = (raw["products"] ?? []) as Record<string, unknown>[];
    const products: OrderDetails["products"] = rawProducts.map((p) => ({
      product_sku: String(p["sku"] ?? p["product_sku"] ?? ""),
      product_name: String(p["name"] ?? p["product_name"] ?? ""),
      quantity: Number(p["quantity"] ?? 0),
      unit_price: parsePrice(p["price"] ?? p["unit_price"]),
    }));

    return {
      order_number: String(raw["order_number"] ?? ""),
      order_status: normalizeOrderStatus(String(raw["order_status"] ?? "")),
      tracking: String(raw["tracking"] ?? ""),
      order_total: String(raw["order_total"] ?? "0"),
      client_name: String(raw["client_name"] ?? ""),
      client_email: String(raw["client_email"] ?? ""),
      address: String(raw["address"] ?? ""),
      postal_code: String(raw["postal_code"] ?? ""),
      city: String(raw["city"] ?? ""),
      state_code: raw["state_code"] != null ? String(raw["state_code"]) : null,
      country_code: String(raw["country_code"] ?? ""),
      shipping_company: String(raw["shipping_company"] ?? ""),
      shipping_cost: String(raw["shipping_cost"] ?? "0"),
      telephone: String(raw["telephone"] ?? ""),
      comments: String(raw["comments"] ?? ""),
      expected_delivery_date: String(raw["expected_delivery_date"] ?? ""),
      expected_delivery_date_2: String(raw["expected_delivery_date_2"] ?? ""),
      expected_dispatch_date: String(raw["expected_dispatch_date"] ?? ""),
      expected_dispatch_date_2:
        raw["expected_dispatch_date_2"] != null
          ? String(raw["expected_dispatch_date_2"])
          : null,
      dropshipping: Number(raw["dropshipping"] ?? 0),
      entry_date: String(raw["entry_date"] ?? ""),
      products,
    };
  }

  /**
   * Get tracking numbers for one or more orders at once.
   * Tracking becomes available 24–72 hours after order creation.
   *
   * @example
   * ```ts
   * const trackings = await client.getTrackings(["743799256961", "743799256962"]);
   * ```
   */
  async getTrackings(orderNumbers: string[]): Promise<TrackingInfo[]> {
    if (orderNumbers.length === 0)
      throw new BTSRequestError(
        "getTrackings: at least one order number required",
      );

    const url = new URL(`${this.baseUrl}/getTrackings`);
    orderNumbers.forEach((n, i) =>
      url.searchParams.append(`order_number[${i}]`, n),
    );

    return this.executeRequest<TrackingInfo[]>(url.toString(), {
      method: "GET",
      headers: this.authHeaders,
    });
  }
}
