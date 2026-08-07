import { createHash, randomUUID } from "node:crypto";
import {
  getAccountInformationRequest,
  getAddOrderItemRequest,
  getCancelOrderRequest,
  getCreateOrderRequest,
  getGetOrderDetailRequest,
  getPlaceOrderRequest,
  getStockFileRequest,
  type Address,
} from "./xmlRequests.ts";

export type { Address };

export interface BeautyfortConfig {
  user: string;
  secret: string;
  endpoint: string;
  /** true selects BeautyFort's test environment, which needs separate test credentials. */
  testMode: boolean;
  timeoutMs?: number;
}

export interface DeliveryOption {
  id: string;
  name: string;
  countryCode: string;
  price: string;
}

export interface BeautyfortParcel {
  boxNumber: string;
  courierName: string;
  trackingCode: string;
  trackingURL: string;
  dateDispatched: string;
}

export interface BeautyfortOrderDetail {
  orderReference: string;
  status: string;
  orderCostSummary: { subtotal: string; tax: string; shipping: string; total: string } | null;
  orderItems: Array<{ stockCode: string; quantity: string; price: string }> | null;
  parcels: BeautyfortParcel[] | null;
  warnings: string[];
}

export class BeautyfortError extends Error {
  constructor(
    message: string,
    readonly operation: string,
    readonly raw?: string,
  ) {
    super(message);
    this.name = "BeautyfortError";
  }
}

/** One set of auth values. Regenerated per request — see the `credentials()` comment. */
interface AuthTriplet {
  nonce: string;
  createdAt: string;
  password: string;
}

export class BeautyfortClient {
  private readonly timeoutMs: number;

  constructor(private readonly config: BeautyfortConfig) {
    if (!config.user || !config.secret) {
      throw new Error("BeautyFort credentials are missing — set BEAUTYFORT_USER and BEAUTYFORT_SECRET");
    }
    this.timeoutMs = config.timeoutMs ?? 180_000;
  }

  /**
   * Fresh nonce and timestamp for every request.
   *
   * The original client computed these once in the constructor, so the second call on an instance
   * failed with "Invalid credentials". BeautyFort rejects a repeated nonce within 5 minutes and
   * requires the timestamp to be within 5 minutes of its own clock.
   */
  private credentials(): AuthTriplet {
    const nonce = randomUUID();
    const createdAt = new Date().toISOString();
    // The digest is hex, and that hex *string* is then base64-encoded. Unusual, but it is what
    // BeautyFort validates against — do not "fix" it to a base64 of the raw digest.
    const password = Buffer.from(
      createHash("sha1").update(nonce + createdAt + this.config.secret).digest("hex"),
    ).toString("base64");
    return { nonce, createdAt, password };
  }

  private async post(operation: string, buildXml: (auth: AuthTriplet) => string): Promise<string> {
    const auth = this.credentials();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let text: string;
    try {
      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/soap+xml; charset=utf-8" },
        body: buildXml(auth),
        signal: controller.signal,
      });
      text = await response.text();
    } catch (err) {
      throw new BeautyfortError(`${operation} request failed: ${String(err)}`, operation);
    } finally {
      clearTimeout(timer);
    }

    const fault = text.match(/<SOAP-ENV:Fault>[\s\S]*?<SOAP-ENV:faultstring>(.*?)<\/SOAP-ENV:faultstring>/);
    if (fault?.[1]) throw new BeautyfortError(fault[1], operation, text);
    return text;
  }

  private xmlArgs(auth: AuthTriplet): [string, string, string, string, boolean] {
    return [this.config.user, auth.nonce, auth.createdAt, auth.password, this.config.testMode];
  }

  /**
   * Download the full catalogue. Returns parsed records rather than writing to disk.
   *
   * BeautyFort has no delta endpoint and no pagination — this is the whole 9k-record file every
   * time, which takes about 6 seconds.
   */
  async getStockFile(): Promise<unknown[]> {
    const text = await this.post("GetStockFile", (auth) => getStockFileRequest(...this.xmlArgs(auth)));

    const match = text.match(/<ns1:File>([\s\S]*?)<\/ns1:File>/);
    if (!match?.[1]) {
      throw new BeautyfortError("no <ns1:File> element in the response", "GetStockFile", text.slice(0, 2000));
    }

    // The original used atob(), which decodes byte-wise and mangles every multi-byte UTF-8
    // sequence — German category and product names came back as "ReisegrÃ¶Ãe". The feed is
    // UTF-8, so decode it as UTF-8.
    const json = Buffer.from(match[1], "base64").toString("utf8");

    const parsed = parseLenientJson(json);
    if (!Array.isArray(parsed)) {
      throw new BeautyfortError("stock file did not parse to an array", "GetStockFile");
    }
    return parsed;
  }

  async getAccountInformation(): Promise<{ deliveryOptions: DeliveryOption[]; raw: string }> {
    const text = await this.post("GetAccountInformation", (auth) =>
      getAccountInformationRequest(...this.xmlArgs(auth)),
    );

    const deliveryOptions: DeliveryOption[] = [];
    for (const m of text.matchAll(
      /<ns1:DirectDispatchDeliveryOption>([\s\S]*?)<\/ns1:DirectDispatchDeliveryOption>/g,
    )) {
      const xml = m[1] ?? "";
      deliveryOptions.push({
        id: tag(xml, "ID") ?? "",
        name: tag(xml, "Name") ?? "",
        countryCode: tag(xml, "CountryCode") ?? "",
        price: tag(xml, "Amount") ?? "",
      });
    }
    return { deliveryOptions, raw: text };
  }

  async createOrder(
    orderType: "Wholesale" | "Direct Dispatch",
    yourOrderReference?: string,
  ): Promise<{ orderReference: string; yourOrderReference: string | null; warnings: string[] }> {
    const text = await this.post("CreateOrder", (auth) =>
      getCreateOrderRequest(...this.xmlArgs(auth), orderType, yourOrderReference),
    );
    const orderReference = tag(text, "OrderReference");
    if (!orderReference) {
      throw new BeautyfortError("no OrderReference in the response", "CreateOrder", text.slice(0, 2000));
    }
    return {
      orderReference,
      yourOrderReference: tag(text, "YourOrderReference") ?? null,
      warnings: warnings(text),
    };
  }

  async addOrderItem(
    stockCode: string,
    quantity: number,
    orderReference?: number,
    yourOrderReference?: string,
  ): Promise<{ itemReference: string; totalQuantity: string; warnings: string[] }> {
    requireReference(orderReference, yourOrderReference);
    const text = await this.post("AddOrderItem", (auth) =>
      getAddOrderItemRequest(...this.xmlArgs(auth), stockCode, quantity, orderReference, yourOrderReference),
    );
    if (text.includes("<ns1:Errors>")) {
      throw new BeautyfortError(tag(text, "Description") ?? "unknown error", "AddOrderItem", text.slice(0, 2000));
    }
    return {
      itemReference: tag(text, "ItemReference") ?? "",
      totalQuantity: tag(text, "TotalQuantity") ?? "",
      warnings: warnings(text),
    };
  }

  async placeOrder(params: {
    deliveryOptionId: number;
    invoiceFirstName: string;
    invoiceLastName: string;
    invoiceAddress: Address;
    deliveryFirstName: string;
    deliveryLastName: string;
    deliveryAddress: Address;
    orderReference?: number;
    yourOrderReference?: string;
    attemptAutomaticPayment?: boolean;
  }): Promise<{ success: boolean; orderReference: string; status: string; warnings: string[] }> {
    requireReference(params.orderReference, params.yourOrderReference);
    const text = await this.post("PlaceOrder", (auth) =>
      getPlaceOrderRequest(
        ...this.xmlArgs(auth),
        params.deliveryOptionId,
        params.invoiceFirstName,
        params.invoiceLastName,
        params.invoiceAddress,
        params.deliveryFirstName,
        params.deliveryLastName,
        params.deliveryAddress,
        params.orderReference,
        params.yourOrderReference,
        params.attemptAutomaticPayment ?? false,
      ),
    );
    const success = text.includes("<ns1:Success>true</ns1:Success>");
    if (!success) {
      throw new BeautyfortError(
        `PlaceOrder failed: ${tag(text, "Description") ?? "unknown error"}`,
        "PlaceOrder",
        text.slice(0, 2000),
      );
    }
    return {
      success,
      orderReference: tag(text, "OrderReference") ?? "",
      status: tag(text, "Status") ?? "Unknown",
      warnings: warnings(text),
    };
  }

  async cancelOrder(
    orderReference?: number,
    yourOrderReference?: string,
  ): Promise<{ success: boolean; cancellationFee: string | null; warnings: string[] }> {
    requireReference(orderReference, yourOrderReference);
    const text = await this.post("CancelOrder", (auth) =>
      getCancelOrderRequest(...this.xmlArgs(auth), orderReference, yourOrderReference),
    );
    const warns = warnings(text);
    // The fee sometimes arrives only inside a warning: "Cancellation fee of 0.85 EUR applied".
    let cancellationFee = tag(text, "CancellationFee") ?? null;
    if (!cancellationFee) {
      for (const w of warns) {
        const found = w.match(/cancellation fee of ([\d.]+)/i)?.[1];
        if (found) {
          cancellationFee = found;
          break;
        }
      }
    }
    return {
      success: /<ns1:CancelOrderResponse>/.test(text),
      cancellationFee,
      warnings: warns,
    };
  }

  async getOrderDetail(
    orderReference?: number,
    yourOrderReference?: string,
    includeOrderItems = false,
  ): Promise<BeautyfortOrderDetail> {
    requireReference(orderReference, yourOrderReference);
    const text = await this.post("GetOrderDetail", (auth) =>
      getGetOrderDetailRequest(...this.xmlArgs(auth), orderReference, yourOrderReference, includeOrderItems),
    );

    const ref = tag(text, "OrderReference");
    if (!ref) {
      throw new BeautyfortError("no OrderReference in the response", "GetOrderDetail", text.slice(0, 2000));
    }

    const subtotal = tag(text, "Subtotal");
    const tax = tag(text, "Tax");
    const shipping = tag(text, "Shipping");
    const total = tag(text, "Total");

    let orderItems: BeautyfortOrderDetail["orderItems"] = null;
    if (includeOrderItems) {
      orderItems = [];
      for (const m of text.matchAll(/<ns1:OrderItem>([\s\S]*?)<\/ns1:OrderItem>/g)) {
        const xml = m[1];
        if (!xml) continue;
        const stockCode = tag(xml, "StockCode");
        if (!stockCode) continue;
        orderItems.push({
          stockCode,
          quantity: tag(xml, "Quantity") ?? "0",
          price: tag(xml, "Price") ?? "0",
        });
      }
    }

    let parcels: BeautyfortParcel[] | null = null;
    for (const m of text.matchAll(/<ns1:Parcels>([\s\S]*?)<\/ns1:Parcels>/g)) {
      const xml = m[1];
      if (!xml) continue;
      parcels ??= [];
      const boxNumber = tag(xml, "BoxNumber");
      const courierName = tag(xml, "CourierName");
      if (!boxNumber || !courierName) continue;
      parcels.push({
        boxNumber,
        courierName,
        trackingCode: tag(xml, "TrackingCode") ?? "",
        trackingURL: tag(xml, "TrackingURL") ?? "",
        dateDispatched: tag(xml, "DateDispatched") ?? "",
      });
    }

    return {
      orderReference: ref,
      status: tag(text, "Status") ?? "Unknown",
      orderCostSummary:
        subtotal && tax && shipping && total ? { subtotal, tax, shipping, total } : null,
      orderItems,
      parcels,
      warnings: warnings(text),
    };
  }
}

function tag(xml: string, name: string): string | undefined {
  return xml.match(new RegExp(`<ns1:${name}>([\\s\\S]*?)</ns1:${name}>`))?.[1];
}

/** Each <ns1:Warning> wraps a Code and a Description; only the description is useful. */
function warnings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<ns1:Warning>([\s\S]*?)<\/ns1:Warning>/g)) {
    const desc = m[1] ? tag(m[1], "Description") : undefined;
    if (desc) out.push(desc);
  }
  return out;
}

function requireReference(orderReference?: number, yourOrderReference?: string): void {
  if (!orderReference && !yourOrderReference) {
    throw new Error("Either orderReference or yourOrderReference must be provided");
  }
}

/**
 * Both vendors have shipped feeds with a trailing comma before the closing bracket, which is
 * invalid strict JSON. Retry once with it stripped rather than failing a whole sync run.
 */
export function parseLenientJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const repaired = text.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(repaired);
  }
}
