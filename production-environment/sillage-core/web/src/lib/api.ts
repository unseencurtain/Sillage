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
  syncRuns: () => request<{ runs: SyncRun[] }>("/api/sync/runs"),
  runSync: (mode: "fast" | "full") =>
    request<{ ok: boolean }>("/api/sync/run", { method: "POST", body: JSON.stringify({ mode }) }),
  products: (q: string, page: number) =>
    request<ProductsPage>(`/api/products?q=${encodeURIComponent(q)}&page=${page}&limit=50`),
  vendors: () => request<{ vendors: Vendor[] }>("/api/vendors"),
  orders: (status?: string) =>
    request<{ orders: VendorOrder[] }>(`/api/orders${status ? `?status=${status}` : ""}`),
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
  updateOrderAddress: (id: number, address: OrderAddress) =>
    request<{ ok: boolean }>(`/api/orders/${id}/address`, {
      method: "PUT",
      body: JSON.stringify({ address }),
    }),
  logs: (level?: string) =>
    request<{ events: LogEvent[] }>(`/api/logs${level ? `?level=${level}` : ""}`),
};

export interface Overview {
  offers: number;
  products: number;
  published: number;
  lastSync: SyncRun | null;
  ordersByStatus: Record<string, number>;
  syncsLast7Days: Array<{ day: string; n: number }>;
  settings: { dryRun: boolean; autoDispatch: boolean; syncEnabled: boolean };
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
  skuPrefix: string;
  priceMultiplier: number;
  minVisibleStock: number;
  serviceableCountries: string[];
  active: boolean;
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

export interface LogEvent {
  id: number;
  level: string;
  scope: string;
  message: string;
  context: unknown;
  run_id: number | null;
  created_at: string;
}
