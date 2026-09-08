import { describe, expect, test } from "bun:test";
import { fetchedLabel } from "../web/src/lib/syncRunLabels.ts";

describe("fetchedLabel", () => {
  test("wholesale shows WPF SKU count, not BeautyFort/BTS", () => {
    expect(
      fetchedLabel({
        products_fetched: 140155,
        fetched_by_vendor: { "wholesale-perfumes": 19083 },
      }),
    ).toBe("WPF 19,083");
  });

  test("retail still shows BF · BTS", () => {
    expect(
      fetchedLabel({
        products_fetched: 9000,
        fetched_by_vendor: { beautyfort: 9000, bts: 100 },
        bts_delta: true,
      }),
    ).toBe("BF 9,000 · BTS 100 Δ");
  });
});
