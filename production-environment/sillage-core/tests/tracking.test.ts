import { describe, expect, test } from "bun:test";
import { BeautyfortError } from "../src/vendors/beautyfort/BeautyfortClient.ts";
import { isPermanentPollFailure, nextVendorOrderStatus } from "../src/orders/pollRules.ts";

describe("isPermanentPollFailure", () => {
  test("flags BeautyfortError.permanent", () => {
    expect(
      isPermanentPollFailure(
        new BeautyfortError("no OrderReference in the response", "GetOrderDetail", undefined, true),
      ),
    ).toBe(true);
  });

  test("flags no-OrderReference message even without the permanent flag", () => {
    expect(
      isPermanentPollFailure(
        new BeautyfortError("no OrderReference in the response", "GetOrderDetail"),
      ),
    ).toBe(true);
  });

  test("flags invalid vendor order number", () => {
    expect(isPermanentPollFailure(new Error("invalid vendor order number: abc"))).toBe(true);
  });

  test("does not park transient network errors", () => {
    expect(
      isPermanentPollFailure(
        new BeautyfortError("GetOrderDetail request failed: AbortError", "GetOrderDetail"),
      ),
    ).toBe(false);
    expect(isPermanentPollFailure(new Error("ECONNRESET"))).toBe(false);
  });
});

describe("nextVendorOrderStatus", () => {
  test("applies BTS Cancelled from submitted (rank compare used to drop it)", () => {
    expect(nextVendorOrderStatus("submitted", "cancelled")).toBe("cancelled");
    expect(nextVendorOrderStatus("confirmed", "cancelled")).toBe("cancelled");
    expect(nextVendorOrderStatus("dispatched", "cancelled")).toBe("cancelled");
  });

  test("does not reopen a delivered row as cancelled", () => {
    expect(nextVendorOrderStatus("delivered", "cancelled")).toBe(null);
  });

  test("still advances forward ranks", () => {
    expect(nextVendorOrderStatus("submitted", "confirmed")).toBe("confirmed");
    expect(nextVendorOrderStatus("confirmed", "dispatched")).toBe("dispatched");
    expect(nextVendorOrderStatus("dispatched", "delivered")).toBe("delivered");
    expect(nextVendorOrderStatus("delivered", "dispatched")).toBe(null);
  });
});
