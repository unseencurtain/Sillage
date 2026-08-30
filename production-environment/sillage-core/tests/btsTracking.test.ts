import { describe, expect, test } from "bun:test";
import { btsVendorPollStatus } from "../src/vendors/bts/orderStatus.ts";
import {
  BTSRequestError,
  coerceBtsTracking,
  isBtsTrackingNotReady,
} from "../src/vendors/bts/BtsClient.ts";

describe("coerceBtsTracking", () => {
  test("treats JSON null / empty / placeholder strings as not assigned", () => {
    expect(coerceBtsTracking(null)).toBe("");
    expect(coerceBtsTracking(undefined)).toBe("");
    expect(coerceBtsTracking("")).toBe("");
    expect(coerceBtsTracking("null")).toBe("");
    expect(coerceBtsTracking("N/A")).toBe("");
  });

  test("keeps a real carrier code", () => {
    expect(coerceBtsTracking("GLS-9876543210")).toBe("GLS-9876543210");
  });
});

describe("isBtsTrackingNotReady", () => {
  test("recognizes the v2.1 getTrackings order_not_found payload", () => {
    const err = new BTSRequestError(
      'BTS API 404 Not Found: {"message":"order_not_found"}',
      404,
      '{"message":"order_not_found"}',
    );
    expect(isBtsTrackingNotReady(err)).toBe(true);
  });

  test("does not swallow unrelated errors", () => {
    expect(isBtsTrackingNotReady(new BTSRequestError("BTS API 500", 500, "boom"))).toBe(false);
    expect(isBtsTrackingNotReady(new Error("order_not_found"))).toBe(false);
  });
});

describe("btsVendorPollStatus", () => {
  test("maps Cancelled / Shipped / Paid", () => {
    expect(btsVendorPollStatus("Cancelled")).toBe("cancelled");
    expect(btsVendorPollStatus("Shipped")).toBe("dispatched");
    expect(btsVendorPollStatus("Paid")).toBe("confirmed");
    expect(btsVendorPollStatus("Pending Payment")).toBe("pending");
  });
});
