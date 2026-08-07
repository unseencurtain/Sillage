import { describe, expect, test } from "bun:test";
import { BeautyfortError } from "../src/vendors/beautyfort/BeautyfortClient.ts";
import { isPermanentPollFailure } from "../src/orders/tracking.ts";

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
