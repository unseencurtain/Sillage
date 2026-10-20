import { describe, expect, test } from "bun:test";
import { hashIp, isEan, openReviews, roundAverage } from "../src/reviews/store.ts";

const EAN = "3349668656509";

describe("reviews store", () => {
  test("stores published rows and aggregates them by EAN", () => {
    const store = openReviews(":memory:");
    store.insert({ ean: EAN, name: "Ada", rating: 5, title: "Lovely", body: "Would buy again", status: "published" });
    store.insert({ ean: EAN, name: "Bo", rating: 4, body: "Good", status: "published" });
    store.insert({ ean: "12345678", name: "Cy", rating: 3, status: "published" });

    const summary = store.summary(EAN);
    expect(summary.count).toBe(2);
    expect(summary.average).toBe(4.5);

    const rows = store.list(EAN);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.ean).toBe(EAN);
    expect(rows.every((row) => row.rating >= 4)).toBe(true);

    expect(store.summary("99999999")).toEqual({ ean: "99999999", count: 0, average: 0 });
    store.close();
  });

  test("keeps a new review out of the public list until an operator publishes it", () => {
    const store = openReviews(":memory:");
    const pending = store.insert({
      ean: EAN,
      name: "Ada",
      email: "ada@example.com",
      rating: 5,
      customerId: 7,
    });

    expect(pending.status).toBe("pending");
    expect(store.list(EAN)).toHaveLength(0);
    expect(store.summary(EAN).count).toBe(0);

    const page = store.dashboard({ status: "pending" });
    expect(page.items).toHaveLength(1);
    expect(page.counts).toEqual({ pending: 1, published: 0, hidden: 0 });

    expect(store.setStatus(pending.id, "published")).toBe(true);
    expect(store.list(EAN)).toHaveLength(1);
    expect(store.summary(EAN)).toEqual({ ean: EAN, count: 1, average: 5 });

    // Only one review per customer per product, whatever its moderation state.
    expect(store.hasReviewFrom(EAN, 7, "ada@example.com")).toBe(true);
    expect(store.hasReviewFrom(EAN, 8, "ada@example.com")).toBe(true);
    expect(store.hasReviewFrom(EAN, 8, "bo@example.com")).toBe(false);
    store.close();
  });

  test("counts a client's recent rows for the rate limit", () => {
    const store = openReviews(":memory:");
    store.insert({ ean: EAN, name: "Ada", rating: 5, ip: "203.0.113.9" });

    expect(store.countRecentFromIp(hashIp("203.0.113.9"), 60)).toBe(1);
    expect(store.countRecentFromIp(hashIp("203.0.113.10"), 60)).toBe(0);
    // A raw address is never stored.
    const page = store.dashboard({ status: "all" });
    expect(JSON.stringify(page)).not.toContain("203.0.113.9");
    store.close();
  });

  test("rounds an average to one decimal and floors an empty product at zero", () => {
    expect(roundAverage(4.444)).toBe(4.4);
    expect(roundAverage(4.45)).toBe(4.5);
    expect(roundAverage(null)).toBe(0);
    expect(roundAverage(0)).toBe(0);
  });

  test("accepts only 8–14 digit barcodes", () => {
    expect(isEan(EAN)).toBe(true);
    expect(isEan("1234567")).toBe(false);
    expect(isEan("123456789012345")).toBe(false);
    expect(isEan("ABC12345")).toBe(false);
    expect(isEan(undefined)).toBe(false);
  });
});
