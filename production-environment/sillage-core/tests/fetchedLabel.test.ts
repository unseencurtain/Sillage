import { describe, expect, test } from "bun:test";
import { fetchedLabel } from "../web/src/lib/syncRunLabels.ts";

describe("fetchedLabel", () => {
  test("retail shows BF · BTS", () => {
    expect(
      fetchedLabel({
        products_fetched: 9000,
        fetched_by_vendor: { beautyfort: 9000, bts: 100 },
        bts_delta: true,
      }),
    ).toBe("BF 9,000 · BTS 100 Δ");
  });
});
