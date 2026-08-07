// ============================================================
// BTS Wholesaler API — TypeScript Types
// Base URL: https://api.btswholesaler.com/v1/api
// Auth: Bearer JWT in Authorization header
// ============================================================

// ─── Client Config ──────────────────────────────────────────

export interface BTSConfig {
  /** JWT token from BTSWholesaler account portal */
  token: string;
  /** Override base URL (default: https://api.btswholesaler.com/v1/api) */
  baseUrl?: string;
  /** Request timeout in ms (default: 120_000) */
  timeout?: number;
  /** Max retries on 429 rate-limit (default: 3) */
  maxRetries?: number;
}

// ─── Pagination ──────────────────────────────────────────────

export interface Pagination {
  current_page: number;
  page_size: number;
  total_products: number;
  total_pages: number;
  has_next_page: boolean;
  has_previous_page: boolean;
}

// ─── Products ────────────────────────────────────────────────

export interface Product {
  id: number;
  /** EAN / SKU — used as the primary product identifier */
  ean: string;
  /** Category path e.g. "14498/15008" — IDs separated by "/" */
  categories: string;
  manufacturer: string;
  name: string;
  description: string;
  recommended_price: number;
  price: number;
  stock: number;
  image: string;
  /** Lead time in hours */
  delivery: number;
  gender: string;
  flammable?: boolean;
  /** ISO-3166-1 alpha-2 codes where product is restricted */
  restricted_countries?: string[];
  leadtime_to_ship?: string;
}

export interface ProductListResponse {
  pagination: Pagination;
  products: Product[];
}

export interface GetListProductsParams {
  page?: number;
  /** 50–500 (default 200) */
  page_size?: number;
  /** en-US | es-ES | fr-FR | it-IT | de-DE */
  language_code?: string;
  /** Comma-separated category IDs e.g. "12,45,78" */
  category_ids?: string;
  /** Comma-separated brand names e.g. "ADIDAS,CHANEL" */
  manufacturer_names?: string;
}

// ─── Feed Status ─────────────────────────────────────────────

export interface FeedStatus {
  status: "use_pagination" | "available" | "stale" | "not_available";
  message: string;
  recommended_page_size: number;
  cached_file_exists: boolean;
  cached_file_age_minutes: number | null;
}

// ─── Product Changes (delta sync) ────────────────────────────

export interface ProductChange {
  id: number;
  product_sku: string;
  last_modified: string;
  product_price: number;
  product_stock: number;
  recommended_price: number;
}

export interface ProductChangesResponse {
  query: {
    since: string;
    language_code: string;
  };
  pagination: Pagination;
  products: ProductChange[];
}

export interface GetProductChangesParams {
  /** Y-m-d or "Y-m-d H:i:s". Max 30 days back. */
  since: string;
  language_code?: string;
  page?: number;
  page_size?: number;
}

// ─── Real-time Stock ─────────────────────────────────────────

export type StockAvailability = "in_stock" | "out_of_stock" | "not_found";

export interface StockItem {
  stock: number;
  price: number | null;
  availability: StockAvailability;
  last_updated: string | null;
}

export interface StockResponse {
  requested_skus: number;
  found_skus: number;
  timestamp: string;
  products: Record<string, StockItem>;
}

// ─── New Products ─────────────────────────────────────────────

export interface NewProduct {
  id: number;
  product_sku: string;
  published_date: string;
  product_name: string;
  manufacturer_name: string;
  product_price: number;
  product_stock: number;
  recommended_price: number;
}

export interface NewProductsResponse {
  query: {
    days: number;
    since: string;
    language_code: string;
  };
  pagination: Pagination;
  products: NewProduct[];
}

export interface GetNewProductsParams {
  /** 1–30 (default 7) */
  days?: number;
  language_code?: string;
  page?: number;
  page_size?: number;
}

// ─── Categories ───────────────────────────────────────────────

export interface Category {
  id: number;
  name: string;
  /** 0 = root category */
  parent_id: number;
}

// ─── Shipping ────────────────────────────────────────────────

export interface ShippingAddress {
  country_code: string;
  postal_code: string;
}

export interface OrderProduct {
  sku: string;
  quantity: number;
}

export interface ShippingOption {
  /** Use as `shipping_cost_id` when creating an order */
  id: number;
  /** Business days */
  delivery_time: number;
  company_name: string;
  shipping_cost: number;
  /** Order subtotal threshold for free shipping */
  free_shipping: number;
}

// ─── Countries ────────────────────────────────────────────────

export interface Country {
  country_code: string;
  country_name: string;
}

// ─── Orders ──────────────────────────────────────────────────

export type PaymentMethod = "wallet" | "banktransfer" | "btscredit";

export interface CreateOrderParams {
  payment_method: PaymentMethod;
  products: OrderProduct[];
  /** From getShippingPrices response */
  shipping_cost_id: number;
  client_name: string;
  address: string;
  postal_code: string;
  city: string;
  /** ISO-3166-1 alpha-2 — must match the country used in getShippingPrices */
  country_code: string;
  telephone: string;
  /** 0 = no, 1 = yes (default 1) */
  dropshipping?: 0 | 1;
  /** Required for US and CA orders (e.g. NY, CA, QC) */
  state_code?: string;
}

export interface CreateOrderResponse {
  order_number: string;
  order_total: string;
  order_status: string;
  expected_dispatch_date: string;
  expected_dispatch_date_2: string;
  expected_delivery_date: string;
  expected_delivery_date_2: string;
}

export interface OrderItem {
  product_sku: string;
  product_name: string;
  quantity: number;
  unit_price: number;
}

export interface OrderDetails {
  order_number: string;
  order_status: string;
  tracking: string;
  order_total: string;
  client_name: string;
  client_email: string;
  address: string;
  postal_code: string;
  city: string;
  state_code: string | null;
  country_code: string;
  shipping_company: string;
  shipping_cost: string;
  telephone: string;
  comments: string;
  expected_delivery_date: string;
  expected_delivery_date_2: string;
  expected_dispatch_date: string;
  expected_dispatch_date_2: string | null;
  dropshipping: number;
  entry_date: string;
  products: OrderItem[];
}

export interface TrackingInfo {
  order_number: string;
  tracking: string;
}

// ─── Errors ──────────────────────────────────────────────────

export type OrderErrorCode =
  | "country_code_is_required"
  | "shipping_cost_code_error"
  | "state_code_error"
  | "payment_method_error"
  | "no_enough_money"
  | "no_enough_credit"
  | "product_error"
  | "no_stock";

export interface BTSAPIError {
  error: string | OrderErrorCode;
  message?: string;
  code?: number;
}
