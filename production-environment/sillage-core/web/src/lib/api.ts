export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (res.status === 401 && !path.startsWith("/api/auth/login")) {
    if (!window.location.pathname.startsWith("/login")) {
      window.location.href = "/login";
    }
    throw new ApiError("unauthorized", 401);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, res.status);
  return data as T;
}

export const api = {
  me: () => request<{ ok: boolean; user: string }>("/api/auth/me"),
  login: (user: string, password: string) =>
    request<{ ok: boolean; user: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ user, password }),
    }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  overview: () => request<Overview>("/api/overview"),
  syncRuns: (page = 1) =>
    request<SyncRunsPage>(`/api/sync/runs?page=${page}&limit=50`),
  runSync: (mode: "fast" | "full", opts?: { source?: string; vendors?: string[] }) =>
    request<{ ok: boolean; started?: boolean; mode?: string; source?: string; vendors?: string[] }>(
      "/api/sync/run",
      {
        method: "POST",
        body: JSON.stringify({ mode, ...opts }),
      },
    ),
  stopSync: () =>
    request<{ ok: boolean; detail?: string }>("/api/sync/stop", { method: "POST" }),
  secrets: () =>
    request<{ path: string; hotReload: boolean; note?: string; secrets: SecretStatus[] }>(
      "/api/secrets",
    ),
  setSecret: (key: string, value: string) =>
    request<{ ok: boolean; secret: SecretStatus }>("/api/secrets", {
      method: "PUT",
      body: JSON.stringify({ key, value }),
    }),
  clearSecret: (key: string) =>
    request<{ ok: boolean; secret: SecretStatus }>(`/api/secrets/${encodeURIComponent(key)}`, {
      method: "DELETE",
    }),
  liveStatus: () =>
    request<{
      liveFeedMinMinutes: number;
      beautyfort: { allow: boolean; reason: string; maxPerDay: number; cacheAgeMinutes: number | null };
      bts: { allow: boolean; reason: string; maxPerDay: number; cacheAgeMinutes: number | null };
    }>("/api/sync/live-status"),
  products: (q: string, page: number) =>
    request<ProductsPage>(`/api/products?q=${encodeURIComponent(q)}&page=${page}&limit=50`),
  vendors: () =>
    request<{
      vendors: Vendor[];
      globalPriceMultiplier: number;
      globalStockThreshold: number;
    }>("/api/vendors"),
  saveVendor: (slug: string, body: VendorPatch) =>
    request<{ ok: boolean; syncStarted?: boolean }>(`/api/vendors/${encodeURIComponent(slug)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  orders: (page = 1, status?: string) => {
    const params = new URLSearchParams({ page: String(page), limit: "50" });
    if (status) params.set("status", status);
    return request<OrdersPage>(`/api/orders?${params}`);
  },
  order: (id: number) => request<OrderDetail>(`/api/orders/${id}`),
  approveOrder: (id: number) =>
    request<{ ok: boolean; reason?: string }>(`/api/orders/${id}/approve`, { method: "POST" }),
  dispatchOrder: (id: number, live: boolean) =>
    request<{
      status: string;
      reason?: string;
      dryRun: boolean;
      vendorOrderNumber?: string | null;
    }>(`/api/orders/${id}/dispatch`, {
      method: "POST",
      body: JSON.stringify({ live }),
    }),
  settings: () => request<Record<string, string>>("/api/settings"),
  saveSettings: (body: Record<string, string>) =>
    request<{ ok: boolean; syncStarted?: boolean }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  updateOrderAddress: (
    id: number,
    body: {
      address?: OrderAddress;
      delivery?: OrderAddress;
      billing?: CompanyBillingAddress;
      resetDeliveryFromWoo?: boolean;
      useCompanyBilling?: boolean;
    },
  ) =>
    request<{ ok: boolean }>(`/api/orders/${id}/address`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  updateOrderStatus: (id: number, status: string, confirm?: boolean) =>
    request<{ ok: boolean; status: string; needsConfirm?: boolean }>(`/api/orders/${id}/status`, {
      method: "POST",
      body: JSON.stringify({ status, confirm }),
    }),
  logs: (page = 1, level?: string) => {
    const params = new URLSearchParams({ page: String(page), limit: "50" });
    if (level) params.set("level", level);
    return request<LogsPage>(`/api/logs?${params}`);
  },
};

export interface Overview {
  offers: number;
  products: number;
  /** WP `publish` count — includes catalog-excluded products. */
  published: number;
  /** Shop loop roughly: publish and not `exclude-from-catalog`. */
  catalogVisible: number;
  hiddenFromCatalog: number;
  outOfStock: number;
  /** Hidden from catalog without outofstock term (usually no/placeholder image). */
  hiddenNoImage: number;
  /** Hidden from catalog with outofstock (stock threshold). */
  hiddenStock: number;
  lastSync: SyncRun | null;
  ordersByStatus: Record<string, number>;
  syncsLast7Days: Array<{ day: string; n: number }>;
  settings: {
    dryRun: boolean;
    autoDispatch: boolean;
    syncEnabled: boolean;
    hideProductsWithoutImage?: boolean;
    stockThreshold?: number;
  };
}

export interface SyncRun {
  id: number;
  mode: string;
  source: string;
  status: string;
  duration_ms: number;
  products_fetched: number;
  posts_created: number;
  posts_updated: number;
  prices_updated: number;
  products_vanished: number;
  errors: number;
  started_at: string;
  finished_at?: string | null;
}

export interface SecretStatus {
  key: string;
  label: string;
  set: boolean;
  source: "overlay" | "env" | "unset";
  masked: string;
}

export interface SyncRunsPage {
  runs: SyncRun[];
  total: number;
  page: number;
  limit: number;
}

export interface OrdersPage {
  orders: VendorOrder[];
  total: number;
  page: number;
  limit: number;
}

export interface LogsPage {
  events: LogEvent[];
  total: number;
  page: number;
  limit: number;
}

export interface ProductsPage {
  items: Array<{
    id: number;
    sku: string;
    wp_post_id: number;
    name: string;
    stock: number;
    vendor_price: string;
    primary_ean: string | null;
    vendor: string;
    image_url: string | null;
  }>;
  total: number;
  page: number;
  limit: number;
}

export interface Vendor {
  id: number;
  slug: string;
  name: string;
  storefrontLabel: string;
  skuPrefix: string;
  currency: string;
  fxRate: number;
  vatRate: number;
  /** null = fall back to global multiplier + price tiers. */
  priceMultiplier: number | null;
  /** null = fall back to global stock threshold. */
  minVisibleStock: number | null;
  minOrderValueEur: number | null;
  serviceableCountries: string[];
  active: boolean;
  liveMaxPerDay: number | null;
  storeLiveMaxPerDay: number | null;
  storeLiveMinMinutes: number | null;
  orderConfig: Record<string, unknown>;
}

export interface VendorPatch {
  storefrontLabel?: string;
  priceMultiplier?: number | null;
  minVisibleStock?: number | null;
  fxRate?: number;
  vatRate?: number;
  minOrderValueEur?: number | null;
  serviceableCountries?: string[];
  active?: boolean;
  liveMaxPerDay?: number | null;
  storeLiveMaxPerDay?: number | null;
  storeLiveMinMinutes?: number | null;
}

export interface VendorOrder {
  id: number;
  wc_order_id: number;
  vendor: string;
  our_reference: string;
  status: string;
  items_cost: string;
  shipping_cost: string | null;
  total_cost: string | null;
  revenue: string;
  destination_country: string;
  dry_run: number;
  vendor_order_number: string | null;
  created_at: string;
}

export interface OrderAddress {
  firstName: string;
  lastName: string;
  company: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  postcode: string;
  country: string;
  email: string;
  phone: string;
}

export interface CompanyBillingAddress extends OrderAddress {
  vat: string;
}

export interface OrderLineItem {
  id: number;
  sku: string;
  name: string;
  quantity: number;
  unit_cost: string;
  unit_price?: string;
}

export interface OrderEvent {
  id: number;
  from_status: string | null;
  to_status: string | null;
  message: string;
  created_at: string;
}

export interface OrderTracking {
  id: number;
  courier: string | null;
  tracking_code: string;
  tracking_url: string | null;
  dispatched_at: string | null;
}

export interface OrderDetail {
  order: VendorOrder & Record<string, unknown>;
  address?: OrderAddress;
  wooAddress?: OrderAddress | null;
  deliveryAddress?: OrderAddress;
  billingAddress?: CompanyBillingAddress;
  companyBilling?: CompanyBillingAddress;
  wpAdminUrl?: string;
  items: OrderLineItem[];
  events: OrderEvent[];
  tracking: OrderTracking[];
}

export const emptyAddress = (): OrderAddress => ({
  firstName: "",
  lastName: "",
  company: "",
  address1: "",
  address2: "",
  city: "",
  state: "",
  postcode: "",
  country: "",
  email: "",
  phone: "",
});

export const emptyCompanyBilling = (): CompanyBillingAddress => ({
  ...emptyAddress(),
  vat: "",
});

export interface LogEvent {
  id: number;
  level: string;
  scope: string;
  message: string;
  context: unknown;
  run_id: number | null;
  created_at: string;
}
