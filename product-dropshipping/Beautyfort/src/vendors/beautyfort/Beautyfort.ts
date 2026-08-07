import config from "../../configs/beautyfortConfig";
import { CryptoHasher } from "bun";
import {
  getStockFileRequest,
  getCreateOrderRequest,
  getAddOrderItemRequest,
  getPlaceOrderRequest,
  getCancelOrderRequest,
  getGetOrderDetailRequest,
  getAccountInformationRequest,
  type Address,
} from "./xml/xmlRequests";

class Beautyfort {
  user: string;
  secret: string;
  endpoint: string;
  mode: boolean;
  nonce: string;
  createdAt: string;
  password: string;

  constructor(cfg: typeof config) {
    this.user = cfg.user;
    this.secret = cfg.secret;
    this.endpoint = cfg.endpoint;
    this.mode = cfg.mode;

    this.nonce = crypto.randomUUID();
    this.createdAt = new Date().toISOString();
    this.password = Buffer.from(
      new CryptoHasher("sha1")
        .update(this.nonce + this.createdAt + this.secret)
        .digest("hex"),
    ).toString("base64");
  }

  //Get Stockfile
  async getStockFile(): Promise<void> {
    const xmlRequest = getStockFileRequest(
      this.user,
      this.nonce,
      this.createdAt,
      this.password,
      this.mode,
    );

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/soap+xml; charset=utf-8",
      },
      body: xmlRequest,
    });

    const responseText = await response.text();
    const match = responseText.match(/<ns1:File>(.*?)<\/ns1:File>/);

    if (!match || !match[1]) {
      throw new Error("Failed to extract file content from response");
    }

    const decoded = atob(match[1]);
    await Bun.write("products.json", decoded);
    console.log("Products file saved as products.json");
  }

  // Create Order
  async createOrder(
    orderType: "Wholesale" | "Direct Dispatch",
    yourOrderReference?: string,
  ): Promise<{
    orderReference: string;
    yourOrderReference: string | null;
    warnings: string[];
  }> {
    const xmlRequest = getCreateOrderRequest(
      this.user,
      this.nonce,
      this.createdAt,
      this.password,
      this.mode,
      orderType,
      yourOrderReference,
    );

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/soap+xml; charset=utf-8",
      },
      body: xmlRequest,
    });

    const responseText = await response.text();

    // Check for SOAP faults
    const faultMatch = responseText.match(
      /<SOAP-ENV:Fault>.*?<SOAP-ENV:faultstring>(.*?)<\/SOAP-ENV:faultstring>/s,
    );
    if (faultMatch && faultMatch[1]) {
      throw new Error(`BeautyFort API Error: ${faultMatch[1]}`);
    }

    // Extract OrderReference
    const orderRefMatch = responseText.match(
      /<ns1:OrderReference>(\d+)<\/ns1:OrderReference>/,
    );
    if (!orderRefMatch || !orderRefMatch[1]) {
      throw new Error("Failed to extract OrderReference from response");
    }

    // Extract YourOrderReference
    const yourOrderRefMatch = responseText.match(
      /<ns1:YourOrderReference>(.*?)<\/ns1:YourOrderReference>/,
    );

    // Extract warnings — each <ns1:Warning> contains <ns1:Code> and
    // <ns1:Description> child tags, so pull out just the description text.
    const warnings: string[] = [];
    const warningMatches = responseText.matchAll(
      /<ns1:Warning>([\s\S]*?)<\/ns1:Warning>/g,
    );
    for (const match of warningMatches) {
      if (match[1]) {
        const desc = match[1].match(
          /<ns1:Description>(.*?)<\/ns1:Description>/,
        )?.[1];
        if (desc) warnings.push(desc);
      }
    }

    return {
      orderReference: orderRefMatch[1],
      yourOrderReference:
        yourOrderRefMatch && yourOrderRefMatch[1] ? yourOrderRefMatch[1] : null,
      warnings,
    };
  }

  // Get Account Information (including delivery options)
  async getAccountInformation(): Promise<{
    deliveryOptions: Array<{
      id: string;
      name: string;
      countryCode: string;
      price: string;
    }>;
    raw: string;
  }> {
    const xmlRequest = getAccountInformationRequest(
      this.user,
      this.nonce,
      this.createdAt,
      this.password,
      this.mode,
    );

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/soap+xml; charset=utf-8" },
      body: xmlRequest,
    });

    const responseText = await response.text();

    const faultMatch = responseText.match(
      /<SOAP-ENV:Fault>.*?<SOAP-ENV:faultstring>(.*?)<\/SOAP-ENV:faultstring>/s,
    );
    if (faultMatch && faultMatch[1]) {
      throw new Error(`BeautyFort API Error: ${faultMatch[1]}`);
    }

    const deliveryOptions: Array<{
      id: string;
      name: string;
      countryCode: string;
      price: string;
    }> = [];

    const ddMatches = responseText.matchAll(
      /<ns1:DirectDispatchDeliveryOption>([\s\S]*?)<\/ns1:DirectDispatchDeliveryOption>/g,
    );
    for (const match of ddMatches) {
      const xml = match[1] ?? "";
      const id = xml.match(/<ns1:ID>(\d+)<\/ns1:ID>/)?.[1] ?? "";
      const name = xml.match(/<ns1:Name>(.*?)<\/ns1:Name>/)?.[1] ?? "";
      const countryCode =
        xml.match(/<ns1:CountryCode>(.*?)<\/ns1:CountryCode>/)?.[1] ?? "";
      const price = xml.match(/<ns1:Amount>(.*?)<\/ns1:Amount>/)?.[1] ?? "";
      deliveryOptions.push({ id, name, countryCode, price });
    }

    return { deliveryOptions, raw: responseText };
  }

  // Add Order Item
  async addOrderItem(
    stockCode: string,
    quantity: number,
    orderReference?: number,
    yourOrderReference?: string,
  ): Promise<{
    itemReference: string;
    totalQuantity: string;
    warnings: string[];
  }> {
    if (!orderReference && !yourOrderReference) {
      throw new Error(
        "At least one of orderReference or yourOrderReference must be provided",
      );
    }

    const xmlRequest = getAddOrderItemRequest(
      this.user,
      this.nonce,
      this.createdAt,
      this.password,
      this.mode,
      stockCode,
      quantity,
      orderReference,
      yourOrderReference,
    );

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/soap+xml; charset=utf-8" },
      body: xmlRequest,
    });

    const responseText = await response.text();

    const faultMatch = responseText.match(
      /<SOAP-ENV:Fault>.*?<SOAP-ENV:faultstring>(.*?)<\/SOAP-ENV:faultstring>/s,
    );
    if (faultMatch && faultMatch[1]) {
      throw new Error(`BeautyFort API Error: ${faultMatch[1]}`);
    }

    const errorMatch = responseText.match(
      /<ns1:Description>(.*?)<\/ns1:Description>/,
    );
    if (errorMatch && responseText.includes("<ns1:Errors>")) {
      throw new Error(`BeautyFort Error: ${errorMatch[1]}`);
    }

    const itemReference =
      responseText.match(
        /<ns1:ItemReference>(\d+)<\/ns1:ItemReference>/,
      )?.[1] ?? "";
    const totalQuantity =
      responseText.match(
        /<ns1:TotalQuantity>(\d+)<\/ns1:TotalQuantity>/,
      )?.[1] ?? "";

    // Extract warnings — each <ns1:Warning> contains <ns1:Code> and
    // <ns1:Description> child tags, so pull out just the description text.
    const warnings: string[] = [];
    for (const m of responseText.matchAll(
      /<ns1:Warning>([\s\S]*?)<\/ns1:Warning>/g,
    )) {
      if (m[1]) {
        const desc = m[1].match(
          /<ns1:Description>(.*?)<\/ns1:Description>/,
        )?.[1];
        if (desc) warnings.push(desc);
      }
    }

    return { itemReference, totalQuantity, warnings };
  }

  // Place Order
  async placeOrder(
    deliveryOptionId: number,
    invoiceFirstName: string,
    invoiceLastName: string,
    invoiceAddress: Address,
    deliveryFirstName: string,
    deliveryLastName: string,
    deliveryAddress: Address,
    orderReference?: number,
    yourOrderReference?: string,
    attemptAutomaticPayment: boolean = false,
  ): Promise<{
    success: boolean;
    orderReference: string;
    status: string;
    warnings: string[];
  }> {
    if (!orderReference && !yourOrderReference) {
      throw new Error(
        "At least one of orderReference or yourOrderReference must be provided",
      );
    }

    const xmlRequest = getPlaceOrderRequest(
      this.user,
      this.nonce,
      this.createdAt,
      this.password,
      this.mode,
      deliveryOptionId,
      invoiceFirstName,
      invoiceLastName,
      invoiceAddress,
      deliveryFirstName,
      deliveryLastName,
      deliveryAddress,
      orderReference,
      yourOrderReference,
      attemptAutomaticPayment,
    );

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/soap+xml; charset=utf-8" },
      body: xmlRequest,
    });

    const responseText = await response.text();

    const faultMatch = responseText.match(
      /<SOAP-ENV:Fault>.*?<SOAP-ENV:faultstring>(.*?)<\/SOAP-ENV:faultstring>/s,
    );
    if (faultMatch && faultMatch[1]) {
      throw new Error(`BeautyFort API Error: ${faultMatch[1]}`);
    }

    const success = responseText.includes("<ns1:Success>true</ns1:Success>");
    const orderRef =
      responseText.match(
        /<ns1:OrderReference>(\d+)<\/ns1:OrderReference>/,
      )?.[1] ?? "";
    const status =
      responseText.match(/<ns1:Status>(.*?)<\/ns1:Status>/)?.[1] ?? "Unknown";

    // Extract warnings — each <ns1:Warning> contains <ns1:Code> and
    // <ns1:Description> child tags, so pull out just the description text.
    const warnings: string[] = [];
    for (const m of responseText.matchAll(
      /<ns1:Warning>([\s\S]*?)<\/ns1:Warning>/g,
    )) {
      if (m[1]) {
        const desc = m[1].match(
          /<ns1:Description>(.*?)<\/ns1:Description>/,
        )?.[1];
        if (desc) warnings.push(desc);
      }
    }

    if (!success) {
      const errDesc = responseText.match(
        /<ns1:Description>(.*?)<\/ns1:Description>/,
      )?.[1];
      throw new Error(`PlaceOrder failed: ${errDesc ?? "unknown error"}`);
    }

    return { success, orderReference: orderRef, status, warnings };
  }

  // Cancel Order
  async cancelOrder(
    orderReference?: number,
    yourOrderReference?: string,
  ): Promise<{
    success: boolean;
    cancellationFee: string | null;
    warnings: string[];
  }> {
    if (!orderReference && !yourOrderReference) {
      throw new Error(
        "At least one of orderReference or yourOrderReference must be provided",
      );
    }

    const xmlRequest = getCancelOrderRequest(
      this.user,
      this.nonce,
      this.createdAt,
      this.password,
      this.mode,
      orderReference,
      yourOrderReference,
    );

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/soap+xml; charset=utf-8",
      },
      body: xmlRequest,
    });

    const responseText = await response.text();

    // Check for SOAP faults
    const faultMatch = responseText.match(
      /<SOAP-ENV:Fault>.*?<SOAP-ENV:faultstring>(.*?)<\/SOAP-ENV:faultstring>/s,
    );
    if (faultMatch && faultMatch[1]) {
      throw new Error(`BeautyFort API Error: ${faultMatch[1]}`);
    }

    // Extract success status
    const successMatch = responseText.match(
      /<ns1:CancelOrderResponse>([\s\S]*?)<\/ns1:CancelOrderResponse>/,
    );
    const success = successMatch ? true : false;

    // Extract cancellation fee from dedicated field (not always present)
    const feeMatch = responseText.match(
      /<ns1:CancellationFee>(.*?)<\/ns1:CancellationFee>/,
    );

    // Extract warnings — each <ns1:Warning> contains <ns1:Code> and
    // <ns1:Description> child tags, so pull out just the description text.
    const warnings: string[] = [];
    const warningMatches = responseText.matchAll(
      /<ns1:Warning>([\s\S]*?)<\/ns1:Warning>/g,
    );
    for (const match of warningMatches) {
      if (match[1]) {
        const desc = match[1].match(
          /<ns1:Description>(.*?)<\/ns1:Description>/,
        )?.[1];
        if (desc) warnings.push(desc);
      }
    }

    // If the dedicated fee field was absent, BeautyFort sometimes embeds the
    // fee amount inside a warning description, e.g.
    // "Cancellation fee of 0.85 EUR applied" — extract it as a fallback.
    let cancellationFee: string | null = feeMatch?.[1] ?? null;
    if (!cancellationFee) {
      for (const w of warnings) {
        const fromWarning = w.match(/cancellation fee of ([\d.]+)/i)?.[1];
        if (fromWarning) {
          cancellationFee = fromWarning;
          break;
        }
      }
    }

    return {
      success,
      cancellationFee,
      warnings,
    };
  }

  // Get Order Detail
  async getOrderDetail(
    orderReference?: number,
    yourOrderReference?: string,
    includeOrderItems: boolean = false,
  ): Promise<{
    orderReference: string;
    status: string;
    orderCostSummary: {
      subtotal: string;
      tax: string;
      shipping: string;
      total: string;
    } | null;
    orderItems: Array<{
      stockCode: string;
      quantity: string;
      price: string;
    }> | null;
    parcels: Array<{
      boxNumber: string;
      courierName: string;
      trackingCode: string;
      trackingURL: string;
      dateDispatched: string;
    }> | null;
    warnings: string[];
  }> {
    if (!orderReference && !yourOrderReference) {
      throw new Error(
        "At least one of orderReference or yourOrderReference must be provided",
      );
    }

    const xmlRequest = getGetOrderDetailRequest(
      this.user,
      this.nonce,
      this.createdAt,
      this.password,
      this.mode,
      orderReference,
      yourOrderReference,
      includeOrderItems,
    );

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/soap+xml; charset=utf-8",
      },
      body: xmlRequest,
    });

    const responseText = await response.text();

    // Check for SOAP faults
    const faultMatch = responseText.match(
      /<SOAP-ENV:Fault>.*?<SOAP-ENV:faultstring>(.*?)<\/SOAP-ENV:faultstring>/s,
    );
    if (faultMatch && faultMatch[1]) {
      throw new Error(`BeautyFort API Error: ${faultMatch[1]}`);
    }

    // Extract OrderReference
    const orderRefMatch = responseText.match(
      /<ns1:OrderReference>(\d+)<\/ns1:OrderReference>/,
    );
    if (!orderRefMatch || !orderRefMatch[1]) {
      throw new Error("Failed to extract OrderReference from response");
    }

    // Extract Status
    const statusMatch = responseText.match(/<ns1:Status>(.*?)<\/ns1:Status>/);
    const status = statusMatch && statusMatch[1] ? statusMatch[1] : "Unknown";

    // Extract OrderCostSummary
    let orderCostSummary: {
      subtotal: string;
      tax: string;
      shipping: string;
      total: string;
    } | null = null;

    const subtotalMatch = responseText.match(
      /<ns1:Subtotal>(.*?)<\/ns1:Subtotal>/,
    );
    const taxMatch = responseText.match(/<ns1:Tax>(.*?)<\/ns1:Tax>/);
    const shippingMatch = responseText.match(
      /<ns1:Shipping>(.*?)<\/ns1:Shipping>/,
    );
    const totalMatch = responseText.match(/<ns1:Total>(.*?)<\/ns1:Total>/);

    if (
      subtotalMatch &&
      subtotalMatch[1] &&
      taxMatch &&
      taxMatch[1] &&
      shippingMatch &&
      shippingMatch[1] &&
      totalMatch &&
      totalMatch[1]
    ) {
      orderCostSummary = {
        subtotal: subtotalMatch[1],
        tax: taxMatch[1],
        shipping: shippingMatch[1],
        total: totalMatch[1],
      };
    }

    // Extract OrderItems
    let orderItems: Array<{
      stockCode: string;
      quantity: string;
      price: string;
    }> | null = null;

    if (includeOrderItems) {
      orderItems = [];
      const itemMatches = responseText.matchAll(
        /<ns1:OrderItem>([\s\S]*?)<\/ns1:OrderItem>/g,
      );

      for (const match of itemMatches) {
        const itemXml = match[1];
        if (!itemXml) continue;

        const stockCodeMatch = itemXml.match(
          /<ns1:StockCode>(.*?)<\/ns1:StockCode>/,
        );
        const quantityMatch = itemXml.match(
          /<ns1:Quantity>(.*?)<\/ns1:Quantity>/,
        );
        const priceMatch = itemXml.match(/<ns1:Price>(.*?)<\/ns1:Price>/);

        if (
          stockCodeMatch &&
          stockCodeMatch[1] &&
          quantityMatch &&
          quantityMatch[1] &&
          priceMatch &&
          priceMatch[1]
        ) {
          orderItems.push({
            stockCode: stockCodeMatch[1],
            quantity: quantityMatch[1],
            price: priceMatch[1],
          });
        }
      }
    }

    // Extract Parcels (tracking information)
    let parcels: Array<{
      boxNumber: string;
      courierName: string;
      trackingCode: string;
      trackingURL: string;
      dateDispatched: string;
    }> | null = null;

    const parcelMatches = responseText.matchAll(
      /<ns1:Parcels>([\s\S]*?)<\/ns1:Parcels>/g,
    );
    for (const match of parcelMatches) {
      const parcelXml = match[1];
      if (!parcelXml) continue;

      if (!parcels) {
        parcels = [];
      }

      const boxNumberMatch = parcelXml.match(
        /<ns1:BoxNumber>(.*?)<\/ns1:BoxNumber>/,
      );
      const courierNameMatch = parcelXml.match(
        /<ns1:CourierName>(.*?)<\/ns1:CourierName>/,
      );
      const trackingCodeMatch = parcelXml.match(
        /<ns1:TrackingCode>(.*?)<\/ns1:TrackingCode>/,
      );
      const trackingURLMatch = parcelXml.match(
        /<ns1:TrackingURL>(.*?)<\/ns1:TrackingURL>/,
      );
      const dateDispatchedMatch = parcelXml.match(
        /<ns1:DateDispatched>(.*?)<\/ns1:DateDispatched>/,
      );

      if (
        boxNumberMatch &&
        boxNumberMatch[1] &&
        courierNameMatch &&
        courierNameMatch[1]
      ) {
        parcels.push({
          boxNumber: boxNumberMatch[1],
          courierName: courierNameMatch[1],
          trackingCode:
            trackingCodeMatch && trackingCodeMatch[1]
              ? trackingCodeMatch[1]
              : "",
          trackingURL:
            trackingURLMatch && trackingURLMatch[1] ? trackingURLMatch[1] : "",
          dateDispatched:
            dateDispatchedMatch && dateDispatchedMatch[1]
              ? dateDispatchedMatch[1]
              : "",
        });
      }
    }

    // Extract warnings — each <ns1:Warning> contains <ns1:Code> and
    // <ns1:Description> child tags, so pull out just the description text.
    const warnings: string[] = [];
    const warningMatches = responseText.matchAll(
      /<ns1:Warning>([\s\S]*?)<\/ns1:Warning>/g,
    );
    for (const match of warningMatches) {
      if (match[1]) {
        const desc = match[1].match(
          /<ns1:Description>(.*?)<\/ns1:Description>/,
        )?.[1];
        if (desc) warnings.push(desc);
      }
    }

    return {
      orderReference: orderRefMatch[1],
      status,
      orderCostSummary,
      orderItems,
      parcels,
      warnings,
    };
  }
}

export default Beautyfort;
