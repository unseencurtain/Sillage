/**
 * wholesale-perfumes.eu order adapter — cart-based submit.
 *
 * Two hazards, both handled explicitly:
 * 1. The cart is account-global mutable state. Concurrent dispatches would merge into one wrong
 *    order. The empty→insert→verify→submit sequence runs under a MariaDB GET_LOCK.
 * 2. There is no client idempotency key (same as BTS). Rails already refuse to re-submit a live
 *    `submitted` row; a crash mid-submit leaves `needs_attention` and must never auto-retry.
 *
 * Dry-run means *no remote mutation whatsoever* — not even DELETE /cart.
 */
import { env } from "../../config/env.ts";
import { query, type RowDataPacket } from "../../db/pool.ts";
import { loadVendor } from "../../db/settings.ts";
import { WholesalePerfumesClient } from "../../vendors/wholesale-perfumes/WholesalePerfumesClient.ts";
import type {
  CancelResult,
  Destination,
  OrderItem,
  ShippingQuote,
  StockVerification,
  VendorOrderAdapter,
  VendorOrderDraft,
  VendorOrderResult,
  VendorOrderStatus,
} from "../adapter.ts";

const CART_LOCK = "sillage:wholesale-perfumes-cart";
const CART_LOCK_TIMEOUT_SEC = 120;

/**
 * ASSUMPTION (unconfirmed — verify with a real dry-run against the portal before going live):
 * wholesale-perfumes cart line `code` is the catalog product `id`, not the EAN. The PHP sample in the vendor
 * docs posts `{ code: 3, quantity: 4 }` and catalog records key on `<id>`. If the live API
 * actually wants EAN or another SKU, change only this function.
 */
function wholesalePerfumesCartCode(item: OrderItem): string {
  return item.vendorProductId;
}

function client(): WholesalePerfumesClient {
  return new WholesalePerfumesClient({
    user: env.wholesalePerfumes.user,
    token: env.wholesalePerfumes.token,
    catalogUrl: env.wholesalePerfumes.catalogUrl,
    storeUrl: env.wholesalePerfumes.storeUrl,
    apiBaseUrl: env.wholesalePerfumes.apiBaseUrl,
  });
}

async function acquireCartLock(): Promise<boolean> {
  const rows = await query<RowDataPacket & { locked: number | null }>(
    `SELECT GET_LOCK(?, ?) AS locked`,
    [CART_LOCK, CART_LOCK_TIMEOUT_SEC],
  );
  return rows[0]?.locked === 1;
}

async function releaseCartLock(): Promise<void> {
  await query(`SELECT RELEASE_LOCK(?)`, [CART_LOCK]);
}

function extractOrderNumber(response: unknown): string | null {
  if (response === null || response === undefined) return null;
  if (typeof response === "string" || typeof response === "number") {
    const s = String(response).trim();
    return s || null;
  }
  if (typeof response === "object") {
    const obj = response as Record<string, unknown>;
    for (const key of ["order_number", "orderNumber", "number", "id", "order_id"]) {
      const v = obj[key];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
  }
  return null;
}

export class WholesalePerfumesOrderAdapter implements VendorOrderAdapter {
  readonly slug = "wholesale-perfumes";

  async serviceableCountries(): Promise<string[]> {
    const vendor = await loadVendor("wholesale-perfumes");
    return vendor.serviceableCountries;
  }

  /**
   * wholesale-perfumes has no dedicated stock-check endpoint. Trust sil_offers quantities carried on the
   * draft (kept fresh by the hourly store sync). Still enforce positive qty here.
   */
  async verifyStock(items: OrderItem[]): Promise<StockVerification> {
    const lines = items.map((item) => ({
      sku: item.sku,
      requested: item.quantity,
      available: item.quantity,
      ok: item.quantity > 0,
    }));
    const bad = lines.filter((l) => !l.ok);
    return {
      ok: bad.length === 0,
      lines,
      reason: bad.length === 0 ? undefined : `invalid quantity on ${bad.map((l) => l.sku).join(", ")}`,
    };
  }

  /**
   * wholesale-perfumes does not expose a per-cart shipping quote in the documented cart API. Return a single
   * placeholder so the dispatcher rails can still project a total; operator confirms rates later.
   */
  async quoteShipping(_dest: Destination, _items: OrderItem[]): Promise<ShippingQuote[]> {
    return [
      {
        id: "wholesale-perfumes-default",
        company: "wholesale-perfumes.eu (rate TBC)",
        cost: 0,
        deliveryDays: undefined,
      },
    ];
  }

  async submit(order: VendorOrderDraft, dryRun: boolean): Promise<VendorOrderResult> {
    const vendor = await loadVendor("wholesale-perfumes");
    const minOrder = Number(vendor.orderConfig.min_order_value_eur ?? 0);

    const stock = await this.verifyStock(order.items);
    if (!stock.ok) {
      return {
        committed: false,
        vendorOrderNumber: null,
        shippingCost: null,
        shippingOptionId: null,
        shippingCompany: null,
        totalCost: null,
        requestPayload: null,
        responsePayload: stock,
        error: stock.reason ?? "stock verification failed",
      };
    }

    const quotes = await this.quoteShipping(order.destination, order.items);
    const chosen = quotes[0]!;
    const itemsCost = order.items.reduce((s, i) => s + i.unitCost * i.quantity, 0);

    if (minOrder > 0 && itemsCost < minOrder) {
      return {
        committed: false,
        vendorOrderNumber: null,
        shippingCost: chosen.cost,
        shippingOptionId: chosen.id,
        shippingCompany: chosen.company,
        totalCost: null,
        requestPayload: { itemsCost, minOrder },
        responsePayload: { error: "below_min_order_value" },
        error: `wholesale-perfumes min order value €${minOrder} not met (items €${itemsCost.toFixed(2)})`,
      };
    }

    const cartLines = order.items.map((i) => ({
      code: wholesalePerfumesCartCode(i),
      quantity: i.quantity,
    }));

    const addr = order.destination.address;
    const requestPayload = {
      ourReference: order.ourReference,
      cartLines,
      // Isolated assumption — see wholesalePerfumesCartCode().
      codeFieldAssumption: "catalog id (vendorProductId)",
      delivery: {
        name: `${addr.firstName} ${addr.lastName}`.trim(),
        address1: addr.address1,
        address2: addr.address2,
        city: addr.city,
        postcode: addr.postcode,
        country: order.destination.country,
        phone: addr.phone,
      },
      companyBilling: order.billing
        ? {
            company: order.billing.address.company,
            vat: order.billing.vat,
            name: `${order.billing.address.firstName} ${order.billing.address.lastName}`.trim(),
            address1: order.billing.address.address1,
            city: order.billing.address.city,
            postcode: order.billing.address.postcode,
            country: order.billing.country,
          }
        : null,
      itemsCost,
      quote: chosen,
      minOrderValueEur: minOrder,
    };

    // Dry-run: build and record the payload only. No DELETE/POST to the cart API.
    if (dryRun) {
      return {
        committed: false,
        vendorOrderNumber: null,
        shippingCost: chosen.cost,
        shippingOptionId: chosen.id,
        shippingCompany: chosen.company,
        totalCost: Number((itemsCost + chosen.cost).toFixed(2)),
        requestPayload,
        responsePayload: { dryRun: true },
      };
    }

    if (!(await acquireCartLock())) {
      return {
        committed: false,
        vendorOrderNumber: null,
        shippingCost: chosen.cost,
        shippingOptionId: chosen.id,
        shippingCompany: chosen.company,
        totalCost: null,
        requestPayload,
        responsePayload: { error: "wholesale_perfumes_cart_lock_busy" },
        error: "could not acquire wholesale-perfumes cart advisory lock — another dispatch holds it",
      };
    }

    try {
      const api = client();
      await api.clearCart();
      await api.addToCart(cartLines);
      const cart = await api.getCart();
      const submitResponse = await api.submitCart();
      const vendorOrderNumber = extractOrderNumber(submitResponse);

      if (!vendorOrderNumber) {
        // Submit may or may not have created an order — treat as ambiguous (no idempotency key).
        return {
          committed: false,
          vendorOrderNumber: null,
          shippingCost: chosen.cost,
          shippingOptionId: chosen.id,
          shippingCompany: chosen.company,
          totalCost: null,
          requestPayload,
          responsePayload: { cart, submitResponse },
          ambiguous: true,
          error: "wholesale-perfumes submit returned no order_number",
        };
      }

      return {
        committed: true,
        vendorOrderNumber,
        shippingCost: chosen.cost,
        shippingOptionId: chosen.id,
        shippingCompany: chosen.company,
        totalCost: Number((itemsCost + chosen.cost).toFixed(2)),
        requestPayload,
        responsePayload: { cart, submitResponse },
      };
    } catch (err) {
      return {
        committed: false,
        vendorOrderNumber: null,
        shippingCost: chosen.cost,
        shippingOptionId: chosen.id,
        shippingCompany: chosen.company,
        totalCost: null,
        requestPayload,
        responsePayload: { error: String(err) },
        ambiguous: true,
        error: String(err),
      };
    } finally {
      await releaseCartLock();
    }
  }

  async poll(vendorOrderNumber: string): Promise<VendorOrderStatus> {
    const detail = await client().getOrder(vendorOrderNumber);
    const rawStatus =
      detail && typeof detail === "object"
        ? String(
            (detail as Record<string, unknown>).status ??
              (detail as Record<string, unknown>).order_status ??
              "unknown",
          )
        : String(detail ?? "unknown");

    const lower = rawStatus.toLowerCase();
    let status: VendorOrderStatus["status"] = "unknown";
    if (lower.includes("deliver")) status = "delivered";
    else if (lower.includes("ship") || lower.includes("dispatch")) status = "dispatched";
    else if (lower.includes("cancel")) status = "cancelled";
    else if (lower.includes("confirm") || lower.includes("paid") || lower.includes("process")) {
      status = "confirmed";
    } else if (lower.includes("pend") || lower.includes("new") || lower.includes("open")) {
      status = "pending";
    }

    return {
      status,
      vendorOrderNumber,
      rawStatus,
      parcels: [],
      shippingCompany: null,
    };
  }

  async cancel?(_vendorOrderNumber: string): Promise<CancelResult> {
    return {
      ok: false,
      fee: null,
      message: "wholesale-perfumes has no documented cancel API; cancel via the wholesale-perfumes.eu portal",
    };
  }
}
