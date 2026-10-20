import { describe, expect, test } from "bun:test";
import { reviews } from "../src/server/routes/reviews.ts";

/**
 * The review write and helpful vote are state-changing public endpoints. These checks exercise the
 * cheap gates that run before any database or upload work: a cross-site request must be refused,
 * an anonymous write must be refused, and a photo name must never be treated as a path.
 */
describe("public review route guards", () => {
  test("rejects a review POST from another origin", async () => {
    const response = await reviews.request("/reviews", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "shop.test",
        origin: "https://evil.test",
      },
      body: "{}",
    });

    expect(response.status).toBe(403);
  });

  test("rejects a same-origin review POST without a signed-in session before parsing a body", async () => {
    const response = await reviews.request("/reviews", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "shop.test",
        origin: "https://shop.test",
      },
      body: "{}",
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "sign_in_required" });
  });

  test("compares against the public host Caddy forwards, not the internal upstream host", async () => {
    const response = await reviews.request("/reviews", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "localhost:4000",
        "x-forwarded-host": "shop.test",
        origin: "https://shop.test",
      },
      body: "{}",
    });

    expect(response.status).toBe(401);
  });

  test("rejects a helpful vote from another origin", async () => {
    const response = await reviews.request("/reviews/1/helpful", {
      method: "POST",
      headers: { host: "shop.test", origin: "https://evil.test" },
    });

    expect(response.status).toBe(403);
  });

  test("rejects an invalid EAN without touching the review store", async () => {
    const response = await reviews.request("/reviews?ean=not-an-ean");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "invalid" });
  });

  test("does not turn a photo name into a path", async () => {
    const response = await reviews.request("/reviews/photo/..%2f..%2fetc%2fpasswd");

    expect(response.status).toBe(404);
  });
});
