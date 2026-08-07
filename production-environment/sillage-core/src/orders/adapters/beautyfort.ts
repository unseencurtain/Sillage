/**
 * BeautyFort Direct Dispatch adapter — four-step, partially committed state.
 *
 * createOrder leaves a real shell at the vendor. That shell's `orderReference` is persisted
 * before every subsequent step so a crash between addItem and placeOrder can still cancel it.
 * Stock is verified against our local offer table: BeautyFort has no stock-check endpoint.
 */
import { env } from "../../config/env.ts";
import { query, type RowDataPacket } from "../../db/pool.ts";
import { loadVendor } from "../../db/settings.ts";
import { sil } from "../../config/env.ts";
import { BeautyfortClient, type Address } from "../../vendors/beautyfort/BeautyfortClient.ts";
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

function client(): BeautyfortClient {
  return new BeautyfortClient({
    user: env.beautyfort.user,
    secret: env.beautyfort.secret,
    endpoint: env.beautyfort.endpoint,
    testMode: env.beautyfort.testMode,
  });
}

function toAddress(dest: Destination): Address {
  const a = dest.address;
  return {
    companyName: a.company || undefined,
    address1: a.address1,
    address2: a.address2 || undefined,
    town: a.city,
    county: a.state || undefined,
    postcode: a.postcode,
    countryCode: dest.country,
  };
}

export class BeautyfortOrderAdapter implements VendorOrderAdapter {
  readonly slug = "beautyfort";

  async serviceableCountries(): Promise<string[]> {
    const vendor = await loadVendor("beautyfort");
    return vendor.serviceableCountries;
  }

  async verifyStock(items: OrderItem[]): Promise<StockVerification> {
    // No stock endpoint. The offer table is refreshed every 30 minutes and is the best we have.
    const ids = items.map((i) => i.vendorProductId);
    const rows = await query<RowDataPacket & { vendor_product_id: string; stock: number }>(
      `SELECT o.vendor_product_id, o.stock
         FROM ${sil("sil_offers")} o
         JOIN ${sil("sil_vendors")} v ON v.id = o.vendor_id
        WHERE v.slug = 'beautyfort'
          AND o.vendor_product_id IN (${ids.map(() => "?").join(",")})
          AND o.vanished_at IS NULL`,
      ids,
    );
    const byId = new Map(rows.map((r) => [r.vendor_product_id, Number(r.stock)]));
    const lines = items.map((item) => {
      const available = byId.get(item.vendorProductId) ?? 0;
      return {
        sku: item.sku,
        requested: item.quantity,
        available,
        ok: available >= item.quantity,
      };
    });
    const bad = lines.filter((l) => !l.ok);
    return {
      ok: bad.length === 0,
      lines,
      reason: bad.length === 0 ? undefined : `insufficient stock: ${bad.map((l) => `${l.sku} need ${l.requested} have ${l.available}`).join("; ")}`,
    };
  }

  async quoteShipping(dest: Destination, _items: OrderItem[]): Promise<ShippingQuote[]> {
    const { deliveryOptions } = await client().getAccountInformation();
    return deliveryOptions
      .filter((o) => o.countryCode.toUpperCase() === dest.country.toUpperCase())
      .map((o) => ({
        id: o.id,
        company: o.name,
        cost: Number(o.price) || 0,
      }));
  }

  async submit(order: VendorOrderDraft, dryRun: boolean): Promise<VendorOrderResult> {
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
    if (quotes.length === 0) {
      return {
        committed: false,
        vendorOrderNumber: null,
        shippingCost: null,
        shippingOptionId: null,
        shippingCompany: null,
        totalCost: null,
        requestPayload: null,
        responsePayload: { quotes },
        error: `BeautyFort has no Direct Dispatch option for ${order.destination.country}`,
      };
    }
    const chosen = order.shippingOptionId
      ? quotes.find((q) => q.id === order.shippingOptionId) ?? quotes[0]!
      : quotes[0]!;

    const itemsCost = order.items.reduce((s, i) => s + i.unitCost * i.quantity, 0);
    const deliveryAddr = toAddress(order.destination);
    const billingSrc = order.billing ?? order.destination;
    const invoiceAddr = toAddress({
      address: billingSrc.address,
      country: billingSrc.country || order.destination.country,
    });
    const invoiceFirst =
      billingSrc.address.firstName ||
      billingSrc.address.company ||
      order.destination.address.firstName ||
      ".";
    const invoiceLast = billingSrc.address.lastName || ".";
    const attemptAutomaticPayment = Boolean(
      (await loadVendor("beautyfort")).orderConfig.attemptAutomaticPayment,
    );

    const requestPayload = {
      ourReference: order.ourReference,
      orderType: "Direct Dispatch",
      deliveryOptionId: Number(chosen.id),
      items: order.items.map((i) => ({ stockCode: i.vendorProductId, quantity: i.quantity })),
      invoice: {
        firstName: invoiceFirst,
        lastName: invoiceLast,
        address: invoiceAddr,
        vat: order.billing?.vat || undefined,
      },
      delivery: {
        firstName: order.destination.address.firstName,
        lastName: order.destination.address.lastName,
        address: deliveryAddr,
      },
      attemptAutomaticPayment,
      itemsCost,
      shippingCost: chosen.cost,
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

    const bf = client();
    let orderReference: string | null = null;

    try {
      // Step 1: create the shell. Persist the reference before anything else — an unplaced shell
      // is cancellable, but only if we know its number.
      const created = await bf.createOrder("Direct Dispatch", order.ourReference);
      orderReference = created.orderReference;

      for (const item of order.items) {
        await bf.addOrderItem(item.vendorProductId, item.quantity, Number(orderReference));
      }

      const placed = await bf.placeOrder({
        deliveryOptionId: Number(chosen.id),
        invoiceFirstName: invoiceFirst,
        invoiceLastName: invoiceLast,
        invoiceAddress: invoiceAddr,
        deliveryFirstName: order.destination.address.firstName,
        deliveryLastName: order.destination.address.lastName,
        deliveryAddress: deliveryAddr,
        orderReference: Number(orderReference),
        yourOrderReference: order.ourReference,
        attemptAutomaticPayment,
      });

      return {
        committed: true,
        vendorOrderNumber: placed.orderReference || orderReference,
        shippingCost: chosen.cost,
        shippingOptionId: chosen.id,
        shippingCompany: chosen.company,
        totalCost: Number((itemsCost + chosen.cost).toFixed(2)),
        requestPayload: { ...requestPayload, orderReference },
        responsePayload: placed,
      };
    } catch (err) {
      // Best-effort cleanup of the unplaced shell. Failure here still leaves the row marked
      // failed with the shell number recorded so an operator can cancel it.
      if (orderReference) {
        try {
          await bf.cancelOrder(Number(orderReference));
        } catch {
          /* recorded below */
        }
      }
      return {
        committed: false,
        vendorOrderNumber: orderReference,
        shippingCost: chosen.cost,
        shippingOptionId: chosen.id,
        shippingCompany: chosen.company,
        totalCost: null,
        requestPayload: { ...requestPayload, orderReference },
        responsePayload: { error: String(err) },
        error: String(err),
      };
    }
  }

  async poll(vendorOrderNumber: string, ourReference?: string): Promise<VendorOrderStatus> {
    const detail = await client().getOrderDetail(
      vendorOrderNumber ? Number(vendorOrderNumber) : undefined,
      ourReference,
      true,
    );
    const raw = detail.status;
    const lower = raw.toLowerCase();

    let status: VendorOrderStatus["status"] = "unknown";
    if (lower.includes("dispatch")) status = "dispatched";
    else if (lower.includes("deliver")) status = "delivered";
    else if (lower.includes("cancel")) status = "cancelled";
    else if (lower.includes("process") || lower.includes("payment")) status = "confirmed";
    else if (lower.includes("saved") || lower.includes("hold")) status = "pending";

    return {
      status,
      vendorOrderNumber: detail.orderReference || vendorOrderNumber,
      rawStatus: raw,
      parcels: (detail.parcels ?? []).map((p) => ({
        courier: p.courierName,
        code: p.trackingCode,
        url: p.trackingURL,
        dispatchedAt: p.dateDispatched || null,
      })),
      shippingCompany: detail.parcels?.[0]?.courierName ?? null,
    };
  }

  async cancel(vendorOrderNumber: string, ourReference?: string): Promise<CancelResult> {
    const result = await client().cancelOrder(
      vendorOrderNumber ? Number(vendorOrderNumber) : undefined,
      ourReference,
    );
    return {
      ok: result.success,
      fee: result.cancellationFee,
      message: result.warnings.join("; ") || (result.success ? "cancelled" : "cancel failed"),
    };
  }
}
