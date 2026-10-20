export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const BASE_PATH = import.meta.env.BASE_URL === "/" ? "" : import.meta.env.BASE_URL.replace(/\/$/, "");

/** Review photos use the same clean public path as the storefront; Caddy maps it to the engine. */
export function reviewPhotoUrl(name: string): string {
  return `/reviews/photos/${encodeURIComponent(name)}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_PATH}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  // `/me` is the auth guard's probe. Let RequireAuth handle it with an in-app navigation;
  // reloading the whole document here left guests on a blank loading screen while it restarted.
  if (res.status === 401 && !path.startsWith("/api/auth/login") && !path.startsWith("/api/auth/me")) {
    if (!window.location.pathname.startsWith(`${BASE_PATH}/login`)) {
      window.location.href = `${BASE_PATH}/login`;
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
    request<{
      ok: boolean;
      started?: boolean;
      alreadyRunning?: boolean;
      queued?: boolean;
      cooldown?: boolean;
      scheduleOwnsSync?: boolean;
      pendingRebuild?: boolean;
      retryInMinutes?: number;
      nextAllowedAt?: string | null;
      detail?: string;
      mode?: string;
      source?: string;
      vendors?: string[];
    }>("/api/sync/run", {
      method: "POST",
      body: JSON.stringify({ mode, ...opts }),
    }),
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
      profile?: "retail" | "wholesale";
      vendors?: string[];
      cooldownMinutes: number;
      liveFeedMinMinutes: number;
      allow: boolean;
      retryInMinutes: number;
      nextAllowedAt: string | null;
      reason: string;
      syncEnabled?: boolean;
      pendingRebuild?: boolean;
      catalogueReady?: boolean;
      scheduleOwnsFastSync?: boolean;
      dailyCapEnabled?: boolean;
      beautyfort: {
        allow: boolean;
        reason: string;
        retryInMinutes: number;
        maxPerDay: number;
        usedToday: number;
        dailyRemaining: number | null;
      };
      bts: {
        allow: boolean;
        reason: string;
        retryInMinutes: number;
        maxPerDay: number;
        usedToday: number;
        dailyRemaining: number | null;
      };
      wholesalePerfumes?: {
        allow: boolean;
        reason: string;
        retryInMinutes: number;
        maxPerDay: number;
        usedToday: number;
        dailyRemaining: number | null;
      } | null;
    }>("/api/sync/live-status"),
  products: (q: string, page: number, limit = 10) =>
    request<ProductsPage>(
      `/api/products?q=${encodeURIComponent(q)}&page=${page}&limit=${limit}`,
    ),
  setProductVisibility: (id: number, hidden: boolean) =>
    request<{ ok: boolean; operator_hidden: boolean; syncStarted?: boolean; syncQueued?: boolean }>(
      `/api/products/${id}/visibility`,
      { method: "PUT", body: JSON.stringify({ hidden }) },
    ),
  vendors: () =>
    request<{
      vendors: Vendor[];
      profile?: "retail" | "wholesale";
      parkedVendors?: string[];
      globalPriceMultiplier: number;
      globalStockThreshold: number;
      callIntervalMinutes?: number;
      lastLiveFetch?: Record<string, string | null>;
    }>("/api/vendors"),
  saveVendor: (slug: string, body: VendorPatch) =>
    request<{
      ok: boolean;
      syncStarted?: boolean;
      syncQueued?: boolean;
      syncKind?: string | null;
      detail?: string;
      marked?: number;
    }>(`/api/vendors/${encodeURIComponent(slug)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  orders: (page = 1, status?: string, limit = 50, filter: OrderFilter = "all") => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (status) params.set("status", status);
    if (filter !== "all") params.set("filter", filter);
    return request<OrdersPage>(`/api/orders?${params}`);
  },
  order: (id: number) => request<OrderDetail>(`/api/orders/${id}`),
  /** Close (action "done") or delete orders. Deleting needs the dashboard password. */
  bulkOrders: (body: {
    action: "done" | "delete";
    wc_order_ids?: number[];
    ids?: number[];
    filter?: OrderFilter;
    password?: string;
  }) =>
    request<{
      ok: boolean;
      action: string;
      changed: number;
      orders: number;
      skipped: number;
      ignored: number;
      remaining: number;
    }>("/api/orders/bulk", { method: "POST", body: JSON.stringify(body) }),  approveOrder: (id: number) =>
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
  shipping: () => request<ShippingOverview>("/api/shipping"),
  refreshShipping: () =>
    request<{ ok: boolean; results: Array<{ vendor: string; ok: number; none: number; error: number }> }>(
      "/api/shipping/refresh",
      { method: "POST" },
    ),
  saveSettings: (body: Record<string, string>) =>
    request<{
      ok: boolean;
      syncStarted?: boolean;
      syncQueued?: boolean;
      syncKind?: string | null;
      detail?: string;
      marked?: number;
    }>("/api/settings", {
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
  messages: (kind: MessageKind, page = 1, status: MessageStatus | "all" = "all") => {
    const params = new URLSearchParams({ kind, page: String(page), limit: "25", status });
    return request<MessagesPage>(`/api/messages?${params}`);
  },
  setMessageStatus: (kind: MessageKind, id: number, status: MessageStatus) =>
    request<{ ok: boolean; status: MessageStatus }>(`/api/messages/${id}?kind=${kind}`, {
      method: "PUT",
      body: JSON.stringify({ status }),
    }),
  deleteMessage: (kind: MessageKind, id: number) =>
    request<{ ok: boolean }>(`/api/messages/${id}?kind=${kind}`, { method: "DELETE" }),
  bulkDeleteMessages: (kind: MessageKind, ids: number[]) =>
    request<{ ok: boolean; removed: number }>(`/api/messages/bulk-delete?kind=${kind}`, {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),
  emptyArchive: (kind: MessageKind) =>
    request<{ ok: boolean; removed: number }>(`/api/messages/empty-archive?kind=${kind}`, {
      method: "POST",
    }),
  reviews: (status: ReviewStatus | "all" = "pending", page = 1) => {
    const params = new URLSearchParams({ status, page: String(page), limit: "25" });
    return request<ReviewsPage>(`/api/reviews?${params}`);
  },
  setReviewStatus: (id: number, status: ReviewStatus) =>
    request<{ ok: boolean; status: ReviewStatus }>(`/api/reviews/${id}`, {
      method: "PUT",
      body: JSON.stringify({ status }),
    }),
  deleteReview: (id: number) =>
    request<{ ok: boolean }>(`/api/reviews/${id}`, { method: "DELETE" }),
};

export type MessageKind = "contact" | "withdrawal";
export type MessageStatus = "new" | "read" | "archived";

export type ReviewStatus = "pending" | "published" | "hidden";

/** A product review as the dashboard sees it — including the customer and moderation state. */
export interface StoreReview {
  id: number;
  ean: string;
  productSlug: string;
  productName: string;
  name: string;
  email: string;
  rating: number;
  title: string;
  body: string;
  photos: string[];
  verified: boolean;
  recommends: boolean | null;
  helpfulCount: number;
  locale: string;
  customerId: number | null;
  createdAt: string;
  status: ReviewStatus;
}

export interface ReviewsPage {
  ok: boolean;
  page: number;
  limit: number;
  total: number;
  counts: Record<ReviewStatus, number>;
  items: StoreReview[];
}

/** The columns both message tables share. `kind` says which table the row came from. */
interface MessageCommon {
  id: number;
  status: MessageStatus;
  name: string;
  email: string;
  order_ref: string;
  locale: string;
  signed_in: boolean;
  customer_id: number | null;
  ip: string;
  user_agent: string;
  created_at: string;
  read_at: string | null;
  archived_at: string | null;
}

export interface ContactMessage extends MessageCommon {
  kind: "contact";
  phone: string;
  subject: string;
  body: string | null;
}

export interface WithdrawalMessage extends MessageCommon {
  kind: "withdrawal";
  goods: string | null;
  ordered_on: string;
  received_on: string;
  address: string | null;
  comment: string | null;
}

export type StoreMessage = ContactMessage | WithdrawalMessage;

export interface MessagesPage {
  items: StoreMessage[];
  total: number;
  page: number;
  limit: number;
  /** Unread per tab — the badge on each tab button. */
  counts: { contact: number; withdrawal: number };
  /** Archived per tab, so "Empty archive" can be offered only when there is something to empty. */
  archived: { contact: number; withdrawal: number };
}

export interface Overview {
  offers: number;
  products: number;
  /** WP `publish` count — includes catalog-excluded products. */
  published: number;
  /** Shop loop roughly: publish and not `exclude-from-catalog`. */
  catalogVisible: number;
  hiddenFromCatalog: number;
  /** Every out-of-stock product, including those also missing a photo. Overlaps `hiddenStock`. */
  outOfStock: number;
  /**
   * Exclusive hide reason: the shop has no photo to print (may also be OOS).
   *
   * Counted from the thumbnail the writer actually wrote, not from the vendor's raw image_url — a
   * non-empty vendor URL is often a placeholder or a weak BeautyFort /pic/ thumb that never
   * reaches the storefront.
   */
  hiddenNoImage: number;
  /** Exclusive hide reason: has a photo, but at/below the stock threshold. */
  hiddenStock: number;
  hiddenOperator?: number;
  /**
   * The finished sync run the counts above were computed from. The counts are precomputed on the
   * engine and only recomputed when a run finishes, so the dashboard watches that run id and knows
   * exactly when its value is due to move — rather than re-running a heavy aggregate on a timer.
   */
  countsRunId?: number;
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
  /** BeautyFort + BTS credential readiness (values never returned). */
  secrets?: { ready: boolean; missing: string[] };
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
  fetched_by_vendor?: Record<string, number> | null;
  skipped_vendors?: string[];
  bts_delta?: boolean;
}

export interface SecretStatus {
  key: string;
  label: string;
  set: boolean;
  source: "overlay" | "env" | "unset";
  masked: string;
  /** Optional values never gate "ready" — the shop runs without them. */
  optional: boolean;
}

export interface SyncRunsPage {
  runs: SyncRun[];
  total: number;
  page: number;
  limit: number;
}

export type OrderFilter = "all" | "todo" | "done";

export interface OrdersPage {
  orders: OrderRow[];
  total: number;
  page: number;
  limit: number;
  /** Whole-table totals for the filter row. */
  counts: { all: number; todo: number; done: number };
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
    shop_visibility?: "visible" | "hidden_no_image" | "hidden_stock" | "hidden_operator";
    operator_hidden?: boolean;
    photo_url?: string | null;
    shop_url?: string | null;
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
  parked?: boolean;
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
  /** The vendor's own short code — BF for BeautyFort, BTS for BTS Wholesaler (same as the reference). */
  vendor_prefix: string;
  our_reference: string;
  status: string;
  /** 1 once the row is really at the vendor or closed; 0 while it is still to do. */
  done: number;
  items_cost: string;
  shipping_cost: string | null;
  total_cost: string | null;
  revenue: string;
  destination_country: string;
  dry_run: number;
  vendor_order_number: string | null;
  created_at: string;
  updated_at?: string;
}

/** One WooCommerce order in the Orders list — the vendor split lives under `vendors`. */
export interface OrderRow {
  wc_order_id: number;
  /** 1 when every vendor row is placed or closed; 0 while any is still to do. */
  order_done: number;
  any_dry_run: number;
  items_cost: string;
  shipping_cost: string | null;
  total_cost: string | null;
  revenue: string;
  destination_country: string;
  created_at: string;
  updated_at: string;
  vendors: VendorOrder[];
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
  /** The other vendor rows of the same WooCommerce order — the panel's vendor tabs. */
  siblings: Array<{ id: number; vendor: string; vendor_prefix: string; status: string; done: number }>;
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

export interface ShippingQuoteRow {
  vendorSlug: string;
  country: string;
  costEur: number;
  carrier: string | null;
  deliveryDays: number | null;
  status: string;
  quotedAt: string;
}

export interface ShippingOverview {
  rules: {
    markupPercent: number;
    markupFixedEur: number;
    freeOverEur: number;
    displayMode: "total" | "per_location";
    refreshHours: number;
  };
  vendors: Array<{ slug: string; name: string; countries: number }>;
  quotes: ShippingQuoteRow[];
}
