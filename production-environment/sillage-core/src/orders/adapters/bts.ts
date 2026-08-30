/**
 * BTS Wholesaler order adapter — single-shot submit.
 *
 * BTS accepts no client reference and has no list-orders endpoint. A network error after
 * `setCreateOrder` is therefore genuinely ambiguous: the order may or may not exist. The
 * dispatcher records the payload hash before the call and never auto-retries a row left in
 * `submitting`.
 */
import { env } from "../../config/env.ts";
import { loadVendor } from "../../db/settings.ts";
import { BTSClient, coerceBtsTracking, isBtsTrackingNotReady } from "../../vendors/bts/BtsClient.ts";
import type { CreateOrderParams, PaymentMethod } from "../../vendors/bts/types.ts";
import { btsVendorPollStatus } from "../../vendors/bts/orderStatus.ts";
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

function client(): BTSClient {
  return new BTSClient({
    token: env.bts.token,
    baseUrl: env.bts.baseUrl,
  });
}

/**
 * BTS's stock, shipping and create-order endpoints key products by EAN, not by their internal
 * product id. Falling back to the id only when an offer has no EAN at all (rare, and those
 * products cannot be ordered through the API anyway).
 */
function btsSku(item: OrderItem): string {
  return item.ean && item.ean.trim() !== "" ? item.ean.trim() : item.vendorProductId;
}

function pickStrategy(quotes: ShippingQuote[], strategy: string): ShippingQuote {
  if (quotes.length === 0) throw new Error("BTS returned no shipping options for this destination");
  if (strategy === "fastest") {
    return [...quotes].sort((a, b) => (a.deliveryDays ?? 99) - (b.deliveryDays ?? 99) || a.cost - b.cost)[0]!;
  }
  return [...quotes].sort((a, b) => a.cost - b.cost || (a.deliveryDays ?? 99) - (b.deliveryDays ?? 99))[0]!;
}

export class BtsOrderAdapter implements VendorOrderAdapter {
  readonly slug = "bts";

  async serviceableCountries(): Promise<string[]> {
    const vendor = await loadVendor("bts");
    return vendor.serviceableCountries;
  }

  async verifyStock(items: OrderItem[]): Promise<StockVerification> {
    const keyed = items.map((item) => ({ item, key: btsSku(item) }));
    const response = await client().getProductStock(keyed.map((k) => k.key));
    const lines = keyed.map(({ item, key }) => {
      const stock = response.products[key];
      const available = stock?.stock ?? 0;
      return {
        sku: item.sku,
        requested: item.quantity,
        available,
        ok: available >= item.quantity && stock?.availability === "in_stock",
      };
    });
    const bad = lines.filter((l) => !l.ok);
    return {
      ok: bad.length === 0,
      lines,
      reason: bad.length === 0 ? undefined : `insufficient stock: ${bad.map((l) => `${l.sku} need ${l.requested} have ${l.available}`).join("; ")}`,
    };
  }

  async quoteShipping(dest: Destination, items: OrderItem[]): Promise<ShippingQuote[]> {
    const options = await client().getShippingPrices(
      { country_code: dest.country, postal_code: dest.address.postcode },
      items.map((i) => ({ sku: btsSku(i), quantity: i.quantity })),
    );
    return options.map((o) => ({
      id: String(o.id),
      company: o.company_name,
      cost: Number(o.shipping_cost),
      deliveryDays: o.delivery_time,
    }));
  }

  async submit(order: VendorOrderDraft, dryRun: boolean): Promise<VendorOrderResult> {
    const vendor = await loadVendor("bts");
    const strategy = String(vendor.orderConfig.shippingStrategy ?? "cheapest");
    const payment = (vendor.orderConfig.paymentMethod as PaymentMethod | undefined) ?? "banktransfer";

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
    const chosen = order.shippingOptionId
      ? quotes.find((q) => q.id === order.shippingOptionId) ?? pickStrategy(quotes, strategy)
      : pickStrategy(quotes, strategy);

    const itemsCost = order.items.reduce((s, i) => s + i.unitCost * i.quantity, 0);
    const addr = order.destination.address;
    const params: CreateOrderParams = {
      payment_method: payment,
      products: order.items.map((i) => ({ sku: btsSku(i), quantity: i.quantity })),
      shipping_cost_id: Number(chosen.id),
      client_name: `${addr.firstName} ${addr.lastName}`.trim(),
      address: [addr.address1, addr.address2].filter(Boolean).join(", "),
      postal_code: addr.postcode,
      city: addr.city,
      country_code: order.destination.country,
      telephone: addr.phone || "0000000000",
      dropshipping: 1,
      state_code: addr.state || undefined,
    };

    // BTS ship-to only — account invoice is whatever is on the BTS portal. Surface company
    // billing in the recorded payload so ops can verify the tax invoice separately.
    const requestPayload = {
      ourReference: order.ourReference,
      params,
      quote: chosen,
      itemsCost,
      delivery: {
        client_name: params.client_name,
        address: params.address,
        postal_code: params.postal_code,
        city: params.city,
        country_code: params.country_code,
        telephone: params.telephone,
        state_code: params.state_code,
      },
      companyBillingNote:
        "BTS API has no separate invoice address; account billing is configured in the BTS portal.",
      companyBilling: order.billing
        ? {
            company: order.billing.address.company,
            vat: order.billing.vat,
            name: `${order.billing.address.firstName} ${order.billing.address.lastName}`.trim(),
            address1: order.billing.address.address1,
            address2: order.billing.address.address2,
            city: order.billing.address.city,
            postcode: order.billing.address.postcode,
            country: order.billing.country,
            email: order.billing.address.email,
            phone: order.billing.address.phone,
          }
        : null,
    };

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

    try {
      const response = await client().setCreateOrder(params);
      return {
        committed: true,
        vendorOrderNumber: response.order_number,
        shippingCost: chosen.cost,
        shippingOptionId: chosen.id,
        shippingCompany: chosen.company,
        totalCost: Number(response.order_total) || Number((itemsCost + chosen.cost).toFixed(2)),
        requestPayload,
        responsePayload: response,
      };
    } catch (err) {
      // Network/timeout after the request left: outcome unknown. The dispatcher must park the
      // row in needs_attention — never auto-retry.
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
    }
  }

  async poll(vendorOrderNumber: string): Promise<VendorOrderStatus> {
    const api = client();
    const detail = await api.getOrder(vendorOrderNumber);
    let tracking = coerceBtsTracking(detail.tracking);
    // getOrder is the status source. getTrackings is the v2.1 bulk tracking
    // endpoint — it often returns tracking:null or order_not_found until 24–72h.
    if (!tracking) {
      try {
        const rows = await api.getTrackings([vendorOrderNumber]);
        const match =
          rows.find((r) => r.order_number === vendorOrderNumber) ?? rows[0];
        tracking = coerceBtsTracking(match?.tracking);
      } catch (err) {
        if (!isBtsTrackingNotReady(err)) throw err;
      }
    }

    const parcels = tracking
      ? [
          {
            courier: detail.shipping_company || "",
            code: tracking,
            url: "",
            dispatchedAt: null,
          },
        ]
      : [];

    return {
      status: btsVendorPollStatus(detail.order_status),
      vendorOrderNumber,
      rawStatus: detail.order_status,
      parcels,
      shippingCompany: detail.shipping_company || null,
    };
  }

  // BTS has no cancel endpoint.
  async cancel?(_vendorOrderNumber: string): Promise<CancelResult> {
    return { ok: false, fee: null, message: "BTS has no cancel API; cancel via the BTS portal" };
  }
}
